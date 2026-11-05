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


// The modules outside guard/ the analyzer runs, beside it in the package
const MODULES = ['cache', 'constants', 'jsonc', 'timing', 'tsconfig'];


// This analyzer's stamp, computed once per process
let analyzer: string | undefined;


// Every file under `directory`, by path relative to `root`
function collect(root: string, directory: string, files: string[]): void {
    for (let entry of fs.readdirSync(directory, { withFileTypes: true })) {
        let file = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            collect(root, file, files);
        }
        else {
            files.push(path.relative(root, file).split(path.sep).join('/'));
        }
    }
}


// Everything the findings are a function of: this analyzer's own build (see stamp()), the config,
// every file the program reads, and the dependency lockfile (installed .js the exceptions channel
// scans changes only with it)
function signature(config: AnalyzeConfig, files: ReadonlyArray<string>): string {
    let hash = createHash('sha256'),
        self = fileURLToPath(import.meta.url),
        sorted = [...files].sort();

    analyzer ??= stamp(path.join(path.dirname(self), '..'), path.extname(self));

    hash.update(`${analyzer}\0${config.tsconfigPath}\0${JSON.stringify(config.channels)}\0`);

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


// The analyzer's own build by content: its package.json, every file under its guard/ directory and
// the modules it runs beside it. A fresh install of the same build writes the same contents at a new
// time, so a cache restored onto it (CI) is reused; any change to the analyzer is a new stamp.
const stamp = (directory: string, extension: string): string => {
    let files: string[] = [],
        hash = createHash('sha256');

    collect(directory, directory, files);
    files.sort();
    hash.update(cache.read(path.join(directory, '..', '..', 'package.json')) ?? '');

    for (let i = 0, n = files.length; i < n; i++) {
        hash.update(`\0${files[i]}\0`);
        hash.update(cache.read(path.join(directory, files[i])) ?? '');
    }

    for (let i = 0, n = MODULES.length; i < n; i++) {
        hash.update(`\0${MODULES[i]}\0`);
        hash.update(cache.read(path.join(directory, '..', MODULES[i] + extension)) ?? '\0missing');
    }

    return hash.digest('hex');
};


export default { findings, stamp };
