import { DiagnosticSeverity } from 'vscode-languageserver/node';

import type { Diagnostic as LspDiagnostic, DiagnosticRelatedInformation, Position, Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Diagnostic as AnalyzeDiagnostic, SourceLocation } from '~/analyze/kernel/types';

// Resolves an analyze absolute file path to the client's open document, so ranges
// come from the exact buffer the editor holds (and its URI matches the client's).
export type DocumentResolver = (fileName: string) => TextDocument | undefined;

// An analyze SourceLocation carries 1-based line/column for display plus absolute
// pos/end offsets. LSP wants 0-based positions; prefer the open document's
// offset mapping and fall back to the 1-based line/column when the file is closed.
function rangeOf(location: SourceLocation, document: TextDocument | undefined): Range {
    if (document) {
        return { start: document.positionAt(location.pos), end: document.positionAt(location.end) };
    }

    let start: Position = { line: Math.max(0, location.line - 1), character: Math.max(0, location.column - 1) };

    return { start, end: { line: start.line, character: start.character + 1 } };
}

function relatedOf(diagnostic: AnalyzeDiagnostic, resolve: DocumentResolver, uriOf: (fileName: string) => string): DiagnosticRelatedInformation[] {
    return diagnostic.related.map((related) => ({
        location: { range: rangeOf(related.location, resolve(related.location.fileName)), uri: uriOf(related.location.fileName) },
        message: related.message,
    }));
}

// Map one analyze finding to an LSP diagnostic. The escape chain (throw site →
// boundary) rides along as relatedInformation so the editor can jump the origin.
function toLspDiagnostic(diagnostic: AnalyzeDiagnostic, severity: DiagnosticSeverity, resolve: DocumentResolver, uriOf: (fileName: string) => string): LspDiagnostic {
    return {
        code: diagnostic.channel,
        message: diagnostic.message,
        range: rangeOf(diagnostic.location, resolve(diagnostic.location.fileName)),
        relatedInformation: relatedOf(diagnostic, resolve, uriOf),
        severity,
        source: 'analyze',
    };
}

// Group findings by their anchor file, mapping each to LSP form. Files with no
// findings never appear here; the server clears their stale diagnostics.
function groupByFile(diagnostics: ReadonlyArray<AnalyzeDiagnostic>, severity: DiagnosticSeverity, resolve: DocumentResolver, uriOf: (fileName: string) => string): Map<string, LspDiagnostic[]> {
    let grouped = new Map<string, LspDiagnostic[]>();

    for (let i = 0, n = diagnostics.length; i < n; i++) {
        let diagnostic = diagnostics[i]!,
            fileName = diagnostic.location.fileName,
            list = grouped.get(fileName);

        if (!list) {
            list = [];
            grouped.set(fileName, list);
        }

        list.push(toLspDiagnostic(diagnostic, severity, resolve, uriOf));
    }

    return grouped;
}

export { DiagnosticSeverity, groupByFile, toLspDiagnostic };
