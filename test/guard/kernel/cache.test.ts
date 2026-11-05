import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeConfig, Diagnostic } from '~/guard/kernel/types';

import cache from '~/guard/kernel/cache';
import fs from 'fs';
import os from 'os';
import path from 'path';


const FINDING: Diagnostic = {
    channel: 'exceptions',
    location: { column: 1, end: 5, fileName: 'src/a.ts', line: 1, pos: 0 },
    message: 'finding',
    related: []
};


describe('guard/kernel/cache', () => {
    let config: AnalyzeConfig,
        files: string[],
        root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cache-'));
        fs.mkdirSync(path.join(root, 'node_modules'));
        fs.mkdirSync(path.join(root, 'src'));
        fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;');
        fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
        config = { channels: { exceptions: { options: {}, severity: 'error' } }, projectRoot: root, tsconfigPath: path.join(root, 'tsconfig.json') };
        files = [path.join(root, 'src/a.ts')];
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        fs.rmSync(root, { force: true, recursive: true });
    });

    it('reuses the findings of an unchanged project', () => {
        let run = vi.fn(() => [FINDING]);

        expect(cache.findings(config, files, run)).toEqual([FINDING]);
        expect(cache.findings(config, files, run)).toEqual([FINDING]);
        expect(run).toHaveBeenCalledTimes(1);
        expect(fs.readdirSync(path.join(root, 'node_modules/.cache/@esportsplus/typescript/guard'))).toHaveLength(1);
    });

    it('re-runs when a file, the file set, the config or the lockfile changes', () => {
        let run = vi.fn(() => [FINDING]);

        cache.findings(config, files, run);
        fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 2;');
        cache.findings(config, files, run);
        fs.writeFileSync(path.join(root, 'src/b.ts'), '');
        cache.findings(config, [...files, path.join(root, 'src/b.ts')], run);
        cache.findings({ ...config, channels: { exceptions: { options: {}, severity: 'warn' } } }, [...files, path.join(root, 'src/b.ts')], run);
        fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
        cache.findings({ ...config, channels: { exceptions: { options: {}, severity: 'warn' } } }, [...files, path.join(root, 'src/b.ts')], run);

        expect(run).toHaveBeenCalledTimes(5);
    });

    it('keeps one entry per tsconfig', () => {
        let run = vi.fn(() => []),
            other = { ...config, tsconfigPath: path.join(root, 'tsconfig.build.json') };

        cache.findings(config, files, run);
        cache.findings(other, files, run);
        cache.findings(config, files, run);
        cache.findings(other, files, run);

        expect(run).toHaveBeenCalledTimes(2);
    });

    it('is disabled by ESPORTSPLUS_ANALYZE_CACHE=0', () => {
        let run = vi.fn(() => []);

        vi.stubEnv('ESPORTSPLUS_ANALYZE_CACHE', '0');
        cache.findings(config, files, run);
        cache.findings(config, files, run);

        expect(run).toHaveBeenCalledTimes(2);
    });
});

describe('guard/kernel/cache stamp', () => {
    const ANALYZER: Record<string, string> = {
        'build/cache.js': 'export default {};',
        'build/constants.js': "export const PACKAGE_NAME = 'x';",
        'build/guard/kernel/analyze.js': 'export const analyze = () => [];',
        'build/guard/kernel/cache.js': 'export default {};',
        'build/guard/overlay/base/exceptions.jsonc': '{}',
        'build/jsonc.js': 'export const stripJsonc = (s) => s;',
        'build/timing.js': 'export default () => () => {};',
        'build/tsconfig.js': 'export const readPlugins = () => [];',
        'package.json': '{"name":"@esportsplus/typescript","version":"1.0.0"}'
    };

    let installs: string[] = [];

    // A package's files written now, every one stamped with `time`, as a fresh install writes them
    function install(time: Date, files: Record<string, string> = ANALYZER): string {
        let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-stamp-'));

        installs.push(directory);

        for (let [name, content] of Object.entries(files)) {
            let file = path.join(directory, name);

            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, content);
            fs.utimesSync(file, time, time);
        }

        return path.join(directory, 'build', 'guard');
    }

    afterEach(() => {
        for (let directory of installs) {
            fs.rmSync(directory, { force: true, recursive: true });
        }

        installs = [];
    });

    it('is the same for two installs of one build written at different times', () => {
        let first = install(new Date('2026-01-01T00:00:00Z')),
            second = install(new Date('2026-06-01T12:00:00Z'));

        expect(fs.statSync(path.join(first, 'kernel/cache.js')).mtimeMs).not.toBe(fs.statSync(path.join(second, 'kernel/cache.js')).mtimeMs);
        expect(cache.stamp(second, '.js')).toBe(cache.stamp(first, '.js'));
    });

    it('changes with any file of the analyzer, a module beside it or its version', () => {
        let time = new Date('2026-01-01T00:00:00Z'),
            base = cache.stamp(install(time), '.js');

        expect(cache.stamp(install(time, { ...ANALYZER, 'build/guard/kernel/analyze.js': 'export const analyze = () => [1];' }), '.js')).not.toBe(base);
        expect(cache.stamp(install(time, { ...ANALYZER, 'build/guard/overlay/base/exceptions.jsonc': '{"a":1}' }), '.js')).not.toBe(base);
        expect(cache.stamp(install(time, { ...ANALYZER, 'build/jsonc.js': 'export const stripJsonc = (s) => s.trim();' }), '.js')).not.toBe(base);
        expect(cache.stamp(install(time, { ...ANALYZER, 'package.json': '{"name":"@esportsplus/typescript","version":"1.0.1"}' }), '.js')).not.toBe(base);
    });

    it('is the stamp a cache restored onto a fresh install of this analyzer is keyed by', () => {
        let root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-restored-')),
            run = vi.fn(() => [FINDING]);

        installs.push(root);
        fs.mkdirSync(path.join(root, 'node_modules'));
        fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;');

        let config: AnalyzeConfig = { channels: {}, projectRoot: root, tsconfigPath: path.join(root, 'tsconfig.json') };

        cache.findings(config, [path.join(root, 'a.ts')], run);

        let saved = path.join(root, 'saved');

        fs.cpSync(path.join(root, 'node_modules/.cache'), saved, { recursive: true });
        fs.rmSync(path.join(root, 'node_modules'), { force: true, recursive: true });
        fs.mkdirSync(path.join(root, 'node_modules'));
        fs.cpSync(saved, path.join(root, 'node_modules/.cache'), { recursive: true });

        expect(cache.findings(config, [path.join(root, 'a.ts')], run)).toEqual([FINDING]);
        expect(run).toHaveBeenCalledTimes(1);
    });
});
