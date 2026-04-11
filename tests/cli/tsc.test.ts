import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { isPlugin, loadPlugins, normalizePath, runTscAlias } from '~/cli/tsc';


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

    it('skips invalid plugin format with error', async () => {
        let pluginFile = 'invalid.mjs';

        fs.writeFileSync(path.join(tmpDir, pluginFile), 'export default { notTransform: true };');

        let spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        let plugins = await loadPlugins([{ transform: './' + pluginFile }], tmpDir);

        expect(plugins).toHaveLength(0);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it('skips invalid array element with error', async () => {
        let pluginFile = 'mixed.mjs';

        fs.writeFileSync(path.join(tmpDir, pluginFile), 'export default [{ transform: () => ({}) }, { bad: true }];');

        let spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        let plugins = await loadPlugins([{ transform: './' + pluginFile }], tmpDir);

        expect(plugins).toHaveLength(1);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
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
