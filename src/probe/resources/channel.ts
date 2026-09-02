import * as ts from '~/probe/adapter';

import type {
    CalleeResolution,
    Channel,
    Diagnostic,
    DiagnosticFix,
    DiagnosticRelated,
    DiagnoseContext,
    Dispatch,
    FunctionInfo,
    Summary,
    TransferContext,
} from '../kernel/types';
import { overlayThrows } from '../exceptions/channel';
import { bodyOf, calleeSelectors, paramSymbols, unwrap } from '../kernel/ast';
import { isEmpty, type ExceptionsValue } from '../exceptions/value';
import { isFunctionLike, locationOf } from '../kernel/ids';
import {
    bottom,
    equals,
    fromParams,
    widen,
    type ResourcesValue,
} from './value';
// Types

// The raw per-symbol overlay entry for this channel (see overlay/base/resources.jsonc).
//   acquires:     resource label, e.g. "Interval" — presence marks an acquire site.
//   releasedBy:   how the obligation is discharged. A bare name ("clearInterval",
//                 "removeEventListener") is a free function/sibling call; "#close"
//                 is a method on the tracked value.
//   pairKey:      argument indices that must match between acquire and release for
//                 receiver-keyed resources (addEventListener/removeEventListener).
//   informational: modeled but not obligation-bearing (e.g. AbortController).
type ResourceEntry  = {
    acquires?: unknown;
    releasedBy?: unknown;
    pairKey?: unknown;
    ownsParams?: unknown;
    informational?: unknown;
};

// A classified acquire site.
type Acquire  = {
    readonly kind: 'handle' | 'pair';
    readonly releasedBy: string | undefined;
    readonly pairKey: ReadonlyArray<number> | undefined;
    readonly label: string;
};

// A configured ownership-taking call: passing a tracked resource to `params` of
// `callee` transfers the obligation to that callee.
type Ownership  = {
    readonly callee: string;
    readonly params: ReadonlyArray<number>;
};

// Per-analysis working state shared by every helper.
type Env  = {
    readonly checker: ts.TypeChecker;
    readonly dispatch: Dispatch;
    readonly fn: FunctionInfo;
    readonly ownership: ReadonlyArray<Ownership>;
    readonly summaryOf: (fn: FunctionInfo) => Summary<ResourcesValue>;
    readonly resolveCall: (
        call: ts.CallExpression | ts.NewExpression,
    ) => CalleeResolution;
    readonly resolveExceptions: (
        call: ts.CallExpression | ts.NewExpression,
    ) => CalleeResolution;
    readonly peerThrows: (fnId: string) => boolean;
    readonly logDegrade: (message: string) => void;
    readonly paramSymbols: Map<ts.Symbol, number>;
};

type Outcome = 'safe' | 'leak' | 'degrade';
// Constants

// Free functions that release a handle passed as their first argument.
const FREE_RELEASERS = new Set([
    'clearImmediate',
    'clearInterval',
    'clearTimeout',
]);

// Instance methods that discharge the resource they are called on.
const DISPOSE_METHODS = new Set([
    'close',
    'destroy',
    'disconnect',
    'dispose',
    'release',
    'unsubscribe',
]);

// Container/escape methods that make a tracked value opaque (v1 stops tracking).
const OPAQUE_METHODS = new Set([
    'add',
    'append',
    'enqueue',
    'push',
    'set',
    'unshift',
]);
// Internal functions

function refsSym(env: Env, expr: ts.Expression, sym: ts.Symbol): boolean {
    const e = unwrap(expr, { assertions: true, awaits: true });

    if (!ts.isIdentifier(e)) {
        return false;
    }

    return env.checker.getSymbolAtLocation(e) === sym;
}

// True when `node` (or a descendant, not crossing into a nested function) matches.
function containsMatch(node: ts.Node, pred: (n: ts.Node) => boolean): boolean {
    let found = false;

    const rec = (n: ts.Node): void => {
        if (found) {
            return;
        }

        if (n !== node && isFunctionLike(n)) {
            return;
        }

        if (pred(n)) {
            found = true;
            return;
        }

        ts.forEachChild(n, rec);
    };

    rec(node);

    return found;
}

function isExitStatement(n: ts.Node): boolean {
    return (
        ts.isReturnStatement(n) ||
        ts.isThrowStatement(n) ||
        ts.isBreakStatement(n) ||
        ts.isContinueStatement(n)
    );
}

function isCallLike(n: ts.Node): boolean {
    return ts.isCallExpression(n) || ts.isNewExpression(n);
}

