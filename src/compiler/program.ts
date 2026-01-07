import path from 'path';
import ts from 'typescript';


let cache = new Map<string, ts.Program>();


function create(root: string): ts.Program {
    let tsconfig = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');

    if (!tsconfig) {
        throw new Error('tsconfig.json not found');
    }

    let file = ts.readConfigFile(tsconfig, ts.sys.readFile);

    if (file.error) {
        throw new Error(`Error reading tsconfig.json: ${file.error.messageText}`);
    }

    let parsed = ts.parseJsonConfigFileContent(
            file.config,
            ts.sys,
            path.dirname(tsconfig)
        );

    if (parsed.errors.length > 0) {
        throw new Error(`Error parsing tsconfig.json: ${parsed.errors[0].messageText}`);
    }

    return ts.createProgram({
        options: parsed.options,
        rootNames: parsed.fileNames
    });
}


const get = (root: string): ts.Program => {
    let program = cache.get(root);

    if (!program) {
        program = create(root);
        cache.set(root, program);
    }

    return program;
}

const del = (root: string): void => {
    cache.delete(root);
}


export default { get, delete: del };
