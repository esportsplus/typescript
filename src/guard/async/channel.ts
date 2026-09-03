import * as ts from '~/guard/adapter';

import type {
    CalleeResolution,
    Channel,
    Diagnostic,
    DiagnosticFix,
    DiagnoseContext,
    FunctionInfo,
    FunctionLike,
    Summary,
    TransferContext,
} from '../kernel/types';
import { bodyOf, constituents, hasModifier, isAwaited, unwrap } from '../kernel/ast';
import { isFunctionLike, locationOf } from '../kernel/ids';
import { bottom, equals, promise, widen, type AsyncValue } from './value';

// The async aggregators whose input decides fan-out width, and whose result is a
// promise ownership moves into.
const AGGREGATORS = new Set(['all', 'allSettled', 'race', 'any']);
// Promise combinators that move ownership onto their result (the chain top).
const CHAIN_METHODS = new Set(['catch', 'finally', 'then']);
// Tuple element flags that make a tuple's length unbounded (Rest | Variadic).
const UNBOUNDED_TUPLE_FLAGS = 12;

// Per-diagnose working state shared by the ownership/fan-out walk.
type Env  = {
    readonly checker: ts.TypeChecker;
    readonly summaryOf: (fn: FunctionInfo) => Summary<AsyncValue>;
    readonly resolveCall: (
        call: ts.CallExpression | ts.NewExpression,
    ) => CalleeResolution;
    readonly heldSignalNames: (fn: FunctionInfo) => ReadonlySet<string>;
    // Names bound to an AbortSignal the current function holds (A3).
    readonly held: ReadonlySet<string>;
};
// Promise typing

function isPromiseType(
    checker: ts.TypeChecker,
    type: ts.Type | undefined,
): boolean {
    if (!type) {
        return false;
    }
    for (const c of constituents(type)) {
        const sym = c.getSymbol() ?? c.getAliasSymbol();
        if (sym && sym.name === 'Promise') {
            return true;
        }
        const apparent = checker.getApparentType(c) ?? c;
        if (checker.getPropertyOfType(apparent, 'then')) {
            return true;
        }
    }
    return false;
}

// Whether the nearest enclosing function is async — `await` is only a valid fix
// inside one.
function enclosingAsync(node: ts.Node): boolean {
    let p = node.parent;
    while (p) {
        if (isFunctionLike(p)) {
            return hasModifier(p, ts.SyntaxKind.AsyncKeyword);
        }
        p = p.parent;
    }
    return false;
}

// Whether invoking this function yields a promise the caller must own. An async
// function always does; otherwise its inferred signature return type decides.
function returnsPromise(checker: ts.TypeChecker, node: FunctionLike): boolean {
    if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) {
        return true;
    }
    const fnType = checker.getTypeAtLocation(node);
    if (!fnType) {
        return false;
    }
    const sig = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call)[0];
    if (!sig) {
        return false;
    }
    return isPromiseType(checker, checker.getReturnTypeOfSignature(sig));
}

// A call produces an owned-relevant promise. App targets answer from their
// converged summary (call-graph aware); overlay/lib/unresolved leaves fall back
// to the checker's type at the call site.
function producesPromise(
    env: Env,
    call: ts.CallExpression | ts.NewExpression,
): boolean {
    const res = env.resolveCall(call);
    if (res.targets.length > 0) {
        return res.targets.some((t) => env.summaryOf(t).value.returnsPromise);
    }
    return isPromiseType(env.checker, env.checker.getTypeAtLocation(call));
}
// Callee identity

// The aggregator member (all/allSettled/race/any) of a `Promise.<m>(…)` call.
function aggregatorOf(call: ts.CallExpression): string | undefined {
    const callee = call.expression;
    if (
        !ts.isPropertyAccessExpression(callee) ||
        !ts.isIdentifier(callee.expression)
    ) {
        return undefined;
    }
    if (
        callee.expression.text !== 'Promise' ||
        !AGGREGATORS.has(callee.name.text)
    ) {
        return undefined;
    }
    return callee.name.text;
}

