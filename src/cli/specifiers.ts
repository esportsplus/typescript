// Imports only Node builtins and the compiler API by package name: this repo's own build runs it
// from the emitted tree before that tree's extensionless relative imports are fixed
import { API } from 'typescript/unstable/sync';
import { pathToFileURL } from 'url';

import fs from 'fs';
import path from 'path';


type Config = {
    declarationDir: string;
    outDir: string;
    patterns: Pattern[];
    rootDir: string;
};

type Pattern = {
    prefix: string;
    suffix: string;
    targets: string[];
    wildcard: boolean;
};

type State = {
    config: Config;
    exists: Map<string, boolean>;
    sources: Map<string, string | null>;
};


const BACKSLASH = /\\/g;

const CONCURRENCY = 64;

const DECLARATION = /\.d\.[cm]?ts$/;

const EMITTED = /\.(?:[cm]?js|d\.[cm]?ts)$/;

const EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.d.mts', '.cts', '.d.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

// A `.js`-family specifier may name the TypeScript source it is emitted from
const JS_TO_TS: Record<string, string[]> = {
    '.cjs': ['.cts', '.d.cts'],
    '.js': ['.ts', '.tsx', '.d.ts'],
    '.jsx': ['.tsx'],
    '.mjs': ['.mts', '.d.mts']
};

// Source extension → the extension of the file a specifier names after emit (declarations included:
// TypeScript resolves `./x.js` to `./x.d.ts`)
const OUTPUT: [RegExp, string][] = [
    [/\.d\.ts$/, '.js'],
    [/\.d\.mts$/, '.mjs'],
    [/\.d\.cts$/, '.cjs'],
    [/\.tsx?$/, '.js'],
    [/\.jsx$/, '.js'],
    [/\.mts$/, '.mjs'],
    [/\.cts$/, '.cjs']
];

// The module specifier of an import, export or require, or of an `import()` type or call
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\2/g;


// The specifier an aliased import becomes: relative to `file`, naming the target's emitted location
function alias(state: State, file: string, declaration: boolean, specifier: string): string | null {
    let { patterns } = state.config;

    for (let i = 0, n = patterns.length; i < n; i++) {
        let pattern = patterns[i];

        if (pattern.wildcard
            ? specifier.length < pattern.prefix.length + pattern.suffix.length || !specifier.startsWith(pattern.prefix) || !specifier.endsWith(pattern.suffix)
            : specifier !== pattern.prefix) {
            continue;
        }

        let capture = pattern.wildcard ? specifier.slice(pattern.prefix.length, specifier.length - pattern.suffix.length) : '';

        for (let j = 0, m = pattern.targets.length; j < m; j++) {
            let source = locate(state, pattern.targets[j].replace('*', capture));

            if (source !== null) {
                return relative(path.dirname(file), output(state.config, source, declaration));
            }
        }

        return null;
    }

    return null;
}

// tsc's default rootDir: the longest common directory of the non-declaration inputs
function common(fileNames: string[]): string {
    let shared: string[] | null = null;

    for (let i = 0, n = fileNames.length; i < n; i++) {
        if (DECLARATION.test(fileNames[i])) {
            continue;
        }

        let parts = path.dirname(path.resolve(fileNames[i])).split(path.sep);

        if (shared === null) {
            shared = parts;
            continue;
        }

        let j = 0;

        while (j < shared.length && j < parts.length && shared[j] === parts[j]) {
            j++;
        }

        shared.length = j;
    }

    return shared === null ? process.cwd() : shared.join(path.sep) || path.sep;
}

function exists(state: State, file: string): boolean {
    let cached = state.exists.get(file);

    if (cached !== undefined) {
        return cached;
    }

    let found = fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;

    state.exists.set(file, found);

    return found;
}

// The source file a module path names, by TypeScript's lookup order: the path itself, a `.js`-family
// path's TypeScript source, an added extension, then a directory index
function locate(state: State, candidate: string): string | null {
    let cached = state.sources.get(candidate);

    if (cached !== undefined) {
        return cached;
    }

    let found: string | null = null,
        extension = path.extname(candidate),
        replacements = JS_TO_TS[extension];

    if (extension !== '' && exists(state, candidate)) {
        found = candidate;
    }

    for (let i = 0, n = replacements?.length ?? 0; found === null && i < n; i++) {
        let replaced = candidate.slice(0, -extension.length) + replacements![i];

        if (exists(state, replaced)) {
            found = replaced;
        }
    }

    for (let i = 0, n = EXTENSIONS.length; found === null && i < n; i++) {
        if (exists(state, candidate + EXTENSIONS[i])) {
            found = candidate + EXTENSIONS[i];
        }
    }

    for (let i = 0, n = EXTENSIONS.length; found === null && i < n; i++) {
        let index = path.join(candidate, 'index' + EXTENSIONS[i]);

        if (exists(state, index)) {
            found = index;
        }
    }

    state.sources.set(candidate, found);

    return found;
}

// Where a source file lands after emit; a file outside rootDir is not emitted and is named in place
function output(config: Config, source: string, declaration: boolean): string {
    let relative = path.relative(config.rootDir, source);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return source;
    }

    for (let i = 0, n = OUTPUT.length; i < n; i++) {
        if (OUTPUT[i][0].test(relative)) {
            relative = relative.replace(OUTPUT[i][0], OUTPUT[i][1]);
            break;
        }
    }

    return path.join(declaration ? config.declarationDir : config.outDir, relative);
}

