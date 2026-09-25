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
        "export { make as default } from './index';"
    ].join('\n'),
    'node_modules/fake-pkg/package.json': JSON.stringify({ name: 'fake-pkg', types: './index.d.ts' }),
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
