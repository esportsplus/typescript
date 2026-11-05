import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Checker, Program } from 'typescript/async';
import type { Plugin, Warning } from '~/compiler/types';
import type { SourceFile } from 'typescript/ast';

import cache from '~/compiler/plugins/cache';
import coordinator from '~/compiler/coordinator';
import languageService from '~/compiler/language-service';
import tsc from '~/compiler/plugins/tsc';
import vite from '~/compiler/plugins/vite';


vi.mock('~/compiler/language-service', () => ({
    default: {
        contains: vi.fn(async () => true),
        dispose: vi.fn(async () => undefined),
        findConfig: vi.fn(() => ''),
        invalidate: vi.fn(),
        parse: vi.fn(async (fileName: string, content: string) => ({ fileName, text: content }) as unknown as SourceFile),
        stage: vi.fn(),
        update: vi.fn(async (_root: string, _fileName: string, _content: string) => ({
            checker: {} as unknown as Checker,
            program: { getSourceFile: async () => undefined } as unknown as Program,
            release: () => undefined
        }))
    }
}));

vi.mock('~/compiler/coordinator', () => ({
    default: {
        accepts: vi.fn(() => true),
        transform: vi.fn(async (_plugins: Plugin[], code: string, _file: SourceFile, _project: { checker: Checker; program: Program }, _root: string, _ctx: Map<string, unknown>) => ({
            changed: false,
            code,
            dependencies: [] as string[],
            map: { generations: [] },
            modules: new Map<string, string>(),
            warnings: []
        }))
    }
}));


describe('plugin.tsc', () => {
    it('returns a function that returns the plugins array', async () => {
        let p1: Plugin = { transform: async () => ({}) },
            p2: Plugin = { transform: async () => ({}) },
            factory = tsc([p1, p2]),
            result = factory();

        expect(result).toEqual([p1, p2]);
    });

    it('returns empty array for empty input', async () => {
        let result = tsc([])();

        expect(result).toEqual([]);
    });
});


