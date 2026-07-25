import { afterAll, describe, expect, it } from 'vitest';
import type { Identifier, Node, SourceFile } from 'typescript/unstable/ast';
import { isIdentifier, isImportClause, isImportSpecifier, isNamespaceImport } from 'typescript/unstable/ast/is';
import type { Checker } from 'typescript/unstable/sync';
import { SymbolFlags } from 'typescript/unstable/sync';

import imports from '~/compiler/imports';
import languageService from '~/compiler/language-service';


const root = process.cwd().replace(/\\/g, '/');


function parse(code: string, fileName = root + '/src/test-imports.ts'): SourceFile {
    return languageService.parse(fileName, code);
}


afterAll(() => languageService.dispose());


describe('imports.all', () => {
    it('finds named imports from a package', () => {
        let file = parse("import { foo, bar } from 'my-pkg';"),
            result = imports.all(file, 'my-pkg');

        expect(result).toHaveLength(1);
        expect(result[0].specifiers.get('foo')).toBe('foo');
        expect(result[0].specifiers.get('bar')).toBe('bar');
    });

    it('handles aliased imports', () => {
        let file = parse("import { foo as f } from 'my-pkg';"),
            result = imports.all(file, 'my-pkg');

        expect(result).toHaveLength(1);
        expect(result[0].specifiers.get('foo')).toBe('f');
    });

    it('returns empty for non-matching package', () => {
        let file = parse("import { foo } from 'other-pkg';"),
            result = imports.all(file, 'my-pkg');

        expect(result).toHaveLength(0);
    });

    it('returns empty when no imports', () => {
        let file = parse('let x = 1;'),
            result = imports.all(file, 'my-pkg');

        expect(result).toHaveLength(0);
    });

    it('finds multiple import statements for same package', () => {
        let file = parse("import { a } from 'pkg';\nimport { b } from 'pkg';"),
            result = imports.all(file, 'pkg');

        expect(result).toHaveLength(2);
    });

    it('tracks start and end positions', () => {
        let file = parse("import { foo } from 'my-pkg';"),
            result = imports.all(file, 'my-pkg');

        expect(result[0].start).toBe(0);
        expect(result[0].end).toBeGreaterThan(0);
    });

    it('handles default import (no named bindings)', () => {
        let file = parse("import pkg from 'my-pkg';"),
            result = imports.all(file, 'my-pkg');

        expect(result).toHaveLength(1);
        expect(result[0].specifiers.size).toBe(0);
    });

    it('handles namespace import', () => {
        let file = parse("import * as pkg from 'my-pkg';"),
            result = imports.all(file, 'my-pkg');

        expect(result).toHaveLength(1);
        expect(result[0].specifiers.size).toBe(0);
    });
});


