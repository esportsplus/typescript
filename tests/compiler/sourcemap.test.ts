import { describe, expect, it } from 'vitest';

import type { Edit, PositionMapping, SourceMapV3 } from '~/compiler/sourcemap';

import sourcemap from '~/compiler/sourcemap';


function absolute(mappings: string): { column: number; line: number }[] {
    let decoded = sourcemap.decode(mappings),
        origColumn = 0,
        origLine = 0,
        out: { column: number; line: number }[] = [],
        source = 0;

    for (let i = 0, n = decoded.length; i < n; i++) {
        for (let j = 0, m = decoded[i].length; j < m; j++) {
            let values = decoded[i][j];

            if (values.length >= 4) {
                source += values[1];
                origLine += values[2];
                origColumn += values[3];
                out.push({ column: origColumn, line: origLine });
            }
        }
    }

    return out;
}

function map(before: string, edits: Edit[]): PositionMapping {
    return { generations: [sourcemap.buildGeneration(before, edits)] };
}

function transformText(before: string, edits: Edit[]): string {
    let ordered = [...edits].sort((a, b) => b.start - a.start),
        result = before;

    for (let i = 0, n = ordered.length; i < n; i++) {
        result = result.slice(0, ordered[i].start) + ordered[i].newText + result.slice(ordered[i].end);
    }

    return result;
}


describe('sourcemap.decode / encode', () => {
    it('round-trips an empty mappings string', () => {
        expect(sourcemap.decode('')).toEqual([]);
        expect(sourcemap.encode([])).toBe('');
    });

    it('round-trips a canonical multi-line, multi-field mappings string', () => {
        let mappings = 'AAAA,GAGA;AACA;;AAgBC,QAAO';

        expect(sourcemap.encode(sourcemap.decode(mappings))).toBe(mappings);
    });

    it('decodes signed VLQ values (positive, negative, one- and five-field segments)', () => {
        let decoded = sourcemap.decode('AAAA;ADFH;IAAAD');

        expect(decoded[0]).toEqual([[0, 0, 0, 0]]);
        expect(decoded[1]).toEqual([[0, -1, -2, -3]]);
        expect(decoded[2]).toEqual([[4, 0, 0, 0, -1]]);
    });

    it('preserves empty lines on round-trip', () => {
        let mappings = 'AAAA;;AACA';

        expect(sourcemap.encode(sourcemap.decode(mappings))).toBe(mappings);
    });
});


