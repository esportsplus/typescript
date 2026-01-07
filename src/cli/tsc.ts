import { spawn } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

import path from 'path';
import ts from 'typescript';


type PluginConfig = {
    after?: boolean;
    transform: string;
};

type PluginContext = Map<string, unknown>;

type PluginInstance = {
    analyze?: (sourceFile: ts.SourceFile) => void;
    transform: ts.TransformerFactory<ts.SourceFile>;
};

type PluginFactory = (program: ts.Program, context: PluginContext) => PluginInstance;


const BACKSLASH_REGEX = /\\/g;


let require = createRequire(import.meta.url),
    skipFlags = new Set(['--help', '--init', '--noEmit', '--showConfig', '--version', '-h', '-noEmit', '-v']);


async function build(config: object, tsconfig: string, plugins: PluginConfig[]): Promise<void> {
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

    await loadPlugins(plugins, root).then((factories) => {
        let context: PluginContext = new Map(),
            printer = ts.createPrinter(),
            program = ts.createProgram(parsed.fileNames, parsed.options),
            transformedFiles = new Map<string, string>();

        // Create plugin instances with shared context
        let instances = factories.before.map(f => f(program, context));

        // Phase 1: Analyze - all plugins analyze all files first
        for (let i = 0, n = parsed.fileNames.length; i < n; i++) {
            let fileName = parsed.fileNames[i],
                sourceFile = program.getSourceFile(fileName);

            if (!sourceFile) {
                continue;
            }

            for (let j = 0, m = instances.length; j < m; j++) {
                instances[j].analyze?.(sourceFile);
            }
        }

        // Phase 2: Transform - all plugins transform all files
        let transformers = instances.map(i => i.transform);

        for (let i = 0, n = parsed.fileNames.length; i < n; i++) {
            let fileName = parsed.fileNames[i],
                sourceFile = program.getSourceFile(fileName);

            if (!sourceFile) {
                continue;
            }

            let result = ts.transform(sourceFile, transformers),
                transformed = result.transformed[0];

            if (transformed !== sourceFile) {
                transformedFiles.set(normalizePath(fileName), printer.printFile(transformed));
            }

            result.dispose();
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
    });
}

async function loadPlugins(plugins: PluginConfig[], root: string): Promise<{
    after: PluginFactory[];
    before: PluginFactory[];
}> {
    let after: PluginFactory[] = [],
        before: PluginFactory[] = [],
        promises: Promise<void>[] = [];

    for (let i = 0, n = plugins.length; i < n; i++) {
        let plugin = plugins[i],
            pluginPath = plugin.transform;

        if (pluginPath.startsWith('.')) {
            pluginPath = pathToFileURL(path.resolve(root, pluginPath)).href;
        }
        else {
            pluginPath = pathToFileURL(require.resolve(pluginPath, { paths: [root] })).href;
        }

        promises.push(
            import(pluginPath).then((module) => {
                let factory = module.default ?? module.createTransformer ?? module;

                if (typeof factory !== 'function') {
                    console.error(`Plugin ${plugin.transform}: no transformer factory found`);
                    return;
                }

                if (plugin.after) {
                    after.push(factory);
                }
                else {
                    before.push(factory);
                }
            })
        );
    }

    return Promise.all(promises).then(() => ({ after, before }));
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

    let plugins = config?.compilerOptions?.plugins?.filter(
            (p: unknown) => typeof p === 'object' && p !== null && 'transform' in p
        ) ?? [];

    console.log(`Found ${plugins.length} transformer plugin(s), using programmatic build...`);

    build(config, tsconfig, plugins).catch((err) => {
        console.error(err);
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
