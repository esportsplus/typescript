import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import ast from '~/compiler/ast';


function parse(code: string): ts.SourceFile {
    return ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true);
}

function findFirst(file: ts.SourceFile, predicate: (n: ts.Node) => boolean): ts.Node | undefined {
    let result: ts.Node | undefined;

    function visit(node: ts.Node) {
        if (result) {
            return;
        }

        if (predicate(node)) {
            result = node;
            return;
        }

        ts.forEachChild(node, visit);
    }

    ts.forEachChild(file, visit);

    return result;
}


describe('ast.expression.name', () => {
    it('returns text for identifiers', () => {
        let file = parse('let x = foo;'),
            node = findFirst(file, ts.isIdentifier);

        expect(node).toBeDefined();
        expect(ast.expression.name(node as ts.Expression)).toBe('x');
    });

    it('returns dotted path for property access', () => {
        let file = parse('a.b.c;'),
            node = findFirst(file, ts.isPropertyAccessExpression);

        expect(node).toBeDefined();
        expect(ast.expression.name(node as ts.Expression)).toBe('a.b.c');
    });

    it('returns null for unsupported expressions', () => {
        let file = parse('foo();'),
            node = findFirst(file, ts.isCallExpression);

        expect(node).toBeDefined();
        expect(ast.expression.name(node as ts.Expression)).toBeNull();
    });
});


describe('ast.inRange', () => {
    it('returns true when node is within range', () => {
        expect(ast.inRange([{ start: 0, end: 100 }], 10, 50)).toBe(true);
    });

    it('returns true at exact boundaries', () => {
        expect(ast.inRange([{ start: 10, end: 50 }], 10, 50)).toBe(true);
    });

    it('returns false when node is outside range', () => {
        expect(ast.inRange([{ start: 10, end: 50 }], 0, 9)).toBe(false);
    });

    it('returns false when node partially overlaps', () => {
        expect(ast.inRange([{ start: 10, end: 50 }], 5, 30)).toBe(false);
    });

    it('returns false for empty ranges', () => {
        expect(ast.inRange([], 0, 10)).toBe(false);
    });

    it('checks multiple ranges', () => {
        let ranges = [{ start: 0, end: 10 }, { start: 20, end: 30 }];

        expect(ast.inRange(ranges, 0, 10)).toBe(true);
        expect(ast.inRange(ranges, 25, 28)).toBe(true);
        expect(ast.inRange(ranges, 11, 19)).toBe(false);
    });
});


describe('ast.property.path', () => {
    it('returns dotted path for nested access', () => {
        let file = parse('a.b.c.d;'),
            node = findFirst(file, (n) => ts.isPropertyAccessExpression(n) && !ts.isPropertyAccessExpression(n.parent));

        expect(node).toBeDefined();
        expect(ast.property.path(node as ts.Expression)).toBe('a.b.c.d');
    });

    it('returns null for non-identifier base', () => {
        let file = parse('foo().bar;'),
            node = findFirst(file, ts.isPropertyAccessExpression);

        expect(node).toBeDefined();
        expect(ast.property.path(node as ts.Expression)).toBeNull();
    });
});


describe('ast.test', () => {
    it('returns true when predicate matches root', () => {
        let file = parse('let x = 1;'),
            found = ast.test(file, (n) => ts.isVariableStatement(n));

        expect(found).toBe(true);
    });

    it('returns true when predicate matches deep child', () => {
        let file = parse('function f() { return { a: 1 }; }'),
            found = ast.test(file, (n) => ts.isObjectLiteralExpression(n));

        expect(found).toBe(true);
    });

    it('returns false when predicate never matches', () => {
        let file = parse('let x = 1;'),
            found = ast.test(file, (n) => ts.isClassDeclaration(n));

        expect(found).toBe(false);
    });
});
