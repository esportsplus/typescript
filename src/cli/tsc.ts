import type { Plugin, SharedContext } from '../compiler/types';
import type { PositionMapping } from '../compiler/sourcemap';
import type { Diagnostic as AnalyzeDiagnostic } from '../guard/kernel/types';
import type { Config } from './specifiers';
import { API, type Checker, DiagnosticCategory, type Program, type Snapshot } from 'typescript/unstable/sync';
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
import timing from '../timing';
import { analyze, analyzeProgram } from '../guard/kernel/analyze';
import analyzed from '../guard/kernel/cache';
import { formatDiagnostics } from '../guard/kernel/format';
import { loadConfigFromTsconfig } from '../guard/kernel/config';
import { stripJsonc } from '../jsonc';
import { readPlugins } from '../tsconfig';


type Flags = {
    // Compiler flags only tsc.js applies (the API program is opened from the tsconfig alone)
    forwarded: boolean;
    informational: boolean;
    noEmit: boolean;
    watch: boolean;
};

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

const LAYOUT_FLAGS: Record<string, string> = {
    '--baseurl': 'baseUrl',
    '--declarationdir': 'declarationDir',
    '--outdir': 'outDir',
    '--rootdir': 'rootDir'
};

const NO_EMIT_FLAGS = new Set(['--noEmit', '-noEmit']);

const PROJECT_FLAGS = new Set(['--project', '-p']);

const WATCH_FLAGS = new Set(['--watch', '-w']);


let require = createRequire(import.meta.url);


async function build(tsconfig: string, pluginConfigs: PluginConfig[], instance?: API, noEmit = false): Promise<void> {
    let stop = timing('open program'),
        opened = instance === undefined ? languageService.open(tsconfig) : undefined,
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

    stop();

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

    stop = timing('transform');

    for (let i = 0, n = plugins.length > 0 ? fileNames.length : 0; i < n; i++) {
        let fileName = fileNames[i],
            sourceFile = project.program.getSourceFile(fileName);

        if (!sourceFile) {
            continue;
        }

        let result = coordinator.transform(
            plugins,
            sourceFile.getFullText(),
            sourceFile,
            { checker: project.checker, program: project.program },
            root,
            shared
        );

        if (result.changed) {
            transformedFiles.set(normalizePath(fileName), { code: result.code, mapping: result.map });
        }
    }

    stop(`${transformedFiles.size} of ${fileNames.length} files changed`);
    stop = timing('diagnostics');

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

    stop();

    if (diagnostics.length > 0) {
        console.error(format(diagnostics, root, transformedFiles));
    }

    if (diagnostics.some((diagnostic) => diagnostic.category === DiagnosticCategory.Error)) {
        teardown(snapshot, tsconfig, owned);
        process.exit(1);
    }

    if (noEmit || options.noEmit === true) {
        teardown(snapshot, tsconfig, owned);
        process.exit(0);
    }

    stop = timing('emit (tsc.js --noCheck)');

    let code = await emit(tsconfig, fileNames, transformedFiles, root, options);

    stop();

    teardown(snapshot, tsconfig, owned);
    process.exit(code);
}

function classifyFlags(args: string[]): Flags {
    let flags: Flags = { forwarded: false, informational: false, noEmit: false, watch: false };

    for (let i = 0, n = args.length; i < n; i++) {
        let arg = args[i];

        if (PROJECT_FLAGS.has(arg)) {
            i++;
        }
        else if (arg.startsWith('--project=')) {
            continue;
        }
        else if (INFORMATIONAL_FLAGS.has(arg)) {
            flags.informational = true;
        }
        else if (NO_EMIT_FLAGS.has(arg)) {
            flags.noEmit = true;
        }
        else if (WATCH_FLAGS.has(arg)) {
            flags.watch = true;
        }
        else {
            flags.forwarded = true;
        }
    }

    return flags;
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

        if (code === 0) {
            await rewrite(files, specifiers.configure(options, fileNames));
        }

        return code;
    }

    let mirror = fs.mkdtempSync(path.join(root, '.esportsplus-tsc-'));

    try {
        let created = new Set<string>(),
            declaration = options.declaration === true,
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
                directory = path.dirname(target),
                transformed = transformedFiles.get(normalizePath(fileNames[i]));

            if (!created.has(directory)) {
                fs.mkdirSync(directory, { recursive: true });
                created.add(directory);
            }

            if (transformed === undefined) {
                link(source, target);
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

        if (code !== 0) {
            return code;
        }

        if (fs.existsSync(mirrorOut)) {
            composeSourceMaps(mirrorOut, mirror, root, transformedFiles);
            fs.cpSync(mirrorOut, realOutDir, { force: true, recursive: true });
        }

        if (separateDecl && realDeclDir !== undefined && fs.existsSync(mirrorDecl)) {
            fs.cpSync(mirrorDecl, realDeclDir, { force: true, recursive: true });
        }

        // Rewritten in place after the copy, so specifiers are computed against the real layout
        for (let i = 0, n = emitted.length; i < n; i++) {
            let file = path.resolve(emitted[i]),
                decl = path.relative(mirrorDecl, file);

            emitted[i] = separateDecl && realDeclDir !== undefined && !decl.startsWith('..')
                ? path.join(realDeclDir, decl)
                : path.join(realOutDir, path.relative(mirrorOut, file));
        }

        await rewrite(emitted, specifiers.configure(options, fileNames));

        return 0;
    }
    finally {
        fs.rmSync(mirror, { force: true, recursive: true });
    }
}

