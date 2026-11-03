import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { Checker, Program } from 'typescript/unstable/sync';
import type { Plugin } from '~/compiler/types';
import type { SourceFile } from 'typescript/unstable/ast';

import coordinator from '~/compiler/coordinator';
import languageService from '~/compiler/language-service';
import tsc from '~/compiler/plugins/tsc';
import vite from '~/compiler/plugins/vite';


vi.mock('~/compiler/language-service', () => ({
    default: {
        contains: vi.fn(() => true),
        dispose: vi.fn(),
        findConfig: vi.fn(() => ''),
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
        accepts: vi.fn(() => true),
        transform: vi.fn((_plugins: Plugin[], code: string, _file: SourceFile, _project: { checker: Checker; program: Program }, _root: string, _ctx: Map<string, unknown>) => ({
            changed: false,
            code,
            dependencies: [] as string[],
            map: { generations: [] }
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

        expect(plugin.transform.handler('code', 'file.css')).toBeNull();
    });

    it('filters node_modules', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(plugin.transform.handler('code', 'node_modules/pkg/index.ts')).toBeNull();
    });

    it('processes .ts files — returns null when unchanged', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })(),
            result = plugin.transform.handler('let x = 1;', 'src/app.ts');

        expect(result).toBeNull();
        expect(coordinator.transform).toHaveBeenCalled();
    });

    it('returns transformed code with a non-null composed map when changed', () => {
        vi.mocked(coordinator.transform).mockReturnValueOnce({
            changed: true,
            code: 'TRANSFORMED',
            dependencies: [],
            map: { generations: [] }
        });

        let plugin = vite({ name: 'test-pkg', plugins: [] })(),
            result = plugin.transform.handler('let x = 1;', 'src/app.ts');

        expect(result).not.toBeNull();
        expect(result?.code).toBe('TRANSFORMED');
        expect(result?.map).not.toBeNull();
        expect(result?.map.version).toBe(3);
        expect(result?.map.sources).toContain('src/app.ts');
        expect(typeof result?.map.mappings).toBe('string');
    });

    it('skips files no plugin pattern matches without syncing them into the language service', () => {
        vi.mocked(coordinator.accepts).mockReturnValueOnce(false);

        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(plugin.transform.handler('let x = 1;', 'src/app.ts')).toBeNull();
        expect(languageService.update).not.toHaveBeenCalled();
        expect(coordinator.transform).not.toHaveBeenCalled();
    });

    it('skips files outside the project (linked dependencies) without syncing them', () => {
        vi.mocked(languageService.contains).mockReturnValueOnce(false);

        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(plugin.transform.handler('let x = reactive(1);', 'G:/linked-dependency/build/index.js')).toBeNull();
        expect(languageService.update).not.toHaveBeenCalled();
        expect(coordinator.transform).not.toHaveBeenCalled();
    });

    it('returns null (no map) when unchanged', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(plugin.transform.handler('let x = 1;', 'src/app.ts')).toBeNull();
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

        vi.mocked(languageService.findConfig).mockReturnValueOnce('/my/root/tsconfig.json');
        plugin.configResolved({ root: '/my/root' });
        plugin.transform.handler('let x = 1;', 'src/app.ts');

        expect(languageService.update).toHaveBeenCalledWith('/my/root/tsconfig.json', expect.any(String), expect.any(String));
    });

    it.each([false, true])('uses the selected tsconfig for transforms and cleanup (explicit root: %s)', (explicit) => {
        let app = resolve('/project'),
            docs = resolve(app, 'docs'),
            selected = explicit ? app : docs,
            configPath = resolve(selected, 'tsconfig.json'),
            plugin = vite({ name: 'test-pkg', plugins: [] })(explicit ? { root: app } : {});

        vi.mocked(languageService.findConfig).mockReturnValueOnce(configPath);
        plugin.configResolved({ configFile: resolve(docs, 'custom.vite.config.ts'), root: app });
        plugin.transform.handler('let x = 1;', resolve(docs, 'src/app.ts'));
        plugin.watchChange(resolve(docs, 'src/app.ts'));
        plugin.closeBundle();

        expect(languageService.findConfig).toHaveBeenCalledWith(selected);
        expect(languageService.update).toHaveBeenCalledWith(configPath, expect.any(String), 'let x = 1;');
        expect(languageService.invalidate).toHaveBeenCalledWith(configPath, expect.any(String));
        expect(languageService.dispose).toHaveBeenCalledWith(configPath);
    });

    it('uses the app root when config loading is disabled', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        plugin.configResolved({ configFile: false, root: '/project' });

        expect(languageService.findConfig).toHaveBeenCalledWith('/project');
    });

    // A file a plugin cannot compile must fail the build rather than ship uncompiled
    it('propagates a coordinator.transform() error', () => {
        vi.mocked(coordinator.transform).mockImplementationOnce(() => {
            throw new Error('transform failed');
        });

        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(() => plugin.transform.handler('let x = 1;', 'src/app.ts')).toThrow('transform failed');
    });

    it('rejects a chunk that still contains a compile-only runtime stub', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [], uncompiled: ['must be compiled'] })();

        expect(() => plugin.renderChunk('throw new Error("html must be compiled")', { fileName: 'app.js' })).toThrow(/app\.js/);
        expect(plugin.renderChunk('let compiled = 1;', { fileName: 'app.js' })).toBeNull();
        expect(vite({ name: 'test-pkg', plugins: [] })().renderChunk('must be compiled', { fileName: 'app.js' })).toBeNull();
    });

    it('invalidates modules whose compile relied on a changed file', () => {
        vi.mocked(coordinator.transform).mockReturnValueOnce({
            changed: false,
            code: 'let x = 1;',
            dependencies: ['src/state.ts'],
            map: { generations: [] }
        });

        let plugin = vite({ name: 'test-pkg', plugins: [] })(),
            changed = { id: 'src/state.ts' },
            dependent = { id: 'src/app.ts' },
            invalidateModule = vi.fn(),
            server = {
                moduleGraph: {
                    getModulesByFile: (file: string) => file === 'src/app.ts' ? new Set([dependent]) : undefined,
                    invalidateModule
                }
            };

        plugin.transform.handler('let x = 1;', 'src/app.ts');

        let result = plugin.handleHotUpdate({ file: 'src/state.ts', modules: [changed], server, timestamp: 1 } as never);

        expect(result).toEqual([changed, dependent]);
        expect(invalidateModule).toHaveBeenCalledWith(dependent, expect.any(Set), 1, true);
        expect(plugin.handleHotUpdate({ file: 'src/other.ts', modules: [], server, timestamp: 2 } as never)).toBeUndefined();
    });

    it('falls back to languageService.parse when getSourceFile returns undefined', () => {
        vi.mocked(languageService.update).mockReturnValueOnce({
            checker: {} as unknown as Checker,
            program: { getSourceFile: () => undefined } as unknown as Program
        });

        let plugin = vite({ name: 'test-pkg', plugins: [] })(),
            result = plugin.transform.handler('let x = 1;', 'src/app.ts');

        expect(result).toBeNull();
        expect(languageService.parse).toHaveBeenCalled();
        expect(coordinator.transform).toHaveBeenCalled();
    });

    it('closeBundle disposes the language service for the root', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        vi.mocked(languageService.findConfig).mockReturnValueOnce('/my/root/tsconfig.json');
        plugin.configResolved({ root: '/my/root' });
        plugin.closeBundle();

        expect(languageService.dispose).toHaveBeenCalledWith('/my/root/tsconfig.json');
    });

    it('filters natively to project scripts', () => {
        let { filter } = vite({ name: 'test-pkg', plugins: [] })().transform,
            matches = (id: string) => filter.id.include.test(id) && !filter.id.exclude.some(pattern => pattern.test(id));

        expect(['src/app.ts', 'src/app.tsx', 'src/app.mts', 'src/app.js'].every(matches)).toBe(true);
        expect(['style.css', 'src/app.ts?raw', 'node_modules/pkg/index.ts', '\0virtual.ts'].some(matches)).toBe(false);
    });

    describe('build', () => {
        function changed(dependencies: string[] = []) {
            vi.mocked(coordinator.transform).mockImplementationOnce((_plugins, code) => ({
                changed: true,
                code: code + ' // compiled',
                dependencies,
                map: { generations: [] }
            }));
        }

        it('answers a module seen with the same text from its result cache', () => {
            let plugin = vite({ name: 'test-pkg', plugins: [] })();

            plugin.configResolved({ command: 'build', root: '/project' });
            changed();

            let first = plugin.transform.handler('let x = 1;', 'src/app.ts'),
                second = plugin.transform.handler('let x = 1;', 'src/app.ts');

            expect(second).toEqual(first);
            expect(second).not.toBe(first);
            expect(coordinator.transform).toHaveBeenCalledTimes(1);
            expect(languageService.update).toHaveBeenCalledTimes(1);

            plugin.transform.handler('let x = 2;', 'src/app.ts');

            expect(coordinator.transform).toHaveBeenCalledTimes(2);
        });

        it('shares the cache with a nested build instance and releases only after the outer build', () => {
            let factory = vite({ name: 'test-pkg', plugins: [] }),
                outer = factory(),
                inner = factory();

            vi.mocked(languageService.findConfig).mockReturnValueOnce('/project/tsconfig.json').mockReturnValueOnce('/project/tsconfig.json');
            outer.configResolved({ command: 'build', root: '/project' });
            inner.configResolved({ command: 'build', root: '/project' });
            outer.buildStart();
            outer.transform.handler('let x = 1;', 'src/app.ts');
            inner.buildStart();
            inner.transform.handler('let x = 1;', 'src/app.ts');
            inner.closeBundle();

            expect(coordinator.transform).toHaveBeenCalledTimes(1);
            expect(languageService.dispose).not.toHaveBeenCalled();

            outer.closeBundle();

            expect(languageService.dispose).toHaveBeenCalledWith('/project/tsconfig.json');

            outer.transform.handler('let x = 1;', 'src/app.ts');

            expect(coordinator.transform).toHaveBeenCalledTimes(2);
        });

        it('does not cache while serving', () => {
            let plugin = vite({ name: 'test-pkg', plugins: [] })();

            plugin.configResolved({ command: 'serve', root: '/project' });
            plugin.transform.handler('let x = 1;', 'src/app.ts');
            plugin.transform.handler('let x = 1;', 'src/app.ts');

            expect(coordinator.transform).toHaveBeenCalledTimes(2);
        });

        it('recompiles a module whose dependency changed and keeps unrelated results', () => {
            let plugin = vite({ name: 'test-pkg', plugins: [] })();

            plugin.configResolved({ command: 'build', root: '/project' });
            changed(['src/state.ts']);
            plugin.transform.handler('let a = 1;', 'src/app.ts');
            plugin.transform.handler('let b = 1;', 'src/other.ts');
            plugin.watchChange('src/state.ts');
            plugin.transform.handler('let a = 1;', 'src/app.ts');
            plugin.transform.handler('let b = 1;', 'src/other.ts');

            expect(vi.mocked(coordinator.transform).mock.calls.map(call => call[1])).toEqual(['let a = 1;', 'let b = 1;', 'let a = 1;']);
        });
    });

    it('watchChange drops only the shared entries of the changed module and its dependents', () => {
        let context: Map<string, unknown> | undefined,
            plugin = vite({ name: 'test-pkg', plugins: [] })({ root: '/shared-root' });

        vi.mocked(coordinator.transform).mockImplementationOnce((_plugins, code, _file, _project, _root, ctx) => {
            context = ctx;
            ctx.set('src/app.ts', 'app');
            ctx.set('src/state.ts', 'state');
            ctx.set('src/other.ts', 'other');
            ctx.set('global', 'kept');

            return { changed: false, code, dependencies: ['src/state.ts'], map: { generations: [] } };
        });

        plugin.transform.handler('let x = 1;', 'src/app.ts');
        plugin.watchChange('src/state.ts');

        expect([...context!.keys()]).toEqual(['src/other.ts', 'global']);
    });

    it('closeWatcher disposes the language service for the root', () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        vi.mocked(languageService.findConfig).mockReturnValueOnce('/my/root/tsconfig.json');
        plugin.configResolved({ root: '/my/root' });
        plugin.closeWatcher();

        expect(languageService.dispose).toHaveBeenCalledWith('/my/root/tsconfig.json');
    });
});
