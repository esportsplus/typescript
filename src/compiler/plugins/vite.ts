import type { Plugin, SharedContext } from '../types';
import type { ResolvedConfig } from 'vite';
import type { SourceMapV3 } from '../sourcemap';
import type { Store } from './cache';
import { hash } from 'node:crypto';
import { dirname } from 'node:path';

import cache from './cache';
import coordinator from '../coordinator';
import languageService from '../language-service';
import sourcemap from '../sourcemap';


// A build-mode transform result, valid while the module's text (and what it relied on) is unchanged
type Cached = {
    dependencies: string[];
    hash: string;
    modules: [string, string][];
    output: Output | null;
};

// Hosts compiled as one: each file is compiled once, by `executor`, with the plugins of every member
// that would have compiled it, in plugin order, against one program
type Group = {
    // Files members before the executor left to it, by key: the hash of the code each was given and
    // the members that deferred it
    deferred: Map<string, { hash: string; hosts: Set<Host> }[]>;
    executor: Host;
    // Files the executor compiled for the members after it: the hash of the code it passed on
    handled: Map<string, string[]>;
    members: Host[];
    name: string;
};

type Host = {
    // The plugin Vite runs for this host: the host itself, or a wrapper delegating to it
    entry: object | null;
    index: number;
    name: string;
    plugins: Plugin[];
    root: string;
    tsconfig: string | null;
    // Whether a wrapper replaced the host's transform: it may do work around each compile, which
    // must then happen in its own call
    wrapped: boolean;
};

// The part of Vite's HmrContext this plugin reads, declared structurally so hosts' emitted
// declarations never have to name Vite's types; generic so it stays assignable to the real hook
type HotUpdate<M> = {
    file: string;
    modules: M[];
    server: {
        moduleGraph: {
            getModuleById?(id: string): M | undefined;
            getModulesByFile(file: string): Set<M> | undefined;
            invalidateModule(module: M, seen: Set<M>, timestamp: number, isHmr: boolean): void;
        };
    };
    timestamp: number;
};

// Declared here, not imported: hosts' emitted declarations inline it rather than name a module
// outside the package's exports
type Output = {
    code: string;
    map: SourceMapV3;
};

// The hosts of one build (one resolved config), and the groups they form once all have registered
type Registry = {
    groups: Map<Host, Group> | null;
    hosts: Host[];
    plugins: readonly { name?: string; transform?: unknown }[];
};

