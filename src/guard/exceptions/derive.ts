import { dirname } from 'node:path';

import * as NodeFS from 'node:fs';

import * as ts from '~/guard/adapter';
import { API } from 'typescript/unstable/sync';

import { bodyOf, hasModifier, isAwaited, unwrap } from '../kernel/ast';
import { isFunctionLike } from '../kernel/ids';
import { resolveBackingJs } from './resolve-js';
import { ORIGIN_CAP, originOf } from './value';

import type { ExceptionOrigin } from './value';
import type { FileSystem } from 'typescript/unstable/fs';

// Thrown constructors we map to a concrete error class. Anything else (a local
// subclass, `throw err`, `throw obj`) becomes `Error` — never TOP, which would
// defeat instanceof discharge in the exceptions channel.
const GLOBAL_ERROR_CLASSES = new Set([
    'AggregateError',
    'Error',
    'EvalError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TypeError',
    'URIError',
]);

// LSP hot-path bounds: skip a backing file that is too big or minified.
const MAX_AVG_LINE = 300;
const MAX_FILE_BYTES = 512 * 1024;
// Reachable-throw recursion bound (across same-file siblings and followed imports).
const MAX_DEPTH = 6;

// An import binding: the module it came from and the export it names.
type ImportTarget = {
    readonly exportName: string;
    readonly specifier: string;
};

// The syntactic index of one scanned file: its top-level functions/classes, its
// named exports (with re-export redirects), and its import/namespace bindings so
// a call to an imported name can be followed into the file that defines it.
type FileIndex = {
    readonly classes: Map<string, ts.Node>;
    readonly exportsByName: Map<string, ts.Node>;
    readonly fns: Map<string, ts.Node>;
    readonly imports: Map<string, ImportTarget>;
    readonly namespaces: Map<string, string>;
    readonly reexportAll: string | undefined;
    readonly reexports: Map<string, ImportTarget>;
};

// A parsed backing file (AST + its index) kept alive by its snapshot until the
// index is disposed.
type ParsedFile = {
    readonly fileIndex: FileIndex | null;
    readonly mtimeMs: number;
    readonly size: number;
    readonly sourceFile: ts.SourceFile | null;
};

// Per-(file, export, member) result before the awaited filter: escaping error
// classes plus whether the target is async (its throws are rejections that count
// only at an awaited call site). `null` = scanned, nothing derivable.
type Cached = {
    readonly async: boolean;
    readonly classes: Map<string, ExceptionOrigin[]>;
} | null;

type ThrowIndex = {
    api: API | null;
    readonly contents: Map<string, string>;
    nextProject: number;
    readonly parsed: Map<string, ParsedFile>;
    readonly resolved: Map<string, string | undefined>;
    readonly snapshots: ReturnType<API['updateSnapshot']>[];
    readonly summaries: Map<string, Cached>;
};

type DerivedSummary = {
    readonly classes: ReadonlyMap<string, ReadonlyArray<ExceptionOrigin>>;
};

type DeriveParams = {
    readonly awaited: boolean;
    readonly exportName: string;
    readonly importerFileName: string;
    readonly memberName: string | undefined;
    readonly specifier: string;
};

type LocatedTarget = {
    readonly fileIndex: FileIndex;
    readonly realpath: string;
    readonly sourceFile: ts.SourceFile;
    readonly target: ts.Node;
};

function createThrowIndex(): ThrowIndex {
    return {
        api: null,
        contents: new Map(),
        nextProject: 0,
        parsed: new Map(),
        resolved: new Map(),
        snapshots: [],
        summaries: new Map(),
    };
}

function disposeThrowIndex(index: ThrowIndex): void {
    for (let snapshot of index.snapshots) {
        try {
            if (!snapshot.isDisposed()) {
                snapshot.dispose();
            }
        } catch {
            // Native handles may already be closed; teardown is best-effort.
        }
    }

    try {
        index.api?.close();
    } catch {
        // Native handles may already be closed; teardown is best-effort.
    }

    index.api = null;
    index.contents.clear();
    index.parsed.clear();
    index.resolved.clear();
    index.snapshots.length = 0;
    index.summaries.clear();
}
// Parsing

function isMinified(text: string): boolean {
    let lines = 1;
    for (let i = 0, n = text.length; i < n; i++) {
        if (text[i] === '\n') {
            lines += 1;
        }
    }
    return text.length / lines > MAX_AVG_LINE;
}

