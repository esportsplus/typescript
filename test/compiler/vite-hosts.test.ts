import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isNumericLiteral, isVariableDeclaration } from 'typescript/ast/is';
import type { Node } from 'typescript/ast';
import type { Program } from 'typescript/sync';
import type { Plugin } from '~/compiler/types';

import fs from 'fs';
import languageService from '~/compiler/language-service';
import path from 'path';
import vite from '~/compiler/plugins/vite';


type Host = ReturnType<ReturnType<typeof vite>>;

type Log = { id: string; loc?: { column: number; file: string; line: number }; message: string };


const CODE = 'export const x = 1 + 2;\n';


let directory = fs.mkdtempSync(path.join(process.cwd(), 'test/.vite-hosts-')).replace(/\\/g, '/'),
    file = directory + '/src/app.ts',
    seen: Program[] = [],
    warned: Log[] = [];


function each(node: Node, visit: (node: Node) => void): void {
    visit(node);
    node.forEachChild((child) => {
        each(child, visit);
    });
}

// Warns about every `2`, and spreads every `1` over three lines so output lines no longer match the source's
function flagging(): Plugin {
    return {
        name: 'flag',
        transform({ sourceFile }) {
            let replacements: NonNullable<ReturnType<Plugin['transform']>['replacements']> = [],
                warnings: NonNullable<ReturnType<Plugin['transform']>['warnings']> = [];

            each(sourceFile, (node) => {
                if (isNumericLiteral(node) && node.text === '2') {
                    warnings.push({ message: 'two', position: node.getStart(sourceFile) });
                }
                else if (isNumericLiteral(node) && node.text === '1') {
                    replacements.push({ generate: () => '(\n1\n)', node });
                }
            });

            return { replacements, warnings };
        }
    };
}

// Wraps every initializer, reading it through text() so what other plugins rewrote inside it stays
function wrapping(): Plugin {
    return {
        name: 'wrap',
        transform({ program, sourceFile }) {
            let replacements: NonNullable<ReturnType<Plugin['transform']>['replacements']> = [];

            seen.push(program);
            each(sourceFile, (node) => {
                if (isVariableDeclaration(node) && node.initializer) {
                    let initializer = node.initializer;

                    replacements.push({ generate: (_file, text) => `wrap(${text(initializer)})`, node: initializer });
                }
            });

            return { replacements };
        }
    };
}

function numbering(): Plugin {
    return {
        name: 'number',
        transform({ program, sourceFile }) {
            let replacements: NonNullable<ReturnType<Plugin['transform']>['replacements']> = [];

            seen.push(program);
            each(sourceFile, (node) => {
                if (isNumericLiteral(node) && node.text === '1') {
                    replacements.push({ generate: () => 'one()', node });
                }
            });

            return { replacements };
        }
    };
}

// One build of `file` through the listed plugins in order, each host given the previous output
function build(listed: object[], hosts: Host[], command = 'build', source = CODE): string {
    let config = { command, plugins: listed, root: directory },
        code = source,
        context = { warn: (log: Log) => { warned.push(log); } };

    for (let i = 0, n = hosts.length; i < n; i++) {
        hosts[i].configResolved(config);
    }

    for (let i = 0, n = listed.length; i < n; i++) {
        let plugin = listed[i] as { transform?: { handler: (this: unknown, code: string, id: string) => { code: string } | null } };

        code = plugin.transform?.handler.call(context, code, file)?.code ?? code;
    }

    return code;
}

function hosts(): [Host, Host] {
    return [
        vite({ name: 'host-a', plugins: [wrapping()] })({ root: directory }),
        vite({ name: 'host-b', plugins: [numbering()] })({ root: directory })
    ];
}

// A wrapper replacing a host's transform, as packages wrapping their host do
function wrapped(host: Host, skip = false): object {
    return {
        ...host,
        transform: {
            filter: host.transform.filter,
            handler(this: unknown, code: string, id: string) {
                return skip ? null : host.transform.handler.call(this, code, id);
            }
        }
    };
}


