import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';

import { CodeActionKind, createConnection, ProposedFeatures, StreamMessageReader, StreamMessageWriter, TextDocuments, TextDocumentSyncKind } from 'vscode-languageserver/node';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { codeActionsAt, DiagnosticSeverity, groupByFile, hoverAt } from './diagnostics';
import { AnalyzeWorkspace } from './workspace';

import type { Connection } from 'vscode-languageserver/node';
import type { DocumentResolver } from './diagnostics';
import type { Diagnostic as AnalyzeDiagnostic } from '~/probe/kernel/types';

// Windows hands back file URIs with inconsistent drive-letter casing and percent
// encoding; a case-folded absolute path is the only stable key across the native
// program's file names and the client's document URIs.
function pathKey(fileName: string): string {
    let resolved = NodePath.resolve(fileName);

    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function findTsconfig(rootDir: string): string | undefined {
    let candidate = NodePath.join(rootDir, 'tsconfig.json');

    return NodeFS.existsSync(candidate) ? candidate : undefined;
}

function rootFromInitialize(params: { rootUri?: string | null; workspaceFolders?: ReadonlyArray<{ uri: string }> | null }): string | undefined {
    let folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined;

    return folder ? fileURLToPath(folder) : undefined;
}

// Wire an analyze language server onto a JSON-RPC connection. The native compiler
// serves standard TypeScript features; this server publishes only analyze's
// throw-safety diagnostics, so a client attaches it alongside the native LSP.
function createServer(connection: Connection): void {
    let analyzed = new Map<string, AnalyzeDiagnostic[]>(),
        documents = new TextDocuments(TextDocument),
        pending = new Set<string>(),
        published = new Set<string>(),
        timer: ReturnType<typeof setTimeout> | undefined,
        workspace: AnalyzeWorkspace | undefined;

    // Publish (or clear) the single tsconfig.json diagnostic that reports a
    // rejected/legacy `tsc-probe` key. The workspace keeps `config` undefined while
    // an error stands, so analysis stays inert until the config loads cleanly.
    function publishConfigError(): void {
        if (!workspace) {
            return;
        }

        let uri = pathToFileURL(workspace.configPath).toString();

        if (workspace.configError) {
            connection.sendDiagnostics({
                diagnostics: [{
                    message: workspace.configError,
                    range: { end: { character: 0, line: 0 }, start: { character: 0, line: 0 } },
                    severity: DiagnosticSeverity.Error,
                    source: 'analyze',
                }],
                uri,
            });
            published.add(uri);
        }
        else if (published.has(uri)) {
            connection.sendDiagnostics({ diagnostics: [], uri });
            published.delete(uri);
        }
    }

    // The native API reads files from disk, so unsaved buffers are not reflected;
    // analysis runs on open and on save against the last-saved project state.
    function runAnalysis(): void {
        timer = undefined;

        if (!workspace) {
            return;
        }

        publishConfigError();

        if (!workspace.config) {
            return;
        }

        let config = workspace.config,
            changed = [...pending];

        pending.clear();

        try {
            workspace.refresh(changed);
        }
        catch (error) {
            connection.console.error(`analyze: snapshot refresh failed — ${(error as Error).message}`);
            return;
        }

        let result = workspace.analyze();

        if (!result) {
            return;
        }

        // Keep the raw findings per file so hover and code-action requests can look
        // them up by position without re-running analysis.
        analyzed = new Map();

        for (let diagnostic of result.diagnostics) {
            let key = pathKey(diagnostic.location.fileName),
                list = analyzed.get(key);

            if (!list) {
                list = [];
                analyzed.set(key, list);
            }

            list.push(diagnostic);
        }

        let openByPath = new Map(documents.all().map((document) => [pathKey(fileURLToPath(document.uri)), document])),
            resolve: DocumentResolver = (fileName) => openByPath.get(pathKey(fileName)),
            severityOf = (channel: string) => config.channels[channel]?.severity === 'warn' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
            uriOf = (fileName: string) => openByPath.get(pathKey(fileName))?.uri ?? pathToFileURL(fileName).toString(),
            grouped = groupByFile(result.diagnostics, severityOf, resolve, uriOf),
            next = new Set<string>();

        // A standing config-error diagnostic on tsconfig.json is not a finding, so
        // keep it out of the stale-clear sweep below.
        if (workspace.configError) {
            next.add(pathToFileURL(workspace.configPath).toString());
        }

        for (let [fileName, diagnostics] of grouped) {
            let uri = uriOf(fileName);

            next.add(uri);
            connection.sendDiagnostics({ diagnostics, uri });
        }

        for (let uri of published) {
            if (!next.has(uri)) {
                connection.sendDiagnostics({ diagnostics: [], uri });
            }
        }

        published = next;
    }

    function schedule(changed: ReadonlyArray<string>): void {
        for (let i = 0, n = changed.length; i < n; i++) {
            pending.add(changed[i]!);
        }

        if (timer !== undefined) {
            clearTimeout(timer);
        }

        timer = setTimeout(runAnalysis, 300);
    }

    connection.onInitialize((params) => {
        let root = rootFromInitialize(params);

        if (root) {
            let tsconfig = findTsconfig(root);

            if (tsconfig) {
                workspace = new AnalyzeWorkspace(tsconfig);
            }
        }

        return {
            capabilities: {
                codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
                hoverProvider: true,
                textDocumentSync: TextDocumentSyncKind.Incremental,
            },
        };
    });

    connection.onInitialized(() => {
        if (workspace) {
            schedule([]);
        }
    });

    connection.onShutdown(() => {
        workspace?.dispose();
        workspace = undefined;
    });

    connection.onHover((params) => {
        let document = documents.get(params.textDocument.uri);

        if (!document) {
            return null;
        }

        let diagnostics = analyzed.get(pathKey(fileURLToPath(params.textDocument.uri)));

        return diagnostics ? hoverAt(diagnostics, document.offsetAt(params.position), document) ?? null : null;
    });

    connection.onCodeAction((params) => {
        let document = documents.get(params.textDocument.uri);

        if (!document) {
            return [];
        }

        let target = pathKey(fileURLToPath(params.textDocument.uri)),
            diagnostics = analyzed.get(target);

        if (!diagnostics) {
            return [];
        }

        let uriOf = (fileName: string) => (pathKey(fileName) === target ? params.textDocument.uri : pathToFileURL(fileName).toString());

        return codeActionsAt(diagnostics, document.offsetAt(params.range.start), document.offsetAt(params.range.end), document, uriOf);
    });

    documents.onDidOpen((event) => schedule([fileURLToPath(event.document.uri)]));

    documents.onDidSave((event) => {
        let fileName = fileURLToPath(event.document.uri);

        if (workspace && NodePath.basename(fileName) === 'tsconfig.json') {
            workspace.reloadConfig();
        }

        schedule([fileName]);
    });

    documents.listen(connection);
    connection.listen();
}

// Start a stdio-based analyze language server. Clients (the T3 Code file viewer,
// or any LSP host) spawn this and connect it beside the native TypeScript server.
function startServer(): void {
    createServer(createConnection(ProposedFeatures.all, new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout)));
}

export { createServer, startServer };