describe('sourcemap.buildGeneration / originalPositionFor', () => {
    it('maps untouched regions identically (no edits)', () => {
        let before = 'let a = 1;\nlet b = 2;\n',
            mapping = map(before, []);

        expect(sourcemap.originalPositionFor(mapping, before, before, 1, 4)).toEqual({ column: 4, line: 1 });
    });

    it('prepend (line growth): post-injection lines shift back by the injected line count', () => {
        let before = 'let a = 1;\nlet b = 2;\n',
            edits: Edit[] = [{ end: 0, newText: 'INJECT\n', start: 0 }],
            after = transformText(before, edits),
            mapping = map(before, edits);

        expect(after).toBe('INJECT\nlet a = 1;\nlet b = 2;\n');
        // Transformed line 1 (`let a`) came from original line 0.
        expect(sourcemap.originalPositionFor(mapping, after, before, 1, 0)).toEqual({ column: 0, line: 0 });
        // Untouched column exactness on transformed line 2 (`let b`, original line 1).
        expect(sourcemap.originalPositionFor(mapping, after, before, 2, 4)).toEqual({ column: 4, line: 1 });
        // Injected text anchors at the injection point.
        expect(sourcemap.originalPositionFor(mapping, after, before, 0, 3)).toEqual({ column: 0, line: 0 });
    });

    it('replacement (line shrink): a multi-line span collapses to a single token', () => {
        let before = 'aa\nbb\ncc\n',
            edits: Edit[] = [{ end: 5, newText: 'Z', start: 0 }],
            after = transformText(before, edits),
            mapping = map(before, edits);

        expect(after).toBe('Z\ncc\n');
        // Transformed line 1 (`cc`) is original line 2.
        expect(sourcemap.originalPositionFor(mapping, after, before, 1, 0)).toEqual({ column: 0, line: 2 });
        // Inside the replacement token maps to the span start.
        expect(sourcemap.originalPositionFor(mapping, after, before, 0, 0)).toEqual({ column: 0, line: 0 });
    });

    it('handles CRLF line endings without double-counting columns', () => {
        let before = 'aa\r\nbb\r\n',
            edits: Edit[] = [{ end: 0, newText: 'X\r\n', start: 0 }],
            after = transformText(before, edits),
            mapping = map(before, edits);

        // Transformed line 2 (`bb`) is original line 1; the \r stays a column, not a line break.
        expect(sourcemap.originalPositionFor(mapping, after, before, 2, 0)).toEqual({ column: 0, line: 1 });
        expect(sourcemap.originalPositionFor(mapping, after, before, 1, 1)).toEqual({ column: 1, line: 0 });
    });

    it('handles a leading BOM as a single code unit', () => {
        let before = '﻿let a = 1;\nlet b = 2;\n',
            mapping = map(before, []);

        expect(sourcemap.originalPositionFor(mapping, before, before, 0, 1)).toEqual({ column: 1, line: 0 });
        expect(sourcemap.originalPositionFor(mapping, before, before, 1, 0)).toEqual({ column: 0, line: 1 });
    });

    it('counts astral-plane characters as two UTF-16 code units', () => {
        let before = '\u{1D7D8}x\ny\n',
            edits: Edit[] = [{ end: 0, newText: 'Z\n', start: 0 }],
            after = transformText(before, edits),
            mapping = map(before, edits);

        // `x` follows a surrogate pair — column 2 on original line 0.
        expect(sourcemap.originalPositionFor(mapping, after, before, 1, 2)).toEqual({ column: 2, line: 0 });
        expect(sourcemap.originalPositionFor(mapping, after, before, 2, 0)).toEqual({ column: 0, line: 1 });
    });

    it('handles an empty file', () => {
        let mapping = map('', []);

        expect(sourcemap.originalPositionFor(mapping, '', '', 0, 0)).toEqual({ column: 0, line: 0 });
    });

    it('handles an edit at offset 0 and an edit ending at EOF', () => {
        let before = 'ab',
            edits: Edit[] = [{ end: 2, newText: 'CD', start: 2 }],
            after = transformText(before, edits),
            mapping = map(before, edits);

        expect(after).toBe('abCD');
        expect(sourcemap.originalPositionFor(mapping, after, before, 0, 1)).toEqual({ column: 1, line: 0 });
        // Appended text past EOF anchors at the append point.
        expect(sourcemap.originalPositionFor(mapping, after, before, 0, 3)).toEqual({ column: 2, line: 0 });
    });

    it('handles two adjacent edits sharing a boundary offset', () => {
        let before = 'abcd',
            edits: Edit[] = [
                { end: 2, newText: 'X', start: 1 },
                { end: 3, newText: 'Y', start: 2 }
            ],
            after = transformText(before, edits),
            mapping = map(before, edits);

        expect(after).toBe('aXYd');
        expect(sourcemap.originalPositionFor(mapping, after, before, 0, 0)).toEqual({ column: 0, line: 0 });
        expect(sourcemap.originalPositionFor(mapping, after, before, 0, 1)).toEqual({ column: 1, line: 0 });
        expect(sourcemap.originalPositionFor(mapping, after, before, 0, 2)).toEqual({ column: 2, line: 0 });
        expect(sourcemap.originalPositionFor(mapping, after, before, 0, 3)).toEqual({ column: 3, line: 0 });
    });

    it('handles a pure deletion (zero-length replacement)', () => {
        let before = 'abXYcd',
            edits: Edit[] = [{ end: 4, newText: '', start: 2 }],
            after = transformText(before, edits),
            mapping = map(before, edits);

        expect(after).toBe('abcd');
        // `c` in transformed maps back past the deleted `XY`.
        expect(sourcemap.originalPositionFor(mapping, after, before, 0, 2)).toEqual({ column: 4, line: 0 });
    });
});


describe('sourcemap.composeEmittedMap', () => {
    it('remaps a JS→transformed map onto the real source and drops sourcesContent', () => {
        let before = 'a\nb\n',
            edits: Edit[] = [{ end: 0, newText: 'X\n', start: 0 }],
            after = transformText(before, edits),
            mapping = map(before, edits),
            input: SourceMapV3 = {
                mappings: 'AAAA;AACA;AACA',
                names: [],
                sources: ['../src/index.ts'],
                sourcesContent: [after],
                version: 3
            },
            composed = sourcemap.composeEmittedMap(input, mapping, after, before),
            lines = absolute(composed.mappings);

        expect(composed.sources).toEqual(['../src/index.ts']);
        expect(composed.sourcesContent).toBeUndefined();
        // JS lines 0,1,2 → transformed lines 0,1,2 → original lines 0,0,1.
        expect(lines.map((l) => l.line)).toEqual([0, 0, 1]);
    });
});


describe('sourcemap.toSourceMapV3', () => {
    it('produces a valid v3 map naming the source and one segment per transformed line', () => {
        let before = 'a\nb\n',
            edits: Edit[] = [{ end: 0, newText: 'X\n', start: 0 }],
            after = transformText(before, edits),
            mapping = map(before, edits),
            result = sourcemap.toSourceMapV3(mapping, after, before, 'src/index.ts'),
            lines = absolute(result.mappings);

        expect(result.version).toBe(3);
        expect(result.sources).toEqual(['src/index.ts']);
        expect(result.sourcesContent).toBeUndefined();
        // Transformed line starts 0,1,2,3 (trailing empty line) resolve to original lines 0,0,1,2.
        expect(lines.map((l) => l.line)).toEqual([0, 0, 1, 2]);
    });
});