function normalize(fileName: string): string {
    return fileName.replace(/\\/g, '/');
}

function overlayFileSystem(contents: Map<string, string>): FileSystem {
    return {
        fileExists: (fileName) => contents.has(normalize(fileName)) || undefined,
        getAccessibleEntries: (directoryName) => {
            let directory = normalize(directoryName),
                files: string[] = [];

            for (let fileName of contents.keys()) {
                let slash = fileName.lastIndexOf('/');

                if (fileName.slice(0, slash) === directory) {
                    files.push(fileName.slice(slash + 1));
                }
            }

            return files.length > 0 ? { directories: [], files } : undefined;
        },
        readFile: (fileName) => contents.get(normalize(fileName)),
    };
}

// Parse one JavaScript file into a real AST via a one-file virtual project (TS 7
// has no standalone parser). Every snapshot stays alive so the AST it backs
// remains valid until the index is disposed.
function parseText(index: ThrowIndex, text: string): ts.SourceFile | null {
    try {
        if (!index.api) {
            index.api = new API({ cwd: '/guard-scan', fs: overlayFileSystem(index.contents) });
        }

        let directory = `/guard-scan/${index.nextProject++}`,
            config = `${directory}/tsconfig.json`,
            file = `${directory}/scan.js`;

        index.contents.set(file, text);
        index.contents.set(config, JSON.stringify({
            compilerOptions: {
                allowJs: true,
                checkJs: false,
                module: 'commonjs',
                noEmit: true,
                target: 'esnext',
            },
            files: ['scan.js'],
        }));

        let snapshot = index.api.updateSnapshot({ openProjects: [config] });

        index.snapshots.push(snapshot);
        return (
            snapshot
                .getProject(config)
                ?.program.getSourceFile(file) ?? null
        );
    } catch {
        return null;
    }
}

// Parse + index a backing file, cached by realpath and invalidated on mtime/size.
// A changed file drops every summary (a followed file's edit can affect a summary
// keyed by a different entry file), so cross-file results never go stale.
function parseFile(index: ThrowIndex, realpath: string): ParsedFile | undefined {
    let stat: NodeFS.Stats;
    try {
        stat = NodeFS.statSync(realpath);
    } catch {
        return undefined;
    }
    const cached = index.parsed.get(realpath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached;
    }
    if (cached) {
        index.summaries.clear();
    }
    let text = '';
    try {
        text = stat.size <= MAX_FILE_BYTES ? NodeFS.readFileSync(realpath, 'utf8') : '';
    } catch {
        text = '';
    }
    const sourceFile = text.length > 0 && !isMinified(text) ? parseText(index, text) : null;
    const parsed: ParsedFile = {
        fileIndex: sourceFile ? indexFile(sourceFile) : null,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sourceFile,
    };
    index.parsed.set(realpath, parsed);
    return parsed;
}
// The concrete error class a `throw` produces: the named global constructor, or
// `Error` for everything else. Never TOP.
function classifyThrow(expr: ts.Expression | undefined): string {
    if (!expr) {
        return 'Error';
    }
    const value = unwrap(expr);
    if (
        ts.isNewExpression(value) &&
        ts.isIdentifier(value.expression) &&
        GLOBAL_ERROR_CLASSES.has(value.expression.text)
    ) {
        return value.expression.text;
    }
    return 'Error';
}

// File indexing (exports, imports, re-exports)

function initializerFn(node: ts.Node): ts.Node | undefined {
    const initializer = (node as { initializer?: ts.Node }).initializer;
    return initializer && isFunctionLike(initializer) ? initializer : undefined;
}

// The module string of a `require("…")` call expression, if that is what `expr` is.
function requireSpecifier(expr: ts.Expression | undefined): string | undefined {
    if (!expr || !ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== 'require') {
        return undefined;
    }
    const arg = expr.arguments[0];
    return arg && ts.isStringLiteral(arg) ? arg.text : undefined;
}

function targetOf(expr: ts.Expression, fns: Map<string, ts.Node>, classes: Map<string, ts.Node>): ts.Node | undefined {
    const value = unwrap(expr);
    if (isFunctionLike(value)) {
        return value;
    }
    if (ts.isIdentifier(value)) {
        return fns.get(value.text) ?? classes.get(value.text);
    }
    return undefined;
}

