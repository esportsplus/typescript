import { afterAll, describe, expect, it } from 'vitest';
import { SymbolFlags, type Checker } from 'typescript/unstable/sync';
import type { Identifier, Node, SourceFile } from 'typescript/unstable/ast';
import { SyntaxKind } from 'typescript/unstable/ast';
import { isIdentifier, isImportClause, isImportSpecifier, isNamespaceImport } from 'typescript/unstable/ast/is';

import fs from 'fs';
import imports from '~/compiler/imports';
import languageService from '~/compiler/language-service';
import path from 'path';


const root = process.cwd().replace(/\\/g, '/');


function findAll(file: SourceFile, name: string): Identifier[] {
    let found: Identifier[] = [];

    file.forEachChild((node) => {
        visitIdentifiers(node, name, found);
    });

    return found;
}

function findIdentifier(file: SourceFile, name: string): Identifier | undefined {
    return findAll(file, name)[0];
}

function findSpecifier(file: SourceFile): Node | undefined {
    let found: Node | undefined;

    let visit = (node: Node): void => {
        if (isImportSpecifier(node)) {
            found ??= node;
        }

        node.forEachChild(visit);
    };

    file.forEachChild(visit);

    return found;
}

function parse(code: string, fileName = root + '/src/test-imports.ts'): SourceFile {
    return languageService.parse(fileName, code);
}

function visitIdentifiers(node: Node, name: string, found: Identifier[]): void {
    if (isIdentifier(node) && node.text === name) {
        let parent = node.parent;

        if (!isImportSpecifier(parent) && !isImportClause(parent) && !isNamespaceImport(parent)) {
            found.push(node);
        }
    }

    node.forEachChild((child) => {
        visitIdentifiers(child, name, found);
    });
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

    it('records a default import', () => {
        let file = parse("import pkg from 'my-pkg';"),
            result = imports.all(file, 'my-pkg');

        expect(result).toHaveLength(1);
        expect(result[0].defaultName).toBe('pkg');
        expect(result[0].specifiers.size).toBe(0);
    });

    it('records a namespace import', () => {
        let file = parse("import * as pkg from 'my-pkg';"),
            result = imports.all(file, 'my-pkg');

        expect(result).toHaveLength(1);
        expect(result[0].namespace).toBe('pkg');
        expect(result[0].specifiers.size).toBe(0);
    });
});


describe('imports.includes', () => {
    let mockChecker = { getSymbolAtLocation: () => null } as unknown as Checker;

    // A declaration inside node_modules/<pkg> is what the checker returns for a genuine import.
    let resolvingChecker = {
        getSymbolAtLocation: () => ({
            declarations: [{ path: root + '/node_modules/my-pkg/index.d.ts' }]
        })
    } as unknown as Checker;

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

        // Inner resolves to the shadowing local outside node_modules; outer to the genuine import inside it.
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

    it('matches a linked install by its package.json name, with no node_modules segment in the path', () => {
        let directory = fs.mkdtempSync(path.join(root, 'test/.imports-linked-')).replace(/\\/g, '/');

        try {
            fs.writeFileSync(directory + '/package.json', JSON.stringify({ name: 'my-linked-pkg' }));
            fs.mkdirSync(directory + '/build');
            fs.writeFileSync(directory + '/build/package.json', JSON.stringify({ type: 'module' }));

            let file = parse("import { foo } from 'my-linked-pkg';\nbar();"),
                node = findIdentifier(file, 'bar'),
                checker = {
                    getSymbolAtLocation: () => ({ declarations: [{ path: directory + '/build/index.d.ts' }], flags: SymbolFlags.None })
                } as unknown as Checker;

            expect(imports.includes(checker, node!, 'my-linked-pkg')).toBe(true);
            expect(imports.includes(checker, node!, 'other-pkg')).toBe(false);
        }
        finally {
            fs.rmSync(directory, { force: true, recursive: true });
        }
    });

    it('never attributes a declaration in the analyzed file to the package, even inside its repository', () => {
        let directory = fs.mkdtempSync(path.join(root, 'test/.imports-self-')).replace(/\\/g, '/');

        try {
            fs.writeFileSync(directory + '/package.json', JSON.stringify({ name: 'my-own-pkg' }));

            let fileName = directory + '/component.ts',
                file = parse("import { html } from 'my-own-pkg';\nhtml(1);", fileName),
                node = findIdentifier(file, 'html'),
                checker = {
                    getSymbolAtLocation: () => ({ declarations: [{ path: fileName }], flags: SymbolFlags.None })
                } as unknown as Checker;

            expect(imports.includes(checker, node!, 'my-own-pkg', 'html')).toBe(false);
        }
        finally {
            fs.rmSync(directory, { force: true, recursive: true });
        }
    });

    it('matches symbolName against the local binding, so callers can pass a resolved alias', () => {
        let renamed = parse("import { validator as v } from 'my-pkg';\nv(1);");

        let checker = {
                getSymbolAtLocation: () => ({
                    declarations: [{
                        kind: SyntaxKind.ImportSpecifier,
                        path: root + '/src/test-imports.ts',
                        resolve: () => findSpecifier(renamed)
                    }],
                    flags: SymbolFlags.Alias
                })
            } as unknown as Checker;

        expect(imports.includes(checker, findIdentifier(renamed, 'v')!, 'my-pkg', 'v')).toBe(true);
        expect(imports.includes(checker, findIdentifier(renamed, 'v')!, 'my-pkg', 'validator')).toBe(false);
    });
});
