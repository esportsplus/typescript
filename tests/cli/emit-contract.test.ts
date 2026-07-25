import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { API } from 'typescript/unstable/sync';
import { build } from '~/cli/tsc';
import { createFixture, MARKER_PLUGIN, snapshotTree } from './fixtures';


const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const IMPORT_INJECT_PLUGIN = 'export default { patterns: ["~/util"], transform: () => ({ imports: [{ package: "~/runtime", add: ["helper"] }], prepend: ["export const injected = helper;"] }) };';


function decodeSegments(mappings: string): { originalColumn: number; originalLine: number }[] {
    let inverse: Record<string, number> = {},
        origColumn = 0,
        origLine = 0,
        out: { originalColumn: number; originalLine: number }[] = [],
        source = 0;

    for (let i = 0; i < BASE64.length; i++) {
        inverse[BASE64[i]] = i;
    }

    let lines = mappings.split(';');

    for (let l = 0, n = lines.length; l < n; l++) {
        if (lines[l] === '') {
            continue;
        }

        let tokens = lines[l].split(',');

        for (let t = 0, m = tokens.length; t < m; t++) {
            let token = tokens[t],
                values: number[] = [],
                i = 0;

            while (i < token.length) {
                let digit = 0,
                    result = 0,
                    shift = 0;

                do {
                    digit = inverse[token[i]];
                    i++;
                    result += (digit & 31) << shift;
                    shift += 5;
                }
                while (digit & 32);

                values.push((result & 1) ? -(result >>> 1) : (result >>> 1));
            }

            if (values.length >= 4) {
                source += values[1];
                origLine += values[2];
                origColumn += values[3];
                out.push({ originalColumn: origColumn, originalLine: origLine });
            }
        }
    }

    return out;
}


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

    it('composed .js.map resolves post-injection lines and untouched columns to real source', async () => {
        let outDir = path.join(tmpDir, 'out'),
            source = 'export const untouched = 123;\nexport const value = untouched + 1;\n',
            tsconfigPath = createFixture(tmpDir, {
                sources: {
                    'index.ts': source
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

        await expect(build(tsconfigPath, [{ transform: './plugin.mjs' }], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(0);

        let map = JSON.parse(fs.readFileSync(path.join(outDir, 'index.js.map'), 'utf8')),
            segments = decodeSegments(map.mappings),
            lines = source.split('\n');

        expect(map.sources).toEqual(['../src/index.ts']);
        expect(map.sourcesContent).toBeUndefined();

        // No segment may resolve past the last real source line (bug produced phantom lines from the mirror's injected offset).
        expect(segments.every((s) => s.originalLine <= 1)).toBe(true);

        // Both real source lines are reachable — post-injection lines are not collapsed onto line 0.
        expect(segments.some((s) => s.originalLine === 0)).toBe(true);
        expect(segments.some((s) => s.originalLine === 1)).toBe(true);

        // Untouched column on an untouched line resolves exactly: the `untouched` reference on real line 1.
        let referenceColumn = lines[1].indexOf('untouched');

        expect(referenceColumn).toBeGreaterThan(0);
        expect(segments.some((s) => s.originalLine === 1 && s.originalColumn === referenceColumn)).toBe(true);

        // And its declaration on real line 0 at its own exact column.
        let declarationColumn = lines[0].indexOf('untouched');

        expect(segments.some((s) => s.originalLine === 0 && s.originalColumn === declarationColumn)).toBe(true);
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

    it('fixtures helper is a non-suite module vitest discovery never runs', () => {
        let helper = path.resolve(import.meta.dirname, 'fixtures.ts');

        expect(fs.existsSync(helper)).toBe(true);
        expect(path.basename(helper).endsWith('.test.ts')).toBe(false);
        expect(typeof createFixture).toBe('function');
        expect(typeof snapshotTree).toBe('function');
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