function relative(from: string, to: string): string {
    let specifier = path.relative(from, to).replace(BACKSLASH, '/');

    return specifier.startsWith('.') ? specifier : './' + specifier;
}

// The specifier Node's ESM loader needs for an extensionless relative import, or null when it
// already names a file or names nothing that was emitted
function resolve(state: State, directory: string, specifier: string, declaration: boolean): string | null {
    let base = path.resolve(directory, specifier),
        suffix = declaration ? '.d.ts' : '.js';

    if (exists(state, base)) {
        return null;
    }

    if (exists(state, base + suffix) || exists(state, base + '.js')) {
        return specifier + '.js';
    }

    if (exists(state, path.join(base, 'index' + suffix)) || exists(state, path.join(base, 'index.js'))) {
        return specifier.replace(/\/?$/, '/index.js');
    }

    return null;
}

function transform(state: State, file: string, text: string): string {
    let declaration = DECLARATION.test(file),
        directory = path.dirname(file);

    return text.replace(SPECIFIER, (match, head: string, quote: string, specifier: string) => {
        let resolved: string | null;

        if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
            resolved = resolve(state, directory, specifier, declaration);
        }
        else if (state.config.patterns.length > 0) {
            resolved = alias(state, file, declaration, specifier);
        }
        else {
            return match;
        }

        return resolved === null ? match : head + quote + resolved + quote;
    });
}

function walk(directory: string, files: string[]): string[] {
    if (!fs.existsSync(directory)) {
        return files;
    }

    for (let entry of fs.readdirSync(directory, { withFileTypes: true })) {
        let full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            walk(full, files);
        }
        else if (EMITTED.test(entry.name)) {
            files.push(full);
        }
    }

    return files;
}


// The emit layout and tsconfig `paths` patterns, from compiler options as `parseConfigFile` returns
// them (extends chain merged, `${configDir}` substituted). Patterns are ordered as TypeScript matches
// them: exact keys first, then wildcards by longest prefix.
const configure = (options: Record<string, unknown>, fileNames: string[]): Config => {
    let paths = (options.paths ?? {}) as Record<string, string[]>,
        base = typeof options.baseUrl === 'string'
            ? options.baseUrl
            : typeof options.pathsBasePath === 'string'
                ? options.pathsBasePath
                : typeof options.configFilePath === 'string' ? path.dirname(options.configFilePath) : process.cwd(),
        keys = Object.keys(paths),
        patterns: Pattern[] = [],
        rootDir = typeof options.rootDir === 'string' ? path.resolve(options.rootDir) : common(fileNames),
        outDir = typeof options.outDir === 'string' ? path.resolve(options.outDir) : rootDir;

    for (let i = 0, n = keys.length; i < n; i++) {
        let key = keys[i],
            star = key.indexOf('*'),
            targets: string[] = [];

        for (let j = 0, m = paths[key].length; j < m; j++) {
            targets.push(path.resolve(base, paths[key][j]));
        }

        patterns.push({
            prefix: star === -1 ? key : key.slice(0, star),
            suffix: star === -1 ? '' : key.slice(star + 1),
            targets,
            wildcard: star !== -1
        });
    }

    patterns.sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.prefix.length - a.prefix.length);

    return {
        declarationDir: typeof options.declarationDir === 'string' ? path.resolve(options.declarationDir) : outDir,
        outDir,
        patterns,
        rootDir
    };
};

// Emit keeps specifiers verbatim, so in one read and at most one write per emitted file: specifiers
// matching a `paths` pattern become relative paths to the target's emitted location, and
// extensionless relative ones gain the extension Node's ESM loader requires. Source maps are left
// alone: only specifier lengths change, within their line. Files are processed concurrently: a file
// tsc just wrote is slow to open the first time (Windows scans it on open), and those waits overlap.
const rewrite = async (files: string[], config: Config): Promise<void> => {
    let next = 0,
        state: State = { config, exists: new Map(), sources: new Map() },
        workers: Promise<void>[] = [];

    let work = async (): Promise<void> => {
        while (next < files.length) {
            let file = files[next++];

            if (!EMITTED.test(file)) {
                continue;
            }

            let text = await fs.promises.readFile(file, 'utf8'),
                rewritten = transform(state, file, text);

            if (rewritten !== text) {
                await fs.promises.writeFile(file, rewritten);
            }
        }
    };

    for (let i = 0, n = Math.min(CONCURRENCY, files.length); i < n; i++) {
        workers.push(work());
    }

    await Promise.all(workers);
};

const tree = (config: Config): string[] => {
    let files = walk(config.outDir, []);

    return config.declarationDir === config.outDir ? files : walk(config.declarationDir, files);
};


// `node build/cli/specifiers.js [tsconfig]`: rewrites an already emitted tree in place
if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    let api = new API({ cwd: process.cwd() }),
        tsconfig = path.resolve(process.argv[2] ?? 'tsconfig.json');

    try {
        let { fileNames, options } = api.parseConfigFile(tsconfig),
            config = configure(options, fileNames);

        await rewrite(tree(config), config);
    }
    finally {
        api.close();
    }
}


export default { configure, rewrite, tree };
export type { Config };