describe('plugin.vite', () => {
    // Build state is process-wide; a closing outermost build releases it
    afterEach(async () => {
        await vite({ name: 'test-pkg', plugins: [] })().closeBundle();
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('creates VitePlugin with correct shape', async () => {
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

    it('name includes package name', async () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(plugin.name).toBe('test-pkg/compiler/vite');
    });

    it('filters non-ts files', async () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(await plugin.transform.handler('code', 'file.css')).toBeNull();
    });

    it('filters node_modules', async () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(await plugin.transform.handler('code', 'node_modules/pkg/index.ts')).toBeNull();
    });

    it('processes .ts files — returns null when unchanged', async () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })(),
            result = await plugin.transform.handler('let x = 1;', 'src/app.ts');

        expect(result).toBeNull();
        expect(coordinator.transform).toHaveBeenCalled();
    });

    it('returns transformed code with a non-null composed map when changed', async () => {
        vi.mocked(coordinator.transform).mockResolvedValueOnce({
            changed: true,
            code: 'TRANSFORMED',
            dependencies: [],
            map: { generations: [] },
            modules: new Map<string, string>(),
            warnings: []
        });

        let plugin = vite({ name: 'test-pkg', plugins: [] })(),
            result = await plugin.transform.handler('let x = 1;', 'src/app.ts');

        expect(result).not.toBeNull();
        expect(result?.code).toBe('TRANSFORMED');
        expect(result?.map).not.toBeNull();
        expect(result?.map.version).toBe(3);
        expect(result?.map.sources).toContain('src/app.ts');
        expect(typeof result?.map.mappings).toBe('string');
    });

    it('skips files no plugin pattern matches without syncing them into the language service', async () => {
        vi.mocked(coordinator.accepts).mockReturnValueOnce(false);

        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(await plugin.transform.handler('let x = 1;', 'src/app.ts')).toBeNull();
        expect(languageService.update).not.toHaveBeenCalled();
        expect(coordinator.transform).not.toHaveBeenCalled();
    });

    it('skips files outside the project (linked dependencies) without syncing them', async () => {
        vi.mocked(languageService.contains).mockResolvedValueOnce(false);

        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(await plugin.transform.handler('let x = reactive(1);', 'G:/linked-dependency/build/index.js')).toBeNull();
        expect(languageService.update).not.toHaveBeenCalled();
        expect(coordinator.transform).not.toHaveBeenCalled();
    });

    it('returns null (no map) when unchanged', async () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        expect(await plugin.transform.handler('let x = 1;', 'src/app.ts')).toBeNull();
    });

    it('watchChange calls onWatchChange and invalidate', async () => {
        let onWatchChange = vi.fn(),
            plugin = vite({ name: 'test-pkg', onWatchChange, plugins: [] })();

        plugin.watchChange('src/app.ts');

        expect(onWatchChange).toHaveBeenCalled();
        expect(languageService.invalidate).toHaveBeenCalledWith('', 'src/app.ts');
    });

    it('watchChange ignores non-ts files', async () => {
        let onWatchChange = vi.fn(),
            plugin = vite({ name: 'test-pkg', onWatchChange, plugins: [] })();

        plugin.watchChange('style.css');

        expect(onWatchChange).not.toHaveBeenCalled();
    });

    it('configResolved sets root', async () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        vi.mocked(languageService.findConfig).mockReturnValueOnce('/my/root/tsconfig.json');
        plugin.configResolved({ root: '/my/root' });
        await plugin.transform.handler('let x = 1;', 'src/app.ts');

        expect(languageService.update).toHaveBeenCalledWith('/my/root/tsconfig.json', expect.any(String), expect.any(String));
    });

    it.each([false, true])('uses the selected tsconfig for transforms and cleanup (explicit root: %s)', async (explicit) => {
        let app = resolve('/project'),
            docs = resolve(app, 'docs'),
            selected = explicit ? app : docs,
            configPath = resolve(selected, 'tsconfig.json'),
            plugin = vite({ name: 'test-pkg', plugins: [] })(explicit ? { root: app } : {});

        vi.mocked(languageService.findConfig).mockReturnValueOnce(configPath);
        plugin.configResolved({ configFile: resolve(docs, 'custom.vite.config.ts'), root: app });
        await plugin.transform.handler('let x = 1;', resolve(docs, 'src/app.ts'));
        plugin.watchChange(resolve(docs, 'src/app.ts'));
        await plugin.closeBundle();

        expect(languageService.findConfig).toHaveBeenCalledWith(selected);
        expect(languageService.update).toHaveBeenCalledWith(configPath, expect.any(String), 'let x = 1;');
        expect(languageService.invalidate).toHaveBeenCalledWith(configPath, expect.any(String));
        expect(languageService.dispose).toHaveBeenCalledWith();
    });

    it('uses the app root when config loading is disabled', async () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        plugin.configResolved({ configFile: false, root: '/project' });

        expect(languageService.findConfig).toHaveBeenCalledWith('/project');
    });

    // A file a plugin cannot compile must fail the build rather than ship uncompiled
    it('propagates a coordinator.transform() error', async () => {
        vi.mocked(coordinator.transform).mockImplementationOnce(async () => {
            throw new Error('transform failed');
        });

        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        await expect(plugin.transform.handler('let x = 1;', 'src/app.ts')).rejects.toThrow('transform failed');
    });

    it('rejects a chunk that still contains a compile-only runtime stub', async () => {
        let plugin = vite({ name: 'test-pkg', plugins: [], uncompiled: ['must be compiled'] })();

        expect(() => plugin.renderChunk('throw new Error("html must be compiled")', { fileName: 'app.js' })).toThrow(/app\.js/);
        expect(plugin.renderChunk('let compiled = 1;', { fileName: 'app.js' })).toBeNull();
        expect(vite({ name: 'test-pkg', plugins: [] })().renderChunk('must be compiled', { fileName: 'app.js' })).toBeNull();
    });

    it('invalidates modules whose compile relied on a changed file', async () => {
        vi.mocked(coordinator.transform).mockResolvedValueOnce({
            changed: false,
            code: 'let x = 1;',
            dependencies: ['src/state.ts'],
            map: { generations: [] },
            modules: new Map<string, string>(),
            warnings: []
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

        await plugin.transform.handler('let x = 1;', 'src/app.ts');

        let result = plugin.handleHotUpdate({ file: 'src/state.ts', modules: [changed], server, timestamp: 1 } as never);

        expect(result).toEqual([changed, dependent]);
        expect(invalidateModule).toHaveBeenCalledWith(dependent, expect.any(Set), 1, true);
        expect(plugin.handleHotUpdate({ file: 'src/other.ts', modules: [], server, timestamp: 2 } as never)).toBeUndefined();
    });

    it('falls back to languageService.parse when getSourceFile returns undefined', async () => {
        vi.mocked(languageService.update).mockResolvedValueOnce({
            checker: {} as unknown as Checker,
            program: { getSourceFile: async () => undefined } as unknown as Program,
            release: () => undefined
        });

        let plugin = vite({ name: 'test-pkg', plugins: [] })(),
            result = await plugin.transform.handler('let x = 1;', 'src/app.ts');

        expect(result).toBeNull();
        expect(languageService.parse).toHaveBeenCalled();
        expect(coordinator.transform).toHaveBeenCalled();
    });

    it('closeBundle disposes every tsgo client of the language service', async () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        vi.mocked(languageService.findConfig).mockReturnValueOnce('/my/root/tsconfig.json');
        plugin.configResolved({ root: '/my/root' });
        await plugin.closeBundle();

        expect(languageService.dispose).toHaveBeenCalledWith();
    });

    it('filters natively to project scripts', async () => {
        let { filter } = vite({ name: 'test-pkg', plugins: [] })().transform,
            matches = (id: string) => filter.id.include.test(id) && !filter.id.exclude.some(pattern => pattern.test(id));

        expect(['src/app.ts', 'src/app.tsx', 'src/app.mts', 'src/app.js'].every(matches)).toBe(true);
        expect(['style.css', 'src/app.ts?raw', 'node_modules/pkg/index.ts', '\0virtual.ts'].some(matches)).toBe(false);
    });

    describe('build', () => {
        function changed(dependencies: string[] = []) {
            vi.mocked(coordinator.transform).mockImplementationOnce(async (_plugins, code) => ({
                changed: true,
                code: code + ' // compiled',
                dependencies,
                map: { generations: [] },
                modules: new Map<string, string>(),
                warnings: []
            }));
        }

        it('answers a module seen with the same text from its result cache', async () => {
            let plugin = vite({ name: 'test-pkg', plugins: [] })();

            plugin.configResolved({ command: 'build', root: '/project' });
            changed();

            let first = await plugin.transform.handler('let x = 1;', 'src/app.ts'),
                second = await plugin.transform.handler('let x = 1;', 'src/app.ts');

            expect(second).toEqual(first);
            expect(second).not.toBe(first);
            expect(coordinator.transform).toHaveBeenCalledTimes(1);
            expect(languageService.update).toHaveBeenCalledTimes(1);

            await plugin.transform.handler('let x = 2;', 'src/app.ts');

            expect(coordinator.transform).toHaveBeenCalledTimes(2);
        });

        it('shares the cache with a nested build instance and releases only after the outer build', async () => {
            let factory = vite({ name: 'test-pkg', plugins: [] }),
                outer = factory(),
                inner = factory();

            vi.mocked(languageService.findConfig).mockReturnValueOnce('/project/tsconfig.json').mockReturnValueOnce('/project/tsconfig.json');
            outer.configResolved({ command: 'build', root: '/project' });
            inner.configResolved({ command: 'build', root: '/project' });
            outer.buildStart();
            await outer.transform.handler('let x = 1;', 'src/app.ts');
            inner.buildStart();
            await inner.transform.handler('let x = 1;', 'src/app.ts');
            await inner.closeBundle();

            expect(coordinator.transform).toHaveBeenCalledTimes(1);
            expect(languageService.dispose).not.toHaveBeenCalled();

            await outer.closeBundle();

            expect(languageService.dispose).toHaveBeenCalledWith();

            await outer.transform.handler('let x = 1;', 'src/app.ts');

            expect(coordinator.transform).toHaveBeenCalledTimes(2);
        });

        it('shares results between factories of one name, as a wrapper creating one per instance does', async () => {
            let outer = vite({ name: 'test-pkg', plugins: [] })({ root: '/project' }),
                inner = vite({ name: 'test-pkg', plugins: [] })({ root: '/project' }),
                other = vite({ name: 'other-pkg', plugins: [] })({ root: '/project' });

            vi.mocked(languageService.findConfig)
                .mockReturnValueOnce('/project/tsconfig.json')
                .mockReturnValueOnce('/project/tsconfig.json')
                .mockReturnValueOnce('/project/tsconfig.json');
            outer.configResolved({ command: 'build', root: '/project' });
            inner.configResolved({ command: 'build', root: '/project' });
            other.configResolved({ command: 'build', root: '/project' });
            outer.buildStart();
            await outer.transform.handler('let x = 1;', 'src/app.ts');
            inner.buildStart();
            await inner.transform.handler('let x = 1;', 'src/app.ts');
            await inner.closeBundle();
            await other.transform.handler('let x = 1;', 'src/app.ts');

            expect(coordinator.transform).toHaveBeenCalledTimes(2);
            expect(languageService.dispose).not.toHaveBeenCalled();

            await outer.closeBundle();

            expect(languageService.dispose).toHaveBeenCalled();
        });

        it('does not cache while serving', async () => {
            let plugin = vite({ name: 'test-pkg', plugins: [] })();

            plugin.configResolved({ command: 'serve', root: '/project' });
            await plugin.transform.handler('let x = 1;', 'src/app.ts');
            await plugin.transform.handler('let x = 1;', 'src/app.ts');

            expect(coordinator.transform).toHaveBeenCalledTimes(2);
        });

        it('recompiles a module whose dependency changed and keeps unrelated results', async () => {
            let plugin = vite({ name: 'test-pkg', plugins: [] })();

            plugin.configResolved({ command: 'build', root: '/project' });
            changed(['src/state.ts']);
            await plugin.transform.handler('let a = 1;', 'src/app.ts');
            await plugin.transform.handler('let b = 1;', 'src/other.ts');
            plugin.watchChange('src/state.ts');
            await plugin.transform.handler('let a = 1;', 'src/app.ts');
            await plugin.transform.handler('let b = 1;', 'src/other.ts');

            expect(vi.mocked(coordinator.transform).mock.calls.map(call => call[1])).toEqual(['let a = 1;', 'let b = 1;', 'let a = 1;']);
        });
    });

    describe('persistent build cache', () => {
        let dependency: string,
            directory: string,
            module: string,
            tsconfig: string,
            // What the builds reported through `this.warn`
            warned: { id: string; loc?: { column: number; file: string; line: number }; message: string }[] = [];

        // One production build of `module`: compiled, inspected by `during`, then closed (which
        // writes the cache)
        async function build(plugins: Plugin[] = [], during?: (plugin: ReturnType<ReturnType<typeof vite>>) => void | Promise<void>, code = 'let x = 1;') {
            let plugin = vite({ name: 'test-pkg', plugins })({ root: directory });

            vi.mocked(languageService.findConfig).mockReturnValue(tsconfig);
            plugin.configResolved({ command: 'build', root: directory });
            plugin.buildStart();

            let result = await plugin.transform.handler.call({ warn: (log: (typeof warned)[number]) => { warned.push(log); } }, code, module);

            await during?.(plugin);
            await plugin.closeBundle();

            return result;
        }

        function compiles(
            dependencies: string[] = [dependency],
            touch = false,
            emits: (code: string) => [string, string][] = () => [],
            warnings: Warning[] = []
        ) {
            vi.mocked(coordinator.transform).mockImplementation(async (_plugins, code, _file, _project, _root, ctx) => {
                if (touch) {
                    ctx.get('anything');
                }

                return {
                    changed: true,
                    code: code + ' // compiled',
                    dependencies,
                    map: { generations: [[{ afterEnd: 10, afterStart: 10, beforeStart: 10, identity: false }]] },
                    modules: new Map<string, string>(emits(code)),
                    warnings
                };
            });
        }

        function loads(plugin: ReturnType<ReturnType<typeof vite>>, id: string): string | null {
            let resolved = plugin.resolveId.handler(id);

            return resolved === null ? null : plugin.load.handler(resolved);
        }

        function packs(): string[] {
            let at = join(directory, 'node_modules', '.cache', '@esportsplus', 'typescript', 'transform');

            return existsSync(at) ? readdirSync(at).map((name) => join(at, name)) : [];
        }

        beforeEach(() => {
            directory = mkdtempSync(join(tmpdir(), 'esportsplus-transform-cache-')).replace(/\\/g, '/');
            dependency = directory + '/src/state.ts';
            module = directory + '/src/app.ts';
            tsconfig = directory + '/tsconfig.json';
            mkdirSync(directory + '/node_modules', { recursive: true });
            mkdirSync(directory + '/src');
            writeFileSync(dependency, 'export let state = 1;');
            writeFileSync(tsconfig, '{ "include": ["src"] }');
            warned = [];
            compiles();
        });

        afterEach(async () => {
            delete process.env.ESPORTSPLUS_TRANSFORM_CACHE;
            vi.mocked(coordinator.transform).mockReset();
            vi.mocked(languageService.findConfig).mockReset().mockReturnValue('');
            rmSync(directory, { force: true, recursive: true });
        });

        it('answers an unchanged module from an earlier build without the language service', async () => {
            let first = await build();

            vi.clearAllMocks();

            let second = await build();

            expect(packs()).toHaveLength(1);
            expect(second).toEqual(first);
            expect(second?.map.mappings).toBe(first?.map.mappings);
            expect(coordinator.transform).not.toHaveBeenCalled();
            expect(languageService.contains).not.toHaveBeenCalled();
            expect(languageService.update).not.toHaveBeenCalled();
            expect(languageService.stage).toHaveBeenCalledWith(tsconfig, module, 'let x = 1;');
        });

        it('compiles again once a tracked dependency changes', async () => {
            await build();
            writeFileSync(dependency, 'export let state = 2;');
            vi.clearAllMocks();
            await build();

            expect(coordinator.transform).toHaveBeenCalledTimes(1);
        });

        it('compiles again once the tsconfig changes', async () => {
            await build();
            writeFileSync(tsconfig, '{ "include": ["src"], "compilerOptions": { "strict": true } }');
            vi.clearAllMocks();
            await build();

            expect(coordinator.transform).toHaveBeenCalledTimes(1);
        });

        it('compiles again once the compiler identity changes', async () => {
            await build([{ name: 'a', transform: async () => ({}) }]);
            vi.clearAllMocks();
            await build([{ name: 'b', transform: async () => ({}) }]);

            expect(coordinator.transform).toHaveBeenCalledTimes(1);
            expect(cache.identity('test-pkg', [], directory, tsconfig, '0.40.0 7.1.0-beta'))
                .not.toBe(cache.identity('test-pkg', [], directory, tsconfig, '0.41.0 7.1.0-beta'));
            expect(cache.identity('test-pkg', [], directory, tsconfig, '0.40.0 7.1.0-beta'))
                .not.toBe(cache.identity('test-pkg', [], directory, tsconfig, '0.40.0 7.1.0'));
        });

        it('keeps nothing of a compile that used the shared context', async () => {
            compiles([dependency], true);
            await build();
            vi.clearAllMocks();
            compiles();
            await build();

            expect(coordinator.transform).toHaveBeenCalledTimes(1);
        });

        it('compiles through a corrupt or foreign pack and replaces it', async () => {
            await build();

            let [pack] = packs(),
                stored = JSON.parse(readFileSync(pack, 'utf8')) as { entries: Record<string, unknown> };

            for (let corrupt of ['{ not json', JSON.stringify({ ...stored, entries: { [Object.keys(stored.entries)[0]]: { input: 1 } } })]) {
                writeFileSync(pack, corrupt);
                vi.clearAllMocks();

                expect((await build())?.code).toBe('let x = 1; // compiled');
                expect(coordinator.transform).toHaveBeenCalledTimes(1);
            }

            vi.clearAllMocks();
            await build();

            expect(coordinator.transform).not.toHaveBeenCalled();
        });

        it('keeps nothing with ESPORTSPLUS_TRANSFORM_CACHE=0', async () => {
            process.env.ESPORTSPLUS_TRANSFORM_CACHE = '0';
            await build();
            vi.clearAllMocks();
            await build();

            expect(packs()).toHaveLength(0);
            expect(coordinator.transform).toHaveBeenCalledTimes(1);
        });

        it('writes nothing while serving', async () => {
            let plugin = vite({ name: 'test-pkg', plugins: [] })({ root: directory });

            vi.mocked(languageService.findConfig).mockReturnValue(tsconfig);
            plugin.configResolved({ command: 'serve', root: directory });
            await plugin.transform.handler('let x = 1;', module);
            await plugin.closeWatcher();

            expect(packs()).toHaveLength(0);
        });

        it('serves the virtual modules a compile emitted, also when a later build reuses it', async () => {
            compiles([dependency], false, () => [['virtual:test/a', 'export default 1;']]);

            await build([], (plugin) => {
                expect(loads(plugin, 'virtual:test/a')).toBe('export default 1;');
                expect(loads(plugin, 'virtual:test/missing')).toBeNull();
            });
            vi.clearAllMocks();
            await build([], (plugin) => {
                expect(coordinator.transform).not.toHaveBeenCalled();
                expect(loads(plugin, 'virtual:test/a')).toBe('export default 1;');
            });
        });

        it('reports a compile\'s warnings at their line and column in the module', async () => {
            compiles([dependency], false, () => [], [{ message: 'by hand', position: 15 }, { message: 'anywhere' }]);
            await build([], undefined, 'let x = 1;\nlet y = 2;');

            expect(warned).toEqual([
                { id: module, loc: { column: 4, file: module, line: 2 }, message: `${module}:2:5 by hand` },
                { id: module, message: 'anywhere' }
            ]);
        });

        it('reports the warnings again when a nested build reuses the result', async () => {
            compiles([dependency], false, () => [], [{ message: 'by hand', position: 4 }]);

            let factory = vite({ name: 'test-pkg', plugins: [] }),
                outer = factory({ root: directory }),
                inner = factory({ root: directory }),
                context = { warn: (log: (typeof warned)[number]) => { warned.push(log); } };

            vi.mocked(languageService.findConfig).mockReturnValue(tsconfig);
            outer.configResolved({ command: 'build', root: directory });
            inner.configResolved({ command: 'build', root: directory });
            outer.buildStart();
            await outer.transform.handler.call(context, 'let x = 1;', module);
            inner.buildStart();
            await inner.transform.handler.call(context, 'let x = 1;', module);
            await inner.closeBundle();
            await outer.closeBundle();

            expect(coordinator.transform).toHaveBeenCalledTimes(1);
            expect(warned.map((log) => log.message)).toEqual([`${module}:1:5 by hand`, `${module}:1:5 by hand`]);
        });

        it('reports the warnings again when a later build reuses the result from disk', async () => {
            compiles([dependency], false, () => [], [{ message: 'by hand', position: 4 }]);
            await build();
            vi.clearAllMocks();
            await build();

            expect(coordinator.transform).not.toHaveBeenCalled();
            expect(warned.map((log) => log.message)).toEqual([`${module}:1:5 by hand`, `${module}:1:5 by hand`]);
        });

        it('emits again once a tracked dependency changes', async () => {
            compiles([dependency], false, () => [['virtual:test/a', readFileSync(dependency, 'utf8')]]);
            await build();
            writeFileSync(dependency, 'export let state = 2;');
            vi.clearAllMocks();
            await build([], (plugin) => {
                expect(coordinator.transform).toHaveBeenCalledTimes(1);
                expect(loads(plugin, 'virtual:test/a')).toBe('export let state = 2;');
            });
        });

        it('drops the virtual modules a module no longer emits, or emitted before it changed', async () => {
            compiles([dependency], false, (code) => code.includes('2') ? [['virtual:test/a', 'a']] : [['virtual:test/a', 'a'], ['virtual:test/b', 'b']]);

            await build([], async (plugin) => {
                expect(loads(plugin, 'virtual:test/b')).toBe('b');

                await plugin.transform.handler('let x = 2;', module);

                expect(loads(plugin, 'virtual:test/a')).toBe('a');
                expect(loads(plugin, 'virtual:test/b')).toBeNull();

                plugin.watchChange(module);

                expect(loads(plugin, 'virtual:test/a')).toBeNull();
            });
        });

        it('invalidates the virtual modules a changed file emitted', async () => {
            compiles([], false, () => [['virtual:test/a', 'a']]);

            await build([], (plugin) => {
                let emittedModule = { id: '\0virtual:test/a' },
                    invalidateModule = vi.fn(),
                    server = {
                        moduleGraph: {
                            getModuleById: (id: string) => id === '\0virtual:test/a' ? emittedModule : undefined,
                            getModulesByFile: () => undefined,
                            invalidateModule
                        }
                    };

                plugin.watchChange(module);

                expect(plugin.handleHotUpdate({ file: module, modules: [], server, timestamp: 1 } as never)).toEqual([emittedModule]);
                expect(invalidateModule).toHaveBeenCalledWith(emittedModule, expect.any(Set), 1, true);
            });
        });

        it('rejects an emitted id outside the virtual: namespace', async () => {
            compiles([dependency], false, () => [['test/a', 'a']]);

            await expect(build()).rejects.toThrow(/must have an id starting with 'virtual:'/);
        });
    });

    it('watchChange drops only the shared entries of the changed module and its dependents', async () => {
        let context: Map<string, unknown> | undefined,
            plugin = vite({ name: 'test-pkg', plugins: [] })({ root: '/shared-root' });

        vi.mocked(coordinator.transform).mockImplementationOnce(async (_plugins, code, _file, _project, _root, ctx) => {
            context = ctx;
            ctx.set('src/app.ts', 'app');
            ctx.set('src/state.ts', 'state');
            ctx.set('src/other.ts', 'other');
            ctx.set('global', 'kept');

            return { changed: false, code, dependencies: ['src/state.ts'], map: { generations: [] },     modules: new Map<string, string>(), warnings: [] };
        });

        await plugin.transform.handler('let x = 1;', 'src/app.ts');
        plugin.watchChange('src/state.ts');

        expect([...context!.keys()]).toEqual(['src/other.ts', 'global']);
    });

    it('closeWatcher disposes every tsgo client of the language service', async () => {
        let plugin = vite({ name: 'test-pkg', plugins: [] })();

        vi.mocked(languageService.findConfig).mockReturnValueOnce('/my/root/tsconfig.json');
        plugin.configResolved({ root: '/my/root' });
        await plugin.closeWatcher();

        expect(languageService.dispose).toHaveBeenCalledWith();
    });
});
