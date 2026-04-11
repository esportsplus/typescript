import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import imports from '~/compiler/imports';


function parse(code: string, fileName = 'test.ts'): ts.SourceFile {
    return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
}


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
    let mockChecker = { getSymbolAtLocation: () => null } as unknown as ts.TypeChecker;

    function findIdentifier(file: ts.SourceFile, name: string): ts.Identifier | undefined {
        let found: ts.Identifier | undefined;

        ts.forEachChild(file, function visit(n) {
            if (ts.isIdentifier(n) && n.text === name && !found) {
                let parent = n.parent;

                if (!ts.isImportSpecifier(parent) && !ts.isImportClause(parent) && !ts.isNamespaceImport(parent)) {
                    found = n;
                }
            }

            ts.forEachChild(n, visit);
        });

        return found;
    }

    it('direct named import matches', () => {
        let file = parse("import { reactive } from 'my-pkg';\nreactive(x);"),
            node = findIdentifier(file, 'reactive');

        expect(node).toBeDefined();
        expect(imports.includes(mockChecker, node!, 'my-pkg', 'reactive')).toBe(true);
    });

    it('aliased import matches', () => {
        let file = parse("import { foo as f } from 'my-pkg';\nf();"),
            node = findIdentifier(file, 'f');

        expect(node).toBeDefined();
        expect(imports.includes(mockChecker, node!, 'my-pkg')).toBe(true);
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

        let first = imports.includes(mockChecker, node!, 'my-pkg', 'reactive'),
            second = imports.includes(mockChecker, node!, 'my-pkg', 'reactive');

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
});
