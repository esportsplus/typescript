import type { SourceFile } from 'typescript/ast';
import { type FileSystemCallbacks, serverFS } from 'typescript/fs';
import { API, type Checker, DiagnosticCategory, type Program, type Project, type Snapshot } from 'typescript/async';
import { PACKAGE_NAME } from '../constants';

import checker from './checker';
import shared from '../shared';
import fs from 'fs';
import path from 'path';


// Disk text of a file the program read, valid while the file's mtime and size are unchanged
type Disk = {
    mtimeMs: number;
    size: number;
    text: string;
};

type Entry = {
    configFileName: string;
    contents: Overlay;
    current: Generation;
    disk: Map<string, Disk>;
    // Settles once the update or membership check before it has; each waits for the last
    lock: Promise<void>;
    // The config's file list as of the last membership miss; null until needed, or after invalidate()
    // of a file the list may not cover (one it lacks, or a config)
    members: Set<string> | null;
    // Files proven not to belong to the project; cleared by invalidate() when the file changes
    outside: Set<string>;
    pending: Set<string>;
    root: string;
    seen: Set<string>;
    // Whether the overlay has held a file absent from disk, so existence checks must consult it
    virtual: boolean;
};

// A program snapshot and the transforms reading it: one replaced while transforms still read it is
// disposed once the last of them releases it
type Generation = {
    project: Project;
    readers: number;
    retired: boolean;
    server: Server;
    snapshot: Snapshot;
};

// A program snapshot leased to a transform, until it calls release()
type Lease = {
    checker: Checker;
    program: Program;
    release: () => void;
};

type ScratchEntry = {
    config: string;
    contents: Overlay;
    count: number;
    file: string;
    project: Project;
    server: Server;
    snapshot: Snapshot;
};

// Valid until the next scratch()
type ScratchResult = {
    checker: Checker;
    program: Program;
    sourceFile: SourceFile;
};

// A tsgo API process, closed once retired and none of its snapshots is still read
type Server = {
    api: API;
    live: number;
    retired: boolean;
};


const backslashes = /\\/g;

const CONFIG_REGEX = /\.json$/;


let entries = new Map<string, Entry>(),
    opening = new Map<string, Promise<Entry>>(),
    parser: Server | null = null,
    scratchEntry: ScratchEntry | null = null,
    scratchLock: Promise<void> = Promise.resolve(),
    // Per project: texts staged by stage(), applied by the next update
    staged = new Map<string, Map<string, string>>();


// The overlay's files indexed by directory as they are set and deleted: tsgo asks for a directory's
// entries on every module resolution, which would otherwise scan every overlay key
class Overlay extends Map<string, string> {
    directories = new Map<string, Set<string>>();

    delete(id: string): boolean {
        let at = id.lastIndexOf('/');

        this.directories.get(id.slice(0, at))?.delete(id.slice(at + 1));

        return super.delete(id);
    }

    set(id: string, content: string): this {
        let at = id.lastIndexOf('/'),
            directory = id.slice(0, at),
            names = this.directories.get(directory);

        if (!names) {
            names = new Set();
            this.directories.set(directory, names);
        }

        names.add(id.slice(at + 1));

        return super.set(id, content);
    }
}


function absent(entry: Entry, id: string): boolean {
    return !entry.virtual && !fs.existsSync(id);
}

function acquire(generation: Generation): Lease {
    let released = false;

    generation.readers++;

    return {
        checker: generation.project.checker,
        program: generation.project.program,
        release: () => {
            if (released) {
                return;
            }

            released = true;
            generation.readers--;

            if (generation.retired && generation.readers === 0) {
                void drop(generation);
            }
        }
    };
}

async function advance(entry: Entry, changed: string[]): Promise<void> {
    let previous = entry.current,
        snapshot = await previous.snapshot.update({ fileNotifications: { changed }, openProjects: [entry.configFileName] });

    if (snapshot === previous.snapshot) {
        return;
    }

    previous.server.api.clearSourceFileCache();
    entry.current = generation(previous.server, snapshot, entry.configFileName);
    retire(previous);
}

