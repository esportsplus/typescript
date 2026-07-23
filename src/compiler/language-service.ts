import type { SourceFile } from 'typescript/unstable/ast';
import type { FileSystem } from 'typescript/unstable/fs';
import type { FileChangeSummary } from 'typescript/unstable/proto';
import { API, DiagnosticCategory, type Checker, type Program, type Project, type Snapshot } from 'typescript/unstable/sync';
import { PACKAGE_NAME } from '~/constants';

import fs from 'fs';
import path from 'path';


type Entry = {
    api: API;
    configFileName: string;
    contents: Map<string, string>;
    pending: Set<string>;
    project: Project;
    root: string;
    snapshot: Snapshot;
};

type ScratchEntry = {
    api: API;
    config: string;
    contents: Map<string, string>;
    file: string;
    project: Project;
    snapshot: Snapshot;
};

type UpdateResult = {
    checker: Checker;
    program: Program;
};


const backslashes = /\\/g;


let cache = new Map<string, Entry>(),
    scratchEntry: ScratchEntry | null = null;


function advance(entry: Entry, changes: FileChangeSummary): void {
    let snapshot = entry.api.updateSnapshot({ fileChanges: changes });

    if (!entry.snapshot.isDisposed()) {
        entry.snapshot.dispose();
    }

    entry.api.clearSourceFileCache();
    entry.project = resolveProject(snapshot, entry.configFileName);
    entry.snapshot = snapshot;
}

function createEntry(root: string): Entry {
    let configFileName = findConfig(root);

    if (!configFileName) {
        throw new Error(`${PACKAGE_NAME}: tsconfig.json not found`);
    }

    let contents = new Map<string, string>(),
        api = new API({ cwd: root, fs: overlayFileSystem(contents) }),
        snapshot = api.updateSnapshot({ openProjects: [configFileName] }),
        project = resolveProject(snapshot, configFileName);

    for (let diagnostic of project.program.getConfigFileParsingDiagnostics()) {
        if (diagnostic.category === DiagnosticCategory.Error) {
            snapshot.dispose();
            api.close();

            throw new Error(`${PACKAGE_NAME}: error parsing tsconfig.json ${diagnostic.text}`);
        }
    }

    return { api, configFileName, contents, pending: new Set(), project, root, snapshot };
}

function createScratch(file: string): ScratchEntry {
    let config = normalize(process.cwd()) + '/tsconfig.tsparse.json',
        contents = new Map<string, string>();

    contents.set(config, scratchConfig(file));

    let api = new API({ cwd: process.cwd(), fs: overlayFileSystem(contents) }),
        snapshot = api.updateSnapshot({ openProjects: [config] }),
        project = resolveProject(snapshot, config);

    return { api, config, contents, file, project, snapshot };
}

function disposeEntry(entry: Entry): void {
    if (!entry.snapshot.isDisposed()) {
        entry.snapshot.dispose();
    }

    entry.api.close();
}

function disposeScratch(entry: ScratchEntry): void {
    if (!entry.snapshot.isDisposed()) {
        entry.snapshot.dispose();
    }

    entry.api.close();
}

function getEntry(root: string): Entry {
    let entry = cache.get(root);

    if (!entry) {
        entry = createEntry(root);
        cache.set(root, entry);
    }

    return entry;
}

function normalize(fileName: string): string {
    return fileName.replace(backslashes, '/');
}

function overlayFileSystem(contents: Map<string, string>): FileSystem {
    return {
        fileExists: (fileName) => {
            if (contents.has(normalize(fileName))) {
                return true;
            }

            return undefined;
        },
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

            return { directories, files: [...files, ...extra] };
        },
        readFile: (fileName) => {
            let content = contents.get(normalize(fileName));

            if (content !== undefined) {
                return content;
            }

            return undefined;
        }
    };
}

function reopen(entry: Entry): void {
    if (!entry.snapshot.isDisposed()) {
        entry.snapshot.dispose();
    }

    entry.api.close();
    entry.api = new API({ cwd: entry.root, fs: overlayFileSystem(entry.contents) });
    entry.snapshot = entry.api.updateSnapshot({ openProjects: [entry.configFileName] });
    entry.project = resolveProject(entry.snapshot, entry.configFileName);
}

function reseedScratch(entry: ScratchEntry, file: string): void {
    entry.contents.delete(entry.file);
    entry.contents.set(entry.config, scratchConfig(file));

    if (!entry.snapshot.isDisposed()) {
        entry.snapshot.dispose();
    }

    entry.api.close();
    entry.api = new API({ cwd: process.cwd(), fs: overlayFileSystem(entry.contents) });
    entry.file = file;
    entry.snapshot = entry.api.updateSnapshot({ openProjects: [entry.config] });
    entry.project = resolveProject(entry.snapshot, entry.config);
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


const dispose = (root?: string): void => {
    if (root === undefined) {
        for (let entry of cache.values()) {
            disposeEntry(entry);
        }

        cache.clear();

        if (scratchEntry) {
            disposeScratch(scratchEntry);
            scratchEntry = null;
        }

        return;
    }

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

const invalidate = (root: string, fileName: string): void => {
    let entry = cache.get(root);

    if (!entry) {
        return;
    }

    let id = normalize(fileName);

    entry.contents.delete(id);
    entry.pending.add(id);
};

const parse = (fileName: string, content: string): SourceFile => {
    let id = normalize(fileName);

    if (!scratchEntry) {
        scratchEntry = createScratch(id);
    }
    else if (scratchEntry.file !== id) {
        reseedScratch(scratchEntry, id);
    }

    let entry = scratchEntry;

    entry.contents.set(id, content);

    let snapshot = entry.api.updateSnapshot({ fileChanges: { changed: [id] } });

    if (!entry.snapshot.isDisposed()) {
        entry.snapshot.dispose();
    }

    entry.api.clearSourceFileCache();
    entry.project = resolveProject(snapshot, entry.config);
    entry.snapshot = snapshot;

    let source = entry.project.program.getSourceFile(id);

    if (!source) {
        throw new Error(`${PACKAGE_NAME}: failed to parse ${fileName}`);
    }

    return source;
};

const update = (root: string, fileName: string, content: string): UpdateResult => {
    let entry = getEntry(root),
        id = normalize(fileName);

    entry.contents.set(id, content);
    entry.pending.add(id);

    let changed = [...entry.pending];

    entry.pending.clear();
    advance(entry, { changed });

    let source = entry.project.program.getSourceFile(id);

    if (!source || source.text !== content) {
        reopen(entry);
        source = entry.project.program.getSourceFile(id);
    }

    if (!source || source.text !== content) {
        throw new Error(`${PACKAGE_NAME}: failed to load ${fileName} into the program`);
    }

    return { checker: entry.project.checker, program: entry.project.program };
};


export default { dispose, findConfig, invalidate, parse, update };
export { dispose, findConfig, invalidate, parse, update };
