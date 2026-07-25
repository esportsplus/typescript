type Edit = {
    end: number;
    newText: string;
    start: number;
};

type OffsetAnchor = {
    afterEnd: number;
    afterStart: number;
    beforeStart: number;
    identity: boolean;
};

type PositionMapping = {
    generations: OffsetAnchor[][];
};

type Segment = {
    genColumn: number;
    name?: number;
    originalColumn?: number;
    originalLine?: number;
    source?: number;
};

type SourceMapV3 = {
    file?: string;
    mappings: string;
    names: string[];
    sourceRoot?: string;
    sources: (string | null)[];
    sourcesContent?: (string | null)[];
    version: 3;
};


const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';


let inverse = buildInverse();


function buildInverse(): Int8Array {
    let table = new Int8Array(128).fill(-1);

    for (let i = 0, n = BASE64.length; i < n; i++) {
        table[BASE64.charCodeAt(i)] = i;
    }

    return table;
}

function decodeVlqArray(segment: string): number[] {
    let out: number[] = [],
        i = 0,
        n = segment.length;

    while (i < n) {
        let digit = 0,
            result = 0,
            shift = 0;

        do {
            digit = inverse[segment.charCodeAt(i)];
            i++;
            result += (digit & 31) << shift;
            shift += 5;
        }
        while (digit & 32);

        out.push((result & 1) ? -(result >>> 1) : (result >>> 1));
    }

    return out;
}

function encodeVlq(value: number): string {
    let out = '',
        vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;

    do {
        let digit = vlq & 31;

        vlq >>>= 5;

        if (vlq > 0) {
            digit |= 32;
        }

        out += BASE64[digit];
    }
    while (vlq > 0);

    return out;
}

function lineStarts(text: string): number[] {
    let starts = [0];

    for (let i = 0, n = text.length; i < n; i++) {
        if (text.charCodeAt(i) === 10) {
            starts.push(i + 1);
        }
    }

    return starts;
}

function offsetToLineCol(starts: number[], offset: number): { column: number; line: number } {
    let hi = starts.length - 1,
        line = 0,
        lo = 0;

    while (lo <= hi) {
        let mid = (lo + hi) >> 1;

        if (starts[mid] <= offset) {
            line = mid;
            lo = mid + 1;
        }
        else {
            hi = mid - 1;
        }
    }

    return { column: offset - starts[line], line };
}

function rawToSegments(raw: number[][][]): Segment[][] {
    let name = 0,
        origColumn = 0,
        origLine = 0,
        source = 0;

    return raw.map((line) => {
        let genColumn = 0;

        return line.map((values) => {
            genColumn += values[0];

            let segment: Segment = { genColumn };

            if (values.length >= 4) {
                source += values[1];
                origLine += values[2];
                origColumn += values[3];
                segment.originalColumn = origColumn;
                segment.originalLine = origLine;
                segment.source = source;

                if (values.length >= 5) {
                    name += values[4];
                    segment.name = name;
                }
            }

            return segment;
        });
    });
}

function resolveGeneration(anchors: OffsetAnchor[], offset: number): number {
    let found = anchors[0],
        hi = anchors.length - 1,
        lo = 0;

    while (lo <= hi) {
        let mid = (lo + hi) >> 1,
            anchor = anchors[mid];

        if (offset < anchor.afterStart) {
            hi = mid - 1;
        }
        else {
            found = anchor;
            lo = mid + 1;
        }
    }

    if (found.identity) {
        return found.beforeStart + (offset - found.afterStart);
    }

    return found.beforeStart;
}

function resolveOffset(mapping: PositionMapping, offset: number): number {
    let generations = mapping.generations,
        result = offset;

    for (let i = generations.length - 1; i >= 0; i--) {
        result = resolveGeneration(generations[i], result);
    }

    return result;
}

function segmentsToRaw(segments: Segment[][]): number[][][] {
    let name = 0,
        origColumn = 0,
        origLine = 0,
        source = 0;

    return segments.map((line) => {
        let genColumn = 0;

        return line.map((segment) => {
            let values = [segment.genColumn - genColumn];

            genColumn = segment.genColumn;

            if (segment.source !== undefined && segment.originalLine !== undefined && segment.originalColumn !== undefined) {
                values.push(segment.source - source, segment.originalLine - origLine, segment.originalColumn - origColumn);
                origColumn = segment.originalColumn;
                origLine = segment.originalLine;
                source = segment.source;

                if (segment.name !== undefined) {
                    values.push(segment.name - name);
                    name = segment.name;
                }
            }

            return values;
        });
    });
}