// Whether a call can throw (propagate an exception) into the current function,
// per the `exceptions` channel consulted through the kernel peer API: an
// overlay-modeled thrower, an app callee whose exceptions summary is non-empty,
// or — under pessimist — an unresolved callee. A throwing call between an acquire
// and its release is a path on which the release is skipped, so the resource leaks.
function callCanThrow(
    env: Env,
    call: ts.CallExpression | ts.NewExpression,
): boolean {
    const res = env.resolveExceptions(call);

    if (res.overlay) {
        return overlayThrows(res.overlay.entry);
    }

    if (res.targets.length > 0) {
        return res.targets.some((t) => env.peerThrows(t.id));
    }

    return res.unresolved && env.dispatch === 'pessimist';
}

// Climb to the statement whose parent is the enclosing block.
function enclosingStatement(node: ts.Node): ts.Node {
    let n = node;

    while (n.parent && !ts.isBlock(n.parent) && !ts.isSourceFile(n.parent)) {
        n = n.parent;
    }

    return n;
}

function blockOf(stmt: ts.Node): ts.Block | undefined {
    return stmt.parent && ts.isBlock(stmt.parent) ? stmt.parent : undefined;
}

// A type that carries `Symbol.dispose`/`Symbol.asyncDispose` — the checker names
// those well-known-symbol members "__@dispose@N" / "__@asyncDispose@N".
function isDisposableType(env: Env, type: ts.Type | undefined): boolean {
    if (!type) {
        return false;
    }

    for (const prop of env.checker.getPropertiesOfType(type)) {
        if (
            prop.name.startsWith('__@dispose') ||
            prop.name.startsWith('__@asyncDispose')
        ) {
            return true;
        }
    }

    return false;
}

// Only a *sync* Disposable can convert to a plain `using` (AsyncDisposable needs
// `await using`), so the quick-fix checks for `Symbol.dispose` specifically.
function hasSyncDispose(env: Env, type: ts.Type | undefined): boolean {
    if (!type) {
        return false;
    }

    for (const prop of env.checker.getPropertiesOfType(type)) {
        if (prop.name.startsWith('__@dispose')) {
            return true;
        }
    }

    return false;
}

function parsePairKey(raw: unknown): ReadonlyArray<number> | undefined {
    if (!Array.isArray(raw)) {
        return undefined;
    }

    const out: number[] = [];

    for (const v of raw) {
        if (typeof v === 'number' && Number.isInteger(v)) {
            out.push(v);
        }
    }

    return out.length > 0 ? out : undefined;
}

function acquireAt(
    env: Env,
    call: ts.CallExpression | ts.NewExpression,
): Acquire | undefined {
    const res = env.resolveCall(call);

    if (res.overlay) {
        const entry = res.overlay.entry as ResourceEntry;

        if (entry.informational) {
            return undefined;
        }

        if (typeof entry.acquires === 'string') {
            const releasedBy =
                typeof entry.releasedBy === 'string'
                    ? entry.releasedBy
                    : undefined;
            const pairKey = parsePairKey(entry.pairKey);

            return {
                kind: pairKey ? 'pair' : 'handle',
                releasedBy,
                pairKey,
                label: entry.acquires,
            };
        }
    }

    // A value typed Disposable/AsyncDisposable is a resource regardless of overlay.
    if (isDisposableType(env, env.checker.getTypeAtLocation(call))) {
        return {
            kind: 'handle',
            releasedBy: undefined,
            pairKey: undefined,
            label: 'Disposable',
        };
    }

    return undefined;
}

// The binding an acquire flows into: a `using` declaration (self-discharging), a
// plain single variable (trackable), or nothing (unbound).
function handleBinding(
    env: Env,
    call: ts.CallExpression | ts.NewExpression,
): { using: true } | { using: false; sym: ts.Symbol } | undefined {
    let p: ts.Node = call;

    while (
        p.parent &&
        (ts.isParenthesizedExpression(p.parent) ||
            ts.isNonNullExpression(p.parent) ||
            ts.isAsExpression(p.parent) ||
            ts.isAwaitExpression(p.parent))
    ) {
        p = p.parent;
    }

    const decl = p.parent;

    if (
        !decl ||
        !ts.isVariableDeclaration(decl) ||
        !ts.isIdentifier(decl.name)
    ) {
        return undefined;
    }

    const list = decl.parent;

    // `NodeFlags.AwaitUsing` (6) is `Using` (4) | an extra bit, and `Const` (2)
    // shares that extra bit — so the `Using` bit alone distinguishes a `using` /
    // `await using` binding from a plain `const`/`let`.
    if (
        list &&
        ts.isVariableDeclarationList(list) &&
        (list.flags & ts.NodeFlags.Using) !== 0
    ) {
        return { using: true };
    }

    const sym = env.checker.getSymbolAtLocation(decl.name);

    return sym ? { using: false, sym } : undefined;
}

