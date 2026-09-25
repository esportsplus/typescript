import fs from 'fs';
import path from 'path';


type Manifest = {
    directory: string;
    // Module entry candidates in resolution preference order, as absolute '/'-separated paths
    entries: string[];
    name: string;
};


const BACKSLASH_REGEX = /\\/g;


let directories = new Map<string, Manifest | null>();


function entries(directory: string, json: Record<string, unknown>): string[] {
    let candidates: unknown[] = [],
        root = (json.exports as Record<string, unknown> | string | undefined);

    if (typeof root === 'string') {
        candidates.push(root);
    }
    else if (root && typeof root === 'object') {
        let main = (root['.'] ?? root) as Record<string, unknown> | string;

        if (typeof main === 'string') {
            candidates.push(main);
        }
        else if (main && typeof main === 'object') {
            candidates.push(main.types, main.import, main.default);
        }
    }

    candidates.push(json.types, json.typings, json.module, json.main);

    let result: string[] = [];

    for (let i = 0, n = candidates.length; i < n; i++) {
        let candidate = candidates[i];

        if (typeof candidate === 'string') {
            let entry = path.posix.join(directory, candidate);

            if (!result.includes(entry)) {
                result.push(entry);
            }
        }
    }

    return result;
}


// Nearest named package.json above a file. A linked install (link:, workspace, npm link) or a
// package's own sources resolve to a real path with no node_modules segment, so the path alone
// cannot say which package a file belongs to. Cached per directory; manifests without a name
// (e.g. a nested {"type":"module"}) are skipped.
const find = (fileName: string): Manifest | null => {
    let directory = path.posix.dirname(fileName.replace(BACKSLASH_REGEX, '/')),
        visited: string[] = [],
        manifest: Manifest | null | undefined;

    while (true) {
        manifest = directories.get(directory);

        if (manifest !== undefined) {
            break;
        }

        visited.push(directory);

        try {
            let json = JSON.parse(fs.readFileSync(directory + '/package.json', 'utf8'));

            if (typeof json.name === 'string') {
                manifest = { directory, entries: entries(directory, json), name: json.name };
                break;
            }
        }
        catch {
            // no (readable) manifest in this directory
        }

        let parent = path.posix.dirname(directory);

        if (parent === directory) {
            manifest = null;
            break;
        }

        directory = parent;
    }

    for (let i = 0, n = visited.length; i < n; i++) {
        directories.set(visited[i], manifest);
    }

    return manifest;
};


export default { find };
export type { Manifest };
