import { spawn } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import path from 'path';
import ts from 'typescript';
import coordinator from '~/compiler/coordinator';
import type { Plugin, SharedContext } from '~/compiler/types';
import { PACKAGE_NAME } from '~/constants';


type PluginConfig = {
    after?: boolean;
    transform: string;
};


const BACKSLASH_REGEX = /\\/g;


let require = createRequire(import.meta.url),
    skipFlags = new Set(['--help', '--init', '--noEmit', '--showConfig', '--version', '-h', '-noEmit', '-v']);


async function build(config: object, tsconfig: string, pluginConfigs: PluginConfig[]): Promise<void> {
    let root = path.dirname(path.resolve(tsconfig)),
        parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);

    if (parsed.errors.length > 0) {
        for (let i = 0, n = parsed.errors.length; i < n; i++) {
            console.error(
                ts.flattenDiagnosticMessageText(parsed.errors[i].messageText, '\n')
            );
        }

        process.exit(1);
    }

    let plugins = await loadPlugins(pluginConfigs, root);

    let program = ts.createProgram(parsed.fileNames, parsed.options),
        shared: SharedContext = new Map(),
        transformedFiles = new Map<string, string>();

    for (let i = 0, n = parsed.fileNames.length; i < n; i++) {
        let fileName = parsed.fileNames[i],
            sourceFile = program.getSourceFile(fileName);

        if (!sourceFile) {
            continue;
        }

        let result = coordinator.transform(
            plugins,
            sourceFile.getFullText(),
            sourceFile,
            program,
            root,
            shared
        );

        if (result.changed) {
            transformedFiles.set(normalizePath(fileName), result.code);
        }
    }

    if (transformedFiles.size > 0) {
        let customHost = ts.createCompilerHost(parsed.options),
            originalGetSourceFile = customHost.getSourceFile.bind(customHost),
            originalReadFile = customHost.readFile.bind(customHost);

        customHost.getSourceFile = (
            fileName: string,
            languageVersion: ts.ScriptTarget,
            onError?: (message: string) => void,
            shouldCreateNewSourceFile?: boolean
        ): ts.SourceFile | undefined => {
            let transformed = transformedFiles.get(normalizePath(fileName));

            if (transformed) {
                return ts.createSourceFile(fileName, transformed, languageVersion, true);
            }

            return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
        };

        customHost.readFile = (fileName: string): string | undefined => {
            return transformedFiles.get(normalizePath(fileName)) ?? originalReadFile(fileName);
        };

        program = ts.createProgram(parsed.fileNames, parsed.options, customHost);
    }

    let { diagnostics, emitSkipped } = program.emit();

    diagnostics = ts.getPreEmitDiagnostics(program).concat(diagnostics);

    if (diagnostics.length > 0) {
        console.error(
            ts.formatDiagnosticsWithColorAndContext(diagnostics, {
                getCanonicalFileName: (fileName) => fileName,
                getCurrentDirectory: () => root,
                getNewLine: () => '\n'
            })
        );
    }

    if (emitSkipped) {
        process.exit(1);
    }

    return runTscAlias(process.argv.slice(2)).then((code) => process.exit(code));
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
    let tsconfig = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');

    if (!tsconfig) {
        return passthrough();
    }

    let { config, error } = ts.readConfigFile(tsconfig, ts.sys.readFile);

    if (error) {
        return passthrough();
    }

    let pluginConfigs = config?.compilerOptions?.plugins?.filter(
            (p: unknown) => typeof p === 'object' && p !== null && 'transform' in p
        ) ?? [];

    if (pluginConfigs.length === 0) {
        return passthrough();
    }

    console.log(`${PACKAGE_NAME}: found ${pluginConfigs.length} transformer plugin(s), using coordinated build...`);

    build(config, tsconfig, pluginConfigs).catch((err) => {
        console.error(`${PACKAGE_NAME}: ${err}`);
        process.exit(1);
    });
}

function normalizePath(fileName: string): string {
    return path.resolve(fileName).replace(BACKSLASH_REGEX, '/');
}

function passthrough(): void {
    let args = process.argv.slice(2);

    spawn(process.execPath, [require.resolve('typescript/lib/tsc.js'), ...args], { stdio: 'inherit' })
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


main();
