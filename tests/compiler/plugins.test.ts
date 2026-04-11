import { beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

import type { Plugin } from '~/compiler/types';

import tsc from '~/compiler/plugins/tsc';
import vite from '~/compiler/plugins/vite';

vi.mock('~/compiler/language-service', () => ({
    default: {
        invalidate: vi.fn(),
        update: vi.fn((_root: string, fileName: string, content: string) => {
            let file = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);

            return {
                getSourceFile: () => file,
                getTypeChecker: () => ({} as ts.TypeChecker)
            } as unknown as ts.Program;
        })
    }
}));

vi.mock('~/compiler/coordinator', () => ({
    default: {
        transform: vi.fn((_plugins: Plugin[], code: string, _file: ts.SourceFile, _prog: ts.Program, _root: string, _ctx: Map<string, unknown>) => ({
            changed: false,
            code,
            sourceFile: {} as ts.SourceFile
        }))
    }
}));

import coordinator from '~/compiler/coordinator';
import languageService from '~/compiler/language-service';


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
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        let result = plugin.transform('let x = 1;', 'src/app.ts');

        expect(result).toBeNull();
        expect(coordinator.transform).toHaveBeenCalled();
    });

    it('returns transformed code when changed', () => {
        vi.mocked(coordinator.transform).mockReturnValueOnce({
            changed: true,
            code: 'TRANSFORMED',
            sourceFile: {} as ts.SourceFile
        });

        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        let result = plugin.transform('let x = 1;', 'src/app.ts');

        expect(result).toEqual({ code: 'TRANSFORMED', map: null });
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
});
