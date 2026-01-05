import { spawn } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

import fs from 'fs';
import path from 'path';
import ts from 'typescript';


type ExportValue = string | { default?: string; import?: string; types?: string } | null;

type PluginConfig = {
    after?: boolean;
    afterDeclarations?: boolean;
    transform: string;
};

type TransformerCreator = (program: ts.Program) => ts.TransformerFactory<ts.SourceFile>;


const BACKSLASH_REGEX = /\\/g;


let require = createRequire(import.meta.url),
    skipFlags = ['--help', '--init', '--noEmit', '--showConfig', '--version', '-h', '-noEmit', '-v'];


async function build(tsconfig: string, plugins: PluginConfig[]): Promise<void> {
    let { config, error } = ts.readConfigFile(tsconfig, ts.sys.readFile),
        root = path.dirname(path.resolve(tsconfig));

    if (error) {
        console.error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
        process.exit(1);
    }

    let parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);

    if (parsed.errors.length > 0) {
        for (let i = 0, n = parsed.errors.length; i < n; i++) {
            console.error(ts.flattenDiagnosticMessageText(parsed.errors[i].messageText, '\n'));
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
                transformedFiles.set(fileName, printer.printFile(transformed));
            }

            result.dispose();
        }

        if (transformedFiles.size > 0) {
            let customHost = ts.createCompilerHost(parsed.options),
                originalGetSourceFile = customHost.getSourceFile.bind(customHost),
                originalReadFile = customHost.readFile.bind(customHost);

            customHost.readFile = (fileName: string): string | undefined => {
                let transformed = transformedFiles.get(
                        path.resolve(fileName).replace(BACKSLASH_REGEX, '/')
                    );

                if (transformed) {
                    return transformed;
                }

                return originalReadFile(fileName);
            };

            customHost.getSourceFile = (
                fileName: string,
                languageVersion: ts.ScriptTarget,
                onError?: (message: string) => void,
                shouldCreateNewSourceFile?: boolean
            ): ts.SourceFile | undefined => {
                let transformed = transformedFiles.get(
                        path.resolve(fileName).replace(BACKSLASH_REGEX, '/')
                    );

                if (transformed) {
                    return ts.createSourceFile(fileName, transformed, languageVersion, true);
                }

                return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
            };

            program = ts.createProgram(parsed.fileNames, parsed.options, customHost);
        }

        let diagnostics = ts.getPreEmitDiagnostics(program).concat(program.emit().diagnostics);

        if (diagnostics.length > 0) {
            console.error(
                ts.formatDiagnosticsWithColorAndContext(diagnostics, {
                    getCanonicalFileName: (fileName) => fileName,
                    getCurrentDirectory: () => root,
                    getNewLine: () => '\n'
                })
            );
        }

        if (program.emit().emitSkipped) {
            process.exit(1);
        }

        if (shouldRunTscAlias(process.argv.slice(2))) {
            return runTscAlias().then((code) => {
                if (code !== 0) {
                    process.exit(code);
                }

                process.exit(0);
            });
        }

        process.exit(0);
    });
}

function findPackageJson(moduleName: string, root: string): string | null {
    let file = path.join(
            root,
            'node_modules',
            moduleName.startsWith('@') ? moduleName.split('/').slice(0, 2).join('/') : moduleName.split('/')[0],
            'package.json'
        );

    if (fs.existsSync(file)) {
        return file;
    }

    return null;
}

function findTsconfig(args: string[]): string | undefined {
    let projectIndex = args.indexOf('-p');

    if (projectIndex === -1) {
        projectIndex = args.indexOf('--project');
    }

    if (projectIndex !== -1 && args[projectIndex + 1]) {
        return args[projectIndex + 1];
    }

    return ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
}

function getPlugins(tsconfig: string): PluginConfig[] {
    let { config, error } = ts.readConfigFile(tsconfig, ts.sys.readFile);

    if (error) {
        return [];
    }

    return config?.compilerOptions?.plugins?.filter(
        (p: unknown) => typeof p === 'object' && p !== null && 'transform' in p
    ) ?? [];
}

