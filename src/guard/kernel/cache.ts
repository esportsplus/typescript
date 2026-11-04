import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import type { AnalyzeConfig, Diagnostic } from './types';

import cache from '../../cache';
import fs from 'fs';
import path from 'path';


type Entry = {
    diagnostics: Diagnostic[];
    key: string;
};


// Everything the findings are a function of: this analyzer's own build (its package.json and when
// it was built), the config, every file the program reads, and the dependency lockfile (installed
// .js the exceptions channel scans changes only with it)
function signature(config: AnalyzeConfig, files: ReadonlyArray<string>): string {
    let hash = createHash('sha256'),
        self = fileURLToPath(import.meta.url),
        sorted = [...files].sort();

    hash.update(cache.read(path.join(path.dirname(self), '..', '..', '..', 'package.json')) ?? '');
    hash.update(`\0${fs.statSync(self).mtimeMs}\0${config.tsconfigPath}\0${JSON.stringify(config.channels)}\0`);

    for (let i = 0, n = sorted.length; i < n; i++) {
        hash.update(sorted[i] + '\0');
        hash.update(cache.read(sorted[i]) ?? '\0missing');
        hash.update('\0');
    }

    let lock = cache.lockfile(config.projectRoot);

    hash.update(lock ? cache.read(lock) ?? '' : '');

    return hash.digest('hex');
}


// Analyze is deterministic over the program it reads, so an unchanged project reuses its last
// findings; any change to any input re-runs the whole analysis. `ESPORTSPLUS_ANALYZE_CACHE=0` disables it.
const findings = (config: AnalyzeConfig, files: ReadonlyArray<string>, run: () => Diagnostic[]): Diagnostic[] => {
    let root = process.env.ESPORTSPLUS_ANALYZE_CACHE === '0' ? null : cache.directory(config.projectRoot, 'guard');

    if (root === null) {
        return run();
    }

    let file = path.join(root, createHash('sha1').update(path.resolve(config.tsconfigPath)).digest('hex') + '.json'),
        key = signature(config, files),
        stored = cache.read(file);

    if (stored !== null) {
        try {
            let entry = JSON.parse(stored.toString('utf8')) as Entry;

            if (entry.key === key) {
                return entry.diagnostics;
            }
        }
        catch {
            // an unreadable entry is replaced below
        }
    }

    let diagnostics = run(),
        temporary = `${file}.${process.pid}.tmp`;

    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ diagnostics, key } satisfies Entry));
    fs.renameSync(temporary, file);

    return diagnostics;
};


export default { findings };
