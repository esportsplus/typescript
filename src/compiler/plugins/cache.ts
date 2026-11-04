import type { SourceMapV3 } from '../sourcemap';
import { configFiles } from '../../tsconfig';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import cache from '../../cache';
import fs from 'node:fs';
import path from 'node:path';


type Entry = {
    // Every dependency the compile tracked, with the hash of the content it read (null: absent)
    dependencies: [string, string | null][];
    input: string;
    output: Output | null;
};

type Output = {
    code: string;
    map: SourceMapV3;
};

type Pack = {
    entries: Record<string, Entry>;
    identity: string;
};

type Store = {
    changed: boolean;
    // Content hashes of the dependency files read this build
    digests: Map<string, string | null>;
    entries: Map<string, Entry>;
    file: string;
    identity: string;
    used: Set<string>;
};


let require = createRequire(import.meta.url);


function digest(content: Buffer | string): string {
    return createHash('sha1').update(content).digest('hex');
}

function hashOf(store: Store, file: string): string | null {
    let found = store.digests.get(file);

    if (found === undefined) {
        let content = cache.read(file);

        found = content === null ? null : digest(content);
        store.digests.set(file, found);
    }

    return found;
}

// A stored entry is only trusted in the shape this module writes; anything else is a miss
function valid(entry: unknown): entry is Entry {
    let value = entry as Entry | undefined;

    return typeof value === 'object' &&
        value !== null &&
        typeof value.input === 'string' &&
        Array.isArray(value.dependencies) &&
        value.dependencies.every((dependency) => Array.isArray(dependency) && typeof dependency[0] === 'string') &&
        (value.output === null || (typeof value.output === 'object' && typeof value.output.code === 'string' && typeof value.output.map === 'object'));
}


// Writes what this build used and learned, replacing the previous pack; a failed write only costs
// the next build its reuse
const flush = async (store: Store): Promise<void> => {
    if (!store.changed && store.used.size === store.entries.size) {
        return;
    }

    let entries: Record<string, Entry> = {},
        temporary = `${store.file}.${process.pid}.tmp`;

    for (let id of store.used) {
        entries[id] = store.entries.get(id)!;
    }

    try {
        await fs.promises.mkdir(path.dirname(store.file), { recursive: true });
        await fs.promises.writeFile(temporary, JSON.stringify({ entries, identity: store.identity } satisfies Pack));
        await fs.promises.rename(temporary, store.file);
    }
    catch {
        await fs.promises.rm(temporary, { force: true });
    }
};

// Everything a host's compiles depend on besides each module's text and tracked dependencies:
// the host and its plugins, the versions of this compiler and TypeScript, the installed
// dependencies (a plugin package upgrade changes the lockfile) and every config the tsconfig reads
const identity = (host: string, plugins: string[], root: string, tsconfig: string | null, version: string): string => {
    let hash = createHash('sha256'),
        lock = cache.lockfile(root);

    hash.update(`${host}\0${plugins.join('\0')}\0${version}\0`);
    hash.update(lock ? cache.read(lock) ?? '' : '');

    let files = tsconfig ? configFiles(tsconfig) : [];

    for (let i = 0, n = files.length; i < n; i++) {
        hash.update(`\0${files[i]}\0`);
        hash.update(cache.read(files[i]) ?? '');
    }

    return hash.digest('hex');
};

// The entry compiled from `input` whose every dependency still has the content it was compiled
// against, or undefined
const lookup = (store: Store, id: string, input: string): Entry | undefined => {
    let entry = store.entries.get(id);

    if (!valid(entry) || entry.input !== input) {
        return undefined;
    }

    for (let i = 0, n = entry.dependencies.length; i < n; i++) {
        let [file, hash] = entry.dependencies[i];

        if (hashOf(store, file) !== hash) {
            return undefined;
        }
    }

    store.used.add(id);

    return entry;
};

// Drops what a build knows of modules a watch rebuild recompiles and of the files they read
const forget = (store: Store, ids: string[]): void => {
    store.digests.clear();

    for (let i = 0, n = ids.length; i < n; i++) {
        store.entries.delete(ids[i]);
        store.used.delete(ids[i]);
    }
};

// A host's store under the project's node_modules cache, or null without one; an unreadable or
// foreign pack starts empty. `ESPORTSPLUS_TRANSFORM_CACHE=0` disables it.
const open = (root: string, host: string, identity: string): Store | null => {
    let directory = process.env.ESPORTSPLUS_TRANSFORM_CACHE === '0' ? null : cache.directory(root, 'transform');

    if (directory === null) {
        return null;
    }

    let entries = new Map<string, Entry>(),
        file = path.join(directory, digest(`${host}\0${path.resolve(root)}`) + '.json'),
        stored = cache.read(file);

    if (stored !== null) {
        try {
            let pack = JSON.parse(stored.toString('utf8')) as Pack;

            if (pack.identity === identity && typeof pack.entries === 'object' && pack.entries !== null) {
                for (let id in pack.entries) {
                    entries.set(id, pack.entries[id]);
                }
            }
        }
        catch {
            // an unreadable pack is replaced by the next flush
        }
    }

    return { changed: false, digests: new Map(), entries, file, identity, used: new Set() };
};

const record = (store: Store, id: string, input: string, dependencies: string[], output: Output | null): void => {
    let tracked: [string, string | null][] = [];

    for (let i = 0, n = dependencies.length; i < n; i++) {
        tracked.push([dependencies[i], hashOf(store, dependencies[i])]);
    }

    store.changed = true;
    store.entries.set(id, { dependencies: tracked, input, output });
    store.used.add(id);
};

// This compiler's build (its package.json and when it was built) and the TypeScript it runs
const version = (): string => {
    let self = fileURLToPath(import.meta.url);

    return [
        cache.read(path.join(path.dirname(self), '..', '..', '..', 'package.json'))?.toString('utf8') ?? '',
        fs.statSync(self).mtimeMs,
        (require('typescript/package.json') as { version: string }).version
    ].join('\0');
};


export default { flush, forget, identity, lookup, open, record, version };
export type { Store };
