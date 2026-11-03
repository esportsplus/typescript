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