async function advanceScratch(id: string, content: string): Promise<ScratchEntry> {
    if (!scratchEntry) {
        return scratchEntry = await createScratch(id, content);
    }

    let entry = scratchEntry;

    entry.contents.set(id, content);

    if (entry.file === id) {
        await replaceScratch(entry, entry.config, { fileNotifications: { changed: [id] }, openProjects: [entry.config] });
    }
    else {
        let config = scratchConfigPath(entry.count++),
            previous = entry.config;

        // A tsgo project's file set is fixed when the project opens, so each new scratch file gets
        // a project of its own, opened in the live API process (~1ms) rather than by respawning it
        // (~55ms); the previous project is closed in the same snapshot update
        entry.contents.delete(entry.file);
        entry.contents.set(config, scratchConfig(id));
        await replaceScratch(entry, config, { closeProjects: [previous], fileNotifications: { changed: [id] }, openProjects: [config] });
        entry.contents.delete(previous);
        entry.config = config;
        entry.file = id;
    }

    return entry;
}

async function close(server: Server): Promise<void> {
    try {
        await server.api.close();
    }
    catch {
        // the process is gone either way
    }
}

async function createEntry(configFileName: string): Promise<Entry> {
    let contents = new Overlay(),
        root = path.dirname(configFileName),
        current = await launch(root, configFileName, overlayFileSystem(contents, false));

    for (let diagnostic of await current.project.program.getConfigFileParsingDiagnostics()) {
        if (diagnostic.category === DiagnosticCategory.Error) {
            current.server.retired = true;
            retire(current);

            throw new Error(`${PACKAGE_NAME}: error parsing tsconfig.json ${diagnostic.text}`);
        }
    }

    return {
        configFileName,
        contents,
        current,
        disk: new Map(),
        lock: Promise.resolve(),
        members: null,
        outside: new Set(),
        pending: new Set(),
        root,
        seen: await seed(current.project.program),
        virtual: false
    };
}

async function createScratch(file: string, content: string): Promise<ScratchEntry> {
    let config = scratchConfigPath(0),
        contents = new Overlay();

    contents.set(config, scratchConfig(file));
    contents.set(file, content);

    let server: Server = { api: new API({ cwd: process.cwd(), fs: overlayFileSystem(contents, true) }), live: 0, retired: false },
        snapshot = await server.api.createSnapshot({ openProjects: [config] });

    return { config, contents, count: 1, file, project: project(server, snapshot, config), server, snapshot };
}

// The text the program holds for a file it has seen: the overlay when one was synced, the disk
// otherwise (invalidate() queues a re-read when the disk changes under an open program)
function current(entry: Entry, id: string): string | undefined {
    let content = entry.contents.get(id);

    if (content !== undefined) {
        return content;
    }

    try {
        let stat = fs.statSync(id),
            known = entry.disk.get(id);

        if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
            return known.text;
        }

        let text = fs.readFileSync(id, 'utf8');

        entry.disk.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, text });

        return text;
    }
    catch {
        return undefined;
    }
}

async function drop(generation: Generation): Promise<void> {
    let server = generation.server;

    try {
        await generation.snapshot.dispose();
    }
    catch {
        // a snapshot of a closed process is gone already
    }

    server.live--;

    if (server.retired && server.live === 0) {
        await close(server);
    }
}

// Runs `task` once every update and membership check queued before it has settled
function exclusive<T>(entry: Entry, task: () => Promise<T>): Promise<T> {
    let result = entry.lock.then(task);

    entry.lock = result.then(() => undefined, () => undefined);

    return result;
}

function generation(server: Server, snapshot: Snapshot, configFileName: string): Generation {
    let found = project(server, snapshot, configFileName);

    server.live++;

    return { project: found, readers: 0, retired: false, server, snapshot };
}

function getEntry(configFileName: string): Promise<Entry> {
    // Every caller must address the same project, including relative and Windows paths.
    configFileName = normalize(path.resolve(configFileName));

    let entry = entries.get(configFileName);

    if (entry) {
        return Promise.resolve(entry);
    }

    let pending = opening.get(configFileName);

    if (!pending) {
        pending = createEntry(configFileName)
            .then((created) => {
                entries.set(configFileName, created);

                return created;
            })
            .finally(() => {
                opening.delete(configFileName);
            });

        opening.set(configFileName, pending);
    }

    return pending;
}