async function loadTransformers(plugins: PluginConfig[], root: string): Promise<{
    after: TransformerCreator[];
    afterDeclarations: TransformerCreator[];
    before: TransformerCreator[];
}> {
    let after: TransformerCreator[] = [],
        afterDeclarations: TransformerCreator[] = [],
        before: TransformerCreator[] = [],
        promises: Promise<void>[] = [];

    for (let i = 0, n = plugins.length; i < n; i++) {
        let plugin = plugins[i];

        promises.push(
            import(resolvePlugin(plugin.transform, root)).then((module) => {
                let factory = module.default ?? module.createTransformer ?? module;

                if (typeof factory !== 'function') {
                    console.error(`Plugin ${plugin.transform}: no transformer factory found`);
                    return;
                }

                if (plugin.afterDeclarations) {
                    afterDeclarations.push(factory);
                }
                else if (plugin.after) {
                    after.push(factory);
                }
                else {
                    before.push(factory);
                }
            })
        );
    }

    return Promise.all(promises).then(() => ({ after, afterDeclarations, before }));
}

function main(): void {
    let args = process.argv.slice(2),
        tsconfig = findTsconfig(args);

    if (!tsconfig) {
        passthrough();
        return;
    }

    let plugins = getPlugins(tsconfig);

    if (plugins.length === 0) {
        passthrough();
        return;
    }

    console.log(`Found ${plugins.length} transformer plugin(s), using programmatic build...`);

    build(tsconfig, plugins).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

function passthrough(): void {
    let args = process.argv.slice(2),
        child = spawn(process.execPath, [require.resolve('typescript/lib/tsc.js'), ...args], { stdio: 'inherit' });

    child.on('exit', (code) => {
        if (code === 0 && shouldRunTscAlias(args)) {
            runTscAlias().then((aliasCode) => process.exit(aliasCode ?? 0));
            return;
        }

        process.exit(code ?? 0);
    });
}

function resolveExport(exportValue: ExportValue): string | null {
    if (typeof exportValue === 'string') {
        return exportValue;
    }

    if (exportValue && typeof exportValue === 'object') {
        return exportValue.import ?? exportValue.default ?? null;
    }

    return null;
}

function resolvePlugin(modulePath: string, root: string): string {
    if (modulePath.startsWith('.')) {
        return pathToFileURL(path.resolve(root, modulePath)).href;
    }

    let packageJsonPath = findPackageJson(modulePath, root);

    if (!packageJsonPath) {
        throw new Error(`tsc: cannot find package '${modulePath}' in ${root}`);
    }

    let packageDir = path.dirname(packageJsonPath),
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')),
        parts = modulePath.split('/'),
        subpath = './' + (modulePath.startsWith('@') ? parts.slice(2) : parts.slice(1)).join('/');

    if (packageJson.exports) {
        let exportEntry = subpath === './' ? packageJson.exports['.'] : packageJson.exports[subpath];

        if (exportEntry) {
            let resolved = resolveExport(exportEntry);

            if (resolved) {
                return pathToFileURL(path.resolve(packageDir, resolved)).href;
            }
        }

        throw new Error(`tsc: package subpath '${subpath}' is not exported by '${modulePath}'`);
    }

    return pathToFileURL(path.resolve(packageDir, packageJson.main ?? 'index.js')).href;
}

function runTscAlias(): Promise<number> {
    return new Promise((resolve) => {
        let child = spawn(process.execPath, [require.resolve('tsc-alias/dist/bin/index.js'), ...process.argv.slice(2)], { stdio: 'inherit' });

        child.on('exit', (code) => resolve(code ?? 0));
    });
}

function shouldRunTscAlias(args: string[]): boolean {
    for (let i = 0, n = skipFlags.length; i < n; i++) {
        if (args.includes(skipFlags[i])) {
            return false;
        }
    }

    return true;
}


main();
