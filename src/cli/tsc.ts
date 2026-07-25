import type { Plugin, SharedContext } from '~/compiler/types';
import type { PositionMapping } from '~/compiler/sourcemap';
import { API, DiagnosticCategory, type Snapshot } from 'typescript/unstable/sync';
import { createRequire } from 'module';
import { format } from './diagnostics';
import { PACKAGE_NAME } from '~/constants';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';

import coordinator from '~/compiler/coordinator';
import fs from 'fs';
import languageService from '~/compiler/language-service';
import path from 'path';
import sourcemap from '~/compiler/sourcemap';


type PluginConfig = {
    transform: string;
};

type TransformedFile = {
    code: string;
    mapping: PositionMapping;
};

type ResolvedOptions = ReturnType<API['parseConfigFile']>['options'];


const BACKSLASH_REGEX = /\\/g;

const INFORMATIONAL_FLAGS = new Set(['--help', '--init', '--showConfig', '--version', '-h', '-v']);

const NO_EMIT_FLAGS = new Set(['--noEmit', '-noEmit']);

const WATCH_FLAGS = new Set(['--watch', '-w']);


let require = createRequire(import.meta.url),
    skipFlags = new Set(['--help', '--init', '--noEmit', '--showConfig', '--version', '-h', '-noEmit', '-v']);


