import type { Plugin, SharedContext } from '../types';
import type { SourceMapV3 } from '../sourcemap';
import type { ResolvedConfig } from 'vite';
import { hash } from 'node:crypto';
import { dirname } from 'node:path';

import coordinator from '../coordinator';
import languageService from '../language-service';
import sourcemap from '../sourcemap';


// A build-mode transform result, valid while the module's text (and what it relied on) is unchanged
type Cached = {
    dependencies: string[];
    hash: string;
    output: Output | null;
};

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

type Output = {
    code: string;
    map: SourceMapV3;
};

type VitePlugin = {
    buildStart: () => void;
    closeBundle: () => void;
    closeWatcher: () => void;
    configResolved: (config: unknown) => void;
    enforce: 'pre';
    handleHotUpdate: <M>(ctx: HotUpdate<M>) => M[] | undefined;
    name: string;
    renderChunk: (code: string, chunk: { fileName: string }) => null;
    transform: {
        filter: { id: { exclude: RegExp[]; include: RegExp } };
        handler: (code: string, id: string) => Output | null;
    };
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

const FILE_REGEX = /\.[cm]?[tj]sx?$/;

const NODE_MODULES_REGEX = /node_modules/;

const VIRTUAL_REGEX = /^\0/;


let contexts = new Map<string, SharedContext>();


// Case-folded on Windows: program file names and Vite ids disagree on drive-letter casing
function key(fileName: string): string {
    let id = normalize(fileName);

    return process.platform === 'win32' ? id.toLowerCase() : id;
}

function normalize(fileName: string): string {
    return fileName.replace(DIRECTORY_SEPARATOR_REGEX, '/');
}


export default ({ name, onWatchChange, plugins, uncompiled = [] }: VitePluginOptions) => {
    // Shared by every instance this factory creates: a nested build (a worker bundle) gets a fresh
    // instance but transforms most of the outer build's modules again, and must not dispose the
    // language service the outer build is still using
    let active = 0,
        configs = new Set<string>(),
        results = new Map<string, Cached>(),
        roots = new Set<string>();

    const release = () => {
        for (let config of configs) {
            languageService.dispose(config);
        }

        for (let root of roots) {
            contexts.delete(root);
        }

        configs.clear();
        results.clear();
        roots.clear();
    };

    return ({ root }: { root?: string } = {}): VitePlugin => {
        // dependency file -> ids whose last compile relied on it, and the reverse
        let building = false,
            dependents = new Map<string, Set<string>>(),
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
            buildStart() {
                if (building) {
                    active++;
                }
            },
            // Rolldown closes a nested build before the outer one, so only the last to close releases
            closeBundle() {
                if (active > 0) {
                    active--;
                }

                if (active === 0) {
                    release();
                }
            },
            closeWatcher() {
                release();
            },
            configResolved(config: unknown) {
                let resolved = config as ResolvedConfig;

                building = resolved.command === 'build';
                root ??= resolved.configFile ? dirname(resolved.configFile) : resolved.root;
                tsconfig = languageService.findConfig(root);
                roots.add(root || '');

                if (tsconfig) {
                    configs.add(tsconfig);
                }
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
            transform: {
                // Rolldown applies this natively, so assets, styles, dependencies and virtual modules
                // never call into JavaScript
                filter: { id: { exclude: [NODE_MODULES_REGEX, VIRTUAL_REGEX], include: FILE_REGEX } },
                handler(code: string, id: string) {
                    // The filter again, for a host that does not apply it
                    if (!FILE_REGEX.test(id) || NODE_MODULES_REGEX.test(id) || VIRTUAL_REGEX.test(id) || !coordinator.accepts(plugins, code)) {
                        return null;
                    }

                    let digest = building ? hash('sha1', code) : '',
                        identity = key(id);

                    if (building) {
                        let found = results.get(identity);

                        if (found && found.hash === digest) {
                            track(id, found.dependencies);

                            return found.output && { ...found.output };
                        }
                    }

                    let normalizedId = normalize(id),
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
                            { checker, program },
                            shared,
                            ctx
                        ),
                        output = result.changed
                            ? { code: result.code, map: sourcemap.toSourceMapV3(result.map, result.code, code, normalizedId) }
                            : null;

                    track(id, result.dependencies);

                    if (building) {
                        results.set(identity, { dependencies: result.dependencies, hash: digest, output });
                    }

                    return output && { ...output };
                }
            },
            // Only what the change can affect is dropped: the module itself, every module compiled
            // against it, and the `shared` entries keyed by their paths
            watchChange(id: string) {
                if (!FILE_REGEX.test(id)) {
                    return;
                }

                onWatchChange?.();

                let changed = key(id),
                    ctx = contexts.get(root || ''),
                    stale = [id, ...(dependents.get(changed) ?? [])];

                for (let i = 0, n = stale.length; i < n; i++) {
                    ctx?.delete(normalize(stale[i]));
                    results.delete(key(stale[i]));
                }

                for (let [identity, entry] of results) {
                    for (let i = 0, n = entry.dependencies.length; i < n; i++) {
                        if (key(entry.dependencies[i]) === changed) {
                            results.delete(identity);
                            break;
                        }
                    }
                }

                languageService.invalidate(tsconfig ?? '', id);
            }
        };
    };
};
