import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Node } from 'typescript/unstable/ast';
import { SyntaxKind } from 'typescript/unstable/ast';
import { isBindingElement } from 'typescript/unstable/ast/is';
import type { Checker, Program } from 'typescript/unstable/sync';

import fs from 'fs';
import languageService from '~/compiler/language-service';
import path from 'path';
import references from '~/compiler/references';


const FILES: Record<string, string> = {
    'node_modules/fake-pkg/index.d.ts': [
        'export declare function make(value: number): number;',
        'export declare const tag: (strings: TemplateStringsArray) => string;',
        "export { make as default } from './index';",
        "export { signal as wire } from './internal';"
    ].join('\n'),
    // A library's own barrel renames what its internal module declares
    'node_modules/fake-pkg/internal.d.ts': 'export declare function signal(value: number): number;',
    'node_modules/fake-pkg/package.json': JSON.stringify({ name: 'fake-pkg', types: './index.d.ts' }),
    // A central module re-exporting under other names, the way an app's `app.ts` does
    'src/app.ts': [
        "import { make } from 'fake-pkg';",
        "export { make as x } from 'fake-pkg';",
        "export { tag as t } from 'fake-pkg';",
        'export const held = make;',
        "export * from './star';"
    ].join('\n'),
    'src/assigned.ts': [
        "import { make } from 'fake-pkg';",
        'let x: number;',
        'export let before = () => x;',
        'x = make(0);',
        'export let after = x;'
    ].join('\n'),
    'src/chain.ts': [
        "import * as P from 'fake-pkg';",
        'const a = P.make;',
        'const b = a;',
        'const { tag: c } = P;',
        'export let r1 = b(1);',
        'export let r2 = c`x`;',
        'export let r3 = { a };'
    ].join('\n'),
    'src/defaulted.ts': [
        "import { make } from 'fake-pkg';",
        'export default make;'
    ].join('\n'),
    'src/dynamic.ts': [
        "export let d1 = async () => (await import('fake-pkg')).make(1);",
        "export let d2 = async () => { const m = await import('fake-pkg'); return m.make(2); };"
    ].join('\n'),
    'src/renamed.ts': [
        "import { make as x, tag as h, wire, wire as w } from 'fake-pkg';",
        "import { held, t, x as viaApp } from './app';",
        "import { make as starred, tag as starredTag } from './star';",
        "import r from './defaulted';",
        "import * as app from './app';",
        'export let a1 = x(1);',
        'export let a2 = h`a`;',
        'export let a3 = viaApp(2);',
        'export let a4 = starred(3);',
        'export let a5 = starredTag`b`;',
        'export let a6 = r(4);',
        'export let a7 = held(5);',
        'export let a8 = app.x(6);',
        "export let a9 = app['x'](7);",
        'const { x: y } = app;',
        'export let a10 = y(8);',
        'export let a11 = t`c`;',
        'export let a12 = wire(9);',
        'export let a13 = w(10);'
    ].join('\n'),
    'src/shadow.ts': [
        "import { make, tag } from 'fake-pkg';",
        'export let s1 = (make: (value: number) => number) => make(1);',
        'export let s2 = (obj: { tag: string }) => obj.tag;',
        'export let s3 = make(2);',
        'export let s4 = tag`d`;'
    ].join('\n'),
    // `export *` two modules deep before reaching the package
    'src/star.ts': "export * from './star2';",
    'src/star2.ts': "export * from 'fake-pkg';",
    'src/alias.ts': [
        "import { make as m, tag } from 'fake-pkg';",
        'export let a = m(1);',
        'export let b = tag`x`;'
    ].join('\n'),
    'src/barrel.ts': [
        "export { make as build } from 'fake-pkg';",
        "export * from 'fake-pkg';",
        "import * as P from 'fake-pkg';",
        'export { P };'
    ].join('\n'),
    'src/consumer.ts': [
        "import { build, make, P } from './barrel';",
        "import * as B from './barrel';",
        "import fallback from 'fake-pkg';",
        'export let c = build(1);',
        'export let d = B.build(2);',
        'export let e = B.P.make(3);',
        'export let f = P.make(4);',
        'export let g = make(5);',
        'export let h = fallback(6);',
        'const alias = build;',
        'const { make: destructured } = B;',
        'export let i = [build];',
        'export type T = typeof build;',
        'export let j = (value: typeof make) => value(7);',
        "export let l = B['build'](8);",
        'export let m = alias(9);',
        'export let o = destructured(10);',
        'let loose = build;',
        'export let q = loose(11);'
    ].join('\n'),
    'src/unrelated.ts': [
        'function make(value: number) { return value; }',
        'export let k = make(8);'
    ].join('\n')
};