function collectDeclarations(
    sourceFile: ts.SourceFile,
    classes: Map<string, ts.Node>,
    fns: Map<string, ts.Node>,
    imports: Map<string, ImportTarget>,
    namespaces: Map<string, string>,
): void {
    for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) {
            fns.set(statement.name.text, statement);
        } else if (ts.isClassDeclaration(statement) && statement.name) {
            classes.set(statement.name.text, statement);
        } else if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                const fn = initializerFn(declaration);
                if (fn && ts.isIdentifier(declaration.name)) {
                    fns.set(declaration.name.text, fn);
                }
                const specifier = requireSpecifier(declaration.initializer);
                if (specifier && ts.isIdentifier(declaration.name)) {
                    namespaces.set(declaration.name.text, specifier);
                } else if (specifier && ts.isObjectBindingPattern(declaration.name)) {
                    for (const element of declaration.name.elements) {
                        if (ts.isBindingElement(element) && element.name && ts.isIdentifier(element.name)) {
                            const property = element.propertyName;
                            imports.set(element.name.text, {
                                exportName: property && ts.isIdentifier(property) ? property.text : element.name.text,
                                specifier,
                            });
                        }
                    }
                }
            }
        } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause) {
            const specifier = statement.moduleSpecifier.text;
            const clause = statement.importClause;
            if (clause.name) {
                imports.set(clause.name.text, { exportName: 'default', specifier });
            }
            if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
                namespaces.set(clause.namedBindings.name.text, specifier);
            } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const element of clause.namedBindings.elements) {
                    imports.set(element.name.text, { exportName: (element.propertyName ?? element.name).text, specifier });
                }
            }
        }
    }
}

function collectExports(
    sourceFile: ts.SourceFile,
    classes: Map<string, ts.Node>,
    fns: Map<string, ts.Node>,
    exportsByName: Map<string, ts.Node>,
    reexports: Map<string, ImportTarget>,
): string | undefined {
    let reexportAll: string | undefined;
    const add = (name: string, expr: ts.Expression): void => {
        const target = targetOf(expr, fns, classes);
        if (target) {
            exportsByName.set(name, target);
        }
    };
    for (const statement of sourceFile.statements) {
        const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
        const defaultExport = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
        if (ts.isFunctionDeclaration(statement) && exported) {
            exportsByName.set(defaultExport ? 'default' : statement.name?.text ?? 'default', statement);
        } else if (ts.isClassDeclaration(statement) && exported) {
            exportsByName.set(defaultExport ? 'default' : statement.name?.text ?? 'default', statement);
        } else if (ts.isVariableStatement(statement) && exported) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    add(declaration.name.text, (declaration.initializer ?? declaration.name) as ts.Expression);
                }
            }
        } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
            add('default', statement.expression);
        } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
            const specifier = statement.moduleSpecifier.text;
            if (!statement.exportClause) {
                reexportAll = specifier;
            } else if (ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) {
                    reexports.set(element.name.text, { exportName: (element.propertyName ?? element.name).text, specifier });
                }
            }
        } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            reexportAll = collectCjsExport(statement.expression, add) ?? reexportAll;
        }
    }
    return reexportAll;
}

// CJS `exports.x = …`, `module.exports.x = …`, and `module.exports = …` (object
// literal, `require(...)` re-export, or a single function/class). Returns a whole
// re-export specifier when `module.exports = require("…")`.
function collectCjsExport(assign: ts.BinaryExpression, add: (name: string, expr: ts.Expression) => void): string | undefined {
    const left = assign.left;
    if (!ts.isPropertyAccessExpression(left)) {
        return undefined;
    }
    if (ts.isIdentifier(left.expression) && left.expression.text === 'exports') {
        add(left.name.text, assign.right);
        return undefined;
    }
    if (ts.isPropertyAccessExpression(left.expression) && ts.isIdentifier(left.expression.expression) && left.expression.expression.text === 'module' && left.expression.name.text === 'exports') {
        add(left.name.text, assign.right);
        return undefined;
    }
    if (!ts.isIdentifier(left.expression) || left.expression.text !== 'module' || left.name.text !== 'exports') {
        return undefined;
    }
    const required = requireSpecifier(assign.right);
    if (required) {
        return required;
    }
    const value = unwrap(assign.right);
    if (!ts.isObjectLiteralExpression(value)) {
        add('default', assign.right);
        return undefined;
    }
    for (const property of value.properties) {
        if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
            add(property.name.text, property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)) {
            add(property.name.text, property.name as ts.Expression);
        }
    }
    return undefined;
}

