import fs from 'fs';
import path from 'path';


const LOCKFILES = ['bun.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];


// A cache's directory under the nearest node_modules above `root`, or null without one
const directory = (root: string, name: string): string | null => {
    for (let current = path.resolve(root); ; current = path.dirname(current)) {
        let modules = path.join(current, 'node_modules');

        if (fs.existsSync(modules)) {
            return path.join(modules, '.cache', '@esportsplus', 'typescript', name);
        }

        if (path.dirname(current) === current) {
            return null;
        }
    }
};

// The dependency lockfile nearest above `root`, or '' without one
const lockfile = (root: string): string => {
    for (let current = path.resolve(root); ; current = path.dirname(current)) {
        for (let i = 0, n = LOCKFILES.length; i < n; i++) {
            let file = path.join(current, LOCKFILES[i]);

            if (fs.existsSync(file)) {
                return file;
            }
        }

        if (path.dirname(current) === current) {
            return '';
        }
    }
};

const read = (file: string): Buffer | null => {
    try {
        return fs.readFileSync(file);
    }
    catch {
        return null;
    }
};


export default { directory, lockfile, read };