// Path identity for membership checks: Windows file systems are case-insensitive, and hosts
// (Vite ids, tsconfig file lists) do not agree on drive-letter casing
function key(fileName: string): string {
    let id = normalize(fileName);

    return process.platform === 'win32' ? id.toLowerCase() : id;
}

async function launch(root: string, configFileName: string, overlay: FileSystemCallbacks): Promise<Generation> {
    let server: Server = { api: new API({ cwd: root, fs: overlay }), live: 0, retired: false };

    try {
        return generation(server, await server.api.createSnapshot({ openProjects: [configFileName] }), configFileName);
    }
    catch (error) {
        await close(server);

        throw error;
    }
}

function normalize(fileName: string): string {
    return fileName.replace(backslashes, '/');
}

// Every callback is a round-trip from tsgo, and a program whose imports change re-resolves every
// module, asking whether each candidate path exists. While every overlay file is also on disk the
// disk gives the same answers, so existence checks are only routed here once one is not.
function overlayFileSystem(contents: Overlay, virtual: boolean): FileSystemCallbacks {
    let overlay: FileSystemCallbacks = {
        directoryExists: serverFS.useOS,
        fileExists: serverFS.useOS,
        getAccessibleEntries: (directoryName) => {
            let directory = normalize(directoryName),
                extra = contents.directories.get(directory);

            if (!extra || extra.size === 0) {
                return serverFS.useOS;
            }

            let directories: string[] = [],
                files: string[] = [];

            try {
                for (let entry of fs.readdirSync(directory, { withFileTypes: true })) {
                    (entry.isDirectory() ? directories : files).push(entry.name);
                }
            }
            catch {
                // directory is served entirely from the overlay when it is absent on disk
            }

            return { directories, files: [...new Set([...files, ...extra])], symlinks: undefined };
        },
        readFile: (fileName) => {
            let content = contents.get(normalize(fileName));

            if (content !== undefined) {
                return content;
            }

            return serverFS.useOS;
        },
        realpath: serverFS.useOS,
        removeFile: serverFS.useOS,
        stat: serverFS.useOS,
        writeFile: serverFS.useOS
    };

    if (virtual) {
        overlay.fileExists = (fileName) => {
            if (contents.has(normalize(fileName))) {
                return true;
            }

            return serverFS.useOS;
        };
    }

    return overlay;
}

function project(server: Server, snapshot: Snapshot, configFileName: string): Project {
    let found = snapshot.getConfiguredProject(configFileName);

    if (!found) {
        throw new Error(`${PACKAGE_NAME}: project not found for ${configFileName}`);
    }

    return checker.attach(server.api, found);
}

// tsgo fixes each project's file-set when its API process opens; incremental created/changed events
// and project close+reopen do NOT admit a file unseen at that point, so a first-sight file enters
// the program only through a new API process. The previous one closes once nothing reads it.
async function recreate(entry: Entry): Promise<void> {
    let previous = entry.current;

    entry.current = await launch(entry.root, entry.configFileName, overlayFileSystem(entry.contents, entry.virtual));
    previous.server.retired = true;
    retire(previous);
    entry.seen = await seed(entry.current.project.program);
}

async function replaceScratch(entry: ScratchEntry, config: string, params: Parameters<Snapshot['update']>[0]): Promise<void> {
    let snapshot = await entry.snapshot.update(params);

    if (snapshot !== entry.snapshot && !entry.snapshot.isDisposed()) {
        void entry.snapshot.dispose().catch(() => undefined);
    }

    entry.server.api.clearSourceFileCache();
    entry.project = project(entry.server, snapshot, config);
    entry.snapshot = snapshot;
}

function retire(generation: Generation): void {
    generation.retired = true;

    if (generation.readers === 0) {
        void drop(generation);
    }
}

function scratchConfig(file: string): string {
    return JSON.stringify({
        compilerOptions: {
            allowJs: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            skipLibCheck: true,
            target: 'es2024'
        },
        files: [file]
    });
}