type VitePlugin = {
    buildEnd: () => void;
    buildStart: () => void;
    closeBundle: () => Promise<void> | undefined;
    closeWatcher: () => Promise<void>;
    configResolved: (config: unknown) => void;
    enforce: 'pre';
    handleHotUpdate: <M>(ctx: HotUpdate<M>) => M[] | undefined;
    load: {
        filter: { id: RegExp };
        handler: (id: string) => string | null;
    };
    name: string;
    renderChunk: (code: string, chunk: { fileName: string }) => null;
    resolveId: {
        filter: { id: RegExp };
        handler: (id: string) => string | null;
    };
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

const EMITTED_REGEX = /^virtual:/;

const FILE_REGEX = /\.[cm]?[tj]sx?$/;

const LOADED_REGEX = /^\0virtual:/;

const NODE_MODULES_REGEX = /node_modules/;

const VIRTUAL_REGEX = /^\0/;


// Process-wide, like the language service whose entries it releases: a nested build (a worker
// bundle) runs fresh host instances, often from a fresh factory, that transform most of the outer
// build's modules again and must not dispose what the outer build is still using
let active = 0,
    builds = new WeakMap<object, Registry>(),
    configs = new Set<string>(),
    contexts = new Map<string, SharedContext>(),
    // Virtual modules plugins emitted, by id, and the ids each compiled module (by identity) emitted
    emitted = new Map<string, string>(),
    emitters = new Map<string, string[]>(),
    results = new Map<string, Cached>(),
    roots = new Set<string>(),
    // Build results kept on disk across builds, per group name and root (null: no cache directory)
    stores = new Map<string, Store | null>();


// Records a compiled module's virtual modules, replacing the ones its previous compile emitted
function emit(identity: string, modules: Iterable<[string, string]>): void {
    retract(identity);

    let ids: string[] = [];

    for (let [id, code] of modules) {
        if (!EMITTED_REGEX.test(id)) {
            throw new Error(`${identity.split('\0')[0]}: emitted virtual module '${id}' must have an id starting with 'virtual:'`);
        }

        emitted.set(id, code);
        ids.push(id);
    }

    emitters.set(identity, ids);
}

// Whether a foreign plugin transforms modules between two hosts, so the second is given code the
// first did not produce and the two must compile separately
function interposed(registry: Registry, from: number, to: number, entries: Set<object | null>): boolean {
    for (let i = from + 1; i < to; i++) {
        let plugin = registry.plugins[i];

        if (!entries.has(plugin) && plugin.transform) {
            return true;
        }
    }

    return false;
}

// Case-folded on Windows: program file names and Vite ids disagree on drive-letter casing
function key(fileName: string): string {
    let id = normalize(fileName);

    return process.platform === 'win32' ? id.toLowerCase() : id;
}

function normalize(fileName: string): string {
    return fileName.replace(DIRECTORY_SEPARATOR_REGEX, '/');
}

// The shared context as plugins see it, reporting any use: a compile that read or wrote it depends
// on other modules' compiles, which no file hash captures, so its result is not kept across builds
function observe(shared: SharedContext, used: () => void): SharedContext {
    return new Proxy(shared, {
        get(target, property) {
            let value = Reflect.get(target, property, target);

            used();

            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
}

// Runs of adjacent hosts of one project with no foreign transform between them. A wrapped host ends
// its run and compiles for it, so its wrapper's work wraps the compile; otherwise the first does.
function partition(registry: Registry): Map<Host, Group> {
    let entries = new Set(registry.hosts.map((host) => host.entry)),
        groups = new Map<Host, Group>(),
        hosts = [...registry.hosts].sort((a, b) => a.index - b.index),
        run: Host[] = [];

    let close = () => {
        if (run.length === 0) {
            return;
        }

        let last = run[run.length - 1],
            group: Group = {
                deferred: new Map(),
                executor: last.wrapped ? last : run[0],
                handled: new Map(),
                members: run,
                name: run.map((host) => host.name).join('+')
            };

        for (let i = 0, n = run.length; i < n; i++) {
            groups.set(run[i], group);
        }

        run = [];
    };

    for (let i = 0, n = hosts.length; i < n; i++) {
        let host = hosts[i],
            previous = run[run.length - 1];

        if (
            previous &&
            (previous.wrapped || previous.root !== host.root || previous.tsconfig !== host.tsconfig || interposed(registry, previous.index, host.index, entries))
        ) {
            close();
        }

        run.push(host);
    }

    close();

    return groups;
}

// Writes are left to finish after the build's state is released
function release(): Promise<void> {
    for (let config of configs) {
        languageService.dispose(config);
    }

    for (let root of roots) {
        contexts.delete(root);
    }

    let writes: Promise<void>[] = [];

    for (let store of stores.values()) {
        if (store) {
            writes.push(cache.flush(store));
        }
    }

    configs.clear();
    emitted.clear();
    emitters.clear();
    results.clear();
    roots.clear();
    stores.clear();

    return Promise.all(writes).then(() => undefined);
}

function retract(identity: string): void {
    let ids = emitters.get(identity);

    if (!ids) {
        return;
    }

    for (let i = 0, n = ids.length; i < n; i++) {
        emitted.delete(ids[i]);
    }

    emitters.delete(identity);
}

// Removes and returns the first queued entry matching `hash`
function take<T extends { hash: string } | string>(queue: Map<string, T[]>, file: string, digest: string): T | undefined {
    let entries = queue.get(file);

    if (!entries) {
        return undefined;
    }

    for (let i = 0, n = entries.length; i < n; i++) {
        let entry = entries[i];

        if ((typeof entry === 'string' ? entry : entry.hash) === digest) {
            entries.splice(i, 1);

            if (entries.length === 0) {
                queue.delete(file);
            }

            return entry;
        }
    }

    return undefined;
}


export default ({ name, onWatchChange, plugins, uncompiled = [] }: VitePluginOptions) => {
    return ({ root }: { root?: string } = {}): VitePlugin => {
        // dependency file -> ids whose last compile relied on it, and the reverse
        let building = false,
            dependents = new Map<string, Set<string>>(),
            registry: Registry | null = null,
            relied = new Map<string, string[]>(),
            self: Host = { entry: null, index: -1, name, plugins, root: '', tsconfig: null, wrapped: false },
            // A host Vite does not list (configured by hand) compiles alone
            alone: Group = { deferred: new Map(), executor: self, handled: new Map(), members: [self], name },
            tsconfig: string | null = null;

        let group = (): Group => {
            if (!registry) {
                return alone;
            }

            registry.groups ??= partition(registry);

            return registry.groups.get(self) ?? alone;
        };

        // The group's kept results, opened by its first compile of a build; null without a cache
        let persisted = (members: Group, configPath: string | null): Store | null => {
            let address = `${members.name}\0${root || ''}`,
                store = stores.get(address);

            if (store === undefined) {
                let directory = root || process.cwd(),
                    names: string[] = [];

                for (let i = 0, n = members.members.length; i < n; i++) {
                    let host = members.members[i];

                    for (let j = 0, m = host.plugins.length; j < m; j++) {
                        names.push(`${host.name}:${host.plugins[j].name ?? ''}`);
                    }
                }

                store = cache.open(directory, members.name, cache.identity(members.name, names, directory, configPath, cache.version()));
                stores.set(address, store);
            }

            return store;
        };

        let track = (id: string, dependencies: string[]) => {
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

        // Compiles `id` with the plugins of `included` (this host and those whose compile it runs)
        let compile = (code: string, id: string, included: Host[], digest: string, members: Group): Output | null => {
            let applied: Plugin[] = [],
                names: string[] = [];

            for (let i = 0, n = included.length; i < n; i++) {
                applied.push(...included[i].plugins);
                names.push(included[i].name);
            }

            if (!coordinator.accepts(applied, code)) {
                return null;
            }

            // Hosts compiling alike share results, whichever factory created them
            let identity = `${names.join('+')}\0${root || ''}\0${key(id)}`;

            if (building) {
                let found = results.get(identity);

                if (found && found.hash === digest) {
                    emit(identity, found.modules);
                    track(id, found.dependencies);

                    return found.output && { ...found.output };
                }
            }

            let normalizedId = normalize(id),
                configPath = tsconfig ?? languageService.findConfig(root || ''),
                store = building ? persisted(members, configPath) : null,
                entry = `${names.join('+')}\0${key(id)}`,
                kept = store && cache.lookup(store, entry, digest);

            // A compile kept from an earlier build whose text and dependencies are unchanged
            if (kept) {
                let dependencies = kept.dependencies.map(([file]) => file);

                languageService.stage(configPath ?? '', normalizedId, code);
                emit(identity, kept.modules);
                results.set(identity, { dependencies, hash: digest, modules: kept.modules, output: kept.output });
                track(id, dependencies);

                return kept.output && { ...kept.output };
            }

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

            let isolated = true;

            // Errors propagate: a file a plugin cannot compile must fail the build, never ship as-is
            let result = coordinator.transform(
                    applied,
                    code,
                    sourceFile,
                    { checker, program },
                    shared,
                    store ? observe(ctx, () => { isolated = false; }) : ctx
                ),
                modules = [...result.modules],
                output: Output | null = result.changed
                    ? { code: result.code, map: sourcemap.toSourceMapV3(result.map, result.code, code, normalizedId) }
                    : null;

            emit(identity, modules);
            track(id, result.dependencies);

            if (building) {
                results.set(identity, { dependencies: result.dependencies, hash: digest, modules, output });
            }

            if (store && isolated) {
                cache.record(store, entry, digest, result.dependencies, output, result.modules);
            }

            return output && { ...output };
        };

        let transform: VitePlugin['transform'] = {
            // Rolldown applies this natively, so assets, styles, dependencies and virtual modules
            // never call into JavaScript
            filter: { id: { exclude: [NODE_MODULES_REGEX, VIRTUAL_REGEX], include: FILE_REGEX } },
            handler(code: string, id: string) {
                // The filter again, for a host that does not apply it
                if (!FILE_REGEX.test(id) || NODE_MODULES_REGEX.test(id) || VIRTUAL_REGEX.test(id)) {
                    return null;
                }

                let members = group(),
                    digest = hash('sha1', code),
                    file = key(id),
                    { executor } = members;

                if (executor !== self) {
                    let position = members.members.indexOf(self);

                    // Left to the executor later in plugin order, which is given this same code
                    if (position < members.members.indexOf(executor)) {
                        if (coordinator.accepts(plugins, code)) {
                            let queue = members.deferred.get(file) ?? [],
                                waiting = queue.find((entry) => entry.hash === digest && !entry.hosts.has(self));

                            if (waiting) {
                                waiting.hosts.add(self);
                            }
                            else {
                                queue.push({ hash: digest, hosts: new Set([self]) });
                                members.deferred.set(file, queue);
                            }
                        }

                        return null;
                    }

                    // Compiled by the executor before this host, which is given its output
                    if (take(members.handled, file, digest) !== undefined) {
                        return null;
                    }

                    return compile(code, id, [self], digest, alone);
                }

                let at = members.members.indexOf(self),
                    before = take(members.deferred, file, digest),
                    included = members.members.filter((host, i) => i >= at || before?.hosts.has(host)),
                    output = compile(code, id, included, digest, members);

                if (at < members.members.length - 1) {
                    let queue = members.handled.get(file) ?? [];

                    queue.push(hash('sha1', output?.code ?? code));
                    members.handled.set(file, queue);
                }

                return output;
            }
        };

        return {
            // A host before a wrapped executor returns nothing for the files it leaves to it; one the
            // executor never compiled would ship uncompiled, so the build fails instead
            buildEnd() {
                let members = group();

                if (members.executor !== self || members.deferred.size === 0) {
                    return;
                }

                let files = [...members.deferred.keys()];

                members.deferred.clear();

                throw new Error(
                    `${name}: ${files.length} file(s) left by ${members.members.filter((host) => host !== self).map((host) => host.name).join(', ')} ` +
                    `to this host's compile were never compiled by it (its wrapper skipped them), e.g. ${files[0]}`
                );
            },
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

                return active === 0 ? release() : undefined;
            },
            closeWatcher() {
                return release();
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

                let listed = (resolved.plugins ?? []) as Registry['plugins'];

                if (listed.length === 0) {
                    return;
                }

                registry = builds.get(resolved) ?? null;

                if (!registry) {
                    registry = { groups: null, hosts: [], plugins: listed };
                    builds.set(resolved, registry);
                }

                let claimed = new Set(registry.hosts.map((host) => host.entry)),
                    index = listed.findIndex((plugin) => plugin.name === `${name}/compiler/vite` && !claimed.has(plugin));

                if (index === -1) {
                    registry = null;
                    return;
                }

                self.entry = listed[index];
                self.index = index;
                self.root = root || '';
                self.tsconfig = tsconfig;
                self.wrapped = listed[index].transform !== transform;
                registry.groups = null;
                registry.hosts.push(self);
            },
            enforce: 'pre',
            // A module's compile can depend on declarations in other modules (a reactive binding it
            // reads, a barrel it imports a compiled API through); Vite only re-transforms the file
            // that changed, so every module compiled against it is invalidated alongside, with the
            // virtual modules it emitted
            handleHotUpdate<M>({ file, modules, server, timestamp }: HotUpdate<M>) {
                let ids = dependents.get(key(file)),
                    result = [...modules],
                    seen = new Set(modules),
                    suffix = `\0${root || ''}\0${key(file)}`;

                for (let [identity, emittedIds] of emitters) {
                    if (!identity.endsWith(suffix)) {
                        continue;
                    }

                    for (let i = 0, n = emittedIds.length; i < n; i++) {
                        let module = server.moduleGraph.getModuleById?.(`\0${emittedIds[i]}`);

                        if (module && !seen.has(module)) {
                            seen.add(module);
                            server.moduleGraph.invalidateModule(module, new Set(), timestamp, true);
                            result.push(module);
                        }
                    }
                }

                for (let id of ids ?? []) {
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

                return result.length > modules.length ? result : undefined;
            },
            load: {
                filter: { id: LOADED_REGEX },
                handler(id: string) {
                    return emitted.get(id.slice(1)) ?? null;
                }
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
            resolveId: {
                filter: { id: EMITTED_REGEX },
                handler(id: string) {
                    return emitted.has(id) ? `\0${id}` : null;
                }
            },
            transform,
            // Only what the change can affect is dropped: the module itself, every module compiled
            // against it, the virtual modules they emitted, and the `shared` entries keyed by their paths
            watchChange(id: string) {
                if (!FILE_REGEX.test(id)) {
                    return;
                }

                onWatchChange?.();

                let changed = key(id),
                    ctx = contexts.get(root || ''),
                    stale = [id, ...(dependents.get(changed) ?? [])],
                    suffixes: string[] = [];

                for (let i = 0, n = stale.length; i < n; i++) {
                    ctx?.delete(normalize(stale[i]));
                    suffixes.push(`\0${key(stale[i])}`);
                }

                let drop = (identity: string): boolean => suffixes.some((suffix) => identity.endsWith(`\0${root || ''}${suffix}`));

                for (let [identity, entry] of results) {
                    if (drop(identity) || entry.dependencies.some((dependency) => key(dependency) === changed)) {
                        results.delete(identity);
                    }
                }

                for (let identity of emitters.keys()) {
                    if (drop(identity)) {
                        for (let emittedId of emitters.get(identity)!) {
                            emitted.delete(emittedId);
                        }
                    }
                }

                for (let store of stores.values()) {
                    if (store) {
                        cache.forget(store, suffixes);
                    }
                }

                languageService.invalidate(tsconfig ?? '', id);
            }
        };
    };
};