function isPlugin(value: unknown): value is Plugin {
    return typeof value === 'object' && value !== null && 'transform' in value && typeof (value as Plugin).transform === 'function';
}

// The project's resolved options with the layout flags given on the command line applied, as tsc.js
// applies them
function layout(tsconfig: string, args: string[]): [ResolvedOptions, string[]] {
    let api = new API({ cwd: process.cwd() });

    try {
        let { fileNames, options } = api.parseConfigFile(tsconfig);

        options = { ...options };

        for (let i = 0, n = args.length - 1; i < n; i++) {
            let key = LAYOUT_FLAGS[args[i].toLowerCase()];

            if (key !== undefined) {
                options[key] = path.resolve(args[++i]);
            }
        }

        return [options, fileNames];
    }
    finally {
        api.close();
    }
}

// The mirror only needs untransformed sources readable at their mirrored path: a hard link shares
// the file without copying it; a file system without hard links gets a copy
function link(source: string, target: string): void {
    try {
        fs.linkSync(source, target);
    }
    catch {
        fs.copyFileSync(source, target);
    }
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

// Every real invocation checks the project once, through the API program analyze also reads, then
// emits with tsc.js --noCheck. tsc.js runs on its own (checking again) only for what the API program
// cannot honor: no tsconfig, informational flags, watch mode, or compiler flags on the command line.
function main(): void {
    let args = process.argv.slice(2),
        flags = classifyFlags(args),
        tsconfig = projectPath(args) ?? languageService.findConfig(process.cwd());

    if (!tsconfig || flags.informational) {
        return passthrough(null);
    }

    let pluginConfigs = resolvePluginConfigs(tsconfig);

    if (flags.watch && pluginConfigs.length > 0) {
        console.error(`${PACKAGE_NAME}: --watch is not supported on the transformer plugin path; run a one-shot build or use real tsc directly`);
        process.exit(1);
    }

    if (pluginConfigs.length === 0 && (flags.watch || flags.forwarded)) {
        if (!flags.watch) {
            runAnalyze(tsconfig);
        }

        return passthrough(flags.noEmit || flags.watch ? null : tsconfig);
    }

    if (pluginConfigs.length > 0) {
        console.log(`${PACKAGE_NAME}: found ${pluginConfigs.length} transformer plugin(s), using coordinated build...`);
    }

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

async function rewrite(files: string[], config: Config): Promise<void> {
    let stop = timing('rewrite specifiers');

    await specifiers.rewrite(files, config);
    stop(`over ${files.length} emitted files`);
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

    let diagnostics: ReadonlyArray<AnalyzeDiagnostic>,
        stop = timing('analyze findings (cache lookup included)');

    try {
        diagnostics = program && checker
            ? analyzed.findings(config, program.getSourceFileNames(), () => [...analyzeProgram(program, checker, config).diagnostics])
            : analyze(config).diagnostics;
        stop();
    }
    catch (error) {
        console.error(`${PACKAGE_NAME}: analyze failed: ${error instanceof Error ? error.message : String(error)}`);

        return;
    }

    if (diagnostics.length === 0) {
        return;
    }

    console.error(formatDiagnostics(diagnostics, config.projectRoot));

    // Fail the build only when a finding belongs to a channel configured
    // `severity: "error"`; `warn` channels report without gating. Kept outside the
    // analyze try so the exit is never swallowed as an "analyze failed".
    if (diagnostics.some((diagnostic) => config.channels[diagnostic.channel]?.severity === 'error')) {
        process.exit(1);
    }
}

// `tsconfig` is the project whose emit is post-processed, or null when tsc.js emits nothing to rewrite
function passthrough(tsconfig: string | null): void {
    let args = process.argv.slice(2),
        tscJs = path.join(path.dirname(require.resolve('typescript/package.json')), 'lib', 'tsc.js');

    if (tsconfig === null) {
        spawn(process.execPath, [tscJs, ...args], { stdio: 'inherit' })
            .on('exit', (code) => process.exit(code ?? 0));

        return;
    }

    // Started first so the config is read while tsc.js runs
    let emitted = spawnTsc(tscJs, args),
        config = specifiers.configure(...layout(tsconfig, args));

    void emitted.then(async ({ code, files }) => {
        if (code === 0) {
            await rewrite(files, config);
        }

        process.exit(code);
    });
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