function scratchConfigPath(ordinal: number): string {
    return normalize(process.cwd()) + `/tsconfig.tsparse.${ordinal}.json`;
}

async function seed(program: Program): Promise<Set<string>> {
    let seen = new Set<string>();

    for (let name of await program.getSourceFileNames()) {
        seen.add(normalize(name));
    }

    return seen;
}


// Whether a file belongs to the project, so a host can skip files the program can never load
// (linked or workspace dependencies resolve outside node_modules) instead of recreating the
// API to admit them. A file the program has not seen may be new since it opened: one a later
// snapshot reached through an import belongs, otherwise the config's current file list decides;
// negative answers are cached until invalidate().
// `content` stands in for a file absent from disk (a host's virtual module) while the config's
// include globs are expanded, so such a file matches exactly as it would on disk.
const contains = async (configFileName: string, fileName: string, content?: string): Promise<boolean> => {
    let entry = await getEntry(configFileName),
        id = key(fileName),
        path = normalize(fileName);

    if (entry.seen.has(path) || entry.members?.has(id)) {
        return true;
    }

    return exclusive(entry, async () => {
        if (entry.seen.has(path) || entry.members?.has(id)) {
            return true;
        }

        if (await entry.current.project.program.getSourceFile(path)) {
            entry.outside.delete(id);
            entry.seen.add(path);
            return true;
        }

        if (entry.outside.has(id)) {
            return false;
        }

        let staged = content !== undefined && !entry.contents.has(path) && !fs.existsSync(path);

        if (staged) {
            entry.contents.set(path, content!);
        }

        let members = new Set<string>(),
            { fileNames } = await entry.current.server.api.parseConfigFile(entry.configFileName);

        for (let i = 0, n = fileNames.length; i < n; i++) {
            members.add(key(fileNames[i]));
        }

        entry.members = members;

        if (members.has(id)) {
            // Include globs list the overlay without asking whether files exist; an import of this
            // file resolves only once existence checks are routed to the overlay
            if (staged) {
                entry.virtual = true;
            }

            return true;
        }

        if (staged) {
            entry.contents.delete(path);
        }

        entry.outside.add(id);

        return false;
    });
};

// Closes a project's tsgo process (without `root`: every process the service started, the parse
// and scratch clients included) once no transform reads its snapshots and no parse is in flight
const dispose = async (root?: string): Promise<void> => {
    let configs: string[];

    if (root === undefined) {
        configs = [...new Set([...entries.keys(), ...opening.keys()])];

        if (parser) {
            let server = parser;

            parser = null;
            server.retired = true;

            if (server.live === 0) {
                await close(server);
            }
        }

        if (scratchEntry) {
            let { server } = scratchEntry;

            scratchEntry = null;
            await close(server);
        }

        staged.clear();
    }
    else {
        root = normalize(path.resolve(root));
        configs = [root];
        staged.delete(root);
    }

    await Promise.all(configs.map(async (config) => {
        let entry = entries.get(config) ?? await opening.get(config)?.catch(() => undefined);

        entries.delete(config);

        if (!entry) {
            return;
        }

        entry.current.server.retired = true;

        if (entry.current.readers === 0) {
            entry.current.retired = true;
            await drop(entry.current);
        }
        else {
            retire(entry.current);
        }
    }));
};

const findConfig = (startDir: string): string | null => {
    let current = path.resolve(startDir);

    while (true) {
        let candidate = path.join(current, 'tsconfig.json');

        if (fs.existsSync(candidate)) {
            return normalize(candidate);
        }

        let parent = path.dirname(current);

        if (parent === current) {
            return null;
        }

        current = parent;
    }
};

const invalidate = (configFileName: string, fileName: string): void => {
    configFileName = normalize(path.resolve(configFileName));

    let entry = entries.get(configFileName),
        id = normalize(fileName);

    staged.get(configFileName)?.delete(id);

    if (!entry) {
        return;
    }

    entry.contents.delete(id);
    entry.disk.delete(id);

    // Editing a file the list already holds cannot change what the include globs match
    if (CONFIG_REGEX.test(id) || !entry.members?.has(key(fileName))) {
        entry.members = null;
    }

    entry.outside.delete(key(fileName));
    entry.pending.add(id);
};

