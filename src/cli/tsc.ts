import type { Plugin, SharedContext } from '~/compiler/types';
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


type PluginConfig = {
    transform: string;
};


const BACKSLASH_REGEX = /\\/g;


let require = createRequire(import.meta.url),
    skipFlags = new Set(['--help', '--init', '--noEmit', '--showConfig', '--version', '-h', '-noEmit', '-v']);


async function build(tsconfig: string, pluginConfigs: PluginConfig[]): Promise<void> {
    let root = path.dirname(path.resolve(tsconfig)),
        api = new API({ cwd: root }),
        snapshot = api.updateSnapshot({ openProjects: [tsconfig] }),
        project = snapshot.getProject(tsconfig);

    if (!project) {
        api.close();

        throw new Error(`${PACKAGE_NAME}: project not found for ${tsconfig}`);
    }

    let configDiagnostics = project.program.getConfigFileParsingDiagnostics();

    if (configDiagnostics.some((diagnostic) => diagnostic.category === DiagnosticCategory.Error)) {
        console.error(format(configDiagnostics, root));
        teardown(snapshot, api, root);
        process.exit(1);
    }

    let { fileNames } = api.parseConfigFile(tsconfig),
        plugins = await loadPlugins(pluginConfigs, root),
        shared: SharedContext = new Map(),
        transformedFiles = new Map<string, string>();

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
            transformedFiles.set(normalizePath(fileName), result.code);
        }
    }

    let program = project.program;

    for (let [fileName, code] of transformedFiles) {
        program = languageService.update(root, fileName, code).program;
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
        teardown(snapshot, api, root);
        process.exit(1);
    }

    let code = await emit(tsconfig, fileNames, transformedFiles, root, program.getCompilerOptions().outDir ?? root);

    teardown(snapshot, api, root);

    if (code !== 0) {
        process.exit(code);
    }

    return runTscAlias(process.argv.slice(2)).then((exitCode) => process.exit(exitCode));
}

async function emit(tsconfig: string, fileNames: string[], transformedFiles: Map<string, string>, root: string, outDir: string): Promise<number> {
    let tscJs = path.join(path.dirname(require.resolve('typescript/package.json')), 'lib', 'tsc.js');

    if (transformedFiles.size === 0) {
        return spawnTsc(tscJs, ['-p', tsconfig]);
    }

    let mirror = fs.mkdtempSync(path.join(root, '.esportsplus-tsc-'));

    try {
        let files: string[] = [],
            mirrorOut = path.join(mirror, '__emit');

        for (let i = 0, n = fileNames.length; i < n; i++) {
            let source = path.resolve(fileNames[i]),
                target = path.join(mirror, path.relative(root, source)),
                transformed = transformedFiles.get(normalizePath(fileNames[i]));

            fs.mkdirSync(path.dirname(target), { recursive: true });

            if (transformed === undefined) {
                fs.copyFileSync(source, target);
            }
            else {
                fs.writeFileSync(target, transformed);
            }

            files.push(normalizePath(target));
        }

        fs.writeFileSync(path.join(mirror, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { outDir: normalizePath(mirrorOut), rootDir: normalizePath(mirror) },
            extends: normalizePath(tsconfig),
            files
        }));

        let code = await spawnTsc(tscJs, ['-p', path.join(mirror, 'tsconfig.json')]);

        if (code === 0 && fs.existsSync(mirrorOut)) {
            fs.cpSync(mirrorOut, outDir, { force: true, recursive: true });
        }

        return code;
    }
    finally {
        fs.rmSync(mirror, { force: true, recursive: true });
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
                        if (isPlugin(plugin[j])) {
                            plugins.push(plugin[j]);
                        }
                        else {
                            console.error(`${PACKAGE_NAME}: plugin ${config.transform}[${j}] uses an invalid plugin format`);
                        }
                    }

                    return;
                }

                if (!isPlugin(plugin)) {
                    console.error(`${PACKAGE_NAME}: plugin ${config.transform} uses an invalid plugin format, expected { transform: Function } or Plugin[]`);
                    return;
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

    let config: { compilerOptions?: { plugins?: unknown[] } };

    try {
        config = JSON.parse(stripJsonc(fs.readFileSync(tsconfig, 'utf8')));
    }
    catch {
        return passthrough();
    }

    let pluginConfigs = (config?.compilerOptions?.plugins?.filter(
            (p: unknown): p is PluginConfig => typeof p === 'object' && p !== null && 'transform' in p
        ) ?? []) as PluginConfig[];

    if (pluginConfigs.length === 0) {
        return passthrough();
    }

    console.log(`${PACKAGE_NAME}: found ${pluginConfigs.length} transformer plugin(s), using coordinated build...`);

    build(tsconfig, pluginConfigs).catch((err) => {
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

function teardown(snapshot: Snapshot, api: API, root: string): void {
    if (!snapshot.isDisposed()) {
        snapshot.dispose();
    }

    api.close();
    languageService.dispose(root);
}


if (process.env.VITEST === undefined) {
    main();
}


export { build, isPlugin, loadPlugins, normalizePath, runTscAlias };