function isDischargeOf(
    env: Env,
    expr: ts.Expression,
    sym: ts.Symbol,
    acq: Acquire | undefined,
): boolean {
    if (!ts.isCallExpression(expr)) {
        return false;
    }

    const callee = expr.expression;

    if (ts.isIdentifier(callee)) {
        const freeName =
            acq?.releasedBy !== undefined && !acq.releasedBy.startsWith('#')
                ? acq.releasedBy
                : undefined;
        const isFree =
            FREE_RELEASERS.has(callee.text) || callee.text === freeName;

        if (!isFree) {
            return false;
        }

        const arg = expr.arguments?.[0];

        return arg ? refsSym(env, arg, sym) : false;
    }

    if (ts.isPropertyAccessExpression(callee)) {
        if (!refsSym(env, callee.expression, sym)) {
            return false;
        }

        const method = callee.name.text;

        if (DISPOSE_METHODS.has(method)) {
            return true;
        }

        return (
            acq?.releasedBy !== undefined &&
            acq.releasedBy.startsWith('#') &&
            acq.releasedBy.slice(1) === method
        );
    }

    if (ts.isElementAccessExpression(callee)) {
        if (!refsSym(env, callee.expression, sym)) {
            return false;
        }

        const argx = callee.argumentExpression;

        return (
            argx !== undefined &&
            ts.isPropertyAccessExpression(argx) &&
            (argx.name.text === 'dispose' || argx.name.text === 'asyncDispose')
        );
    }

    return false;
}

// A call whose argument at an ownership-taking index refers to `sym`.
function callOwnsArg(
    env: Env,
    call: ts.CallExpression | ts.NewExpression,
    sym: ts.Symbol,
): boolean {
    const args = call.arguments ? Array.from(call.arguments) : [];
    const indices: number[] = [];

    args.forEach((arg, i) => {
        if (refsSym(env, arg, sym)) {
            indices.push(i);
        }
    });

    if (indices.length === 0) {
        return false;
    }

    const selectors = calleeSelectors(call.expression);

    for (const own of env.ownership) {
        if (
            selectors.has(own.callee) &&
            own.params.some((p) => indices.includes(p))
        ) {
            return true;
        }
    }

    const res = env.resolveCall(call);
    const entry = (res.overlay?.entry ?? undefined) as
        | ResourceEntry
        | undefined;

    if (entry && Array.isArray(entry.ownsParams)) {
        for (const p of entry.ownsParams) {
            if (typeof p === 'number' && indices.includes(p)) {
                return true;
            }
        }
    }

    for (const target of res.targets) {
        const owned = env.summaryOf(target).value.ownsParams;

        for (const i of indices) {
            if (owned.has(i)) {
                return true;
            }
        }
    }

    return false;
}

// Ownership leaves the function: returned, stored on this/an object that outlives
// the call, or handed to an ownership-taking parameter.
function isTransferExpr(
    env: Env,
    expr: ts.Expression,
    sym: ts.Symbol,
): boolean {
    if (
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
        const target = expr.left;

        if (
            (ts.isPropertyAccessExpression(target) ||
                ts.isElementAccessExpression(target)) &&
            refsSym(env, expr.right, sym)
        ) {
            return true;
        }
    }

    if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
        return callOwnsArg(env, expr, sym);
    }

    return false;
}

function statementDischargesOrTransfers(
    env: Env,
    s: ts.Statement,
    sym: ts.Symbol,
    acq: Acquire | undefined,
): boolean {
    if (ts.isReturnStatement(s)) {
        if (!s.expression) {
            return false;
        }

        return (
            refsSym(env, s.expression, sym) ||
            isTransferExpr(env, s.expression, sym)
        );
    }

    if (ts.isExpressionStatement(s)) {
        return (
            isDischargeOf(env, s.expression, sym, acq) ||
            isTransferExpr(env, s.expression, sym)
        );
    }

    return false;
}

