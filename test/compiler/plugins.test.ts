import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Checker, Program } from 'typescript/unstable/sync';
import type { Plugin } from '~/compiler/types';
import type { SourceFile } from 'typescript/unstable/ast';

import coordinator from '~/compiler/coordinator';
import languageService from '~/compiler/language-service';
import tsc from '~/compiler/plugins/tsc';
import vite from '~/compiler/plugins/vite';


vi.mock('~/compiler/language-service', () => ({
    default: {
        dispose: vi.fn(),
        invalidate: vi.fn(),
        parse: vi.fn((fileName: string, content: string) => ({ fileName, text: content }) as unknown as SourceFile),
        update: vi.fn((_root: string, _fileName: string, _content: string) => ({
            checker: {} as unknown as Checker,
            program: { getSourceFile: () => undefined } as unknown as Program
        }))
    }
}));

vi.mock('~/compiler/coordinator', () => ({
    default: {
        transform: vi.fn((_plugins: Plugin[], code: string, _file: SourceFile, _project: { checker: Checker; program: Program }, _root: string, _ctx: Map<string, unknown>) => ({
            changed: false,
            code,
            map: { generations: [] },
            sourceFile: {} as SourceFile
        }))
    }
}));


describe('plugin.tsc', () => {
    it('returns a function that returns the plugins array', () => {
        let p1: Plugin = { transform: () => ({}) },
            p2: Plugin = { transform: () => ({}) },
            factory = tsc([p1, p2]),
            result = factory();

        expect(result).toEqual([p1, p2]);
    });

    it('returns empty array for empty input', () => {
        let result = tsc([])();

        expect(result).toEqual([]);
    });
});


describe('plugin.vite', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('creates VitePlugin with correct shape', () => {
        let factory = vite({ name: 'test-pkg', plugins: [] }),
            plugin = factory();

        expect(plugin).toHaveProperty('closeBundle');
        expect(plugin).toHaveProperty('closeWatcher');
        expect(plugin).toHaveProperty('configResolved');
        expect(plugin).toHaveProperty('enforce');
        expect(plugin).toHaveProperty('name');
        expect(plugin).toHaveProperty('transform');
        expect(plugin).toHaveProperty('watchChange');
    });

    it('name includes package name', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(plugin.name).toBe('test-pkg/compiler/vite');
    });

    it('filters non-ts files', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(plugin.transform('code', 'file.css')).toBeNull();
    });

    it('filters node_modules', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(plugin.transform('code', 'node_modules/pkg/index.ts')).toBeNull();
    });

    it('processes .ts files — returns null when unchanged', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })(),
            result = plugin.transform('let x = 1;', 'src/app.ts');

        expect(result).toBeNull();
        expect(coordinator.transform).toHaveBeenCalled();
    });

    it('returns transformed code with a non-null composed map when changed', () => {
        vi.mocked(coordinator.transform).mockReturnValueOnce({
            changed: true,
            code: 'TRANSFORMED',
            map: { generations: [] },
            sourceFile: {} as SourceFile
        });

        let plugin = vite({ name: 'test-pkg', plugins: [] })(),
            result = plugin.transform('let x = 1;', 'src/app.ts');

        expect(result).not.toBeNull();
        expect(result?.code).toBe('TRANSFORMED');
        expect(result?.map).not.toBeNull();
        expect(result?.map.version).toBe(3);
        expect(result?.map.sources).toContain('src/app.ts');
        expect(typeof result?.map.mappings).toBe('string');
    });

    it('returns null (no map) when unchanged', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(plugin.transform('let x = 1;', 'src/app.ts')).toBeNull();
    });

    it('watchChange calls onWatchChange and invalidate', () => {
        let onWatchChange = vi.fn(),
            plugin = vite({ name: 'test-pkg', onWatchChange, plugins: [] })();

        plugin.watchChange('src/app.ts');

        expect(onWatchChange).toHaveBeenCalled();
        expect(languageService.invalidate).toHaveBeenCalledWith('', 'src/app.ts');
    });

    it('watchChange ignores non-ts files', () => {
        let onWatchChange = vi.fn(),
            plugin = vite({ name: 'test-pkg', onWatchChange, plugins: [] })();

        plugin.watchChange('style.css');

        expect(onWatchChange).not.toHaveBeenCalled();
    });

    it('configResolved sets root', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        plugin.configResolved({ root: '/my/root' });
        plugin.transform('let x = 1;', 'src/app.ts');

        expect(languageService.update).toHaveBeenCalledWith('/my/root', expect.any(String), expect.any(String));
    });

    it('catches coordinator.transform() error and returns null', () => {
        vi.mocked(coordinator.transform).mockImplementationOnce(() => {
            throw new Error('transform failed');
        });

        let consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {}),
            plugin = vite({ name: 'test-pkg', plugins: [] })(),
            result = plugin.transform('let x = 1;', 'src/app.ts');

        expect(result).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('test-pkg'),
            expect.any(Error)
        );

        consoleSpy.mockRestore();
    });

    it('falls back to languageService.parse when getSourceFile returns undefined', () => {
        vi.mocked(languageService.update).mockReturnValueOnce({
            checker: {} as unknown as Checker,
            program: { getSourceFile: () => undefined } as unknown as Program
        });

        let plugin = vite({ name: 'test-pkg', plugins: [] })(),
            result = plugin.transform('let x = 1;', 'src/app.ts');

        expect(result).toBeNull();
        expect(languageService.parse).toHaveBeenCalled();
        expect(coordinator.transform).toHaveBeenCalled();
    });

    it('closeBundle disposes the language service for the root', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        plugin.configResolved({ root: '/my/root' });
        plugin.closeBundle();

        expect(languageService.dispose).toHaveBeenCalledWith('/my/root');
    });

    it('closeWatcher disposes the language service for the root', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        plugin.configResolved({ root: '/my/root' });
        plugin.closeWatcher();

        expect(languageService.dispose).toHaveBeenCalledWith('/my/root');
    });
});
