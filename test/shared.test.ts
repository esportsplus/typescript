import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'url';

import fs from 'fs';
import path from 'path';


// Two copies of the built package, as linked installs and worktrees load them
let build = path.join(process.cwd(), 'build'),
    directory = fs.mkdtempSync(path.join(process.cwd(), 'test/.shared-')),
    version = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;


function copy(name: string, at: string): string {
    let root = path.join(directory, name);

    fs.cpSync(build, path.join(root, 'build'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@esportsplus/typescript', type: 'module', version: at }));

    return pathToFileURL(path.join(root, 'build', 'compiler', 'language-service.js')).href;
}


beforeAll(() => {
    if (!fs.existsSync(path.join(build, 'compiler', 'language-service.js'))) {
        throw new Error('shared.test: build/ is missing; run `pnpm build` first');
    }
});

afterAll(() => {
    fs.rmSync(directory, { force: true, recursive: true });
});


describe('one package state per process', () => {
    it('shares one language service between copies of the same version', async () => {
        let a = (await import(copy('a', version))) as { default: unknown },
            b = (await import(copy('b', version))) as { default: unknown };

        expect(a.default).toBe(b.default);
    });

    it('fails, naming both copies, when another version is loaded', async () => {
        await expect(import(copy('c', '0.0.0-other'))).rejects.toThrow(
            new RegExp(`two versions are loaded in one process, ${version.replace(/\./g, '\\.')} from .*a and 0\\.0\\.0-other from .*c`)
        );
    });
});