describe('imports.includes', () => {
    let mockChecker = { getSymbolAtLocation: () => null } as unknown as Checker;

    // A checker that resolves a name to a declaration living inside node_modules/<pkg> — the genuine-import answer.
    let resolvingChecker = {
        getSymbolAtLocation: () => ({
            declarations: [{ path: root + '/node_modules/my-pkg/index.d.ts' }]
        })
    } as unknown as Checker;

    function findAll(file: SourceFile, name: string): Identifier[] {
        let found: Identifier[] = [];

        function visit(n: Node): void {
            if (isIdentifier(n) && n.text === name) {
                let parent = n.parent;

                if (!isImportSpecifier(parent) && !isImportClause(parent) && !isNamespaceImport(parent)) {
                    found.push(n);
                }
            }

            n.forEachChild(visit);
        }

        file.forEachChild(visit);

        return found;
    }

    function findIdentifier(file: SourceFile, name: string): Identifier | undefined {
        return findAll(file, name)[0];
    }

    it('direct named import matches', () => {
        let file = parse("import { reactive } from 'my-pkg';\nreactive(x);"),
            node = findIdentifier(file, 'reactive');

        expect(node).toBeDefined();
        expect(imports.includes(resolvingChecker, node!, 'my-pkg', 'reactive')).toBe(true);
    });

    it('aliased import matches', () => {
        let file = parse("import { foo as f } from 'my-pkg';\nf();"),
            node = findIdentifier(file, 'f');

        expect(node).toBeDefined();
        expect(imports.includes(resolvingChecker, node!, 'my-pkg')).toBe(true);
    });

    it('shadowed local binding is false at the inner reference and true at the outer', () => {
        let file = parse("import { html } from 'my-pkg';\nhtml(1);\nhtml(2);\n"),
            refs = findAll(file, 'html');

        expect(refs).toHaveLength(2);

        let inner = refs[1],
            outer = refs[0];

        // The checker resolves the inner reference to a local (shadowing) VariableDeclaration outside node_modules,
        // and the outer reference to the genuine import inside node_modules/my-pkg.
        let checker = {
            getSymbolAtLocation: (n: Node) => n === inner
                ? { declarations: [{ path: root + '/src/test-imports.ts' }] }
                : { declarations: [{ path: root + '/node_modules/my-pkg/index.d.ts' }] }
        } as unknown as Checker;

        expect(imports.includes(checker, inner, 'my-pkg')).toBe(false);
        expect(imports.includes(checker, outer, 'my-pkg')).toBe(true);
    });

    it('an unresolvable name-matching symbol is false, never trusted by name', () => {
        let file = parse("import { reactive } from 'my-pkg';\nreactive(1);"),
            node = findIdentifier(file, 'reactive');

        expect(node).toBeDefined();
        expect(imports.includes(mockChecker, node!, 'my-pkg', 'reactive')).toBe(false);
    });

    it('non-matching package returns false', () => {
        let file = parse("import { foo } from 'other-pkg';\nfoo();"),
            node = findIdentifier(file, 'foo');

        expect(node).toBeDefined();
        expect(imports.includes(mockChecker, node!, 'my-pkg')).toBe(false);
    });

    it('non-matching symbol name returns false', () => {
        let file = parse("import { foo } from 'my-pkg';\nfoo();"),
            node = findIdentifier(file, 'foo');

        expect(node).toBeDefined();
        expect(imports.includes(mockChecker, node!, 'my-pkg', 'bar')).toBe(false);
    });

    it('cache returns consistent results', () => {
        let file = parse("import { reactive } from 'my-pkg';\nreactive(1);"),
            node = findIdentifier(file, 'reactive');

        expect(node).toBeDefined();

        let first = imports.includes(resolvingChecker, node!, 'my-pkg', 'reactive'),
            second = imports.includes(resolvingChecker, node!, 'my-pkg', 'reactive');

        expect(first).toBe(true);
        expect(second).toBe(true);
        expect(first).toBe(second);
    });

    it('no imports at all returns false', () => {
        let file = parse('let x = 1;\nx;'),
            node = findIdentifier(file, 'x');

        expect(node).toBeDefined();
        expect(imports.includes(mockChecker, node!, 'my-pkg')).toBe(false);
    });

    it('a non-alias symbol reference returns false without relying on a thrown-and-swallowed error', () => {
        let file = parse("import { foo } from 'my-pkg';\nbar();"),
            node = findIdentifier(file, 'bar');

        expect(node).toBeDefined();

        let checker = {
            getSymbolAtLocation: () => ({
                declarations: [],
                flags: SymbolFlags.None
            }),
            getAliasedSymbol: () => { throw new Error('not an alias'); }
        } as unknown as Checker;

        expect(imports.includes(checker, node!, 'my-pkg')).toBe(false);
    });

    it('resolves a re-export through an aliased symbol whose flags carry the alias bit', () => {
        let file = parse("import { foo } from 'my-pkg';\nbar();"),
            node = findIdentifier(file, 'bar');

        expect(node).toBeDefined();

        let aliased = { declarations: [{ path: root + '/node_modules/my-pkg/index.d.ts' }] },
            checker = {
                getSymbolAtLocation: () => ({
                    declarations: [],
                    flags: SymbolFlags.Alias
                }),
                getAliasedSymbol: () => aliased
            } as unknown as Checker;

        expect(imports.includes(checker, node!, 'my-pkg')).toBe(true);
    });
});
