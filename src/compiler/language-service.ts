import type { SourceFile } from 'typescript/unstable/ast';
import type { FileSystem } from 'typescript/unstable/fs';
import { API, DiagnosticCategory, type Checker, type Program, type Project, type Snapshot } from 'typescript/unstable/sync';
import { PACKAGE_NAME } from '~/constants';

import fs from 'fs';
import path from 'path';


type Entry = {
    api: API;
    // Files whose program text changed since the staging peer last synced with this entry
    changes: Set<string>;
    configFileName: string;
    contents: Map<string, string>;
    // Bumped whenever the API is recreated: a staging peer opened on an older file set is stale
    generation: number;
    // The config's file list as of the last membership miss; null until needed or after invalidate()
    members: Set<string> | null;
    // Files proven not to belong to the project; cleared by invalidate() when the file changes
    outside: Set<string>;
    pending: Set<string>;
    project: Project;
    root: string;
    seen: Set<string>;
    snapshot: Snapshot;
    staging: Staging | null;
    // Whether the overlay has held a file absent from disk, so existence checks must consult it
    virtual: boolean;
};

type ScratchEntry = {
    api: API;
    config: string;
    contents: Map<string, string>;
    count: number;
    file: string;
    project: Project;
    snapshot: Snapshot;
};

type ScratchResult = {
    checker: Checker;
    program: Program;
    sourceFile: SourceFile;
};

type Session = {
    api: API;
    project: Project;
    snapshot: Snapshot;
};

// A second program over the same overlay plus one file's intermediate text, so a plugin chain can
// type-check its later stages without replacing the entry's program (and discarding its checker)
type Staging = Session & {
    contents: Map<string, string>;
    file: string | null;
    generation: number;
};

type UpdateResult = {
    checker: Checker;
    program: Program;
};

type OpenProject = {
    api: API;
    dispose: () => void;
    project: Project;
    snapshot: Snapshot;
};


const backslashes = /\\/g;


let cache = new Map<string, Entry>(),
    scratchEntry: ScratchEntry | null = null;


function absent(entry: Entry, id: string): boolean {
    return !entry.virtual && !fs.existsSync(id);
}

function advance(session: Session, configFileName: string, changed: string[]): void {
    let snapshot = session.api.updateSnapshot({ fileChanges: { changed } });

    if (!session.snapshot.isDisposed()) {
        session.snapshot.dispose();
    }

    session.api.clearSourceFileCache();
    session.project = resolveProject(snapshot, configFileName);
    session.snapshot = snapshot;
}

function advanceScratch(id: string, content: string): ScratchEntry {
    if (!scratchEntry) {
        return scratchEntry = createScratch(id, content);
    }

    let entry = scratchEntry;

    entry.contents.set(id, content);

    if (entry.file === id) {
        advance(entry, entry.config, [id]);
    }
    else {
        retargetScratch(entry, id);
    }

    return entry;
}

function createEntry(configFileName: string): Entry {
    let root = path.dirname(configFileName);

    let contents = new Map<string, string>(),
        opened = open(configFileName, overlayFileSystem(contents, false)),
        { api, project, snapshot } = opened;

    for (let diagnostic of project.program.getConfigFileParsingDiagnostics()) {
        if (diagnostic.category === DiagnosticCategory.Error) {
            snapshot.dispose();
            api.close();

            throw new Error(`${PACKAGE_NAME}: error parsing tsconfig.json ${diagnostic.text}`);
        }
    }

    return {
        api,
        changes: new Set(),
        configFileName,
        contents,
        generation: 0,
        members: null,
        outside: new Set(),
        pending: new Set(),
        project,
        root,
        seen: seed(project.program),
        snapshot,
        staging: null,
        virtual: false
    };
}

function createScratch(file: string, content: string): ScratchEntry {
    let config = scratchConfigPath(0),
        contents = new Map<string, string>();

    contents.set(config, scratchConfig(file));
    contents.set(file, content);

    let api = new API({ cwd: process.cwd(), fs: overlayFileSystem(contents, true) }),
        snapshot = api.updateSnapshot({ openProjects: [config] }),
        project = resolveProject(snapshot, config);

    return { api, config, contents, count: 1, file, project, snapshot };
}

// The text the program holds for a file it has seen: the overlay when one was synced, the disk
// otherwise (invalidate() queues a re-read when the disk changes under an open program)
function current(entry: Entry, id: string): string | undefined {
    let content = entry.contents.get(id);

    if (content !== undefined) {
        return content;
    }

    try {
        return fs.readFileSync(id, 'utf8');
    }
    catch {
        return undefined;
    }
}

function disposeEntry(entry: Pick<Entry, 'api' | 'snapshot'>): void {
    if (!entry.snapshot.isDisposed()) {
        entry.snapshot.dispose();
    }

    entry.api.close();
}

function disposeStaging(entry: Entry): void {
    if (entry.staging) {
        disposeEntry(entry.staging);
        entry.staging = null;
    }
}