// A discharge in a `finally` guarding the acquire — runs on every path, including
// throwing ones. Approximated by lexical position (acquire before the finally).
function finallyDischarges(
    env: Env,
    sym: ts.Symbol,
    acq: Acquire | undefined,
    declStmt: ts.Node,
    body: ts.Node,
): boolean {
    let found = false;

    const rec = (n: ts.Node): void => {
        if (found) {
            return;
        }

        if (n !== body && isFunctionLike(n)) {
            return;
        }

        if (
            ts.isTryStatement(n) &&
            n.finallyBlock &&
            declStmt.getStart() < n.finallyBlock.getStart()
        ) {
            const discharged = containsMatch(
                n.finallyBlock,
                (m) =>
                    (ts.isCallExpression(m) || ts.isNewExpression(m)) &&
                    isDischargeOf(env, m as ts.Expression, sym, acq),
            );

            if (discharged) {
                found = true;
                return;
            }
        }

        ts.forEachChild(n, rec);
    };

    rec(body);

    return found;
}

// A discharge or transfer that dominates every exit: a same-block statement after
// the acquire, reached with no intervening early exit and no intervening call that
// can throw. A throwing call between acquire and release is a bypass path on which
// the release never runs (see `callCanThrow`), so the release is not guaranteed.
function firstGuaranteed(
    env: Env,
    sym: ts.Symbol,
    acq: Acquire | undefined,
    declStmt: ts.Node,
    block: ts.Block,
): boolean {
    const stmts = block.statements;
    const idx = stmts.findIndex((s) => s === declStmt);

    if (idx < 0) {
        return false;
    }

    for (let i = idx + 1; i < stmts.length; i += 1) {
        const s = stmts[i]!;

        if (statementDischargesOrTransfers(env, s, sym, acq)) {
            return true;
        }

        if (containsMatch(s, isExitStatement)) {
            return false;
        }

        if (
            containsMatch(
                s,
                (n) =>
                    isCallLike(n) &&
                    callCanThrow(
                        env,
                        n as ts.CallExpression | ts.NewExpression,
                    ),
            )
        ) {
            return false;
        }
    }

    return false;
}

// A tracked value flowing somewhere v1 cannot follow: pushed into a container or
// aliased to another binding.
function opaqueUseOf(
    env: Env,
    sym: ts.Symbol,
    body: ts.Node,
): ts.Node | undefined {
    let hit: ts.Node | undefined;

    const rec = (n: ts.Node): void => {
        if (hit) {
            return;
        }

        if (n !== body && isFunctionLike(n)) {
            return;
        }

        if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            OPAQUE_METHODS.has(n.expression.name.text)
        ) {
            for (const arg of n.arguments ?? []) {
                if (refsSym(env, arg, sym)) {
                    hit = n;
                    return;
                }
            }
        }

        if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(n.left) &&
            refsSym(env, n.right, sym)
        ) {
            hit = n;
            return;
        }

        if (
            ts.isVariableDeclaration(n) &&
            n.initializer &&
            refsSym(env, n.initializer, sym)
        ) {
            hit = n;
            return;
        }

        ts.forEachChild(n, rec);
    };

    rec(body);

    return hit;
}

function handleOutcome(
    env: Env,
    acq: Acquire,
    sym: ts.Symbol,
    declStmt: ts.Node,
    block: ts.Block,
    body: ts.Node,
): Outcome {
    if (finallyDischarges(env, sym, acq, declStmt, body)) {
        return 'safe';
    }

    if (firstGuaranteed(env, sym, acq, declStmt, block)) {
        return 'safe';
    }

    if (opaqueUseOf(env, sym, body)) {
        return 'degrade';
    }

    return 'leak';
}

function isReleaseCallForPair(
    node: ts.Node,
    acq: Acquire,
    acquireCall: ts.CallExpression | ts.NewExpression,
): boolean {
    if (!ts.isCallExpression(node) || acq.releasedBy === undefined) {
        return false;
    }

    const callee = node.expression;
    const acqCallee = acquireCall.expression;

    if (
        !ts.isPropertyAccessExpression(callee) ||
        !ts.isPropertyAccessExpression(acqCallee)
    ) {
        return false;
    }

    if (callee.name.text !== acq.releasedBy) {
        return false;
    }

    if (callee.expression.getText() !== acqCallee.expression.getText()) {
        return false;
    }

    for (const i of acq.pairKey ?? []) {
        const a = node.arguments?.[i];
        const b = acquireCall.arguments?.[i];

        if (!a || !b || a.getText() !== b.getText()) {
            return false;
        }
    }

    return true;
}

function hasMatchingRelease(
    env: Env,
    acquireCall: ts.CallExpression | ts.NewExpression,
    acq: Acquire,
): boolean {
    const body = bodyOf(env.fn.node);

    if (!body) {
        return false;
    }

    return containsMatch(body, (n) =>
        isReleaseCallForPair(n, acq, acquireCall),
    );
}

