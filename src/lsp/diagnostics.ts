import { CodeActionKind, DiagnosticSeverity, MarkupKind } from 'vscode-languageserver/node';

import type { CodeAction, Diagnostic as LspDiagnostic, DiagnosticRelatedInformation, Hover, Position, Range, TextEdit } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Diagnostic as AnalyzeDiagnostic, SourceLocation } from '~/probe/kernel/types';

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

// Group findings by their anchor file, mapping each to LSP form. Each finding's
// squiggle severity comes from its own channel's configured severity, via
// `severityOf`. Files with no findings never appear here; the server clears their
// stale diagnostics.
function groupByFile(diagnostics: ReadonlyArray<AnalyzeDiagnostic>, severityOf: (channel: string) => DiagnosticSeverity, resolve: DocumentResolver, uriOf: (fileName: string) => string): Map<string, LspDiagnostic[]> {
    let grouped = new Map<string, LspDiagnostic[]>();

    for (let i = 0, n = diagnostics.length; i < n; i++) {
        let diagnostic = diagnostics[i]!,
            fileName = diagnostic.location.fileName,
            list = grouped.get(fileName);

        if (!list) {
            list = [];
            grouped.set(fileName, list);
        }

        list.push(toLspDiagnostic(diagnostic, severityOf(diagnostic.channel), resolve, uriOf));
    }

    return grouped;
}

// The findings whose anchor range covers `offset`, rendered as one hover: each
// channel's message plus its escape/leak chain. Absent when nothing is flagged there.
function hoverAt(diagnostics: ReadonlyArray<AnalyzeDiagnostic>, offset: number, document: TextDocument): Hover | undefined {
    let hits = diagnostics.filter((diagnostic) => offset >= diagnostic.location.pos && offset <= diagnostic.location.end);

    if (hits.length === 0) {
        return undefined;
    }

    let lines: string[] = [];

    for (let i = 0, n = hits.length; i < n; i++) {
        let diagnostic = hits[i]!;

        lines.push(`**${diagnostic.channel}** — ${diagnostic.message}`);

        for (let related of diagnostic.related) {
            lines.push(`- ${related.message}`);
        }
    }

    return { contents: { kind: MarkupKind.Markdown, value: lines.join('\n\n') }, range: rangeOf(hits[0]!.location, document) };
}

// Quick-fix code actions for findings intersecting [startOffset, endOffset]. Fixes
// are authored by the channels (same-file edits), mapped to the open document's
// offsets so the client applies them at the exact ranges.
function codeActionsAt(
    diagnostics: ReadonlyArray<AnalyzeDiagnostic>,
    startOffset: number,
    endOffset: number,
    document: TextDocument,
    uriOf: (fileName: string) => string,
): CodeAction[] {
    let actions: CodeAction[] = [];

    for (let diagnostic of diagnostics) {
        if (diagnostic.location.end < startOffset || diagnostic.location.pos > endOffset) {
            continue;
        }

        for (let fix of diagnostic.fixes ?? []) {
            let changes: Record<string, TextEdit[]> = {};

            for (let edit of fix.edits) {
                let uri = uriOf(edit.fileName),
                    range: Range = { start: document.positionAt(edit.pos), end: document.positionAt(edit.end) };

                (changes[uri] ??= []).push({ newText: edit.newText, range });
            }

            actions.push({ edit: { changes }, kind: CodeActionKind.QuickFix, title: fix.title });
        }
    }

    return actions;
}

export { codeActionsAt, DiagnosticSeverity, groupByFile, hoverAt, toLspDiagnostic };
