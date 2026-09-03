import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';
import * as NodeURL from 'node:url';

import * as ts from '~/guard/adapter';
import { stripJsonc } from '~/jsonc';

import type {
    OverlayLookup,
    OverlaySet,
} from '../kernel/types';

// Namespace-like globals whose members read as `Global.member` instead of
// `Interface#method`. The `Constructor` suffix on the declaring interface
// (e.g. NumberConstructor) is stripped before this check, so `Number.parseInt`
// resolves here while `Array#map` does not.
const KNOWN_NAMESPACES = new Set([
    'JSON',
    'Math',
    'Object',
    'Reflect',
    'Number',
    'Console',
    'console',
]);

// The fallback section searched after the hint-scoped ones: runtime symbols
// (`URL`, `fetch`, `structuredClone`, timers, `AbortController`, …) that exist
// in both the DOM and Node hosts. A Node program declares these via @types/node
// `declare global`, so the hint is `node` and no `lib.dom` section ever matches
// them; searching `global` last closes that gap regardless of hint kind.
const GLOBAL_SECTION = 'global';

// A section's symbol->entry table, and a channel's section tables.
type SectionTable = Map<string, unknown>;
type ChannelTable = Map<string, SectionTable>;
type OverlayFile = { name: string; root: Record<string, unknown> };

type MergedOverlay  = {
    // channel -> section -> overlayKey -> raw entry
    readonly channels: ReadonlyMap<string, ChannelTable>;
    entry(channel: string, section: string, key: string): unknown;
};

function parseJsonc(name: string, text: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripJsonc(text));
    } catch (error) {
        throw new Error(
            `analyze overlay: invalid JSONC in ${name}: ${(error as Error).message}`,
            {
                cause: error,
            },
        );
    }
    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new Error(`analyze overlay: ${name} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
}
// Merge (pure — no checker; directly testable)

function isSectionMap(
    value: unknown,
): value is Record<string, Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeSections(
    into: ChannelTable,
    sections: Record<string, unknown>,
): void {
    for (const [section, keys] of Object.entries(sections)) {
        if (!isSectionMap(keys)) {
            continue;
        }
        let table = into.get(section);
        if (!table) {
            table = new Map();
            into.set(section, table);
        }
        for (const [key, entry] of Object.entries(keys)) {
            table.set(key, entry); // later file wins
        }
    }
}

// Merge overlay files in precedence order (later wins). A file is either a
// bundle (has `overlay`) or a bare exceptions section map.
function mergeOverlayData(
    files: ReadonlyArray<{ name: string; text: string }>,
): MergedOverlay {
    return mergeParsedOverlayData(
        files.map((file) => ({
            name: file.name,
            root: parseJsonc(file.name, file.text),
        })),
    );
}

function mergeParsedOverlayData(files: ReadonlyArray<OverlayFile>): MergedOverlay {
    const channels = new Map<string, ChannelTable>();

    const channelFor = (channel: string): ChannelTable => {
        let table = channels.get(channel);
        if (!table) {
            table = new Map();
            channels.set(channel, table);
        }
        return table;
    };

    for (const file of files) {
        const root = file.root;
        if ('overlay' in root) {
            const overlay = root['overlay'];
            if (overlay !== undefined) {
                if (!isSectionMap(overlay)) {
                    throw new Error(
                        `analyze overlay: ${file.name} overlay must be an object`,
                    );
                }
                for (const [channel, sections] of Object.entries(overlay)) {
                    if (isSectionMap(sections)) {
                        mergeSections(channelFor(channel), sections);
                    }
                }
            }
        }
        else {
            // Bare file: top-level sections belong to the exceptions channel.
            mergeSections(channelFor('exceptions'), root);
        }
    }

    return {
        channels,
        entry(channel, section, key) {
            return channels.get(channel)?.get(section)?.get(key);
        },
    };
}
// Key format (pure — directly testable)

// Build the overlay key. Discriminator: a namespace-like parent (JSON, Math,
// Number, ...) yields `Parent.member`; any other interface parent yields
// `Interface#method`; no parent yields the bare global name.
function overlayKey(
    parentName: string | undefined,
    memberName: string,
    isNamespace: boolean,
): string {
    if (!parentName) {
        return memberName;
    }
    return isNamespace
        ? `${parentName}.${memberName}`
        : `${parentName}#${memberName}`;
}

function stripConstructor(name: string): string {
    return name.endsWith('Constructor')
        ? name.slice(0, -'Constructor'.length)
        : name;
}
// Checker -> key resolution

function declaredParentName(symbol: ts.Symbol): string | undefined {
    for (const decl of ts.symbolDeclarations(symbol)) {
        const parent = decl.parent;
        if (
            parent &&
            (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent))
        ) {
            return parent.name?.text;
        }
    }
    return undefined;
}

