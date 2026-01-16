import path from 'path';
import ts from 'typescript';
import { PACKAGE_NAME } from '~/constants';


type LanguageServiceEntry = {
    contents: Map<string, string>;
    host: ts.LanguageServiceHost;
    rootFiles: Set<string>;
    service: ts.LanguageService;
    versions: Map<string, number>;
};


let cache = new Map<string, LanguageServiceEntry>();


function create(root: string): LanguageServiceEntry {
    let tsconfig = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');

    if (!tsconfig) {
        throw new Error(`${PACKAGE_NAME}: tsconfig.json not found`);
    }

    let file = ts.readConfigFile(tsconfig, ts.sys.readFile);

    if (file.error) {
        throw new Error(`${PACKAGE_NAME}: error reading tsconfig.json ${file.error.messageText}`);
    }

    let parsed = ts.parseJsonConfigFileContent(
            file.config,
            ts.sys,
            path.dirname(tsconfig)
        );

    if (parsed.errors.length > 0) {
        throw new Error(`${PACKAGE_NAME}: error parsing tsconfig.json ${parsed.errors[0].messageText}`);
    }

    let contents = new Map<string, string>(),
        rootFiles = new Set(parsed.fileNames.map(f => f.replace(/\\/g, '/'))),
        versions = new Map<string, number>();

    for (let fileName of rootFiles) {
        versions.set(fileName, 0);
    }

    let host: ts.LanguageServiceHost = {
        fileExists: ts.sys.fileExists,
        getCompilationSettings: () => parsed.options,
        getCurrentDirectory: () => root,
        getDefaultLibFileName: ts.getDefaultLibFilePath,
        getScriptFileNames: () => [...rootFiles],
        getScriptSnapshot: (fileName: string) => {
            let content = contents.get(fileName);

            if (content !== undefined) {
                return ts.ScriptSnapshot.fromString(content);
            }

            if (!ts.sys.fileExists(fileName)) {
                return undefined;
            }

            return ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) || '');
        },
        getScriptVersion: (fileName: string) => String(versions.get(fileName) || 0),
        readFile: ts.sys.readFile
    };

    return { contents, host, rootFiles, service: ts.createLanguageService(host), versions };
}

function getEntry(root: string): LanguageServiceEntry {
    let entry = cache.get(root);

    if (!entry) {
        entry = create(root);
        cache.set(root, entry);
    }

    return entry;
}


const del = (root: string): void => {
    cache.delete(root);
};

const get = (root: string): ts.Program => {
    let entry = getEntry(root),
        program = entry.service.getProgram();

    if (!program) {
        throw new Error(`${PACKAGE_NAME}: failed to get program from language service`);
    }

    return program;
};

const invalidate = (root: string, fileName: string): void => {
    let entry = cache.get(root);

    if (entry) {
        let normalized = fileName.replace(/\\/g, '/');

        entry.contents.delete(normalized);
        entry.versions.set(normalized, (entry.versions.get(normalized) || 0) + 1);
    }
};

const update = (root: string, fileName: string, content: string): ts.Program => {
    let entry = getEntry(root),
        normalized = fileName.replace(/\\/g, '/');

    if (!entry.rootFiles.has(normalized)) {
        entry.rootFiles.add(normalized);
    }

    entry.contents.set(normalized, content);
    entry.versions.set(normalized, (entry.versions.get(normalized) || 0) + 1);

    let program = entry.service.getProgram();

    if (!program) {
        throw new Error(`${PACKAGE_NAME}: failed to get program from language service`);
    }

    return program;
};


export default { delete: del, get, invalidate, update };
export { get, invalidate, update };