// True when a class member discharges `this.<field>` anywhere (its dispose method,
// a teardown method, the constructor's error path, ...).
function classDischargesField(
    cls: ts.Node,
    field: string,
    acq: Acquire | undefined,
): boolean {
    const members = (cls as { members?: ReadonlyArray<ts.Node> }).members ?? [];

    const refsThisField = (expr: ts.Expression): boolean => {
        const e = unwrap(expr, { assertions: true, awaits: true });

        return (
            ts.isPropertyAccessExpression(e) &&
            e.expression.kind === ts.SyntaxKind.ThisKeyword &&
            e.name.text === field
        );
    };

    const dischargesHere = (n: ts.Node): boolean => {
        if (!ts.isCallExpression(n)) {
            return false;
        }

        const callee = n.expression;

        if (ts.isIdentifier(callee)) {
            const freeName =
                acq?.releasedBy !== undefined && !acq.releasedBy.startsWith('#')
                    ? acq.releasedBy
                    : undefined;

            if (!FREE_RELEASERS.has(callee.text) && callee.text !== freeName) {
                return false;
            }

            const arg = n.arguments?.[0];

            return arg ? refsThisField(arg) : false;
        }

        if (
            ts.isPropertyAccessExpression(callee) &&
            refsThisField(callee.expression)
        ) {
            const method = callee.name.text;

            return (
                DISPOSE_METHODS.has(method) ||
                (acq?.releasedBy !== undefined &&
                    acq.releasedBy.startsWith('#') &&
                    acq.releasedBy.slice(1) === method)
            );
        }

        if (
            ts.isElementAccessExpression(callee) &&
            refsThisField(callee.expression)
        ) {
            const argx = callee.argumentExpression;

            return (
                argx !== undefined &&
                ts.isPropertyAccessExpression(argx) &&
                (argx.name.text === 'dispose' ||
                    argx.name.text === 'asyncDispose')
            );
        }

        return false;
    };

    for (const member of members) {
        const body = (member as { body?: ts.Node }).body;

        if (body && containsMatch(body, dischargesHere)) {
            return true;
        }
    }

    return false;
}

function className(cls: ts.Node): string {
    const name = (cls as { name?: ts.Identifier }).name;

    return name && ts.isIdentifier(name) ? name.text : '<anonymous>';
}

// Resources stored on `this` in the constructor body or class field initializers.
function classFieldAcquires(
    env: Env,
    cls: ts.Node,
    ctorBody: ts.Node | undefined,
): ReadonlyArray<{ field: string; node: ts.Node; acq: Acquire }> {
    const out: { field: string; node: ts.Node; acq: Acquire }[] = [];
    const members = (cls as { members?: ReadonlyArray<ts.Node> }).members ?? [];

    for (const member of members) {
        if (
            ts.isPropertyDeclaration(member) &&
            member.initializer &&
            ts.isIdentifier(member.name)
        ) {
            const init = unwrap(member.initializer, {
                assertions: true,
                awaits: true,
            });

            if (ts.isCallExpression(init) || ts.isNewExpression(init)) {
                const acq = acquireAt(env, init);

                if (acq && acq.kind === 'handle') {
                    out.push({ field: member.name.text, node: member, acq });
                }
            }
        }
    }

    if (ctorBody) {
        const rec = (n: ts.Node): void => {
            if (n !== ctorBody && isFunctionLike(n)) {
                return;
            }

            if (
                ts.isBinaryExpression(n) &&
                n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(n.left) &&
                n.left.expression.kind === ts.SyntaxKind.ThisKeyword
            ) {
                const rhs = unwrap(n.right, { assertions: true, awaits: true });

                if (ts.isCallExpression(rhs) || ts.isNewExpression(rhs)) {
                    const acq = acquireAt(env, rhs);

                    if (acq && acq.kind === 'handle') {
                        out.push({ field: n.left.name.text, node: n, acq });
                    }
                }
            }

            ts.forEachChild(n, rec);
        };

        rec(ctorBody);
    }

    return out;
}
// Diagnostics

function relatedPath(
    ctx: DiagnoseContext<ResourcesValue>,
): DiagnosticRelated[] {
    const related: DiagnosticRelated[] = [];

    for (const f of ctx.pathToBoundary(ctx.fn)) {
        related.push({
            message: `on the path to boundary via ${f.name}`,
            location: locationOf(f.node, f.sourceFile),
        });
    }

    return related;
}