let checker: Checker,
    fixture: string,
    program: Program;


function find(file: string, predicate: (node: Node) => boolean): Node {
    let found: Node | undefined,
        visit = (node: Node): void => {
            if (!found && predicate(node)) {
                found = node;
            }

            node.forEachChild(visit);
        };

    visit(program.getSourceFile(fixture + '/' + file)!);

    return found!;
}

// Parent expression text of every value in `file` that holds the package's export, the way the
// template and reactivity compilers find their sites: origins, then holds through const aliases
function sites(file: string, name: string): string[] {
    let targets = new Set(references.exported(checker, program, 'fake-pkg', name).map(references.key)),
        sourceFile = program.getSourceFile(fixture + '/' + file)!,
        result: string[] = [];

    for (let [identifier, origin] of references.origins(checker, program, sourceFile)) {
        if (references.holds(checker, program, origin, targets)) {
            let parent = identifier.parent!;

            result.push(sourceFile.text.slice(parent.getStart(), parent.end));
        }
    }

    return result.sort();
}

// Parent expression text of every identifier in `file` whose value comes from the package's export
function uses(file: string, name: string): string[] {
    let targets = new Set(references.exported(checker, program, 'fake-pkg', name).map(references.key)),
        sourceFile = program.getSourceFile(fixture + '/' + file)!,
        result: string[] = [];

    for (let [identifier, origin] of references.origins(checker, program, sourceFile)) {
        if (targets.has(references.key(origin.declaration))) {
            let parent = identifier.parent!;

            result.push(sourceFile.text.slice(parent.getStart(), parent.end));
        }
    }

    return result.sort();
}


beforeAll(() => {
    fixture = fs.mkdtempSync(path.join(process.cwd(), 'test/.references-')).replace(/\\/g, '/');

    for (let [name, code] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(fixture, name)), { recursive: true });
        fs.writeFileSync(path.join(fixture, name), code);
    }

    fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true, target: 'esnext', types: [] },
        include: ['src']
    }));

    ({ checker, program } = languageService.update(fixture + '/tsconfig.json', fixture + '/src/alias.ts', FILES['src/alias.ts']));
});

afterAll(() => {
    languageService.dispose();
    fs.rmSync(fixture, { force: true, recursive: true });
});


