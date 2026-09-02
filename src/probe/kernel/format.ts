import * as NodePath from 'node:path';

import type { Diagnostic } from './types';

function rel(projectRoot: string, fileName: string): string {
    const r = NodePath.relative(projectRoot, fileName);
    return r === '' || r.startsWith('..')
        ? fileName
        : r.split(NodePath.sep).join('/');
}

// One diagnostic as CLI text: the site, the message, then the escape chain as
// indented related locations.
export function formatDiagnostic(
    diagnostic: Diagnostic,
    projectRoot: string,
): string {
    const loc = diagnostic.location;
    const head = `${rel(projectRoot, loc.fileName)}:${loc.line}:${loc.column} — ${diagnostic.message}`;
    if (diagnostic.related.length === 0) {
        return head;
    }
    const chain = diagnostic.related
        .map((r) => {
            const l = r.location;
            return `    ↳ ${rel(projectRoot, l.fileName)}:${l.line}:${l.column} — ${r.message}`;
        })
        .join('\n');
    return `${head}\n${chain}`;
}

export function formatDiagnostics(
    diagnostics: ReadonlyArray<Diagnostic>,
    projectRoot: string,
): string {
    if (diagnostics.length === 0) {
        return 'analyze: no findings.';
    }
    const body = diagnostics
        .map((d) => formatDiagnostic(d, projectRoot))
        .join('\n\n');
    const noun = diagnostics.length === 1 ? 'finding' : 'findings';
    return `${body}\n\nanalyze: ${diagnostics.length} ${noun}.`;
}