// Replace a `const`/`let` keyword with `using` for a sync-Disposable acquire. The
// source-text check guards against a flag/source mismatch (no fix offered then).
function usingFix(
    env: Env,
    call: ts.CallExpression | ts.NewExpression,
): DiagnosticFix | undefined {
    if (!hasSyncDispose(env, env.checker.getTypeAtLocation(call))) {
        return undefined;
    }

    let p: ts.Node = call;

    while (
        p.parent &&
        (ts.isParenthesizedExpression(p.parent) ||
            ts.isNonNullExpression(p.parent) ||
            ts.isAsExpression(p.parent) ||
            ts.isAwaitExpression(p.parent))
    ) {
        p = p.parent;
    }

    const decl = p.parent;

    if (!decl || !ts.isVariableDeclaration(decl)) {
        return undefined;
    }

    const list = decl.parent;

    if (
        !list ||
        !ts.isVariableDeclarationList(list) ||
        (list.flags & ts.NodeFlags.Using) !== 0
    ) {
        return undefined;
    }

    const sf = call.getSourceFile();
    const start = list.getStart(sf);
    const keyword =
        (list.flags & ts.NodeFlags.Let) !== 0
            ? 'let'
            : (list.flags & ts.NodeFlags.Const) !== 0
              ? 'const'
              : undefined;

    if (!keyword || sf.text.slice(start, start + keyword.length) !== keyword) {
        return undefined;
    }

    return {
        title: 'Convert to `using`',
        edits: [
            {
                fileName: sf.fileName,
                pos: start,
                end: start + keyword.length,
                newText: 'using',
            },
        ],
    };
}

// The release call to synthesize for a leaked handle: a free releaser takes the
// binding as its argument, a `#method` releaser is called on it, and a bare sync
// Disposable is disposed. Unknown/async release yields no text (no fix).
function releaseText(
    env: Env,
    acq: Acquire,
    name: string,
    call: ts.CallExpression | ts.NewExpression,
): string | undefined {
    if (acq.releasedBy) {
        return acq.releasedBy.startsWith('#')
            ? `${name}.${acq.releasedBy.slice(1)}()`
            : `${acq.releasedBy}(${name})`;
    }

    if (hasSyncDispose(env, env.checker.getTypeAtLocation(call))) {
        return `${name}[Symbol.dispose]()`;
    }

    return undefined;
}

// Wrap the statements after the acquire (to the end of its block) in try/finally
// with the synthesized release. Text-generating, so it is offered only when the
// release is known and there is a region to guard; indentation follows the acquire.
function tryFinallyFix(
    env: Env,
    acq: Acquire,
    sym: ts.Symbol,
    declStmt: ts.Node,
    block: ts.Block,
    call: ts.CallExpression | ts.NewExpression,
): DiagnosticFix | undefined {
    const release = releaseText(env, acq, sym.name, call);

    if (!release) {
        return undefined;
    }

    const stmts = block.statements;
    const idx = stmts.findIndex((s) => s === declStmt);

    if (idx < 0 || idx + 1 >= stmts.length) {
        return undefined;
    }

    const sf = call.getSourceFile();
    const text = sf.text;
    const first = stmts[idx + 1]!;
    const last = stmts[stmts.length - 1]!;
    const declStart = declStmt.getStart(sf);

    let lineStart = first.getStart(sf);
    let declLineStart = declStart;

    while (lineStart > 0 && text[lineStart - 1] !== '\n') {
        lineStart -= 1;
    }

    while (declLineStart > 0 && text[declLineStart - 1] !== '\n') {
        declLineStart -= 1;
    }

    const base = text.slice(declLineStart, declStart);
    const unit = '    ';
    const regionEnd = last.getEnd();
    const region = text
        .slice(lineStart, regionEnd)
        .split('\n')
        .map((line) => (line.length > 0 ? unit + line : line))
        .join('\n');
    const replacement = `${base}try {\n${region}\n${base}}\n${base}finally {\n${base}${unit}${release};\n${base}}`;

    return {
        title: 'Wrap in try/finally',
        edits: [
            {
                fileName: sf.fileName,
                pos: lineStart,
                end: regionEnd,
                newText: replacement,
            },
        ],
    };
}

function leakDiagnostic(
    ctx: DiagnoseContext<ResourcesValue>,
    node: ts.Node,
    acq: Acquire,
    why: string,
    fixes?: ReadonlyArray<DiagnosticFix>,
): Diagnostic {
    return {
        channel: 'resources',
        message: `\`${acq.label}\` resource can leak — ${why}`,
        location: locationOf(node, node.getSourceFile()),
        related: relatedPath(ctx),
        fixes,
    };
}
// Options

