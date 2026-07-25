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

    it('escapes a trailing single backslash', () => {
        expect(code.escape('a\\')).toBe('a\\\\');
    });

    it('escapes an embedded backslash-quote pair', () => {
        expect(code.escape("a\\'b")).toBe("a\\\\\\'b");
    });

    it('escapes a doubled backslash', () => {
        expect(code.escape('a\\\\b')).toBe('a\\\\\\\\b');
    });

    it('escapes a newline', () => {
        expect(code.escape('a\nb')).toBe('a\\nb');
    });

    it('escapes a CRLF pair', () => {
        expect(code.escape('a\r\nb')).toBe('a\\r\\nb');
    });

    it('escapes U+2028 line separator', () => {
        expect(code.escape('a\u2028b')).toBe('a\\u2028b');
    });

    it('escapes U+2029 paragraph separator', () => {
        expect(code.escape('a\u2029b')).toBe('a\\u2029b');
    });

    it('round-trips through single-quote literal semantics', () => {
        let original = "it's a \\test\\ with\nnewlines\r\nand   separators   too",
            escaped = code.escape(original),
            reparsed = new Function(`'use strict'; return '${escaped}';`)() as string;

        expect(reparsed).toBe(original);
    });
});
