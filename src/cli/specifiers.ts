// Imports only Node builtins: this repo's own build runs it from the emitted tree before that
// tree's extensionless relative imports are fixed
import { pathToFileURL } from 'url';

import fs from 'fs';
import path from 'path';


type Aliased = {
    file: string;
    specifier: string;
};


const DECLARATION = /\.d\.[cm]?ts$/;

const EMITTED = /\.(?:[cm]?js|d\.[cm]?ts)$/;

// The module specifier of an import, export or require, or of an `import()` type or call
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\2/g;


function exists(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    }
    catch {
        return false;
    }
}

// The specifier Node's ESM loader needs for an extensionless relative import, or null when it
// already names a file or names nothing that was emitted
function resolve(directory: string, specifier: string, declaration: boolean): string | null {
    let base = path.resolve(directory, specifier),
        suffix = declaration ? '.d.ts' : '.js';

    if (exists(base)) {
        return null;
    }

    if (exists(base + suffix) || exists(base + '.js')) {
        return specifier + '.js';
    }

    if (exists(path.join(base, 'index' + suffix)) || exists(path.join(base, 'index.js'))) {
        return specifier.replace(/\/?$/, '/index.js');
    }

    return null;
}

function walk(directory: string, files: string[]): string[] {
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


// Emit keeps specifiers verbatim, so extensionless relative imports gain the extension Node's ESM
// loader requires, and any specifier starting with one of `aliases` (tsconfig `paths` prefixes,
// which nothing rewrites) is reported: it would ship unresolvable.
const rewrite = (files: string[], aliases: string[]): Aliased[] => {
    let aliased: Aliased[] = [];

    for (let i = 0, n = files.length; i < n; i++) {
        let file = files[i];

        if (!EMITTED.test(file)) {
            continue;
        }

        let declaration = DECLARATION.test(file),
            directory = path.dirname(file),
            text = fs.readFileSync(file, 'utf8'),
            next = text.replace(SPECIFIER, (match, head: string, quote: string, specifier: string) => {
                for (let j = 0, m = aliases.length; j < m; j++) {
                    if (specifier.startsWith(aliases[j])) {
                        aliased.push({ file, specifier });

                        return match;
                    }
                }

                if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
                    return match;
                }

                let resolved = resolve(directory, specifier, declaration);

                return resolved === null ? match : head + quote + resolved + quote;
            });

        if (next !== text) {
            fs.writeFileSync(file, next);
        }
    }

    return aliased;
};

const tree = (directory: string): string[] => {
    return walk(directory, []);
};


// `node build/cli/specifiers.js <directory> [alias...]`
if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    let [directory, ...aliases] = process.argv.slice(2),
        aliased = rewrite(tree(path.resolve(directory ?? 'build')), aliases);

    for (let i = 0, n = aliased.length; i < n; i++) {
        console.error(`@esportsplus/typescript: ${aliased[i].file} imports '${aliased[i].specifier}', a path alias nothing rewrites`);
    }

    if (aliased.length > 0) {
        process.exit(1);
    }
}


export default { rewrite, tree };