function getEntry(configFileName: string): Entry {
    // Every caller must address the same project, including relative and Windows paths.
    configFileName = normalize(path.resolve(configFileName));

    let entry = cache.get(configFileName);

    if (!entry) {
        entry = createEntry(configFileName);
        cache.set(configFileName, entry);
    }

    return entry;
}

// Path identity for membership checks: Windows file systems are case-insensitive, and hosts
// (Vite ids, tsconfig file lists) do not agree on drive-letter casing
function key(fileName: string): string {
    let id = normalize(fileName);

    return process.platform === 'win32' ? id.toLowerCase() : id;
}

function normalize(fileName: string): string {
    return fileName.replace(backslashes, '/');
}

function open(configPath: string, overlay?: FileSystem): OpenProject {
    let configFileName = normalize(path.resolve(configPath)),
        entry = overlay === undefined ? getEntry(configFileName) : undefined,
        api = entry?.api ?? new API({ cwd: path.dirname(configFileName), fs: overlay }),
        snapshot = entry?.snapshot ?? api.updateSnapshot({ openProjects: [configFileName] }),
        project = entry?.project ?? resolveProject(snapshot, configFileName);

    if (entry) {
        return {
            api,
            dispose: () => dispose(configFileName),
            project,
            snapshot
        };
    }

    return {
        api,
        dispose: () => disposeEntry({ api, snapshot }),
        project,
        snapshot,
    };
}

