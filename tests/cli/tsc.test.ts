import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { API, type Diagnostic, DiagnosticCategory } from 'typescript/unstable/sync';
import { flatten, format } from '~/cli/diagnostics';
import { build, classifyFlags, isPlugin, loadPlugins, main, normalizePath, resolvePluginConfigs, runTscAlias } from '~/cli/tsc';


describe('isPlugin', () => {
    it('returns true for valid plugin', () => {
        expect(isPlugin({ transform: () => {} })).toBe(true);
    });

    it('returns false for null', () => {
        expect(isPlugin(null)).toBe(false);
    });

    it('returns false for empty object', () => {
        expect(isPlugin({})).toBe(false);
    });

    it('returns false when transform is not a function', () => {
        expect(isPlugin({ transform: 'not-fn' })).toBe(false);
    });

    it('returns false for primitives', () => {
        expect(isPlugin(42)).toBe(false);
        expect(isPlugin('str')).toBe(false);
        expect(isPlugin(undefined)).toBe(false);
    });
});


describe('normalizePath', () => {
    it('converts backslashes to forward slashes', () => {
        let result = normalizePath('C:\\foo\\bar.ts');

        expect(result).not.toContain('\\');
        expect(result).toContain('/foo/bar');
    });

    it('resolves to absolute path', () => {
        let result = normalizePath('relative/file.ts');

        expect(path.isAbsolute(result)).toBe(true);
    });
});


describe('loadPlugins', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loads a valid plugin with transform export', async () => {
        let pluginFile = 'plugin.mjs';

        fs.writeFileSync(path.join(tmpDir, pluginFile), 'export default { transform: () => ({}) };');

        let plugins = await loadPlugins([{ transform: './' + pluginFile }], tmpDir);

        expect(plugins).toHaveLength(1);
        expect(typeof plugins[0].transform).toBe('function');
    });

    it('loads a factory function that returns a plugin', async () => {
        let pluginFile = 'factory.mjs';

        fs.writeFileSync(path.join(tmpDir, pluginFile), 'export default function() { return { transform: () => ({}) }; };');

        let plugins = await loadPlugins([{ transform: './' + pluginFile }], tmpDir);

        expect(plugins).toHaveLength(1);
        expect(typeof plugins[0].transform).toBe('function');
    });

    it('loads array of plugins', async () => {
        let pluginFile = 'array.mjs';

        fs.writeFileSync(path.join(tmpDir, pluginFile), 'export default [{ transform: () => ({}) }, { transform: () => ({}) }];');

        let plugins = await loadPlugins([{ transform: './' + pluginFile }], tmpDir);

        expect(plugins).toHaveLength(2);
    });

    it('rejects an invalid plugin format instead of silently skipping', async () => {
        let pluginFile = 'invalid.mjs';

        fs.writeFileSync(path.join(tmpDir, pluginFile), 'export default { notTransform: true };');

        await expect(loadPlugins([{ transform: './' + pluginFile }], tmpDir)).rejects.toThrow(/invalid plugin format/);
    });

    it('rejects an invalid array element instead of silently dropping it', async () => {
        let pluginFile = 'mixed.mjs';

        fs.writeFileSync(path.join(tmpDir, pluginFile), 'export default [{ transform: () => ({}) }, { bad: true }];');

        await expect(loadPlugins([{ transform: './' + pluginFile }], tmpDir)).rejects.toThrow(/\[1\]/);
    });

    it('resolves relative paths from root', async () => {
        let pluginFile = 'relative.mjs';

        fs.writeFileSync(path.join(tmpDir, pluginFile), 'export default { transform: () => ({}) };');

        let plugins = await loadPlugins([{ transform: './' + pluginFile }], tmpDir);

        expect(plugins).toHaveLength(1);
    });
});


describe('runTscAlias', () => {
    it('returns 0 for --noEmit flag', async () => {
        let code = await runTscAlias(['--noEmit']);

        expect(code).toBe(0);
    });

    it('returns 0 for --help flag', async () => {
        let code = await runTscAlias(['--help']);

        expect(code).toBe(0);
    });

    it('returns 0 for --version flag', async () => {
        let code = await runTscAlias(['--version']);

        expect(code).toBe(0);
    });

    it('returns 0 for -v flag', async () => {
        let code = await runTscAlias(['-v']);

        expect(code).toBe(0);
    });
});