// Parses without a project: tsgo returns the tree whole and it is decoded client-side, so the lease
// keeping it alive in tsgo is released at once, sent with the next request
const parse = async (fileName: string, content: string): Promise<SourceFile> => {
    let server = parser ??= { api: new API({ cwd: process.cwd() }), live: 0, retired: false };

    server.live++;

    try {
        let lease = await server.api.createSourceFile(normalize(fileName), content);

        void lease.dispose().catch(() => undefined);

        return lease.sourceFile;
    }
    finally {
        server.live--;

        if (server.retired && server.live === 0) {
            void close(server);
        }
    }
};

const scratch = (fileName: string, content: string): Promise<ScratchResult> => {
    let result = scratchLock.then(async () => {
        let id = normalize(fileName),
            entry = await advanceScratch(id, content),
            source = await entry.project.program.getSourceFile(id);

        if (!source) {
            throw new Error(`${PACKAGE_NAME}: failed to parse ${fileName}`);
        }

        return { checker: entry.project.checker, program: entry.project.program, sourceFile: source };
    });

    scratchLock = result.then(() => undefined, () => undefined);

    return result;
};

// Records the text a host compiled a file from without a round-trip, for a host that reused the
// file's compile: the project's next update applies it with its own changes, so every later
// compile reads the program it would have read had the file been updated
const stage = (configFileName: string, fileName: string, content: string): void => {
    configFileName = normalize(path.resolve(configFileName));

    let files = staged.get(configFileName);

    if (!files) {
        files = new Map();
        staged.set(configFileName, files);
    }

    files.set(normalize(fileName), content);
};

const update = (configFileName: string, fileName: string, content: string): Promise<Lease> => {
    return updateMany(configFileName, new Map([[fileName, content]]));
};

// The project's program with `updates` applied, leased until release(): transforms running
// concurrently share one snapshot, which a later update replaces only for the transforms after it
const updateMany = async (configFileName: string, updates: Map<string, string>): Promise<Lease> => {
    let entry = await getEntry(configFileName);

    return exclusive(entry, async () => {
        let ids: string[] = [],
            routed = entry.virtual,
            waiting = staged.get(entry.configFileName);

        if (waiting) {
            staged.delete(entry.configFileName);
            updates = new Map([...waiting, ...updates]);
        }

        for (let [fileName, content] of updates) {
            let id = normalize(fileName);

            // Every host transforms every project file; one the program already holds verbatim
            // needs no new snapshot, which keeps a build's per-file cost off the tsgo round-trip
            if (entry.seen.has(id) && !entry.pending.has(id) && current(entry, id) === content) {
                continue;
            }

            if (absent(entry, id)) {
                entry.virtual = true;
            }

            entry.contents.set(id, content);
            ids.push(id);
        }

        if (ids.length === 0 && entry.pending.size === 0) {
            return acquire(entry.current);
        }

        // A file absent from disk is only visible once existence checks are routed to the overlay
        if (routed === entry.virtual && ids.every(id => entry.seen.has(id))) {
            for (let i = 0, n = ids.length; i < n; i++) {
                entry.pending.add(ids[i]);
            }

            let changed = [...entry.pending];

            entry.pending.clear();
            await advance(entry, changed);
        }
        else {
            await recreate(entry);
            entry.pending.clear();

            for (let i = 0, n = ids.length; i < n; i++) {
                entry.seen.add(ids[i]);
            }
        }

        let program = entry.current.project.program,
            sources = await Promise.all(ids.map((id) => program.getSourceFile(id)));

        for (let i = 0, n = ids.length; i < n; i++) {
            if (!sources[i] || sources[i]!.text !== entry.contents.get(ids[i])) {
                throw new Error(`${PACKAGE_NAME}: failed to load ${ids[i]} into the program`);
            }
        }

        return acquire(entry.current);
    });
};


// Every copy of this package in the process uses the first one's service, so its tsgo processes
// and programs are opened once
let service = shared('language-service', () => ({ contains, dispose, findConfig, invalidate, parse, scratch, stage, update, updateMany }));


export default service;
export type { Lease, ScratchResult };
