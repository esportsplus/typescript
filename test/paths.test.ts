import { describe, expect, it } from 'vitest';

import fs from 'fs';
import path from 'path';


const ALIAS = /(?:from\s+|import\s*\(\s*)['"]~\//;

const SOURCE = /\.[cm]?tsx?$/;


function sources(directory: string, files: string[]): string[] {
    for (let entry of fs.readdirSync(directory, { withFileTypes: true })) {
        let full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            sources(full, files);
        }
        else if (SOURCE.test(entry.name)) {
            files.push(full);
        }
    }

    return files;
}


// Emit keeps specifiers verbatim (declarations included) and nothing rewrites `paths` after it,
// so a `~/` import in src would ship as an unresolvable specifier
describe('src imports', () => {
    it('never use the ~/ alias', () => {
        let offenders: string[] = [],
            files = sources(path.join(import.meta.dirname, '..', 'src'), []);

        for (let i = 0, n = files.length; i < n; i++) {
            if (ALIAS.test(fs.readFileSync(files[i], 'utf8'))) {
                offenders.push(path.relative(process.cwd(), files[i]));
            }
        }

        expect(offenders).toEqual([]);
    });
});