beforeAll(() => {
    process.env.ESPORTSPLUS_TRANSFORM_CACHE = '0';
    fs.mkdirSync(directory + '/src', { recursive: true });
    fs.writeFileSync(directory + '/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext', target: 'es2024' }, include: ['src'] }));
    fs.writeFileSync(file, CODE);
});

afterAll(() => {
    delete process.env.ESPORTSPLUS_TRANSFORM_CACHE;
    languageService.dispose();
    fs.rmSync(directory, { force: true, recursive: true });
});

afterEach(async () => {
    seen = [];
    warned = [];
    vi.restoreAllMocks();
    await vite({ name: 'release', plugins: [] })().closeBundle();
});


describe('plugin.vite host merging', () => {
    let separate = '';

    it('compiles adjacent hosts separately when a foreign transform runs between them', () => {
        let [a, b] = hosts(),
            update = vi.spyOn(languageService, 'update');

        separate = build([a, { name: 'foreign', transform: { handler: () => null } }, b], [a, b]);

        expect(separate).toBe('export const x = wrap(one() + 2);\n');
        expect(update).toHaveBeenCalledTimes(2);
        expect(seen[0]).not.toBe(seen[1]);
    });

    it('compiles adjacent hosts once, with every plugin against one program, to the same output', () => {
        let [a, b] = hosts(),
            update = vi.spyOn(languageService, 'update');

        expect(build([a, b], [a, b])).toBe(separate);
        expect(update).toHaveBeenCalledTimes(1);
        expect(seen).toHaveLength(2);
        expect(seen[0]).toBe(seen[1]);
    });

    it('merges while serving too', () => {
        let [a, b] = hosts(),
            update = vi.spyOn(languageService, 'update');

        expect(build([a, b], [a, b], 'serve')).toBe(separate);
        expect(update).toHaveBeenCalledTimes(1);
    });

    it('lets a wrapped later host compile for both, inside its own call', () => {
        let [a, b] = hosts(),
            update = vi.spyOn(languageService, 'update'),
            outer = wrapped(b);

        expect(build([a, outer], [a, b])).toBe(separate);
        expect(a.transform.handler(CODE, file)).toBeNull();
        expect(update).toHaveBeenCalledTimes(1);
    });

    it('fails the build when a wrapped host never compiles a file left to it', () => {
        let [a, b] = hosts();

        build([a, wrapped(b, true)], [a, b]);

        expect(() => b.buildEnd()).toThrow(/host-a .*never compiled/);
    });

    it('reports a merged compile\'s warnings once, through the executor, at their line in the original source', () => {
        let source = 'export const x = 1;\nexport const y = 2;\n',
            a = vite({ name: 'host-a', plugins: [flagging()] })({ root: directory }),
            b = vite({ name: 'host-b', plugins: [wrapping()] })({ root: directory });

        expect(build([a, wrapped(b)], [a, b], 'build', source)).toBe('export const x = wrap((\n1\n));\nexport const y = wrap(2);\n');
        expect(warned).toEqual([{ id: file, loc: { column: 17, file, line: 2 }, message: `${file}:2:18 two` }]);
    });

    it('reports them again for a result reused within the build', () => {
        let source = 'export const y = 2;\n',
            a = vite({ name: 'host-a', plugins: [flagging()] })({ root: directory }),
            update = vi.spyOn(languageService, 'update');

        build([a], [a], 'build', source);
        build([a], [a], 'build', source);

        expect(update).toHaveBeenCalledTimes(1);
        expect(warned.map((log) => log.message)).toEqual([`${file}:1:18 two`, `${file}:1:18 two`]);
    });

    it('reports them on every transform while serving', () => {
        let a = vite({ name: 'host-a', plugins: [flagging()] })({ root: directory });

        build([a], [a], 'serve', 'export const y = 2;\n');
        build([a], [a], 'serve', 'export const y = 2;\n');

        expect(warned).toHaveLength(2);
    });
});
