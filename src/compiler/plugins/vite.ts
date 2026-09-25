import type { Plugin, SharedContext } from '../types';
import type { SourceMapV3 } from '../sourcemap';
import type { ResolvedConfig } from 'vite';
import { dirname } from 'node:path';

import coordinator from '../coordinator';
import languageService from '../language-service';
import sourcemap from '../sourcemap';


// The part of Vite's HmrContext this plugin reads, declared structurally so hosts' emitted
// declarations never have to name Vite's types; generic so it stays assignable to the real hook
type HotUpdate<M> = {
    file: string;
    modules: M[];
    server: {
        moduleGraph: {
            getModulesByFile(file: string): Set<M> | undefined;
            invalidateModule(module: M, seen: Set<M>, timestamp: number, isHmr: boolean): void;
        };
    };
    timestamp: number;
};

type VitePlugin = {
    closeBundle: () => void;
    closeWatcher: () => void;
    configResolved: (config: unknown) => void;
    enforce: 'pre';
    handleHotUpdate: <M>(ctx: HotUpdate<M>) => M[] | undefined;
    name: string;
    renderChunk: (code: string, chunk: { fileName: string }) => null;
    transform: (code: string, id: string) => { code: string; map: SourceMapV3 } | null;
    watchChange: (id: string) => void;
};

type VitePluginOptions = {
    name: string;
    onWatchChange?: () => void;
    plugins: Plugin[];
    // Text only a compile-only runtime stub contains (the tail of the error it throws). Compiled
    // output never calls the stub, so a bundle drops it; a chunk that still holds one means some
    // module reached the API without being compiled (e.g. a dependency shipping uncompiled code).
    uncompiled?: string[];
};


const DIRECTORY_SEPARATOR_REGEX = /\\/g;

const FILE_REGEX = /\.[tj]sx?$/;


let contexts = new Map<string, SharedContext>();


// Case-folded on Windows: program file names and Vite ids disagree on drive-letter casing
function key(fileName: string): string {
    let id = fileName.replace(DIRECTORY_SEPARATOR_REGEX, '/');

    return process.platform === 'win32' ? id.toLowerCase() : id;
}


export default ({ name, onWatchChange, plugins, uncompiled = [] }: VitePluginOptions) => {
    return ({ root }: { root?: string } = {}): VitePlugin => {
        // dependency file -> ids whose last compile relied on it, and the reverse
        let dependents = new Map<string, Set<string>>(),
            relied = new Map<string, string[]>(),
            tsconfig: string | null = null;

        const track = (id: string, dependencies: string[]) => {
            let previous = relied.get(id);

            if (previous) {
                for (let i = 0, n = previous.length; i < n; i++) {
                    dependents.get(previous[i])?.delete(id);
                }
            }

            let keys: string[] = [];

            for (let i = 0, n = dependencies.length; i < n; i++) {
                let dependency = key(dependencies[i]),
                    ids = dependents.get(dependency);

                if (!ids) {
                    ids = new Set();
                    dependents.set(dependency, ids);
                }

                ids.add(id);
                keys.push(dependency);
            }

            relied.set(id, keys);
        };

        return {
            closeBundle() {
                languageService.dispose(tsconfig ?? '');
                contexts.delete(root || '');
            },
            closeWatcher() {
                languageService.dispose(tsconfig ?? '');
                contexts.delete(root || '');
            },
            configResolved(config: unknown) {
                let resolved = config as ResolvedConfig;

                root ??= resolved.configFile ? dirname(resolved.configFile) : resolved.root;
                tsconfig = languageService.findConfig(root);
            },
            enforce: 'pre',
            // A module's compile can depend on declarations in other modules (a reactive binding it
            // reads, a barrel it imports a compiled API through); Vite only re-transforms the file
            // that changed, so every module compiled against it is invalidated alongside
            handleHotUpdate<M>({ file, modules, server, timestamp }: HotUpdate<M>) {
                let ids = dependents.get(key(file));

                if (!ids || ids.size === 0) {
                    return;
                }

                let result = [...modules],
                    seen = new Set(modules);

                for (let id of ids) {
                    let found = server.moduleGraph.getModulesByFile(id);

                    if (!found) {
                        continue;
                    }

                    for (let module of found) {
                        if (seen.has(module)) {
                            continue;
                        }

                        seen.add(module);
                        server.moduleGraph.invalidateModule(module, new Set(), timestamp, true);
                        result.push(module);
                    }
                }

                return result;
            },
            name: `${name}/compiler/vite`,
            renderChunk(code: string, chunk: { fileName: string }) {
                for (let i = 0, n = uncompiled.length; i < n; i++) {
                    if (code.includes(uncompiled[i])) {
                        throw new Error(
                            `${name}: chunk '${chunk.fileName}' contains a runtime stub that only exists uncompiled; a module in it ` +
                            'uses a compile-time API without being compiled (for example a dependency that ships uncompiled code)'
                        );
                    }
                }

                return null;
            },
            transform(code: string, id: string) {
                if (!FILE_REGEX.test(id) || id.includes('node_modules') || !coordinator.accepts(plugins, code)) {
                    return null;
                }

                let normalizedId = id.replace(DIRECTORY_SEPARATOR_REGEX, '/'),
                    configPath = tsconfig ?? languageService.findConfig(root || '');

                // Dependencies linked from outside node_modules (link:, workspaces) are not project files
                if (!languageService.contains(configPath ?? '', normalizedId, code)) {
                    return null;
                }

                let { checker, program } = languageService.update(configPath ?? '', normalizedId, code),
                    sourceFile = program.getSourceFile(normalizedId) ?? languageService.parse(normalizedId, code);

                let shared = root || '',
                    ctx = contexts.get(shared);

                if (!ctx) {
                    ctx = new Map();
                    contexts.set(shared, ctx);
                }

                // Errors propagate: a file a plugin cannot compile must fail the build, never ship as-is
                let result = coordinator.transform(
                        plugins,
                        code,
                        sourceFile,
                        { checker, configPath: configPath ?? undefined, program },
                        shared,
                        ctx
                    );

                track(id, result.dependencies);

                if (!result.changed) {
                    return null;
                }

                return { code: result.code, map: sourcemap.toSourceMapV3(result.map, result.code, code, normalizedId) };
            },
            watchChange(id: string) {
                if (FILE_REGEX.test(id)) {
                    onWatchChange?.();
                    contexts.delete(root || '');
                    languageService.invalidate(tsconfig ?? '', id);
                }
            }
        };
    };
};