describe('classifyFlags', () => {
    it('flags every informational spelling as informational', () => {
        for (let arg of ['--help', '-h', '--version', '-v', '--init', '--showConfig']) {
            expect(classifyFlags([arg])).toEqual({ informational: true, noEmit: false, watch: false });
        }
    });

    it('flags both --noEmit spellings as noEmit', () => {
        expect(classifyFlags(['--noEmit'])).toEqual({ informational: false, noEmit: true, watch: false });
        expect(classifyFlags(['-noEmit'])).toEqual({ informational: false, noEmit: true, watch: false });
    });

    it('flags both watch spellings as watch', () => {
        expect(classifyFlags(['--watch'])).toEqual({ informational: false, noEmit: false, watch: true });
        expect(classifyFlags(['-w'])).toEqual({ informational: false, noEmit: false, watch: true });
    });

    it('leaves an ordinary build argv unflagged', () => {
        expect(classifyFlags(['-p', 'tsconfig.json'])).toEqual({ informational: false, noEmit: false, watch: false });
        expect(classifyFlags([])).toEqual({ informational: false, noEmit: false, watch: false });
    });
});


describe('build', () => {
    let api: API,
        exits: number[],
        originalArgv: string[],
        tmpDir: string;

    let markerPlugin = 'export default { transform: () => ({ prepend: ["export const __TRANSFORMED__ = 42;"] }) };';

    beforeAll(() => {
        api = new API({ cwd: os.tmpdir() });
    });

    afterAll(() => {
        api.close();
    });

    beforeEach(() => {
        exits = [];
        originalArgv = process.argv;
        process.argv = [process.execPath, 'esportsplus-tsc', '--noEmit'];
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-build-'));

        vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
            exits.push(code ?? 0);

            throw new Error(`build-test: process.exit(${code ?? 0})`);
        }) as typeof process.exit);
    });

    afterEach(() => {
        process.argv = originalArgv;
        vi.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('emits transformed sources to outDir and leaves originals untouched', async () => {
        let source = 'export const value = 1;\n',
            sourcePath = path.join(tmpDir, 'index.ts'),
            tsconfigPath = path.join(tmpDir, 'tsconfig.json');

        fs.writeFileSync(sourcePath, source);
        fs.writeFileSync(path.join(tmpDir, 'plugin.mjs'), markerPlugin);
        fs.writeFileSync(tsconfigPath, JSON.stringify({
            compilerOptions: { declaration: true, module: 'esnext', moduleResolution: 'bundler', outDir: './out', skipLibCheck: true, target: 'esnext' },
            files: ['./index.ts']
        }));

        await expect(build(tsconfigPath, [{ transform: './plugin.mjs' }], api)).rejects.toThrow(/process\.exit/);

        let emitted = path.join(tmpDir, 'out', 'index.js');

        expect(fs.existsSync(emitted)).toBe(true);
        expect(fs.readFileSync(emitted, 'utf8')).toContain('__TRANSFORMED__');
        expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
        expect(exits).toContain(0);
    });

    it('never writes the real source file at any point during a transformed emit', async () => {
        let source = 'export const value = 1;\n',
            sourcePath = path.join(tmpDir, 'index.ts'),
            tsconfigPath = path.join(tmpDir, 'tsconfig.json');

        fs.writeFileSync(sourcePath, source);
        fs.writeFileSync(path.join(tmpDir, 'plugin.mjs'), markerPlugin);
        fs.writeFileSync(tsconfigPath, JSON.stringify({
            compilerOptions: { declaration: true, module: 'esnext', moduleResolution: 'bundler', outDir: './out', skipLibCheck: true, target: 'esnext' },
            files: ['./index.ts']
        }));

        let normalizedSource = path.resolve(sourcePath).replace(/\\/g, '/'),
            original = fs.writeFileSync,
            writes: string[] = [];

        vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>): void => {
            let file = args[0];

            if (typeof file === 'string') {
                writes.push(path.resolve(file).replace(/\\/g, '/'));
            }

            (original as (...a: Parameters<typeof fs.writeFileSync>) => void)(...args);
        });

        await expect(build(tsconfigPath, [{ transform: './plugin.mjs' }], api)).rejects.toThrow(/process\.exit/);

        expect(writes.length).toBeGreaterThan(0);
        expect(writes).not.toContain(normalizedSource);
        expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);

        let emitted = path.join(tmpDir, 'out', 'index.js');

        expect(fs.existsSync(emitted)).toBe(true);
        expect(fs.readFileSync(emitted, 'utf8')).toContain('__TRANSFORMED__');
    });

    it('consumes a JSONC tsconfig (comments + trailing commas) and applies its plugin', async () => {
        let sourcePath = path.join(tmpDir, 'index.ts'),
            tsconfigPath = path.join(tmpDir, 'tsconfig.json');

        fs.writeFileSync(sourcePath, 'export const value = 1;\n');
        fs.writeFileSync(path.join(tmpDir, 'plugin.mjs'), markerPlugin);
        fs.writeFileSync(tsconfigPath, [
            '{',
            '    // project options',
            '    "compilerOptions": {',
            '        "declaration": true,',
            '        "module": "esnext",',
            '        "moduleResolution": "bundler",',
            '        "outDir": "./out",',
            '        "skipLibCheck": true,',
            '        "target": "esnext",',
            '    },',
            '    /* files to compile */',
            '    "files": ["./index.ts"],',
            '}',
            ''
        ].join('\n'));

        await expect(build(tsconfigPath, [{ transform: './plugin.mjs' }], api)).rejects.toThrow(/process\.exit/);

        let emitted = path.join(tmpDir, 'out', 'index.js');

        expect(fs.existsSync(emitted)).toBe(true);
        expect(fs.readFileSync(emitted, 'utf8')).toContain('__TRANSFORMED__');
    });

    it('gates a type error with a nonzero exit before emit', async () => {
        let tsconfigPath = path.join(tmpDir, 'tsconfig.json');

        fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export const broken: number = "not a number";\n');
        fs.writeFileSync(tsconfigPath, JSON.stringify({
            compilerOptions: { module: 'esnext', moduleResolution: 'bundler', outDir: './out', skipLibCheck: true, target: 'esnext' },
            files: ['./index.ts']
        }));

        await expect(build(tsconfigPath, [], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(1);
        expect(fs.existsSync(path.join(tmpDir, 'out'))).toBe(false);
    });

    it('--noEmit runs the transform + typecheck gate but writes no artifacts', async () => {
        let sourcePath = path.join(tmpDir, 'index.ts'),
            tsconfigPath = path.join(tmpDir, 'tsconfig.json');

        fs.writeFileSync(sourcePath, 'export const value = 1;\n');
        fs.writeFileSync(path.join(tmpDir, 'plugin.mjs'), markerPlugin);
        fs.writeFileSync(tsconfigPath, JSON.stringify({
            compilerOptions: { declaration: true, module: 'esnext', moduleResolution: 'bundler', outDir: './out', skipLibCheck: true, target: 'esnext' },
            files: ['./index.ts']
        }));

        await expect(build(tsconfigPath, [{ transform: './plugin.mjs' }], api, true)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(0);
        expect(fs.existsSync(path.join(tmpDir, 'out'))).toBe(false);
    });

    it('--noEmit still gates a type error with exit 1 and writes no artifacts', async () => {
        let tsconfigPath = path.join(tmpDir, 'tsconfig.json');

        fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export const broken: number = "not a number";\n');
        fs.writeFileSync(path.join(tmpDir, 'plugin.mjs'), markerPlugin);
        fs.writeFileSync(tsconfigPath, JSON.stringify({
            compilerOptions: { module: 'esnext', moduleResolution: 'bundler', outDir: './out', skipLibCheck: true, target: 'esnext' },
            files: ['./index.ts']
        }));

        await expect(build(tsconfigPath, [{ transform: './plugin.mjs' }], api, true)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(1);
        expect(exits).not.toContain(0);
        expect(fs.existsSync(path.join(tmpDir, 'out'))).toBe(false);
    });

    it('a plugin that fails isPlugin is a hard failure: exit 1, prefixed error, no output', async () => {
        let tsconfigPath = path.join(tmpDir, 'tsconfig.json');

        fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export const value = 1;\n');
        fs.writeFileSync(path.join(tmpDir, 'plugin.mjs'), 'export default {};');
        fs.writeFileSync(tsconfigPath, JSON.stringify({
            compilerOptions: { module: 'esnext', moduleResolution: 'bundler', outDir: './out', skipLibCheck: true, target: 'esnext' },
            files: ['./index.ts']
        }));

        let errors: string[] = [];

        vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => { errors.push(String(msg)); });

        await expect(build(tsconfigPath, [{ transform: './plugin.mjs' }], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(1);
        expect(errors.some((line) => line.includes('@esportsplus/typescript') && line.includes('invalid plugin format'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'out'))).toBe(false);
    });

    it('an invalid array element aborts the whole build: exit 1, indexed error, no output', async () => {
        let tsconfigPath = path.join(tmpDir, 'tsconfig.json');

        fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export const value = 1;\n');
        fs.writeFileSync(path.join(tmpDir, 'plugin.mjs'), 'export default [{ transform: () => ({}) }, { bad: true }];');
        fs.writeFileSync(tsconfigPath, JSON.stringify({
            compilerOptions: { module: 'esnext', moduleResolution: 'bundler', outDir: './out', skipLibCheck: true, target: 'esnext' },
            files: ['./index.ts']
        }));

        let errors: string[] = [];

        vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => { errors.push(String(msg)); });

        await expect(build(tsconfigPath, [{ transform: './plugin.mjs' }], api)).rejects.toThrow(/process\.exit/);

        expect(exits).toContain(1);
        expect(errors.some((line) => line.includes('@esportsplus/typescript') && line.includes('[1]'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'out'))).toBe(false);
    });

    it('resolves a plugin declared in an extended base config and runs the transform', async () => {
        let sourcePath = path.join(tmpDir, 'index.ts'),
            tsconfigPath = path.join(tmpDir, 'tsconfig.json');

        fs.writeFileSync(sourcePath, 'export const value = 1;\n');
        fs.writeFileSync(path.join(tmpDir, 'plugin.mjs'), markerPlugin);
        fs.writeFileSync(path.join(tmpDir, 'base.json'), JSON.stringify({
            compilerOptions: { declaration: true, module: 'esnext', moduleResolution: 'bundler', outDir: './out', plugins: [{ transform: './plugin.mjs' }], skipLibCheck: true, target: 'esnext' }
        }));
        fs.writeFileSync(tsconfigPath, JSON.stringify({
            extends: './base.json',
            files: ['./index.ts']
        }));

        let configs = resolvePluginConfigs(tsconfigPath);

        expect(configs).toEqual([{ transform: './plugin.mjs' }]);

        await expect(build(tsconfigPath, configs, api)).rejects.toThrow(/process\.exit/);

        let emitted = path.join(tmpDir, 'out', 'index.js');

        expect(exits).toContain(0);
        expect(fs.existsSync(emitted)).toBe(true);
        expect(fs.readFileSync(emitted, 'utf8')).toContain('__TRANSFORMED__');
    });
});


describe('resolvePluginConfigs extends resolution', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-extends-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('resolves a plugin from a package-specifier extends via require.resolve', () => {
        let pkgDir = path.join(tmpDir, 'node_modules', 'shared-config'),
            tsconfigPath = path.join(tmpDir, 'tsconfig.json');

        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'shared-config', version: '1.0.0' }));
        fs.writeFileSync(path.join(pkgDir, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { plugins: [{ transform: './plugin.mjs' }] }
        }));
        fs.writeFileSync(tsconfigPath, JSON.stringify({
            extends: 'shared-config/tsconfig.json',
            files: ['./index.ts']
        }));

        expect(resolvePluginConfigs(tsconfigPath)).toEqual([{ transform: './plugin.mjs' }]);
    });

    it('merges plugins across an array of extends, the later base winning', () => {
        let tsconfigPath = path.join(tmpDir, 'tsconfig.json');

        fs.writeFileSync(path.join(tmpDir, 'a.json'), JSON.stringify({ compilerOptions: { strict: true } }));
        fs.writeFileSync(path.join(tmpDir, 'b.json'), JSON.stringify({ compilerOptions: { plugins: [{ transform: './plugin.mjs' }] } }));
        fs.writeFileSync(tsconfigPath, JSON.stringify({
            extends: ['./a.json', './b.json'],
            files: ['./index.ts']
        }));

        expect(resolvePluginConfigs(tsconfigPath)).toEqual([{ transform: './plugin.mjs' }]);
    });

    it('returns no configs when no config in the chain declares plugins', () => {
        let tsconfigPath = path.join(tmpDir, 'tsconfig.json');

        fs.writeFileSync(path.join(tmpDir, 'base.json'), JSON.stringify({ compilerOptions: { strict: true } }));
        fs.writeFileSync(tsconfigPath, JSON.stringify({
            extends: './base.json',
            files: ['./index.ts']
        }));

        expect(resolvePluginConfigs(tsconfigPath)).toEqual([]);
    });
});