const buildGeneration = (beforeText: string, edits: Edit[]): OffsetAnchor[] => {
    let afterCursor = 0,
        anchors: OffsetAnchor[] = [],
        beforeCursor = 0,
        ordered = [...edits].sort((a, b) => a.start - b.start);

    for (let i = 0, n = ordered.length; i < n; i++) {
        let edit = ordered[i];

        if (edit.start > beforeCursor) {
            let length = edit.start - beforeCursor;

            anchors.push({ afterEnd: afterCursor + length, afterStart: afterCursor, beforeStart: beforeCursor, identity: true });
            afterCursor += length;
        }

        let inserted = edit.newText.length;

        if (inserted > 0) {
            anchors.push({ afterEnd: afterCursor + inserted, afterStart: afterCursor, beforeStart: edit.start, identity: false });
            afterCursor += inserted;
        }

        beforeCursor = edit.end;
    }

    if (beforeCursor < beforeText.length) {
        anchors.push({ afterEnd: afterCursor + (beforeText.length - beforeCursor), afterStart: afterCursor, beforeStart: beforeCursor, identity: true });
    }

    if (anchors.length === 0) {
        anchors.push({ afterEnd: 0, afterStart: 0, beforeStart: 0, identity: true });
    }

    return anchors;
};

const composeEmittedMap = (map: SourceMapV3, mapping: PositionMapping, transformedText: string, originalText: string): SourceMapV3 => {
    let oStarts = lineStarts(originalText),
        segments = rawToSegments(decode(map.mappings)),
        tStarts = lineStarts(transformedText);

    for (let i = 0, n = segments.length; i < n; i++) {
        let line = segments[i];

        for (let j = 0, m = line.length; j < m; j++) {
            let segment = line[j];

            if (segment.originalLine === undefined || segment.originalColumn === undefined) {
                continue;
            }

            let base = segment.originalLine < tStarts.length ? tStarts[segment.originalLine] : transformedText.length,
                position = offsetToLineCol(oStarts, resolveOffset(mapping, base + segment.originalColumn));

            segment.originalColumn = position.column;
            segment.originalLine = position.line;
        }
    }

    let composed: SourceMapV3 = {
        mappings: encode(segmentsToRaw(segments)),
        names: map.names ?? [],
        sources: map.sources,
        version: 3
    };

    if (map.file !== undefined) {
        composed.file = map.file;
    }

    if (map.sourceRoot !== undefined) {
        composed.sourceRoot = map.sourceRoot;
    }

    return composed;
};

const decode = (mappings: string): number[][][] => {
    if (mappings === '') {
        return [];
    }

    return mappings.split(';').map((line) => {
        if (line === '') {
            return [];
        }

        return line.split(',').map((segment) => decodeVlqArray(segment));
    });
};

const encode = (decoded: number[][][]): string => {
    let lines: string[] = [];

    for (let i = 0, n = decoded.length; i < n; i++) {
        let parts: string[] = [],
            segments = decoded[i];

        for (let j = 0, m = segments.length; j < m; j++) {
            let encoded = '',
                values = segments[j];

            for (let k = 0, o = values.length; k < o; k++) {
                encoded += encodeVlq(values[k]);
            }

            parts.push(encoded);
        }

        lines.push(parts.join(','));
    }

    return lines.join(';');
};

const originalPositionFor = (mapping: PositionMapping, transformedText: string, originalText: string, line: number, column: number): { column: number; line: number } => {
    let tStarts = lineStarts(transformedText),
        base = line < tStarts.length ? tStarts[line] : transformedText.length;

    return offsetToLineCol(lineStarts(originalText), resolveOffset(mapping, base + column));
};

const toSourceMapV3 = (mapping: PositionMapping, transformedText: string, originalText: string, source: string): SourceMapV3 => {
    let lastColumn = 0,
        lastLine = 0,
        oStarts = lineStarts(originalText),
        raw: number[][][] = [],
        tStarts = lineStarts(transformedText);

    for (let line = 0, n = tStarts.length; line < n; line++) {
        let position = offsetToLineCol(oStarts, resolveOffset(mapping, tStarts[line]));

        raw.push([[0, 0, position.line - lastLine, position.column - lastColumn]]);
        lastColumn = position.column;
        lastLine = position.line;
    }

    return { mappings: encode(raw), names: [], sources: [source], version: 3 };
};


export default { buildGeneration, composeEmittedMap, decode, encode, originalPositionFor, toSourceMapV3 };
export { buildGeneration, composeEmittedMap, decode, encode, originalPositionFor, toSourceMapV3 };
export type { Edit, OffsetAnchor, PositionMapping, Segment, SourceMapV3 };