// Descend a `.then/.catch/.finally` chain to the call that seeded it, so a
// dropped chain is named after its promise source rather than the combinator.
function chainRoot(
    call: ts.CallExpression | ts.NewExpression,
): ts.CallExpression | ts.NewExpression {
    let cur: ts.CallExpression | ts.NewExpression = call;
    while (
        ts.isPropertyAccessExpression(cur.expression) &&
        CHAIN_METHODS.has(cur.expression.name.text)
    ) {
        const receiver = cur.expression.expression;
        if (!ts.isCallExpression(receiver) && !ts.isNewExpression(receiver)) {
            break;
        }
        cur = receiver;
    }
    return cur;
}

function calleeText(node: ts.CallExpression | ts.NewExpression): string {
    const call = chainRoot(node);
    const callee = call.expression;
    if (ts.isIdentifier(callee)) {
        return callee.text;
    }
    if (ts.isPropertyAccessExpression(callee)) {
        return callee.name.text;
    }
    return callee.getText(callee.getSourceFile());
}
// Ownership classification

// A call is a promise-chain continuation when its result feeds a `.then/.catch/
// .finally` call — ownership is decided at the chain top, so the inner call is
// skipped to avoid double-reporting.
function isChainContinuation(
    call: ts.CallExpression | ts.NewExpression,
): boolean {
    const parent = call.parent;
    if (
        !parent ||
        !ts.isPropertyAccessExpression(parent) ||
        parent.expression !== call
    ) {
        return false;
    }
    return (
        CHAIN_METHODS.has(parent.name.text) &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
    );
}

// A promise chain that installs a rejection handler (`.catch(fn)` or a two-arg
// `.then(onFulfilled, onRejected)`) anywhere along its length: its rejections are
// observed, so a dropped chain top is not an unhandled-rejection orphan.
function chainHandlesRejection(
    call: ts.CallExpression | ts.NewExpression,
): boolean {
    let cur: ts.Expression = call;
    while (
        ts.isCallExpression(cur) &&
        ts.isPropertyAccessExpression(cur.expression)
    ) {
        const member = cur.expression.name.text;
        if (member === 'catch' && cur.arguments.length >= 1) {
            return true;
        }
        if (member === 'then' && cur.arguments.length >= 2) {
            return true;
        }
        cur = cur.expression.expression;
    }
    return false;
}

function isValueTransparent(node: ts.Node, child: ts.Node): boolean {
    if (ts.isParenthesizedExpression(node)) {
        return true;
    }
    if (ts.isConditionalExpression(node)) {
        return node.whenTrue === child || node.whenFalse === child;
    }
    if (ts.isBinaryExpression(node) && node.right === child) {
        const k = node.operatorToken.kind;
        return (
            k === ts.SyntaxKind.AmpersandAmpersandToken ||
            k === ts.SyntaxKind.BarBarToken ||
            k === ts.SyntaxKind.QuestionQuestionToken ||
            k === ts.SyntaxKind.CommaToken
        );
    }
    return false;
}

function isOrphan(node: ts.Node): boolean {
    let child = node;
    let parent = node.parent;
    while (parent && isValueTransparent(parent, child)) {
        child = parent;
        parent = parent.parent;
    }
    return parent !== undefined && ts.isExpressionStatement(parent);
}
// Fan-out

// A statically-sized input — an array literal without spreads, or a fixed-length
// tuple type. Everything else is a dynamically-sized (unbounded) input.
function isBoundedInput(env: Env, arg: ts.Expression): boolean {
    const e = unwrap(arg);
    if (ts.isArrayLiteralExpression(e)) {
        return !e.elements.some((el) => ts.isSpreadElement(el));
    }
    const type = env.checker.getTypeAtLocation(e);
    if (type && type.isTupleType()) {
        const flags =
            (type as { elementFlags?: ReadonlyArray<number> }).elementFlags ??
            [];
        return !flags.some((f) => (f & UNBOUNDED_TUPLE_FLAGS) !== 0);
    }
    return false;
}
// Cancellation (A3)

function isAbortSignalType(type: ts.Type | undefined): boolean {
    if (!type) {
        return false;
    }
    for (const c of constituents(type)) {
        const sym = c.getSymbol() ?? c.getAliasSymbol();
        if (sym && sym.name === 'AbortSignal') {
            return true;
        }
    }
    return false;
}

