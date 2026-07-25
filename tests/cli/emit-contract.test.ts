import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { API } from 'typescript/unstable/sync';
import { build } from '~/cli/tsc';
import { createFixture, snapshotTree } from './fixtures';


describe('emit contract', () => {
    let api: API,
        exits: number[],
        originalArgv: string[],
        tmpDir: string;

    beforeAll(() => {
        api = new API({ cwd: os.tmpdir() });
    });

    afterAll(() => {
        api.close();
    });

    beforeEach(() => {
        exits = [];
        originalArgv = process.argv;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-contract-'));

        vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
            exits.push(code ?? 0);

            throw new Error(`emit-contract-test: process.exit(${code ?? 0})`);
        }) as typeof process.exit);
    });

    afterEach(() => {
        process.argv = originalArgv;
        vi.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('passthrough-parity oracle: shipped config shape with zero plugins emits exact tree with rewritten alias', async () => {
        let tsconfigPath = createFixture(tmpDir, {
            sources: {
                'index.ts': "import { value } from '~/util';\n\nexport const result = value;\n",
                'util.ts': 'export const value = 1;\n'
            }
        });

        process.argv = [process.execPath, 'esportsplus-tsc', '-p', tsconfigPath];

        await expect(build(tsconfigPath, [], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(0);

        let buildDir = path.join(tmpDir, 'build');

        expect(snapshotTree(buildDir)).toEqual(['index.d.ts', 'index.js', 'util.d.ts', 'util.js']);

        let emitted = fs.readFileSync(path.join(buildDir, 'index.js'), 'utf8');

        expect(emitted).toContain('./util.js');
        expect(emitted).not.toContain('~/');
    });
});
