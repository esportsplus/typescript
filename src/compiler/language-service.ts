import type { SourceFile } from 'typescript/ast';
import { type FileSystemCallbacks, serverFS } from 'typescript/fs';
import { API, type Checker, DiagnosticCategory, type Program, type Project, type RetainedSourceFile, type Snapshot } from 'typescript/sync';
import { PACKAGE_NAME } from '../constants';

import checker from './checker';
import fs from 'fs';
import path from 'path';


// Disk text of a file the program read, valid while the file's mtime and size are unchanged
type Disk = {
    mtimeMs: number;
    size: number;
    text: string;
};

type Entry = {
    api: API;
    configFileName: string;
    contents: Overlay;
    disk: Map<string, Disk>;
    // The config's file list as of the last membership miss; null until needed, or after invalidate()
    // of a file the list may not cover (one it lacks, or a config)
    members: Set<string> | null;
    // Files proven not to belong to the project; cleared by invalidate() when the file changes
    outside: Set<string>;
    pending: Set<string>;
    project: Project;
    root: string;
    seen: Set<string>;
    snapshot: Snapshot;
    // Whether the overlay has held a file absent from disk, so existence checks must consult it
    virtual: boolean;
};

// Parses without a project: tsgo returns the tree whole and it is decoded client-side, so the lease
// that keeps it alive in tsgo is released with the next parse, in the same round-trip
type Parser = {
    api: API;
    lease: RetainedSourceFile | null;
};

type ScratchEntry = {
    api: API;
    config: string;
    contents: Overlay;
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

const CONFIG_REGEX = /\.json$/;


let cache = new Map<string, Entry>(),
    parser: Parser | null = null,
    scratchEntry: ScratchEntry | null = null;


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

function advance(session: Session, configFileName: string, changed: string[]): void {
    let snapshot = session.snapshot.update({ fileNotifications: { changed }, openProjects: [configFileName] });

    if (snapshot !== session.snapshot && !session.snapshot.isDisposed()) {
        session.snapshot.dispose();
    }

    session.api.clearSourceFileCache();
    session.project = resolveProject(session.api, snapshot, configFileName);
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

    let contents = new Overlay(),
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
        configFileName,
        contents,
        disk: new Map(),
        members: null,
        outside: new Set(),
        pending: new Set(),
        project,
        root,
        seen: seed(project.program),
        snapshot,
        virtual: false
    };
}

function createScratch(file: string, content: string): ScratchEntry {
    let config = scratchConfigPath(0),
        contents = new Overlay();

    contents.set(config, scratchConfig(file));
    contents.set(file, content);

    let api = new API({ cwd: process.cwd(), fs: overlayFileSystem(contents, true) }),
        snapshot = api.createSnapshot({ openProjects: [config] }),
        project = resolveProject(api, snapshot, config);

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

function disposeEntry(entry: Pick<Entry, 'api' | 'snapshot'>): void {
    if (!entry.snapshot.isDisposed()) {
        entry.snapshot.dispose();
    }

    entry.api.close();
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

function open(configPath: string, overlay?: FileSystemCallbacks): OpenProject {
    let configFileName = normalize(path.resolve(configPath)),
        entry = overlay === undefined ? getEntry(configFileName) : undefined,
        api = entry?.api ?? new API({ cwd: path.dirname(configFileName), fs: overlay }),
        snapshot = entry?.snapshot ?? api.createSnapshot({ openProjects: [configFileName] }),
        project = entry?.project ?? resolveProject(api, snapshot, configFileName);

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

function recreate(entry: Entry): void {
    disposeEntry(entry);
    entry.api = new API({ cwd: entry.root, fs: overlayFileSystem(entry.contents, entry.virtual) });
    entry.snapshot = entry.api.createSnapshot({ openProjects: [entry.configFileName] });
    entry.project = resolveProject(entry.api, entry.snapshot, entry.configFileName);
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

    let snapshot = entry.snapshot.update({
            closeProjects: [previous],
            fileNotifications: { changed: [file] },
            openProjects: [config]
        });

    if (snapshot !== entry.snapshot && !entry.snapshot.isDisposed()) {
        entry.snapshot.dispose();
    }

    entry.api.clearSourceFileCache();
    entry.contents.delete(previous);
    entry.config = config;
    entry.file = file;
    entry.project = resolveProject(entry.api, snapshot, config);
    entry.snapshot = snapshot;
}

function resolveProject(api: API, snapshot: Snapshot, configFileName: string): Project {
    let project = snapshot.getConfiguredProject(configFileName);

    if (!project) {
        throw new Error(`${PACKAGE_NAME}: project not found for ${configFileName}`);
    }

    return checker.attach(api, project);
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
        }

        cache.clear();

        if (parser) {
            parser.api.close();
            parser = null;
        }

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

    entry.contents.delete(id);
    entry.disk.delete(id);

    // Editing a file the list already holds cannot change what the include globs match
    if (CONFIG_REGEX.test(id) || !entry.members?.has(key(fileName))) {
        entry.members = null;
    }

    entry.outside.delete(key(fileName));
    entry.pending.add(id);
};

const parse = (fileName: string, content: string): SourceFile => {
    parser ??= { api: new API({ cwd: process.cwd() }), lease: null };

    let { api, lease } = parser,
        id = normalize(fileName);

    parser.lease = lease
        ? api.batch(lease.dispose.gen(), api.createSourceFile.gen(id, content))[1]
        : api.createSourceFile(id, content);

    return parser.lease.sourceFile;
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


export default { contains, dispose, findConfig, invalidate, open, parse, scratch, update, updateMany };
export { contains, dispose, findConfig, invalidate, open, parse, scratch, update, updateMany };
export type { ScratchResult, UpdateResult };