function indexFile(sourceFile: ts.SourceFile): FileIndex {
    const classes = new Map<string, ts.Node>();
    const exportsByName = new Map<string, ts.Node>();
    const fns = new Map<string, ts.Node>();
    const imports = new Map<string, ImportTarget>();
    const namespaces = new Map<string, string>();
    const reexports = new Map<string, ImportTarget>();
    collectDeclarations(sourceFile, classes, fns, imports, namespaces);
    const reexportAll = collectExports(sourceFile, classes, fns, exportsByName, reexports);
    return { classes, exportsByName, fns, imports, namespaces, reexportAll, reexports };
}
// Target location

// Resolve an export to its defining function/class, following `export … from`,
// `export *`, and `module.exports = require(...)` re-export redirects across files.
function locateExport(
    index: ThrowIndex,
    realpath: string,
    exportName: string,
    seen: ReadonlySet<string> = new Set(),
): LocatedTarget | undefined {
    const key = `${realpath}\0${exportName}`;
    if (seen.has(key)) {
        return undefined;
    }
    const parsed = parseFile(index, realpath);
    if (!parsed?.sourceFile || !parsed.fileIndex) {
        return undefined;
    }
    const target = parsed.fileIndex.exportsByName.get(exportName);
    if (target) {
        return { fileIndex: parsed.fileIndex, realpath, sourceFile: parsed.sourceFile, target };
    }
    const redirect =
        parsed.fileIndex.reexports.get(exportName) ??
        (parsed.fileIndex.reexportAll ? { exportName, specifier: parsed.fileIndex.reexportAll } : undefined);
    if (!redirect) {
        return undefined;
    }
    const next = resolveBackingJs(realpath, redirect.specifier);
    return next ? locateExport(index, next, redirect.exportName, new Set(seen).add(key)) : undefined;
}

// A member call's method node: a `class { m() {} }` member or a
// `C.prototype.m = function () {}` assignment in the same file.
function findMethod(sourceFile: ts.SourceFile, classNode: ts.Node, memberName: string): ts.Node | undefined {
    const members = (classNode as { members?: ReadonlyArray<ts.Node> }).members ?? [];
    for (const member of members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === memberName) {
            return member;
        }
    }
    const name = (classNode as { name?: ts.Node }).name;
    if (!name || !ts.isIdentifier(name)) {
        return undefined;
    }
    for (const statement of sourceFile.statements) {
        if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) || statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
            continue;
        }
        const left = statement.expression.left;
        if (
            ts.isPropertyAccessExpression(left) &&
            ts.isPropertyAccessExpression(left.expression) &&
            ts.isIdentifier(left.expression.expression) &&
            left.expression.expression.text === name.text &&
            left.expression.name.text === 'prototype' &&
            left.name.text === memberName
        ) {
            const target = unwrap(statement.expression.right);
            if (isFunctionLike(target)) {
                return target;
            }
        }
    }
    return undefined;
}

// Resolve a call to an imported name (or namespace member) to the export it
// reaches in another file, relative to the current dep file.
function importedTarget(index: ThrowIndex, realpath: string, fileIndex: FileIndex, call: ts.CallExpression): LocatedTarget | undefined {
    if (ts.isIdentifier(call.expression)) {
        const binding = fileIndex.imports.get(call.expression.text);
        if (!binding) {
            return undefined;
        }
        const next = resolveBackingJs(realpath, binding.specifier);
        return next ? locateExport(index, next, binding.exportName) : undefined;
    }
    if (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)) {
        const specifier = fileIndex.namespaces.get(call.expression.expression.text);
        if (!specifier) {
            return undefined;
        }
        const next = resolveBackingJs(realpath, specifier);
        return next ? locateExport(index, next, call.expression.name.text) : undefined;
    }
    return undefined;
}
// Reachable-throw computation

