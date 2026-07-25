import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { API } from 'typescript/unstable/sync';
import { build } from '~/cli/tsc';
import { createFixture, MARKER_PLUGIN, snapshotTree } from './fixtures';


const IMPORT_INJECT_PLUGIN = 'export default { patterns: ["~/util"], transform: () => ({ imports: [{ package: "~/runtime", add: ["helper"] }], prepend: ["export const injected = helper;"] }) };';


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

    it('shipped shape (declaration) keeps .d.ts parity and applies the plugin transform', async () => {
        let buildDir = path.join(tmpDir, 'build'),
            tsconfigPath = createFixture(tmpDir, {
                sources: {
                    'index.ts': "import { value } from '~/util';\n\nexport const result = value;\n",
                    'util.ts': 'export const value = 1;\n'
                }
            });

        fs.writeFileSync(path.join(tmpDir, 'plugin.mjs'), MARKER_PLUGIN);
        process.argv = [process.execPath, 'esportsplus-tsc', '-p', tsconfigPath];

        await expect(build(tsconfigPath, [], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(0);

        let reference = snapshotTree(buildDir);

        fs.rmSync(buildDir, { force: true, recursive: true });
        exits.length = 0;

        await expect(build(tsconfigPath, [{ transform: './plugin.mjs' }], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(0);

        let plugged = snapshotTree(buildDir);

        expect(plugged).toEqual(reference);
        expect(plugged.filter((entry) => entry.endsWith('.d.ts'))).toEqual(['index.d.ts', 'util.d.ts']);
        expect(fs.readFileSync(path.join(buildDir, 'index.js'), 'utf8')).toContain('__TRANSFORMED__');
        expect(fs.readFileSync(path.join(buildDir, 'util.js'), 'utf8')).toContain('__TRANSFORMED__');
    });

    it('alias fixture resolves ~/ specifiers for author-written and plugin-injected imports alike', async () => {
        let buildDir = path.join(tmpDir, 'build'),
            tsconfigPath = createFixture(tmpDir, {
                compilerOptions: { noUnusedLocals: false },
                sources: {
                    'index.ts': "import { value } from '~/util';\n\nexport const result = value;\n",
                    'runtime.ts': 'export const helper = 1;\n',
                    'util.ts': 'export const value = 1;\n'
                }
            });

        fs.writeFileSync(path.join(tmpDir, 'plugin.mjs'), IMPORT_INJECT_PLUGIN);
        process.argv = [process.execPath, 'esportsplus-tsc', '-p', tsconfigPath];

        await expect(build(tsconfigPath, [], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(0);

        let reference = snapshotTree(buildDir);

        fs.rmSync(buildDir, { force: true, recursive: true });
        exits.length = 0;

        await expect(build(tsconfigPath, [{ transform: './plugin.mjs' }], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(0);
        expect(snapshotTree(buildDir)).toEqual(reference);

        let emitted = fs.readFileSync(path.join(buildDir, 'index.js'), 'utf8');

        expect(emitted).not.toContain('~/');
        expect(emitted).toContain('./util.js');
        expect(emitted).toContain('./runtime.js');
    });

    it('literal-relative include shape exits 0 and keeps tree parity (TS6059 regression)', async () => {
        let outDir = path.join(tmpDir, 'out'),
            tsconfigPath = createFixture(tmpDir, {
                sources: {
                    'index.ts': 'export const a = 1;\n',
                    'util.ts': 'export const b = 2;\n'
                },
                tsconfig: {
                    compilerOptions: {
                        declaration: true,
                        module: 'esnext',
                        moduleResolution: 'bundler',
                        outDir: './out',
                        rootDir: './src',
                        skipLibCheck: true,
                        target: 'esnext'
                    },
                    include: ['./src/**/*']
                }
            });

        fs.writeFileSync(path.join(tmpDir, 'plugin.mjs'), MARKER_PLUGIN);
        process.argv = [process.execPath, 'esportsplus-tsc', '-p', tsconfigPath];

        await expect(build(tsconfigPath, [], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(0);

        let reference = snapshotTree(outDir);

        fs.rmSync(outDir, { force: true, recursive: true });
        exits.length = 0;

        await expect(build(tsconfigPath, [{ transform: './plugin.mjs' }], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(0);
        expect(exits).not.toContain(2);
        expect(snapshotTree(outDir)).toEqual(reference);
        expect(fs.readFileSync(path.join(outDir, 'index.js'), 'utf8')).toContain('__TRANSFORMED__');
    });

    it('files + rootDir shape emits at the output root with no gained src segment', async () => {
        let outDir = path.join(tmpDir, 'out'),
            tsconfigPath = createFixture(tmpDir, {
                sources: {
                    'index.ts': 'export const a = 1;\n'
                },
                tsconfig: {
                    compilerOptions: {
                        declaration: false,
                        module: 'esnext',
                        moduleResolution: 'bundler',
                        outDir: './out',
                        rootDir: './src',
                        skipLibCheck: true,
                        sourceMap: true,
                        target: 'esnext'
                    },
                    files: ['./src/index.ts']
                }
            });

        fs.writeFileSync(path.join(tmpDir, 'plugin.mjs'), MARKER_PLUGIN);
        process.argv = [process.execPath, 'esportsplus-tsc', '-p', tsconfigPath];

        await expect(build(tsconfigPath, [], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(0);

        let reference = snapshotTree(outDir);

        expect(reference).toEqual(['index.js', 'index.js.map']);

        fs.rmSync(outDir, { force: true, recursive: true });
        exits.length = 0;

        await expect(build(tsconfigPath, [{ transform: './plugin.mjs' }], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(0);

        let plugged = snapshotTree(outDir);

        expect(plugged).toEqual(['index.js', 'index.js.map']);
        expect(plugged.every((entry) => !entry.startsWith('src/'))).toBe(true);
        expect(fs.existsSync(path.join(outDir, 'index.js.map'))).toBe(true);
        expect(fs.readFileSync(path.join(outDir, 'index.js'), 'utf8')).toContain('__TRANSFORMED__');
    });
});
