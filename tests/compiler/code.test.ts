import { describe, expect, it } from 'vitest';

import code from '~/compiler/code';


describe('code', () => {
    it('interpolates values into template', () => {
        let result = code`let x = ${'hello'};`;

        expect(result).toBe("let x = hello;");
    });

    it('handles multiple interpolations', () => {
        let result = code`${'a'} + ${'b'} = ${'c'}`;

        expect(result).toBe('a + b = c');
    });

    it('collapses null to empty string', () => {
        let result = code`x${null}y`;

        expect(result).toBe('xy');
    });

    it('collapses undefined to empty string', () => {
        let result = code`x${undefined}y`;

        expect(result).toBe('xy');
    });

    it('collapses false to empty string', () => {
        let result = code`x${false}y`;

        expect(result).toBe('xy');
    });

    it('preserves zero', () => {
        let result = code`x${0}y`;

        expect(result).toBe('x0y');
    });

    it('preserves empty string', () => {
        let result = code`x${''}y`;

        expect(result).toBe('xy');
    });

    it('handles no interpolations', () => {
        let result = code`just plain text`;

        expect(result).toBe('just plain text');
    });
});


describe('code.escape', () => {
    it('escapes single quotes', () => {
        expect(code.escape("it's")).toBe("it\\'s");
    });

    it('escapes multiple quotes', () => {
        expect(code.escape("a'b'c")).toBe("a\\'b\\'c");
    });

    it('returns unchanged string without quotes', () => {
        expect(code.escape('hello')).toBe('hello');
    });

    it('handles empty string', () => {
        expect(code.escape('')).toBe('');
    });
});
