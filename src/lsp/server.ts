import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';

import { createConnection, ProposedFeatures, StreamMessageReader, StreamMessageWriter, TextDocuments, TextDocumentSyncKind } from 'vscode-languageserver/node';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { DiagnosticSeverity, groupByFile } from './diagnostics';
import { AnalyzeWorkspace } from './workspace';

import type { Connection } from 'vscode-languageserver/node';
import type { DocumentResolver } from './diagnostics';

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
    let documents = new TextDocuments(TextDocument),
        pending = new Set<string>(),
        published = new Set<string>(),
        timer: ReturnType<typeof setTimeout> | undefined,
        workspace: AnalyzeWorkspace | undefined;

    // The native API reads files from disk, so unsaved buffers are not reflected;
    // analysis runs on open and on save against the last-saved project state.
    function runAnalysis(): void {
        timer = undefined;

        if (!workspace || !workspace.config) {
            return;
        }

        let changed = [...pending];

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

        let openByPath = new Map(documents.all().map((document) => [pathKey(fileURLToPath(document.uri)), document])),
            resolve: DocumentResolver = (fileName) => openByPath.get(pathKey(fileName)),
            severity = workspace.config.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
            uriOf = (fileName: string) => openByPath.get(pathKey(fileName))?.uri ?? pathToFileURL(fileName).toString(),
            grouped = groupByFile(result.diagnostics, severity, resolve, uriOf),
            next = new Set<string>();

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

        return { capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental } };
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
