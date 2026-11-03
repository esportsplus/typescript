import type { Plugin, SharedContext } from '../compiler/types';
import type { PositionMapping } from '../compiler/sourcemap';
import { API, DiagnosticCategory, type Checker, type Program, type Snapshot } from 'typescript/unstable/sync';
import { createRequire } from 'module';
import { format } from './diagnostics';
import { PACKAGE_NAME } from '../constants';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';

import coordinator from '../compiler/coordinator';
import fs from 'fs';
import languageService from '../compiler/language-service';
import path from 'path';
import sourcemap from '../compiler/sourcemap';
import specifiers from './specifiers';
import { analyze, analyzeProgram } from '../guard/kernel/analyze';
import { formatDiagnostics } from '../guard/kernel/format';
import { loadConfigFromTsconfig } from '../guard/kernel/config';
import { stripJsonc } from '../jsonc';
import { readPlugins } from '../tsconfig';


type PluginConfig = {
    transform: string;
};

type TransformedFile = {
    code: string;
    mapping: PositionMapping;
};

type ResolvedOptions = ReturnType<API['parseConfigFile']>['options'];

type Spawned = {
    code: number;
    files: string[];
};


const BACKSLASH_REGEX = /\\/g;

const CARRIAGE_RETURN_REGEX = /\r$/;

const EMITTED_PREFIX = 'TSFILE: ';

const INFORMATIONAL_FLAGS = new Set(['--help', '--init', '--showConfig', '--version', '-h', '-v']);

const NO_EMIT_FLAGS = new Set(['--noEmit', '-noEmit']);

const WATCH_FLAGS = new Set(['--watch', '-w']);


let require = createRequire(import.meta.url);


// tsconfig `paths` prefixes: emit keeps them verbatim and nothing rewrites them afterwards
function aliases(options: ResolvedOptions): string[] {
    let keys = Object.keys(options.paths ?? {}),
        prefixes: string[] = [];

    for (let i = 0, n = keys.length; i < n; i++) {
        if (keys[i].endsWith('*')) {
            prefixes.push(keys[i].slice(0, -1));
        }
    }

    return prefixes;
}

async function build(tsconfig: string, pluginConfigs: PluginConfig[], instance?: API, noEmit = false): Promise<void> {
    let opened = instance === undefined ? languageService.open(tsconfig) : undefined,
        root = path.dirname(path.resolve(tsconfig)),
        owned = instance === undefined,
        api = opened?.api ?? instance!,
        snapshot = opened?.snapshot ?? api.updateSnapshot({ openProjects: [tsconfig] }),
        project = opened?.project ?? snapshot.getProject(tsconfig);

    if (!project) {
        teardown(snapshot, tsconfig, owned);

        throw new Error(`${PACKAGE_NAME}: project not found for ${tsconfig}`);
    }

    let configDiagnostics = project.program.getConfigFileParsingDiagnostics();

    if (configDiagnostics.some((diagnostic) => diagnostic.category === DiagnosticCategory.Error)) {
        console.error(format(configDiagnostics, root));
        teardown(snapshot, tsconfig, owned);
        process.exit(1);
    }

    let { fileNames, options } = api.parseConfigFile(tsconfig),
        plugins: Plugin[],
        shared: SharedContext = new Map(),
        transformedFiles = new Map<string, TransformedFile>();

    runAnalyze(tsconfig, project.program, project.checker);

    try {
        plugins = await loadPlugins(pluginConfigs, root);
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        teardown(snapshot, tsconfig, owned);
        process.exit(1);
    }

    for (let i = 0, n = fileNames.length; i < n; i++) {
        // Coordinated plugins can replace the shared language-service snapshot.
        // Fetch the live project before reading the next source file.
        if (owned) {
            project = languageService.open(tsconfig).project;
        }

        let fileName = fileNames[i],
            sourceFile = project.program.getSourceFile(fileName);

        if (!sourceFile) {
            continue;
        }

        let result = coordinator.transform(
            plugins,
            sourceFile.getFullText(),
            sourceFile,
            { checker: project.checker, configPath: tsconfig, program: project.program },
            root,
            shared
        );

        if (result.changed) {
            transformedFiles.set(normalizePath(fileName), { code: result.code, mapping: result.map });
        }
    }

    let program = transformedFiles.size === 0
        ? project.program
        : languageService.updateMany(tsconfig, new Map([...transformedFiles].map(([fileName, entry]) => [fileName, entry.code]))).program;

    // Declaration diagnostics are gathered here too, so the emit pass below can skip checking
    // (--noCheck) without losing any error it would have reported
    let diagnostics = [
        ...program.getConfigFileParsingDiagnostics(),
        ...program.getSyntacticDiagnostics(),
        ...program.getBindDiagnostics(),
        ...program.getSemanticDiagnostics(),
        ...program.getGlobalDiagnostics(),
        ...program.getProgramDiagnostics(),
        ...(options.declaration === true || options.composite === true ? program.getDeclarationDiagnostics() : [])
    ];

    if (diagnostics.length > 0) {
        console.error(format(diagnostics, root, transformedFiles));
    }

    if (diagnostics.some((diagnostic) => diagnostic.category === DiagnosticCategory.Error)) {
        teardown(snapshot, tsconfig, owned);
        process.exit(1);
    }

    if (noEmit) {
        teardown(snapshot, tsconfig, owned);
        process.exit(0);
    }

    let code = await emit(tsconfig, fileNames, transformedFiles, root, options);

    teardown(snapshot, tsconfig, owned);
    process.exit(code);
}