// Every callback is a round-trip from tsgo, and a program whose imports change re-resolves every
// module, asking whether each candidate path exists. While every overlay file is also on disk the
// disk gives the same answers, so existence checks are only routed here once one is not.
function overlayFileSystem(contents: Map<string, string>, virtual: boolean): FileSystem {
    let overlay: FileSystem = {
        getAccessibleEntries: (directoryName) => {
            let directory = normalize(directoryName),
                extra: string[] = [];

            for (let key of contents.keys()) {
                if (key.slice(0, key.lastIndexOf('/')) === directory) {
                    extra.push(key.slice(key.lastIndexOf('/') + 1));
                }
            }

            if (extra.length === 0) {
                return undefined;
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

            return { directories, files: [...new Set([...files, ...extra])] };
        },
        readFile: (fileName) => {
            let content = contents.get(normalize(fileName));

            if (content !== undefined) {
                return content;
            }

            return undefined;
        }
    };

    if (virtual) {
        overlay.fileExists = (fileName) => {
            if (contents.has(normalize(fileName))) {
                return true;
            }

            return undefined;
        };
    }

    return overlay;
}

function recreate(entry: Entry): void {
    disposeEntry(entry);
    disposeStaging(entry);
    entry.api = new API({ cwd: entry.root, fs: overlayFileSystem(entry.contents, entry.virtual) });
    entry.changes.clear();
    entry.generation++;
    entry.snapshot = entry.api.updateSnapshot({ openProjects: [entry.configFileName] });
    entry.project = resolveProject(entry.snapshot, entry.configFileName);
    entry.seen = seed(entry.project.program);
}

// A tsgo project's file set is fixed when the project opens, so each new scratch file gets a
// project of its own. Opening it in the live API process costs ~1ms; respawning the process (the
// only other way to admit an unseen file) costs ~55ms, which every host that transforms more than
// one file paid per file. The previous project is closed in the same snapshot update.
function retargetScratch(entry: ScratchEntry, file: string): void {
    let config = scratchConfigPath(entry.count++),
        previous = entry.config;

    entry.contents.delete(entry.file);
    entry.contents.set(config, scratchConfig(file));

    let snapshot = entry.api.updateSnapshot({
            closeProjects: [previous],
            fileChanges: { changed: [file] },
            openProjects: [config]
        });

    if (!entry.snapshot.isDisposed()) {
        entry.snapshot.dispose();
    }

    entry.api.clearSourceFileCache();
    entry.contents.delete(previous);
    entry.config = config;
    entry.file = file;
    entry.project = resolveProject(snapshot, config);
    entry.snapshot = snapshot;
}

function resolveProject(snapshot: Snapshot, configFileName: string): Project {
    let project = snapshot.getProject(configFileName);

    if (!project) {
        throw new Error(`${PACKAGE_NAME}: project not found for ${configFileName}`);
    }

    return project;
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

function seed(program: Program): Set<string> {
    let seen = new Set<string>();

    for (let name of program.getSourceFileNames()) {
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
const contains = (configFileName: string, fileName: string, content?: string): boolean => {
    let entry = getEntry(configFileName),
        id = key(fileName),
        path = normalize(fileName);

    if (entry.seen.has(path) || entry.members?.has(id)) {
        return true;
    }

    if (entry.project.program.getSourceFile(path)) {
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
        { fileNames } = entry.api.parseConfigFile(entry.configFileName);

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
};

const dispose = (root?: string): void => {
    if (root === undefined) {
        for (let entry of cache.values()) {
            disposeEntry(entry);
            disposeStaging(entry);
        }

        cache.clear();

        if (scratchEntry) {
            disposeEntry(scratchEntry);
            scratchEntry = null;
        }

        return;
    }

    root = normalize(path.resolve(root));

    let entry = cache.get(root);

    if (entry) {
        disposeEntry(entry);
        disposeStaging(entry);
        cache.delete(root);
    }
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

    let entry = cache.get(configFileName);

    if (!entry) {
        return;
    }

    let id = normalize(fileName);

    entry.changes.add(id);
    entry.contents.delete(id);
    entry.members = null;
    entry.outside.delete(key(fileName));
    entry.pending.add(id);
};

const parse = (fileName: string, content: string): SourceFile => {
    return scratch(fileName, content).sourceFile;
};

const scratch = (fileName: string, content: string): ScratchResult => {
    let id = normalize(fileName),
        entry = advanceScratch(id, content),
        source = entry.project.program.getSourceFile(id);

    if (!source) {
        throw new Error(`${PACKAGE_NAME}: failed to parse ${fileName}`);
    }

    return { checker: entry.project.checker, program: entry.project.program, sourceFile: source };
};

// The program for `fileName` holding `content` while every other file keeps the entry's text, without
// touching the entry's own program: its checker (and everything it has resolved) stays warm for the
// next file, and `content` never leaks to it. One file is staged at a time; staging another unstages it.
const stage = (configFileName: string, fileName: string, content: string): UpdateResult => {
    let entry = getEntry(configFileName),
        id = normalize(fileName),
        staging = entry.staging;

    if (staging && staging.generation !== entry.generation) {
        disposeStaging(entry);
        staging = null;
    }

    if (!staging) {
        let contents = new Map(entry.contents);

        contents.set(id, content);

        let api = new API({ cwd: entry.root, fs: overlayFileSystem(contents, entry.virtual) }),
            snapshot = api.updateSnapshot({ openProjects: [entry.configFileName] });

        staging = entry.staging = {
            api,
            contents,
            file: id,
            generation: entry.generation,
            project: resolveProject(snapshot, entry.configFileName),
            snapshot
        };
    }
    else {
        let changed = new Set(entry.changes);

        if (staging.file !== null) {
            changed.add(staging.file);
        }

        changed.add(id);

        for (let file of changed) {
            let value = entry.contents.get(file);

            if (value === undefined) {
                staging.contents.delete(file);
            }
            else {
                staging.contents.set(file, value);
            }
        }

        staging.contents.set(id, content);
        staging.file = id;
        advance(staging, entry.configFileName, [...changed]);
    }

    entry.changes.clear();

    let source = staging.project.program.getSourceFile(id);

    if (!source || source.text !== content) {
        throw new Error(`${PACKAGE_NAME}: failed to load ${id} into the program`);
    }

    return { checker: staging.project.checker, program: staging.project.program };
};

const update = (configFileName: string, fileName: string, content: string): UpdateResult => {
    return updateMany(configFileName, new Map([[fileName, content]]));
};

const updateMany = (configFileName: string, updates: Map<string, string>): UpdateResult => {
    let entry = getEntry(configFileName),
        ids: string[] = [],
        routed = entry.virtual;

    for (let [fileName, content] of updates) {
        let id = normalize(fileName);

        // Every host transforms every project file; one the program already holds verbatim needs
        // no new snapshot, which keeps a build's per-file cost off the tsgo round-trip
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
        return { checker: entry.project.checker, program: entry.project.program };
    }

    // A file absent from disk is only visible once existence checks are routed to the overlay
    if (routed === entry.virtual && ids.every(id => entry.seen.has(id))) {
        for (let i = 0, n = ids.length; i < n; i++) {
            entry.pending.add(ids[i]);
        }

        let changed = [...entry.pending];

        for (let i = 0, n = changed.length; i < n; i++) {
            entry.changes.add(changed[i]);
        }

        entry.pending.clear();
        advance(entry, entry.configFileName, changed);
    }
    else {
        // tsgo fixes each project's file-set when its API process opens; incremental
        // created/changed events and project close+reopen do NOT admit a file unseen
        // at that point, so a first-sight file enters the program only by recreating the API.
        recreate(entry);
        entry.pending.clear();
        for (let i = 0, n = ids.length; i < n; i++) {
            entry.seen.add(ids[i]);
        }
    }

    for (let i = 0, n = ids.length; i < n; i++) {
        let id = ids[i],
            source = entry.project.program.getSourceFile(id),
            content = entry.contents.get(id);

        if (!source || source.text !== content) {
            throw new Error(`${PACKAGE_NAME}: failed to load ${id} into the program`);
        }
    }

    return { checker: entry.project.checker, program: entry.project.program };
};


export default { contains, dispose, findConfig, invalidate, open, parse, scratch, stage, update, updateMany };
export { contains, dispose, findConfig, invalidate, open, parse, scratch, stage, update, updateMany };
export type { ScratchResult, UpdateResult };