describe('main flag gating', () => {
    let exits: number[],
        originalArgv: string[],
        tmpDir: string;

    beforeEach(() => {
        exits = [];
        originalArgv = process.argv;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-main-'));

        vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
            exits.push(code ?? 0);

            throw new Error(`main-test: process.exit(${code ?? 0})`);
        }) as typeof process.exit);
    });

    afterEach(() => {
        process.argv = originalArgv;
        vi.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('--watch on a plugin project exits 1 with a prefixed error and never builds', () => {
        fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export const value = 1;\n');
        fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { module: 'esnext', moduleResolution: 'bundler', outDir: './out', plugins: [{ transform: './plugin.mjs' }], skipLibCheck: true, target: 'esnext' },
            files: ['./index.ts']
        }));

        let errors: string[] = [];

        vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
        vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => { errors.push(String(msg)); });
        vi.spyOn(console, 'log').mockImplementation(() => {});

        process.argv = [process.execPath, 'esportsplus-tsc', '--watch'];

        expect(() => main()).toThrow(/process\.exit/);
        expect(exits).toContain(1);
        expect(errors.some((line) => line.includes('@esportsplus/typescript') && line.includes('--watch'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'out'))).toBe(false);
    });
});


describe('diagnostics', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-diag-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('flatten concatenates a nested messageChain with indentation', () => {
        let diagnostic: Diagnostic = {
            category: DiagnosticCategory.Error,
            code: 2322,
            end: 5,
            messageChain: [
                {
                    category: DiagnosticCategory.Error,
                    code: 2322,
                    end: 5,
                    messageChain: [
                        { category: DiagnosticCategory.Error, code: 2322, end: 5, pos: 0, text: 'Leaf detail.' }
                    ],
                    pos: 0,
                    text: 'Child reason.'
                }
            ],
            pos: 0,
            text: 'Top level error.'
        };

        let result = flatten(diagnostic);

        expect(result).toContain('Top level error.');
        expect(result).toContain('\n  Child reason.');
        expect(result).toContain('\n    Leaf detail.');
    });

    it('format renders a fileless diagnostic without a location header', () => {
        let diagnostic: Diagnostic = {
            category: DiagnosticCategory.Error,
            code: 1234,
            end: 0,
            pos: 0,
            text: 'Global failure.'
        };

        let clean = format([diagnostic], tmpDir).replace(/\x1b\[[0-9;]*m/g, '');

        expect(clean).toContain('error TS1234: Global failure.');
        expect(clean).not.toContain(':1:1');
    });

    it('format places a caret underline under the offending source range', () => {
        let source = 'const a = 1;\nconst bad = 2;\n',
            sourcePath = path.join(tmpDir, 'source.ts'),
            pos = source.indexOf('bad');

        fs.writeFileSync(sourcePath, source);

        let diagnostic: Diagnostic = {
            category: DiagnosticCategory.Error,
            code: 2451,
            end: pos + 3,
            fileName: sourcePath,
            pos,
            text: 'Cannot redeclare block-scoped variable.'
        };

        let clean = format([diagnostic], tmpDir).replace(/\x1b\[[0-9;]*m/g, '');

        expect(clean).toContain('source.ts:2:7');
        expect(clean).toContain('const bad = 2;');
        expect(clean).toContain('~~~');
    });
});