function classifyFlags(args: string[]): { informational: boolean, noEmit: boolean, watch: boolean } {
    let informational = false,
        noEmit = false,
        watch = false;

    for (let i = 0, n = args.length; i < n; i++) {
        let arg = args[i];

        if (INFORMATIONAL_FLAGS.has(arg)) {
            informational = true;
        }
        else if (NO_EMIT_FLAGS.has(arg)) {
            noEmit = true;
        }
        else if (WATCH_FLAGS.has(arg)) {
            watch = true;
        }
    }

    return { informational, noEmit, watch };
}

function collectMaps(dir: string, results: string[]): void {
    for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
        let full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            collectMaps(full, results);
        }
        else if (entry.name.endsWith('.js.map')) {
            results.push(full);
        }
    }
}

function composeSourceMaps(mirrorOut: string, mirror: string, root: string, transformedFiles: Map<string, TransformedFile>): void {
    let maps: string[] = [];

    collectMaps(mirrorOut, maps);

    for (let i = 0, n = maps.length; i < n; i++) {
        let mapPath = maps[i],
            raw: { file?: string; mappings: string; names?: string[]; sourceRoot?: string; sources?: (string | null)[] };

        try {
            raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
        }
        catch {
            continue;
        }

        if (!raw.sources || raw.sources.length === 0 || typeof raw.sources[0] !== 'string' || typeof raw.mappings !== 'string') {
            continue;
        }

        let mirrorSource = path.resolve(path.dirname(mapPath), raw.sources[0]),
            relative = path.relative(mirror, mirrorSource),
            realSource = normalizePath(path.join(root, relative)),
            entry = transformedFiles.get(realSource);

        if (!entry) {
            continue;
        }

        let composed = sourcemap.composeEmittedMap(
            { mappings: raw.mappings, names: raw.names ?? [], sources: raw.sources, version: 3 },
            entry.mapping,
            entry.code,
            fs.readFileSync(path.join(root, relative), 'utf8')
        );

        if (raw.file !== undefined) {
            composed.file = raw.file;
        }

        if (raw.sourceRoot !== undefined) {
            composed.sourceRoot = raw.sourceRoot;
        }

        fs.writeFileSync(mapPath, JSON.stringify(composed));
    }
}