// The binding names a parameter carries that are typed `AbortSignal`, including
// destructured option properties (`{ signal }: { signal: AbortSignal }`).
// Name-based: a forwarded signal is passed by its binding name at the call site.
function collectSignalNames(
    checker: ts.TypeChecker,
    name: ts.BindingName,
    out: Set<string>,
): void {
    if (ts.isIdentifier(name)) {
        if (isAbortSignalType(checker.getTypeAtLocation(name))) {
            out.add(name.text);
        }
        return;
    }
    if (ts.isObjectBindingPattern(name)) {
        for (const el of name.elements) {
            if (el.name) {
                collectSignalNames(checker, el.name, out);
            }
        }
    }
}

function heldSignalNames(
    checker: ts.TypeChecker,
    node: FunctionLike,
): Set<string> {
    const out = new Set<string>();
    const params =
        (node as { parameters?: ReadonlyArray<ts.ParameterDeclaration> })
            .parameters ?? [];
    for (const p of params) {
        collectSignalNames(checker, p.name, out);
    }
    return out;
}

function overlayCancellable(env: Env, call: ts.CallExpression): boolean {
    const entry = env.resolveCall(call).overlay?.entry as
        | { cancellable?: unknown }
        | undefined;
    return entry?.cancellable === true;
}

// A call whose callee wants an AbortSignal: an overlay-marked cancellable leaf,
// or an app function that itself declares an AbortSignal parameter. The latter is
// wrapper inheritance — a wrapper that accepts a signal to forward propagates the
// requirement to its own callers.
function callRequiresSignal(env: Env, call: ts.CallExpression): boolean {
    if (overlayCancellable(env, call)) {
        return true;
    }
    return env
        .resolveCall(call)
        .targets.some((t) => env.heldSignalNames(t).size > 0);
}

// Whether any argument subtree passes a held signal by name (positional
// `fn(signal)`, shorthand `{ signal }`, or `{ signal: signal }`).
function forwardsSignal(
    call: ts.CallExpression,
    held: ReadonlySet<string>,
): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
        if (found) {
            return;
        }
        if (ts.isIdentifier(n) && held.has(n.text)) {
            found = true;
            return;
        }
        ts.forEachChild(n, visit);
    };
    for (const arg of call.arguments) {
        visit(arg);
    }
    return found;
}
// Diagnostics

// `void <expr>` is always valid; `await <expr>` only inside an async function.
function orphanFixes(
    call: ts.CallExpression | ts.NewExpression,
): ReadonlyArray<DiagnosticFix> {
    const sf = call.getSourceFile();
    const pos = call.getStart(sf);
    const fixes: DiagnosticFix[] = [
        {
            title: 'Ignore the result with `void`',
            edits: [{ fileName: sf.fileName, pos, end: pos, newText: 'void ' }],
        },
    ];
    if (enclosingAsync(call)) {
        fixes.push({
            title: 'Await the promise',
            edits: [
                { fileName: sf.fileName, pos, end: pos, newText: 'await ' },
            ],
        });
    }
    return fixes;
}

function orphanDiagnostic(
    call: ts.CallExpression | ts.NewExpression,
): Diagnostic {
    return {
        channel: 'async',
        message: `result of \`${calleeText(call)}()\` is neither awaited nor voided — rejections will be unhandled`,
        location: locationOf(call, call.getSourceFile()),
        related: [],
        fixes: orphanFixes(call),
    };
}

function fanOutDiagnostic(
    call: ts.CallExpression,
    aggregator: string,
): Diagnostic {
    return {
        channel: 'async',
        message: `unbounded fan-out: \`Promise.${aggregator}\` over a dynamically-sized input — cap concurrency with a pool or bound the input`,
        location: locationOf(call, call.getSourceFile()),
        related: [],
    };
}

// "Forward the signal" is only a safe generic edit for an overlay-cancellable
// call, whose signal rides an options object (`fetch(url, { signal })`). An app
// callee takes the signal positionally, so no generic edit is offered there.
function signalFix(
    env: Env,
    call: ts.CallExpression,
): ReadonlyArray<DiagnosticFix> | undefined {
    if (!overlayCancellable(env, call)) {
        return undefined;
    }

    const name: string | undefined = env.held.values().next().value;

    if (!name) {
        return undefined;
    }

    const sf = call.getSourceFile();
    const prop = name === 'signal' ? 'signal' : `signal: ${name}`;
    const last =
        call.arguments.length > 0
            ? call.arguments[call.arguments.length - 1]
            : undefined;

    if (last && ts.isObjectLiteralExpression(last)) {
        const at = last.getStart(sf) + 1;
        const newText = last.properties.length > 0 ? ` ${prop},` : ` ${prop} `;

        return [
            {
                title: 'Forward the AbortSignal',
                edits: [{ fileName: sf.fileName, pos: at, end: at, newText }],
            },
        ];
    }

    const close = call.getEnd() - 1;
    const newText = call.arguments.length > 0 ? `, { ${prop} }` : `{ ${prop} }`;

    return [
        {
            title: 'Forward the AbortSignal',
            edits: [{ fileName: sf.fileName, pos: close, end: close, newText }],
        },
    ];
}