describe('references', () => {
    describe('exported', () => {
        it('resolves a package export to its declaration', () => {
            let declarations = references.exported(checker, program, 'fake-pkg', 'make');

            expect(declarations).toHaveLength(1);
            expect(declarations[0].kind).toBe(SyntaxKind.FunctionDeclaration);
        });

        it('is empty for an export the package does not have', () => {
            expect(references.exported(checker, program, 'fake-pkg', 'missing')).toEqual([]);
        });

        it('is empty for a package the program does not load', () => {
            expect(references.exported(checker, program, 'absent-pkg', 'make')).toEqual([]);
        });
    });

    describe('origins', () => {
        it('resolves every value read through aliases, barrels, namespaces and defaults', () => {
            expect(uses('src/alias.ts', 'make')).toEqual(['m(1)']);
            expect(uses('src/consumer.ts', 'make')).toEqual([
                "B['build']",
                'B.P.make',
                'B.build',
                'P.make',
                '[build]',
                'alias = build',
                'build(1)',
                'fallback(6)',
                'loose = build',
                'make(5)',
                'make: destructured'
            ].sort());
        });

        it('never resolves a same-named local declaration to the export', () => {
            expect(uses('src/unrelated.ts', 'make')).toEqual([]);
        });

        it('resolves a const export used as a template tag', () => {
            expect(uses('src/alias.ts', 'tag')).toEqual(['tag`x`']);
        });

        it('lists the files an origin resolves through', () => {
            let sourceFile = program.getSourceFile(fixture + '/src/consumer.ts')!,
                call = find('src/consumer.ts', node => node.kind === SyntaxKind.CallExpression && node.getText() === 'build(1)'),
                origin = references.origins(checker, program, sourceFile).get((call as unknown as { expression: Node }).expression)!;

            expect(origin.through.map(file => file.toLowerCase())).toEqual(
                [fixture + '/src/consumer.ts', fixture + '/src/barrel.ts'].map(file => file.toLowerCase())
            );
        });
    });

    // Each case is a shape that has broken the compilers before; none may depend on the name a
    // value is imported, re-exported or bound under
    describe('sites under any name', () => {
        it('resolves a renamed import', () => {
            expect(sites('src/renamed.ts', 'make')).toContain('x(1)');
        });

        it('resolves a renamed template tag', () => {
            expect(sites('src/renamed.ts', 'tag')).toContain('h`a`');
        });

        it('resolves a rename re-exported by a central module', () => {
            expect(sites('src/renamed.ts', 'make')).toContain('viaApp(2)');
            expect(sites('src/renamed.ts', 'tag')).toContain('t`c`');
        });

        it('resolves through export * two modules deep', () => {
            expect(sites('src/renamed.ts', 'make')).toContain('starred(3)');
            expect(sites('src/renamed.ts', 'tag')).toContain('starredTag`b`');
        });

        it('resolves a default export imported under another name', () => {
            expect(sites('src/renamed.ts', 'make')).toContain('r(4)');
        });

        it('resolves a const export holding the export, consumed from another file', () => {
            expect(sites('src/app.ts', 'make')).toEqual(['held = make']);
            expect(sites('src/renamed.ts', 'make')).toContain('held(5)');
        });

        it('resolves members and destructuring of a namespace import', () => {
            expect(sites('src/renamed.ts', 'make')).toEqual(expect.arrayContaining(['app.x', "app['x']", 'x: y', 'y(8)']));
        });

        it('resolves a library-internal barrel rename', () => {
            expect(sites('src/renamed.ts', 'wire')).toEqual(['w(10)', 'wire(9)']);
        });

        it('resolves every site of the renamed fixture and nothing else', () => {
            expect(sites('src/renamed.ts', 'make')).toEqual(
                ['app.x', "app['x']", 'held(5)', 'r(4)', 'starred(3)', 'viaApp(2)', 'x(1)', 'x: y', 'y(8)'].sort()
            );
            expect(sites('src/renamed.ts', 'tag')).toEqual(['h`a`', 'starredTag`b`', 't`c`'].sort());
        });

        it('resolves const aliases of a namespace member to a fixpoint', () => {
            expect(sites('src/chain.ts', 'make')).toEqual(['P.make', 'a', 'b = a', 'b(1)'].sort());
            expect(sites('src/chain.ts', 'tag')).toEqual(['c`x`']);
        });

        it('resolves members of a dynamic import', () => {
            expect(sites('src/dynamic.ts', 'make')).toEqual(["(await import('fake-pkg')).make", 'm.make'].sort());
        });

        it('rejects a parameter shadowing the import and a member of a parameter', () => {
            expect(sites('src/shadow.ts', 'make')).toEqual(['make(2)']);
            expect(sites('src/shadow.ts', 'tag')).toEqual(['tag`d`']);
        });

        it('resolves reads of a let assigned from the export, before and after the assignment', () => {
            let sourceFile = program.getSourceFile(fixture + '/src/assigned.ts')!,
                reads: number[] = [];

            for (let [identifier, origin] of references.origins(checker, program, sourceFile)) {
                if (
                    identifier.getText() === 'x' &&
                    origin.declaration.kind === SyntaxKind.VariableDeclaration &&
                    origin.declaration.path.toLowerCase() === sourceFile.fileName.toLowerCase()
                ) {
                    reads.push(identifier.getStart());
                }
            }

            expect(reads.sort((a, b) => a - b)).toEqual([
                sourceFile.text.indexOf('=> x') + 3,
                sourceFile.text.indexOf('x = make'),
                sourceFile.text.indexOf('after = x') + 8
            ]);
        });
    });

    describe('denotes', () => {
        function callee(file: string, text: string): Node {
            let call = find(file, node => node.kind === SyntaxKind.CallExpression && node.getText() === text);

            return (call as unknown as { expression: Node }).expression;
        }

        it('follows const aliases and destructuring to the export', () => {
            let targets = new Set(references.exported(checker, program, 'fake-pkg', 'make').map(references.key));

            expect(references.denotes(checker, program, callee('src/consumer.ts', 'alias(9)'), targets)).toBe(true);
            expect(references.denotes(checker, program, callee('src/consumer.ts', 'destructured(10)'), targets)).toBe(true);
            expect(references.denotes(checker, program, callee('src/consumer.ts', "B['build'](8)"), targets)).toBe(true);
        });

        it('does not follow a reassignable binding or a same-named local', () => {
            let targets = new Set(references.exported(checker, program, 'fake-pkg', 'make').map(references.key));

            expect(references.denotes(checker, program, callee('src/consumer.ts', 'loose(11)'), targets)).toBe(false);
            expect(references.denotes(checker, program, callee('src/unrelated.ts', 'make(8)'), targets)).toBe(false);
        });
    });

    describe('origin', () => {
        it('resolves the property a binding element destructures', () => {
            let element = find('src/consumer.ts', node => isBindingElement(node)),
                origin = references.origin(checker, program, element)!,
                targets = references.exported(checker, program, 'fake-pkg', 'make').map(references.key);

            expect(targets).toContain(references.key(origin.declaration));
        });
    });
});