// Section-name convention: a lib file `lib.<x>[.<sub>].d.ts` collapses to
// `lib.<x>` (so `lib.es2015.core.d.ts` -> `lib.es2015`). A node type/module
// file `<mod>.d.ts` under @types/node (or a `node:` module) -> `node:<mod>`.
type SourceHint  = {
    kind: 'lib' | 'node' | 'other';
    section: string | undefined;
};

function sourceHint(symbol: ts.Symbol): SourceHint {
    for (const decl of ts.symbolDeclarations(symbol)) {
        const file = decl.getSourceFile().fileName;
        const base = NodePath.basename(file);
        const libMatch = /^(lib(?:\.[a-z0-9]+){1,})\.d\.ts$/.exec(base);
        if (libMatch) {
            const parts = libMatch[1]!.split('.');
            return { kind: 'lib', section: parts.slice(0, 2).join('.') };
        }
        const normalized = file.replace(/\\/g, '/');
        if (
            normalized.includes('@types/node/') ||
            normalized.includes('/node_modules/node/')
        ) {
            return {
                kind: 'node',
                section: `node:${base.replace(/\.d\.ts$/, '')}`,
            };
        }
    }
    return { kind: 'other', section: undefined };
}

function keyFor(symbol: ts.Symbol): string {
    const parent = declaredParentName(symbol);
    const stripped = parent ? stripConstructor(parent) : undefined;
    const isNamespace = stripped ? KNOWN_NAMESPACES.has(stripped) : false;
    return overlayKey(stripped, symbol.name, isNamespace);
}

function findInSections(
    channel: ChannelTable,
    key: string,
    accept: (section: string) => boolean,
    preferred: string | undefined,
): OverlayLookup | undefined {
    if (preferred) {
        const table = channel.get(preferred);
        if (table && table.has(key)) {
            return { pkg: preferred, symbol: key, entry: table.get(key) };
        }
    }
    for (const [section, table] of channel) {
        if (section === preferred || !accept(section)) {
            continue;
        }
        if (table.has(key)) {
            return { pkg: section, symbol: key, entry: table.get(key) };
        }
    }
    return undefined;
}

// The `global` section, searched after the hint-scoped sections regardless of
// hint kind.
function findInGlobal(
    channel: ChannelTable,
    key: string,
): OverlayLookup | undefined {
    const table = channel.get(GLOBAL_SECTION);
    if (table && table.has(key)) {
        return { pkg: GLOBAL_SECTION, symbol: key, entry: table.get(key) };
    }
    return undefined;
}
// Loading

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const shippedOverlayCache = new Map<string, OverlayFile>();
let mergedOverlayCache: MergedOverlay | undefined;

function readShippedOverlay(file: string): OverlayFile {
    let cached = shippedOverlayCache.get(file);
    if (!cached) {
        cached = {
            name: file,
            root: parseJsonc(file, NodeFS.readFileSync(file, 'utf8')),
        };
        shippedOverlayCache.set(file, cached);
    }
    return cached;
}

// Load the shipped, built-in platform model. There is no user overlay: models
// are internal, and `sourceHint` + the `global` fallback do all the gating.
function loadOverlays(): OverlaySet {
    if (!mergedOverlayCache) {
        mergedOverlayCache = mergeParsedOverlayData([
            readShippedOverlay(NodePath.join(HERE, 'base', 'async.jsonc')),
            readShippedOverlay(NodePath.join(HERE, 'base', 'exceptions.jsonc')),
            readShippedOverlay(NodePath.join(HERE, 'base', 'resources.jsonc')),
        ]);
    }

    const merged = mergedOverlayCache;
    const lookupCache = new Map<
        ts.Symbol,
        Map<string, OverlayLookup | undefined>
    >();

    return {
        lookup(symbol, channel) {
            let channels = lookupCache.get(symbol);

            if (channels?.has(channel)) {
                return channels.get(channel);
            }

            const table = merged.channels.get(channel);

            if (!channels) {
                channels = new Map();
                lookupCache.set(symbol, channels);
            }

            if (!table) {
                channels.set(channel, undefined);
                return undefined;
            }
            const key = keyFor(symbol);
            const hint = sourceHint(symbol);
            const accept =
                hint.kind === 'lib'
                    ? (s: string): boolean => s.startsWith('lib.')
                    : hint.kind === 'node'
                      ? (s: string): boolean => s.startsWith('node:')
                      : (s: string): boolean =>
                          s !== GLOBAL_SECTION && !s.startsWith('lib.');
            const found = findInSections(table, key, accept, hint.section);
            const result = found ?? findInGlobal(table, key);

            channels.set(channel, result);
            return result;
        },
    };
}


export { loadOverlays, mergeOverlayData, overlayKey, type MergedOverlay };