function cancellationDiagnostic(
    call: ts.CallExpression,
    fixes: ReadonlyArray<DiagnosticFix> | undefined,
): Diagnostic {
    return {
        channel: 'async',
        message: `\`${calleeText(call)}()\` is awaited without the AbortSignal this function holds — the work cannot be cancelled`,
        location: locationOf(call, call.getSourceFile()),
        related: [],
        fixes,
    };
}

function checkFanOut(
    env: Env,
    call: ts.CallExpression,
    out: Diagnostic[],
): void {
    const aggregator = aggregatorOf(call);
    if (!aggregator) {
        return;
    }
    const arg = call.arguments[0];
    if (!arg || isBoundedInput(env, arg)) {
        return;
    }
    out.push(fanOutDiagnostic(call, aggregator));
}

function checkOwnership(
    env: Env,
    call: ts.CallExpression | ts.NewExpression,
    out: Diagnostic[],
): void {
    if (isChainContinuation(call) || !producesPromise(env, call)) {
        return;
    }
    if (isOrphan(call) && !chainHandlesRejection(call)) {
        out.push(orphanDiagnostic(call));
    }
}

// A cancellable callee awaited without forwarding a signal the function holds
// leaves uncancellable work; a function holding no signal is never flagged.
function checkCancellation(
    env: Env,
    call: ts.CallExpression,
    out: Diagnostic[],
): void {
    if (
        env.held.size === 0 ||
        !callRequiresSignal(env, call) ||
        !isAwaited(call)
    ) {
        return;
    }
    if (!forwardsSignal(call, env.held)) {
        out.push(cancellationDiagnostic(call, signalFix(env, call)));
    }
}

// Walk one function body, never descending into nested function bodies (their own
// graph nodes). Every call is a fan-out candidate; promise-producing chain tops
// are ownership candidates.
function walk(env: Env, body: ts.Node, out: Diagnostic[]): void {
    const visit = (n: ts.Node): void => {
        if (isFunctionLike(n)) {
            return;
        }
        if (ts.isCallExpression(n)) {
            checkFanOut(env, n, out);
            checkCancellation(env, n, out);
        }
        if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
            checkOwnership(env, n, out);
        }
        ts.forEachChild(n, visit);
    };
    ts.forEachChild(body, visit);
}

function createAsyncChannel(): Channel<AsyncValue> {
    const heldByFunction = new Map<FunctionInfo, ReadonlySet<string>>();
    const getHeldSignalNames = (
        checker: ts.TypeChecker,
        fn: FunctionInfo,
    ): ReadonlySet<string> => {
        let held = heldByFunction.get(fn);
        if (!held) {
            held = heldSignalNames(checker, fn.node);
            heldByFunction.set(fn, held);
        }
        return held;
    };
    return {
        name: 'async',
        bottom,
        equals,
        widen,
        transfer(ctx: TransferContext<AsyncValue>): Summary<AsyncValue> {
            const value = returnsPromise(ctx.checker, ctx.fn.node)
                ? promise()
                : bottom();
            return { value, fromCallbacks: new Set() };
        },
        diagnose(ctx: DiagnoseContext<AsyncValue>): ReadonlyArray<Diagnostic> {
            const body = bodyOf(ctx.fn.node);
            if (!body) {
                return [];
            }
            const env: Env = {
                checker: ctx.checker,
                summaryOf: ctx.summaryOf,
                resolveCall: ctx.resolveCall,
                heldSignalNames: (fn) => getHeldSignalNames(ctx.checker, fn),
                held: getHeldSignalNames(ctx.checker, ctx.fn),
            };
            const out: Diagnostic[] = [];
            walk(env, body, out);
            return out;
        },
    };
}


export { createAsyncChannel };