function parseOwnership(channelConfig: unknown): ReadonlyArray<Ownership> {
    if (typeof channelConfig !== 'object' || channelConfig === null) {
        return [];
    }

    const raw = (channelConfig as Record<string, unknown>)['ownership'];

    if (raw === undefined) {
        return [];
    }

    if (!Array.isArray(raw)) {
        throw new Error('resources: "ownership" must be an array');
    }

    return raw.map((item, index) => {
        if (typeof item !== 'object' || item === null) {
            throw new Error(`resources: ownership[${index}] must be an object`);
        }

        const obj = item as Record<string, unknown>;

        if (typeof obj['callee'] !== 'string') {
            throw new Error(
                `resources: ownership[${index}].callee must be a string`,
            );
        }

        const params = obj['params'];

        if (
            !Array.isArray(params) ||
            params.some((v) => typeof v !== 'number' || !Number.isInteger(v))
        ) {
            throw new Error(
                `resources: ownership[${index}].params must be an array of integers`,
            );
        }

        return {
            callee: obj['callee'] as string,
            params: params as ReadonlyArray<number>,
        };
    });
}
// Environment

function makeEnv(
    checker: ts.TypeChecker,
    dispatch: Dispatch,
    fn: FunctionInfo,
    ownership: ReadonlyArray<Ownership>,
    summaryOf: (fn: FunctionInfo) => Summary<ResourcesValue>,
    resolveCall: (
        call: ts.CallExpression | ts.NewExpression,
    ) => CalleeResolution,
    resolveCallFor: (
        channel: string,
        call: ts.CallExpression | ts.NewExpression,
    ) => CalleeResolution,
    peerSummaryValue: (channel: string, fnId: string) => unknown,
    logDegrade: (message: string) => void,
): Env {
    const symbols = paramSymbols(checker, fn.node);

    const resolveExceptions = (
        call: ts.CallExpression | ts.NewExpression,
    ): CalleeResolution => resolveCallFor('exceptions', call);
    const peerThrows = (fnId: string): boolean => {
        const value = peerSummaryValue('exceptions', fnId);

        return value !== undefined && !isEmpty(value as ExceptionsValue);
    };

    return {
        checker,
        dispatch,
        fn,
        ownership,
        summaryOf,
        resolveCall,
        resolveExceptions,
        peerThrows,
        logDegrade,
        paramSymbols: symbols,
    };
}

// A parameter this function takes ownership of: it discharges or transfers that
// parameter somewhere in its body. Presence-based (v1): any discharging/transfer
// use marks ownership, which is the conservative direction for silencing callers.
function ownsParam(env: Env, sym: ts.Symbol, body: ts.Node): boolean {
    // Ownership means the callee discharges or stores/forwards the argument. A
    // bare `return param` is NOT ownership: it hands the resource back to the
    // caller, who is still accountable — so it is deliberately excluded here.
    return containsMatch(body, (n) => {
        if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
            if (
                ts.isCallExpression(n) &&
                isDischargeOf(env, n, sym, undefined)
            ) {
                return true;
            }

            return isTransferExpr(env, n as ts.Expression, sym);
        }

        if (ts.isBinaryExpression(n)) {
            return isTransferExpr(env, n, sym);
        }

        return false;
    });
}

function computeOwnership(env: Env): Set<number> {
    const body = bodyOf(env.fn.node);
    const owned = new Set<number>();

    if (!body) {
        return owned;
    }

    for (const [sym, index] of env.paramSymbols) {
        if (ownsParam(env, sym, body)) {
            owned.add(index);
        }
    }

    return owned;
}