async function emit(tsconfig: string, fileNames: string[], transformedFiles: Map<string, TransformedFile>, root: string, options: ResolvedOptions): Promise<number> {
    let tscJs = path.join(path.dirname(require.resolve('typescript/package.json')), 'lib', 'tsc.js');

    if (transformedFiles.size === 0) {
        let { code, files } = await spawnTsc(tscJs, ['-p', tsconfig, '--noCheck']);

        return code === 0 ? finalize(files, aliases(options)) : code;
    }

    let mirror = fs.mkdtempSync(path.join(root, '.esportsplus-tsc-'));

    try {
        let declaration = options.declaration === true,
            files: string[] = [],
            mirrorDecl = path.join(mirror, '__decl'),
            mirrorOut = path.join(mirror, '__emit'),
            realOutDir = typeof options.outDir === 'string' ? path.resolve(options.outDir) : root,
            realDeclDir = declaration
                ? (typeof options.declarationDir === 'string' ? path.resolve(options.declarationDir) : realOutDir)
                : undefined,
            realRootDir = typeof options.rootDir === 'string' ? path.resolve(options.rootDir) : undefined,
            separateDecl = realDeclDir !== undefined && normalizePath(realDeclDir) !== normalizePath(realOutDir);

        for (let i = 0, n = fileNames.length; i < n; i++) {
            let source = path.resolve(fileNames[i]),
                relative = path.relative(root, source);

            if (relative.startsWith('..')) {
                throw new Error(`${PACKAGE_NAME}: source ${normalizePath(source)} resolves outside the project root ${normalizePath(root)}; monorepo-external sources are not supported by the transform emit path`);
            }

            let target = path.join(mirror, relative),
                transformed = transformedFiles.get(normalizePath(fileNames[i]));

            fs.mkdirSync(path.dirname(target), { recursive: true });

            if (transformed === undefined) {
                fs.copyFileSync(source, target);
            }
            else {
                fs.writeFileSync(target, transformed.code);
            }

            files.push(normalizePath(target));
        }

        let compilerOptions: Record<string, string> = {
            outDir: normalizePath(mirrorOut)
        };

        if (declaration) {
            compilerOptions.declarationDir = normalizePath(separateDecl ? mirrorDecl : mirrorOut);
        }

        if (realRootDir !== undefined) {
            compilerOptions.rootDir = normalizePath(path.join(mirror, path.relative(root, realRootDir)));
        }

        fs.writeFileSync(path.join(mirror, 'tsconfig.json'), JSON.stringify({
            compilerOptions,
            exclude: [],
            extends: normalizePath(tsconfig),
            files,
            include: []
        }));

        let { code, files: emitted } = await spawnTsc(tscJs, ['-p', path.join(mirror, 'tsconfig.json'), '--noCheck']);

        if (code === 0) {
            code = finalize(emitted, aliases(options));
        }

        if (code === 0) {
            if (fs.existsSync(mirrorOut)) {
                composeSourceMaps(mirrorOut, mirror, root, transformedFiles);
                fs.cpSync(mirrorOut, realOutDir, { force: true, recursive: true });
            }

            if (separateDecl && realDeclDir !== undefined && fs.existsSync(mirrorDecl)) {
                fs.cpSync(mirrorDecl, realDeclDir, { force: true, recursive: true });
            }
        }

        return code;
    }
    finally {
        fs.rmSync(mirror, { force: true, recursive: true });
    }
}

function finalize(files: string[], prefixes: string[]): number {
    let aliased = specifiers.rewrite(files, prefixes);

    for (let i = 0, n = aliased.length; i < n; i++) {
        console.error(`${PACKAGE_NAME}: ${normalizePath(aliased[i].file)} imports '${aliased[i].specifier}', a path alias nothing rewrites after emit; use a relative import`);
    }

    return aliased.length === 0 ? 0 : 1;
}

function isPlugin(value: unknown): value is Plugin {
    return typeof value === 'object' && value !== null && 'transform' in value && typeof (value as Plugin).transform === 'function';
}

async function loadPlugins(configs: PluginConfig[], root: string): Promise<Plugin[]> {
    let plugins: Plugin[] = [],
        promises: Promise<void>[] = [];

    for (let i = 0, n = configs.length; i < n; i++) {
        let config = configs[i],
            pluginPath = config.transform;

        if (pluginPath.startsWith('.')) {
            pluginPath = pathToFileURL(path.resolve(root, pluginPath)).href;
        }
        else {
            pluginPath = pathToFileURL(require.resolve(pluginPath, { paths: [root] })).href;
        }

        promises.push(
            import(pluginPath).then((module) => {
                let plugin = module.default ?? module;

                if (typeof plugin === 'function') {
                    plugin = plugin();
                }

                if (Array.isArray(plugin)) {
                    for (let j = 0, m = plugin.length; j < m; j++) {
                        if (!isPlugin(plugin[j])) {
                            throw new Error(`${PACKAGE_NAME}: plugin ${config.transform}[${j}] uses an invalid plugin format, expected { transform: Function }`);
                        }

                        plugins.push(plugin[j]);
                    }

                    return;
                }

                if (!isPlugin(plugin)) {
                    throw new Error(`${PACKAGE_NAME}: plugin ${config.transform} uses an invalid plugin format, expected { transform: Function } or Plugin[]`);
                }

                plugins.push(plugin);
            })
        );
    }

    await Promise.all(promises);

    return plugins;
}

function main(): void {
    let args = process.argv.slice(2),
        tsconfig = projectPath(args) ?? languageService.findConfig(process.cwd());

    if (!tsconfig) {
        return passthrough(false);
    }

    let flags = classifyFlags(args);

    // Run analyze for any project whose tsconfig carries a `analyze` plugin entry,
    // on every real (non-informational, non-watch) tsc invocation. Findings are
    // printed but do not fail the build — the compiler's own result stands.
    let pluginConfigs = resolvePluginConfigs(tsconfig);

    if (pluginConfigs.length === 0) {
        if (!flags.informational && !flags.watch) {
            runAnalyze(tsconfig);
        }

        return passthrough(!flags.informational && !flags.noEmit && !flags.watch);
    }

    if (flags.informational) {
        return passthrough(false);
    }

    if (flags.watch) {
        console.error(`${PACKAGE_NAME}: --watch is not supported on the transformer plugin path; run a one-shot build or use real tsc directly`);
        process.exit(1);
    }

    console.log(`${PACKAGE_NAME}: found ${pluginConfigs.length} transformer plugin(s), using coordinated build...`);

    build(tsconfig, pluginConfigs, undefined, flags.noEmit).catch((err) => {
        console.error(`${PACKAGE_NAME}: ${err}`);
        process.exit(1);
    });
}

