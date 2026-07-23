import { readFileSync } from 'fs';
import { computeLineStarts } from 'typescript/unstable/ast/scanner';
import { type Diagnostic, DiagnosticCategory } from 'typescript/unstable/sync';

import path from 'path';


const ANSI_BLUE = '\x1b[94m';

const ANSI_CYAN = '\x1b[96m';

const ANSI_GREY = '\x1b[90m';

const ANSI_RED = '\x1b[91m';

const ANSI_RESET = '\x1b[0m';

const ANSI_YELLOW = '\x1b[93m';

const BACKSLASH_REGEX = /\\/g;

const TRAILING_NEWLINE_REGEX = /\r?\n$/;


function categoryColor(category: DiagnosticCategory): string {
    switch (category) {
        case DiagnosticCategory.Error:
            return ANSI_RED;

        case DiagnosticCategory.Suggestion:
            return ANSI_BLUE;

        case DiagnosticCategory.Warning:
            return ANSI_YELLOW;

        default:
            return ANSI_GREY;
    }
}

function categoryLabel(category: DiagnosticCategory): string {
    switch (category) {
        case DiagnosticCategory.Error:
            return 'error';

        case DiagnosticCategory.Suggestion:
            return 'suggestion';

        case DiagnosticCategory.Warning:
            return 'warning';

        default:
            return 'message';
    }
}

function formatOne(diagnostic: Diagnostic, root: string): string {
    let category = categoryLabel(diagnostic.category),
        code = `${ANSI_GREY}TS${diagnostic.code}${ANSI_RESET}`,
        color = categoryColor(diagnostic.category),
        message = flatten(diagnostic);

    if (diagnostic.fileName === undefined) {
        return `${color}${category}${ANSI_RESET} ${code}: ${message}`;
    }

    let location = `${ANSI_CYAN}${path.relative(root, diagnostic.fileName).replace(BACKSLASH_REGEX, '/')}${ANSI_RESET}`,
        text = readSource(diagnostic.fileName);

    if (text === undefined) {
        return `${location} - ${color}${category}${ANSI_RESET} ${code}: ${message}`;
    }

    let lineStarts = computeLineStarts(text),
        line = lineOfPosition(lineStarts, diagnostic.pos),
        character = diagnostic.pos - lineStarts[line],
        lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] : text.length,
        source = text.slice(lineStarts[line], lineEnd).replace(TRAILING_NEWLINE_REGEX, ''),
        width = Math.max(1, Math.min(diagnostic.end, lineEnd) - diagnostic.pos),
        underline = `${' '.repeat(character)}${color}${'~'.repeat(width)}${ANSI_RESET}`,
        header = `${location}:${ANSI_YELLOW}${line + 1}${ANSI_RESET}:${ANSI_YELLOW}${character + 1}${ANSI_RESET} - ${color}${category}${ANSI_RESET} ${code}: ${message}`;

    return `${header}\n\n${source}\n${underline}`;
}

function lineOfPosition(lineStarts: readonly number[], position: number): number {
    let high = lineStarts.length - 1,
        low = 0;

    while (low <= high) {
        let middle = (low + high) >> 1;

        if (lineStarts[middle] <= position) {
            low = middle + 1;
        }
        else {
            high = middle - 1;
        }
    }

    return high < 0 ? 0 : high;
}

function readSource(fileName: string): string | undefined {
    try {
        return readFileSync(fileName, 'utf8');
    }
    catch {
        return undefined;
    }
}


const flatten = (diagnostic: Diagnostic, indent: number = 0): string => {
    let result = '';

    if (indent > 0) {
        result += `\n${'  '.repeat(indent)}`;
    }

    result += diagnostic.text;

    if (diagnostic.messageChain !== undefined) {
        for (let i = 0, n = diagnostic.messageChain.length; i < n; i++) {
            result += flatten(diagnostic.messageChain[i], indent + 1);
        }
    }

    return result;
};

const format = (diagnostics: readonly Diagnostic[], root: string): string => {
    let parts: string[] = [];

    for (let i = 0, n = diagnostics.length; i < n; i++) {
        parts.push(formatOne(diagnostics[i], root));
    }

    return parts.join('\n\n');
};


export { flatten, format };