async function build(tsconfig: string, pluginConfigs: PluginConfig[], instance?: API, noEmit = false): Promise<void> {
    let root = path.dirname(path.resolve(tsconfig)),
        owned = instance === undefined,
        api = instance ?? new API({ cwd: root }),
        snapshot = api.updateSnapshot({ openProjects: [tsconfig] }),
        project = snapshot.getProject(tsconfig);

    if (!project) {
        teardown(snapshot, api, root, owned);

        throw new Error(`${PACKAGE_NAME}: project not found for ${tsconfig}`);
    }

    let configDiagnostics = project.program.getConfigFileParsingDiagnostics();

    if (configDiagnostics.some((diagnostic) => diagnostic.category === DiagnosticCategory.Error)) {
        console.error(format(configDiagnostics, root));
        teardown(snapshot, api, root, owned);
        process.exit(1);
    }

    let { fileNames, options } = api.parseConfigFile(tsconfig),
        plugins: Plugin[],
        shared: SharedContext = new Map(),
        transformedFiles = new Map<string, TransformedFile>();

    try {
        plugins = await loadPlugins(pluginConfigs, root);
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        teardown(snapshot, api, root, owned);
        process.exit(1);
    }

    for (let i = 0, n = fileNames.length; i < n; i++) {
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

    let program = project.program;

    for (let [fileName, entry] of transformedFiles) {
        program = languageService.update(root, fileName, entry.code).program;
    }

    let diagnostics = [
        ...program.getConfigFileParsingDiagnostics(),
        ...program.getSyntacticDiagnostics(),
        ...program.getBindDiagnostics(),
        ...program.getSemanticDiagnostics(),
        ...program.getGlobalDiagnostics(),
        ...program.getProgramDiagnostics()
    ];

    if (diagnostics.length > 0) {
        console.error(format(diagnostics, root));
    }

    if (diagnostics.some((diagnostic) => diagnostic.category === DiagnosticCategory.Error)) {
        teardown(snapshot, api, root, owned);
        process.exit(1);
    }

    if (noEmit) {
        teardown(snapshot, api, root, owned);
        process.exit(0);
    }

    let code = await emit(tsconfig, fileNames, transformedFiles, root, options);

    teardown(snapshot, api, root, owned);

    if (code !== 0) {
        process.exit(code);
    }

    return runTscAlias(process.argv.slice(2)).then((exitCode) => process.exit(exitCode));
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
        return spawnTsc(tscJs, ['-p', tsconfig]);
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

        let code = await spawnTsc(tscJs, ['-p', path.join(mirror, 'tsconfig.json')]);

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

function extendsTarget(specifier: unknown, fromDir: string): string | null {
    if (typeof specifier !== 'string') {
        return null;
    }

    if (specifier.startsWith('.')) {
        let resolved = path.resolve(fromDir, specifier);

        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            return resolved;
        }

        if (fs.existsSync(resolved + '.json')) {
            return resolved + '.json';
        }

        let nested = path.join(resolved, 'tsconfig.json');

        if (fs.existsSync(nested)) {
            return nested;
        }

        return null;
    }

    try {
        return require.resolve(specifier, { paths: [fromDir] });
    }
    catch {
        try {
            return require.resolve(specifier + '/tsconfig.json', { paths: [fromDir] });
        }
        catch {
            return null;
        }
    }
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
    let tsconfig = languageService.findConfig(process.cwd());

    if (!tsconfig) {
        return passthrough();
    }

    let pluginConfigs = resolvePluginConfigs(tsconfig);

    if (pluginConfigs.length === 0) {
        return passthrough();
    }

    let flags = classifyFlags(process.argv.slice(2));

    if (flags.informational) {
        return passthrough();
    }

    if (flags.watch) {
        console.error(`${PACKAGE_NAME}: --watch is not supported on the transformer plugin path; run a one-shot build or use real tsc directly`);
        process.exit(1);

        return;
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

function passthrough(): void {
    let args = process.argv.slice(2),
        tsDir = path.dirname(require.resolve('typescript/package.json'));

    spawn(process.execPath, [path.join(tsDir, 'lib', 'tsc.js'), ...args], { stdio: 'inherit' })
        .on('exit', async (code) => {
            if (code === 0) {
                code = await runTscAlias(args);
            }

            process.exit(code ?? 0);
        });
}

function readPlugins(tsconfig: string, seen: Set<string>): unknown[] | undefined {
    let id = path.resolve(tsconfig);

    if (seen.has(id)) {
        return undefined;
    }

    seen.add(id);

    let config: { compilerOptions?: { plugins?: unknown[] }; extends?: unknown };

    try {
        config = JSON.parse(stripJsonc(fs.readFileSync(id, 'utf8')));
    }
    catch {
        return undefined;
    }

    let plugins: unknown[] | undefined;

    if (config?.extends !== undefined) {
        let bases = Array.isArray(config.extends) ? config.extends : [config.extends];

        for (let i = 0, n = bases.length; i < n; i++) {
            let target = extendsTarget(bases[i], path.dirname(id));

            if (target) {
                let inherited = readPlugins(target, seen);

                if (inherited !== undefined) {
                    plugins = inherited;
                }
            }
        }
    }

    if (Array.isArray(config?.compilerOptions?.plugins)) {
        plugins = config.compilerOptions.plugins;
    }

    return plugins;
}

function resolvePluginConfigs(tsconfig: string): PluginConfig[] {
    let plugins = readPlugins(tsconfig, new Set());

    if (!Array.isArray(plugins)) {
        return [];
    }

    return plugins.filter(
        (p: unknown): p is PluginConfig => typeof p === 'object' && p !== null && 'transform' in p
    );
}

function runTscAlias(args: string[]): Promise<number> {
    for (let i = 0, n = args.length; i < n; i++) {
        if (skipFlags.has(args[i])) {
            return Promise.resolve(0);
        }
    }

    return new Promise((resolve) => {
        let child = spawn(process.execPath, [require.resolve('tsc-alias/dist/bin/index.js'), ...args], { stdio: 'inherit' });

        child.on('exit', (code) => resolve(code ?? 0));
    });
}

function spawnTsc(tscJs: string, args: string[]): Promise<number> {
    return new Promise((resolve) => {
        let child = spawn(process.execPath, [tscJs, ...args], { stdio: 'inherit' });

        child.on('exit', (code) => resolve(code ?? 0));
    });
}

function stripJsonc(text: string): string {
    let escaped = false,
        inBlockComment = false,
        inLineComment = false,
        inString = false,
        stripped = '';

    for (let i = 0, n = text.length; i < n; i++) {
        let char = text[i],
            next = text[i + 1];

        if (inLineComment) {
            if (char === '\n') {
                inLineComment = false;
                stripped += char;
            }

            continue;
        }

        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }

            continue;
        }

        if (inString) {
            stripped += char;

            if (escaped) {
                escaped = false;
            }
            else if (char === '\\') {
                escaped = true;
            }
            else if (char === '"') {
                inString = false;
            }

            continue;
        }

        if (char === '"') {
            inString = true;
            stripped += char;

            continue;
        }

        if (char === '/' && next === '/') {
            inLineComment = true;
            i++;

            continue;
        }

        if (char === '/' && next === '*') {
            inBlockComment = true;
            i++;

            continue;
        }

        stripped += char;
    }

    escaped = false;
    inString = false;

    let result = '';

    for (let i = 0, n = stripped.length; i < n; i++) {
        let char = stripped[i];

        if (inString) {
            result += char;

            if (escaped) {
                escaped = false;
            }
            else if (char === '\\') {
                escaped = true;
            }
            else if (char === '"') {
                inString = false;
            }

            continue;
        }

        if (char === '"') {
            inString = true;
            result += char;

            continue;
        }

        if (char === ',') {
            let j = i + 1;

            while (j < n && (stripped[j] === ' ' || stripped[j] === '\n' || stripped[j] === '\r' || stripped[j] === '\t')) {
                j++;
            }

            if (stripped[j] === ']' || stripped[j] === '}') {
                continue;
            }
        }

        result += char;
    }

    return result;
}

function teardown(snapshot: Snapshot, api: API, root: string, owned: boolean): void {
    if (!snapshot.isDisposed()) {
        snapshot.dispose();
    }

    if (owned) {
        api.close();
    }

    languageService.dispose(root);
}


if (process.env.VITEST === undefined) {
    main();
}


export { build, classifyFlags, isPlugin, loadPlugins, main, normalizePath, resolvePluginConfigs, runTscAlias };
