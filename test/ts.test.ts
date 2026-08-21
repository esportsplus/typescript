import { describe, expect, it } from 'vitest';

import * as ts from '~/ts';


describe('ts', () => {
    it('vends the ast node guards and enums', () => {
        expect(typeof ts.isCallExpression).toBe('function');
        expect(typeof ts.isIdentifier).toBe('function');
        expect(typeof ts.isPropertyAccessExpression).toBe('function');
        expect(ts.SyntaxKind.ReadonlyKeyword).toBeTypeOf('number');
    });

    it('vends the sync checker enums and type predicates', () => {
        expect(typeof ts.isStringLiteralType).toBe('function');
        expect(typeof ts.isTupleType).toBe('function');
        expect(typeof ts.isUnionType).toBe('function');
        expect(ts.TypeFlags.Object).toBeTypeOf('number');
        expect(ts.SymbolFlags.Alias).toBeTypeOf('number');
    });

    it('keeps ModifierFlags despite the ast/sync collision', () => {
        expect(ts.ModifierFlags.Readonly).toBe(8);
    });

    it('vends the index-signature surface that replaces IndexKind', () => {
        expect(ts.TypeFlags.String).toBeTypeOf('number');
        expect(ts.ElementFlags.Optional).toBeTypeOf('number');
    });
});
