import { spawn } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

import path from 'path';
import ts from 'typescript';


type PluginConfig = {
    after?: boolean;
    transform: string;
};

type TransformerCreator = (program: ts.Program) => ts.TransformerFactory<ts.SourceFile>;


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

    await loadTransformers(plugins, root).then((transformers) => {
        let printer = ts.createPrinter(),
            program = ts.createProgram(parsed.fileNames, parsed.options);

        let beforeTransformers = transformers.before.map(f => f(program)),
            transformedFiles = new Map<string, string>();

        for (let i = 0, n = parsed.fileNames.length; i < n; i++) {
            let fileName = parsed.fileNames[i],
                sourceFile = program.getSourceFile(fileName);

            if (!sourceFile) {
                continue;
            }

            let result = ts.transform(sourceFile, beforeTransformers),
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

async function loadTransformers(plugins: PluginConfig[], root: string): Promise<{
    after: TransformerCreator[];
    before: TransformerCreator[];
}> {
    let after: TransformerCreator[] = [],
        before: TransformerCreator[] = [],
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