function mergeClasses(into: Map<string, ExceptionOrigin[]>, from: Map<string, ExceptionOrigin[]>): void {
    for (const [name, origins] of from) {
        const existing = into.get(name);
        if (!existing) {
            into.set(name, origins.slice(0, ORIGIN_CAP));
            continue;
        }
        for (const origin of origins) {
            if (existing.length < ORIGIN_CAP && !existing.some((candidate) => candidate.pos === origin.pos && candidate.fileName === origin.fileName)) {
                existing.push(origin);
            }
        }
    }
}

// Throws reachable from `functionNode`'s own body: its `throw`s plus calls to
// same-file siblings and imported functions (resolved and followed across files),
// bounded by depth and a cycle set. A non-awaited call to an async target is an
// orphan rejection and contributes nothing here.
function computeEscaping(
    index: ThrowIndex,
    realpath: string,
    sourceFile: ts.SourceFile,
    fileIndex: FileIndex,
    functionNode: ts.Node,
    depth: number,
    chain: ReadonlySet<ts.Node>,
): Map<string, ExceptionOrigin[]> {
    const classes = new Map<string, ExceptionOrigin[]>();
    const body = bodyOf(functionNode);
    if (!body || depth <= 0 || chain.has(functionNode)) {
        return classes;
    }
    const nextChain = new Set(chain).add(functionNode);

    const visit = (node: ts.Node): void => {
        if (node !== functionNode && isFunctionLike(node)) {
            return;
        }
        if (ts.isThrowStatement(node)) {
            const name = classifyThrow(node.expression);
            const origins = classes.get(name) ?? [];
            if (origins.length < ORIGIN_CAP) {
                origins.push(originOf(node, sourceFile, realpath));
            }
            classes.set(name, origins);
        } else if (ts.isCallExpression(node)) {
            let target = ts.isIdentifier(node.expression) ? fileIndex.fns.get(node.expression.text) : undefined;
            let targetPath = realpath;
            let targetSource = sourceFile;
            let targetIndex = fileIndex;
            if (!target) {
                const imported = importedTarget(index, realpath, fileIndex, node);
                if (imported) {
                    target = imported.target;
                    targetPath = imported.realpath;
                    targetSource = imported.sourceFile;
                    targetIndex = imported.fileIndex;
                }
            }
            if (target && !(hasModifier(target, ts.SyntaxKind.AsyncKeyword) && !isAwaited(node))) {
                mergeClasses(classes, computeEscaping(index, targetPath, targetSource, targetIndex, target, depth - 1, nextChain));
            }
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
    return classes;
}
// Public entry

function computeSummary(index: ThrowIndex, realpath: string, exportName: string, memberName: string | undefined): Cached {
    const located = locateExport(index, realpath, exportName);
    if (!located) {
        return null;
    }
    let target = located.target;
    if (memberName) {
        const method = findMethod(located.sourceFile, target, memberName);
        if (!method) {
            return null;
        }
        target = method;
    }
    return {
        async: hasModifier(target, ts.SyntaxKind.AsyncKeyword),
        classes: computeEscaping(index, located.realpath, located.sourceFile, located.fileIndex, target, MAX_DEPTH, new Set()),
    };
}

// Derive the throw summary for a third-party call keyed by (specifier, export,
// member). Undefined when the backing `.js` is unresolvable/unscannable, the
// export/member is not locatable, or the (async, non-awaited) call is an orphan.
function deriveThrows(index: ThrowIndex, params: DeriveParams): DerivedSummary | undefined {
    let resolution = `${dirname(params.importerFileName)}\0${params.specifier}`,
        realpath = index.resolved.get(resolution);

    if (!index.resolved.has(resolution)) {
        realpath = resolveBackingJs(params.importerFileName, params.specifier);
        index.resolved.set(resolution, realpath);
    }

    if (!realpath) {
        return undefined;
    }
    // Parse up-front so a changed file invalidates stale summaries before the
    // summary cache is consulted.
    parseFile(index, realpath);
    const key = `${realpath}\0${params.exportName}\0${params.memberName ?? ''}`;
    let cached = index.summaries.get(key);
    if (!index.summaries.has(key)) {
        cached = computeSummary(index, realpath, params.exportName, params.memberName);
        index.summaries.set(key, cached);
    }
    if (!cached || (cached.async && !params.awaited) || cached.classes.size === 0) {
        return undefined;
    }
    return { classes: cached.classes };
}


export { createThrowIndex, deriveThrows, disposeThrowIndex, type DerivedSummary, type ThrowIndex };