// Walk one acquire site and emit a leak/untrackable diagnostic when warranted.
function diagnoseAcquire(
    env: Env,
    ctx: DiagnoseContext<ResourcesValue>,
    call: ts.CallExpression | ts.NewExpression,
    acq: Acquire,
    out: Diagnostic[],
): void {
    if (acq.kind === 'pair') {
        if (!hasMatchingRelease(env, call, acq)) {
            out.push(
                leakDiagnostic(
                    ctx,
                    call,
                    acq,
                    `no matching \`${acq.releasedBy ?? 'release'}\` on every path`,
                ),
            );
        }

        return;
    }

    const binding = handleBinding(env, call);

    if (binding && binding.using) {
        return;
    }

    if (binding && !binding.using) {
        const declStmt = enclosingStatement(call);
        const block = blockOf(declStmt);
        const body = bodyOf(env.fn.node);

        if (!block || !body) {
            return;
        }

        const outcome = handleOutcome(
            env,
            acq,
            binding.sym,
            declStmt,
            block,
            body,
        );

        if (outcome === 'leak') {
            const fixes: DiagnosticFix[] = [];
            const asUsing = usingFix(env, call);
            const wrapped = tryFinallyFix(
                env,
                acq,
                binding.sym,
                declStmt,
                block,
                call,
            );

            if (asUsing) {
                fixes.push(asUsing);
            }

            if (wrapped) {
                fixes.push(wrapped);
            }

            out.push(
                leakDiagnostic(
                    ctx,
                    call,
                    acq,
                    'no release, transfer, or `using` on every path',
                    fixes.length > 0 ? fixes : undefined,
                ),
            );
        } else if (outcome === 'degrade') {
            env.logDegrade(
                `${acq.label} at ${env.fn.fileName}:${call.getStart()} flows to an opaque sink`,
            );

            if (env.dispatch === 'pessimist') {
                out.push({
                    channel: 'resources',
                    message: `\`${acq.label}\` resource becomes untrackable — it flows to an opaque sink and release cannot be verified`,
                    location: locationOf(call, call.getSourceFile()),
                    related: relatedPath(ctx),
                });
            }
        }

        return;
    }
}

// A constructor also carries its class's field/`this`-stored obligations.
function diagnoseClassFields(
    env: Env,
    ctx: DiagnoseContext<ResourcesValue>,
    out: Diagnostic[],
): void {
    if (!ts.isConstructorDeclaration(env.fn.node)) {
        return;
    }

    const cls = env.fn.node.parent;

    if (!ts.isClassLike(cls)) {
        return;
    }

    const ctorBody = bodyOf(env.fn.node);

    for (const stored of classFieldAcquires(env, cls, ctorBody)) {
        if (classDischargesField(cls, stored.field, stored.acq)) {
            continue;
        }

        out.push({
            channel: 'resources',
            message: `\`${stored.acq.label}\` stored on \`this.${stored.field}\` can leak — class \`${className(cls)}\` has no release method that discharges it`,
            location: locationOf(stored.node, stored.node.getSourceFile()),
            related: relatedPath(ctx),
        });
    }
}
// Channel

// Leak-on-throwing-path consults the `exceptions` channel via the kernel peer API
// (this channel declares `dependsOn: ["exceptions"]`): a call between an acquire
// and a plain (non-`finally`, non-`using`) release breaks the "released on every
// path" guarantee only when that call can actually throw (see `callCanThrow`).
// When the exceptions channel is disabled its summaries are absent, so app calls
// degrade to non-throwing and only overlay-modeled throwers (e.g. JSON.parse) and,
// under pessimist, unresolved callees still count as bypass paths.
const createResourcesChannel = (
    channelConfig: unknown,
    // Silent by default: degradation is surfaced as a pessimist-mode diagnostic.
    // Callers that want to measure the v1 tracking noise floor inject a logger.
    onDegrade: (message: string) => void = () => {},
): Channel<ResourcesValue> => {
    const ownership = parseOwnership(channelConfig);
    return {
        name: 'resources',
        dependsOn: ['exceptions'],
        bottom,
        equals,
        widen,
        transfer(
            ctx: TransferContext<ResourcesValue>,
        ): Summary<ResourcesValue> {
            const env = makeEnv(
                ctx.checker,
                ctx.dispatch,
                ctx.fn,
                ownership,
                ctx.summaryOf,
                ctx.resolveCall,
                ctx.resolveCallFor,
                ctx.peerSummaryValue,
                onDegrade,
            );

            return {
                value: fromParams(computeOwnership(env)),
                fromCallbacks: new Set(),
            };
        },
        diagnose(
            ctx: DiagnoseContext<ResourcesValue>,
        ): ReadonlyArray<Diagnostic> {
            const env = makeEnv(
                ctx.checker,
                ctx.dispatch,
                ctx.fn,
                ownership,
                ctx.summaryOf,
                ctx.resolveCall,
                ctx.resolveCallFor,
                ctx.peerSummaryValue,
                onDegrade,
            );
            const out: Diagnostic[] = [];

            diagnoseClassFields(env, ctx, out);

            const body = bodyOf(ctx.fn.node);

            if (body) {
                const visit = (n: ts.Node): void => {
                    if (n !== body && isFunctionLike(n)) {
                        return;
                    }

                    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
                        const acq = acquireAt(env, n);

                        if (acq) {
                            diagnoseAcquire(env, ctx, n, acq, out);
                        }
                    }

                    ts.forEachChild(n, visit);
                };

                visit(body);
            }

            return out;
        },
    };
};


export { createResourcesChannel };