function normalizePath(fileName: string): string {
    return path.resolve(fileName).replace(BACKSLASH_REGEX, '/');
}

function projectPath(args: string[]): string | null {
    for (let i = 0, n = args.length; i < n; i++) {
        let arg = args[i],
            value: string | undefined;

        if (arg === '-p' || arg === '--project') {
            value = args[i + 1];
        }
        else if (arg.startsWith('--project=')) {
            value = arg.slice('--project='.length);
        }

        if (value !== undefined) {
            let resolved = path.resolve(value);

            return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
                ? path.join(resolved, 'tsconfig.json')
                : resolved;
        }
    }

    return null;
}

function runAnalyze(tsconfig: string, program?: Program, checker?: Checker): void {
    let config;

    try {
        config = loadConfigFromTsconfig(tsconfig);
    }
    catch (error) {
        // A rejected/legacy config key is a hard error: report it and fail the
        // build rather than silently running with analysis disabled.
        console.error(`${PACKAGE_NAME}: analyze config error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }

    if (!config) {
        return;
    }

    let result;

    try {
        result = program && checker ? analyzeProgram(program, checker, config) : analyze(config);
    }
    catch (error) {
        console.error(`${PACKAGE_NAME}: analyze failed: ${error instanceof Error ? error.message : String(error)}`);

        return;
    }

    if (result.diagnostics.length === 0) {
        return;
    }

    console.error(formatDiagnostics(result.diagnostics, config.projectRoot));

    // Fail the build only when a finding belongs to a channel configured
    // `severity: "error"`; `warn` channels report without gating. Kept outside the
    // analyze try so the exit is never swallowed as an "analyze failed".
    if (result.diagnostics.some((diagnostic) => config.channels[diagnostic.channel]?.severity === 'error')) {
        process.exit(1);
    }
}

function passthrough(emits: boolean): void {
    let args = process.argv.slice(2),
        tscJs = path.join(path.dirname(require.resolve('typescript/package.json')), 'lib', 'tsc.js');

    if (!emits) {
        spawn(process.execPath, [tscJs, ...args], { stdio: 'inherit' })
            .on('exit', (code) => process.exit(code ?? 0));

        return;
    }

    void spawnTsc(tscJs, args).then(({ code, files }) => process.exit(code === 0 ? finalize(files, []) : code));
}

function resolvePluginConfigs(tsconfig: string): PluginConfig[] {
    let plugins = readPlugins(tsconfig);

    if (!Array.isArray(plugins)) {
        return [];
    }

    return plugins.filter(
        (p: unknown): p is PluginConfig => typeof p === 'object' && p !== null && 'transform' in p
    );
}

// Emits with --listEmittedFiles so exactly the files this run wrote are post-processed; the listing
// is consumed here and every other line of output passes through
function spawnTsc(tscJs: string, args: string[]): Promise<Spawned> {
    return new Promise((resolve) => {
        let child = spawn(process.execPath, [tscJs, ...args, '--listEmittedFiles'], { stdio: ['inherit', 'pipe', 'inherit'] }),
            files: string[] = [],
            rest = '';

        let read = (line: string): void => {
            line = line.replace(CARRIAGE_RETURN_REGEX, '');

            if (line.startsWith(EMITTED_PREFIX)) {
                files.push(line.slice(EMITTED_PREFIX.length));
            }
            else {
                process.stdout.write(line + '\n');
            }
        };

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            let lines = (rest + chunk).split('\n');

            rest = lines.pop() ?? '';

            for (let i = 0, n = lines.length; i < n; i++) {
                read(lines[i]);
            }
        });
        // `close`, not `exit`: the listing may still be buffered in the pipe when the process exits
        child.on('close', (code) => {
            if (rest) {
                read(rest);
            }

            resolve({ code: code ?? 0, files });
        });
    });
}

function teardown(snapshot: Snapshot, configPath: string, owned: boolean): void {
    if (owned) {
        languageService.dispose(configPath);

        return;
    }

    if (!snapshot.isDisposed()) {
        snapshot.dispose();
    }
}


if (process.env.VITEST === undefined) {
    main();
}


export { build, classifyFlags, isPlugin, loadPlugins, main, normalizePath, projectPath, resolvePluginConfigs, runAnalyze, stripJsonc };
