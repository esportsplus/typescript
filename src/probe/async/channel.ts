import * as ts from "~/probe/adapter";

import type {
    CalleeResolution,
    Channel,
    Diagnostic,
    DiagnosticFix,
    DiagnoseContext,
    Dispatch,
    FunctionInfo,
    FunctionLike,
    Summary,
    TransferContext,
} from "../kernel/types";
import { isFunctionLike, locationOf } from "../kernel/ids";
import { bottom, equals, join, promise, widen, type AsyncValue } from "./value";

// The async aggregators whose input decides fan-out width, and whose result is a
// promise ownership moves into.
const AGGREGATORS = new Set(["all", "allSettled", "race", "any"]);
// Promise combinators that move ownership onto their result (the chain top).
const CHAIN_METHODS = new Set(["catch", "finally", "then"]);
// Collection mutators a promise flows into opaquely (no longer a tracked binding).
const OPAQUE_SINKS = new Set(["add", "push", "set", "unshift"]);
// Tuple element flags that make a tuple's length unbounded (Rest | Variadic).
const UNBOUNDED_TUPLE_FLAGS = 12;

// How a created promise is accounted for at the point it is produced.
type Ownership = "opaque" | "orphan" | "owned";

// Validated channel options. `fanOut` gates the bounded-fan-out check; promise
// ownership is always checked when the channel is enabled.
interface AsyncOptions {
    readonly fanOut: "error" | "off" | "warn";
    readonly fanOutAllowLiteralUpTo: number;
    readonly poolFunctions: ReadonlyArray<string>;
}

// Per-diagnose working state shared by the ownership/fan-out walk.
interface Env {
    readonly checker: ts.TypeChecker;
    readonly dispatch: Dispatch;
    readonly options: AsyncOptions;
    readonly summaryOf: (fn: FunctionInfo) => Summary<AsyncValue>;
    readonly resolveCall: (call: ts.CallExpression | ts.NewExpression) => CalleeResolution;
    // Names bound to an AbortSignal the current function holds (A3).
    readonly held: ReadonlySet<string>;
}

function fail(message: string): never {
    throw new Error(`async: ${message}`);
}

function parseOptions(raw: unknown): AsyncOptions {
    const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    let fanOut: AsyncOptions["fanOut"] = "warn";
    if (obj["fanOut"] !== undefined) {
        if (obj["fanOut"] !== "off" && obj["fanOut"] !== "warn" && obj["fanOut"] !== "error") {
            fail(`"fanOut" must be "off", "warn", or "error"`);
        }
        fanOut = obj["fanOut"];
    }
    let allow = 16;
    if (obj["fanOutAllowLiteralUpTo"] !== undefined) {
        const n = obj["fanOutAllowLiteralUpTo"];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
            fail(`"fanOutAllowLiteralUpTo" must be a non-negative integer`);
        }
        allow = n;
    }
    let poolFunctions: ReadonlyArray<string> = [];
    if (obj["poolFunctions"] !== undefined) {
        const p = obj["poolFunctions"];
        if (!Array.isArray(p) || p.some((v) => typeof v !== "string")) {
            fail(`"poolFunctions" must be an array of strings`);
        }
        poolFunctions = p as ReadonlyArray<string>;
    }
    return { fanOut, fanOutAllowLiteralUpTo: allow, poolFunctions };
}

// ---------------------------------------------------------------------------
// Promise typing
// ---------------------------------------------------------------------------

function constituents(type: ts.Type): ReadonlyArray<ts.Type> {
    return ts.unionTypes(type) ?? [type];
}

function isPromiseType(checker: ts.TypeChecker, type: ts.Type | undefined): boolean {
    if (!type) {
        return false;
    }
    for (const c of constituents(type)) {
        const sym = c.getSymbol() ?? c.getAliasSymbol();
        if (sym && sym.name === "Promise") {
            return true;
        }
        const apparent = checker.getApparentType(c) ?? c;
        if (checker.getPropertyOfType(apparent, "then")) {
            return true;
        }
    }
    return false;
}

function hasAsyncModifier(node: FunctionLike): boolean {
    const mods = (node as { modifiers?: ReadonlyArray<{ kind: ts.SyntaxKind }> }).modifiers;
    return mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

// Whether the nearest enclosing function is async — `await` is only a valid fix
// inside one.
function enclosingAsync(node: ts.Node): boolean {
    let p = node.parent;
    while (p) {
        if (isFunctionLike(p)) {
            return hasAsyncModifier(p as FunctionLike);
        }
        p = p.parent;
    }
    return false;
}

// Whether invoking this function yields a promise the caller must own. An async
// function always does; otherwise its inferred signature return type decides.
function returnsPromise(checker: ts.TypeChecker, node: FunctionLike): boolean {
    if (hasAsyncModifier(node)) {
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
function producesPromise(env: Env, call: ts.CallExpression | ts.NewExpression): boolean {
    const res = env.resolveCall(call);
    if (res.targets.length > 0) {
        return res.targets.some((t) => env.summaryOf(t).value.returnsPromise);
    }
    return isPromiseType(env.checker, env.checker.getTypeAtLocation(call));
}

// ---------------------------------------------------------------------------
// Callee identity
// ---------------------------------------------------------------------------

function calleeSelectors(callee: ts.Expression): Set<string> {
    const out = new Set<string>();
    if (ts.isIdentifier(callee)) {
        out.add(callee.text);
    } else if (ts.isPropertyAccessExpression(callee)) {
        const member = callee.name.text;
        out.add(member);
        const obj = callee.expression;
        if (ts.isIdentifier(obj)) {
            out.add(`${obj.text}.${member}`);
            out.add(`${obj.text}#${member}`);
        }
    }
    return out;
}

// The aggregator member (all/allSettled/race/any) of a `Promise.<m>(…)` call.
function aggregatorOf(call: ts.CallExpression): string | undefined {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) {
        return undefined;
    }
    if (callee.expression.text !== "Promise" || !AGGREGATORS.has(callee.name.text)) {
        return undefined;
    }
    return callee.name.text;
}

function isAggregatorCall(node: ts.Node): boolean {
    return ts.isCallExpression(node) && aggregatorOf(node) !== undefined;
}

// Descend a `.then/.catch/.finally` chain to the call that seeded it, so a
// dropped chain is named after its promise source rather than the combinator.
function chainRoot(call: ts.CallExpression | ts.NewExpression): ts.CallExpression | ts.NewExpression {
    let cur: ts.CallExpression | ts.NewExpression = call;
    while (ts.isPropertyAccessExpression(cur.expression) && CHAIN_METHODS.has(cur.expression.name.text)) {
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

// ---------------------------------------------------------------------------
// Ownership classification
// ---------------------------------------------------------------------------

// A call is a promise-chain continuation when its result feeds a `.then/.catch/
// .finally` call — ownership is decided at the chain top, so the inner call is
// skipped to avoid double-reporting.
function isChainContinuation(call: ts.CallExpression | ts.NewExpression): boolean {
    const parent = call.parent;
    if (!parent || !ts.isPropertyAccessExpression(parent) || parent.expression !== call) {
        return false;
    }
    return CHAIN_METHODS.has(parent.name.text) && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
}

// A promise chain that installs a rejection handler (`.catch(fn)` or a two-arg
// `.then(onFulfilled, onRejected)`) anywhere along its length: its rejections are
// observed, so a dropped chain top is not an unhandled-rejection orphan.
function chainHandlesRejection(call: ts.CallExpression | ts.NewExpression): boolean {
    let cur: ts.Expression = call;
    while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
        const member = cur.expression.name.text;
        if (member === "catch" && cur.arguments.length >= 1) {
            return true;
        }
        if (member === "then" && cur.arguments.length >= 2) {
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

// Where the promise value produced at `node` ends up. Climbs value-transparent
// parents (parens, ternary/logical results) first, then reads the accounting
// context: awaited/returned/voided/aggregated/tracked-binding are owned; a bare
// expression statement is an orphan; a collection mutator or any other landing
// is opaque (tracked only under the dispatch knob).
function classifyOwnership(node: ts.Node): Ownership {
    let child = node;
    let parent = node.parent;
    while (parent && isValueTransparent(parent, child)) {
        child = parent;
        parent = parent.parent;
    }
    if (!parent) {
        return "opaque";
    }
    if (ts.isAwaitExpression(parent) || ts.isVoidExpression(parent)) {
        return "owned";
    }
    if (ts.isReturnStatement(parent) || ts.isYieldExpression(parent)) {
        return "owned";
    }
    if (ts.isArrowFunction(parent) && parent.body === child) {
        return "owned";
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === child) {
        return "owned";
    }
    if (ts.isPropertyDeclaration(parent) && parent.initializer === child) {
        return "owned";
    }
    if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === child
    ) {
        return "owned";
    }
    if (ts.isExpressionStatement(parent)) {
        return "orphan";
    }
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
        if (isAggregatorCall(parent)) {
            return "owned";
        }
        const callee = parent.expression;
        if (ts.isPropertyAccessExpression(callee) && OPAQUE_SINKS.has(callee.name.text)) {
            return "opaque";
        }
        return "owned";
    }
    if (ts.isArrayLiteralExpression(parent)) {
        const gp = parent.parent;
        if (gp && isAggregatorCall(gp)) {
            return "owned";
        }
        return "opaque";
    }
    return "opaque";
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

function unwrap(expr: ts.Expression): ts.Expression {
    let e = expr;
    while (ts.isParenthesizedExpression(e)) {
        e = e.expression;
    }
    return e;
}

// A statically small, fixed-size input: an array literal without spreads, or a
// tuple type of bounded length. Everything else is treated as dynamic width.
function isBoundedInput(env: Env, arg: ts.Expression): boolean {
    const e = unwrap(arg);
    if (ts.isArrayLiteralExpression(e)) {
        if (e.elements.some((el) => ts.isSpreadElement(el))) {
            return false;
        }
        return e.elements.length <= env.options.fanOutAllowLiteralUpTo;
    }
    const type = env.checker.getTypeAtLocation(e);
    if (type && type.isTupleType?.()) {
        const flags = (type as { elementFlags?: ReadonlyArray<number> }).elementFlags ?? [];
        if (flags.some((f) => (f & UNBOUNDED_TUPLE_FLAGS) !== 0)) {
            return false;
        }
        const len = (type as { fixedLength?: number }).fixedLength;
        return typeof len === "number" && len <= env.options.fanOutAllowLiteralUpTo;
    }
    return false;
}

function moduleMatches(env: Env, call: ts.CallExpression, pkg: string): boolean {
    let sym = env.checker.getSymbolAtLocation(call.expression);
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
        sym = env.checker.getAliasedSymbol(sym);
    }
    if (!sym) {
        return false;
    }
    for (const decl of ts.symbolDeclarations(sym)) {
        const path = decl.getSourceFile().fileName.replace(/\\/g, "/");
        if (path.includes(`node_modules/${pkg}/`)) {
            return true;
        }
    }
    return false;
}

function poolMatches(env: Env, call: ts.CallExpression): boolean {
    const names = calleeSelectors(call.expression);
    for (const sel of env.options.poolFunctions) {
        const hash = sel.indexOf("#");
        if (hash >= 0) {
            const obj = sel.slice(0, hash);
            const method = sel.slice(hash + 1);
            if (names.has(method) || names.has(`${obj}.${method}`) || names.has(`${obj}#${method}`)) {
                return true;
            }
            continue;
        }
        if (names.has(sel) || moduleMatches(env, call, sel)) {
            return true;
        }
    }
    return false;
}

// A configured pool wrapper appearing anywhere in the aggregated input (including
// inside the `.map` callback) satisfies the fan-out requirement.
function routedThroughPool(env: Env, arg: ts.Expression): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
        if (found) {
            return;
        }
        if (ts.isCallExpression(n) && poolMatches(env, n)) {
            found = true;
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(arg);
    return found;
}

// ---------------------------------------------------------------------------
// Cancellation (A3)
// ---------------------------------------------------------------------------

function isAbortSignalType(type: ts.Type | undefined): boolean {
    if (!type) {
        return false;
    }
    for (const c of constituents(type)) {
        const sym = c.getSymbol() ?? c.getAliasSymbol();
        if (sym && sym.name === "AbortSignal") {
            return true;
        }
    }
    return false;
}

// The binding names a parameter carries that are typed `AbortSignal`, including
// destructured option properties (`{ signal }: { signal: AbortSignal }`).
// Name-based: a forwarded signal is passed by its binding name at the call site.
function collectSignalNames(checker: ts.TypeChecker, name: ts.BindingName, out: Set<string>): void {
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

function heldSignalNames(checker: ts.TypeChecker, node: FunctionLike): Set<string> {
    const out = new Set<string>();
    const params = (node as { parameters?: ReadonlyArray<ts.ParameterDeclaration> }).parameters ?? [];
    for (const p of params) {
        collectSignalNames(checker, p.name, out);
    }
    return out;
}

function overlayCancellable(env: Env, call: ts.CallExpression): boolean {
    const entry = env.resolveCall(call).overlay?.entry as { cancellable?: unknown } | undefined;
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
    return env.resolveCall(call).targets.some((t) => heldSignalNames(env.checker, t.node).size > 0);
}

// Whether `call`'s result is directly awaited (through parens/casts).
function isAwaited(call: ts.CallExpression): boolean {
    let child: ts.Node = call;
    let parent = call.parent;
    while (
        parent &&
        (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)) &&
        (parent as { expression?: ts.Node }).expression === child
    ) {
        child = parent;
        parent = parent.parent;
    }
    return parent !== undefined && ts.isAwaitExpression(parent);
}

// Whether any argument subtree passes a held signal by name (positional
// `fn(signal)`, shorthand `{ signal }`, or `{ signal: signal }`).
function forwardsSignal(call: ts.CallExpression, held: ReadonlySet<string>): boolean {
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

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

// `void <expr>` is always valid; `await <expr>` only inside an async function.
function orphanFixes(call: ts.CallExpression | ts.NewExpression): ReadonlyArray<DiagnosticFix> {
    const sf = call.getSourceFile();
    const pos = call.getStart(sf);
    const fixes: DiagnosticFix[] = [
        { title: "Ignore the result with `void`", edits: [{ fileName: sf.fileName, pos, end: pos, newText: "void " }] },
    ];
    if (enclosingAsync(call)) {
        fixes.push({ title: "Await the promise", edits: [{ fileName: sf.fileName, pos, end: pos, newText: "await " }] });
    }
    return fixes;
}

function orphanDiagnostic(call: ts.CallExpression | ts.NewExpression): Diagnostic {
    return {
        channel: "async",
        message: `result of \`${calleeText(call)}()\` is neither awaited nor voided — rejections will be unhandled`,
        location: locationOf(call, call.getSourceFile()),
        related: [],
        fixes: orphanFixes(call),
    };
}

function degradedDiagnostic(call: ts.CallExpression | ts.NewExpression): Diagnostic {
    return {
        channel: "async",
        message: `result of \`${calleeText(call)}()\` flows into an untracked structure — ownership cannot be verified`,
        location: locationOf(call, call.getSourceFile()),
        related: [],
    };
}

function fanOutDiagnostic(call: ts.CallExpression, aggregator: string): Diagnostic {
    return {
        channel: "async",
        message: `unbounded fan-out: \`Promise.${aggregator}\` over a dynamically-sized input — cap concurrency with a pool or bound the input`,
        location: locationOf(call, call.getSourceFile()),
        related: [],
    };
}

// "Forward the signal" is only a safe generic edit for an overlay-cancellable
// call, whose signal rides an options object (`fetch(url, { signal })`). An app
// callee takes the signal positionally, so no generic edit is offered there.
function signalFix(env: Env, call: ts.CallExpression): ReadonlyArray<DiagnosticFix> | undefined {
    if (!overlayCancellable(env, call)) {
        return undefined;
    }

    const name: string | undefined = env.held.values().next().value;

    if (!name) {
        return undefined;
    }

    const sf = call.getSourceFile();
    const prop = name === "signal" ? "signal" : `signal: ${name}`;
    const last = call.arguments.length > 0 ? call.arguments[call.arguments.length - 1] : undefined;

    if (last && ts.isObjectLiteralExpression(last)) {
        const at = last.getStart(sf) + 1;
        const newText = last.properties.length > 0 ? ` ${prop},` : ` ${prop} `;

        return [{ title: "Forward the AbortSignal", edits: [{ fileName: sf.fileName, pos: at, end: at, newText }] }];
    }

    const close = call.getEnd() - 1;
    const newText = call.arguments.length > 0 ? `, { ${prop} }` : `{ ${prop} }`;

    return [{ title: "Forward the AbortSignal", edits: [{ fileName: sf.fileName, pos: close, end: close, newText }] }];
}

function cancellationDiagnostic(call: ts.CallExpression, fixes: ReadonlyArray<DiagnosticFix> | undefined): Diagnostic {
    return {
        channel: "async",
        message: `\`${calleeText(call)}()\` is awaited without the AbortSignal this function holds — the work cannot be cancelled`,
        location: locationOf(call, call.getSourceFile()),
        related: [],
        fixes,
    };
}

function checkFanOut(env: Env, call: ts.CallExpression, out: Diagnostic[]): void {
    if (env.options.fanOut === "off") {
        return;
    }
    const aggregator = aggregatorOf(call);
    if (!aggregator) {
        return;
    }
    const arg = call.arguments[0];
    if (!arg || isBoundedInput(env, arg) || routedThroughPool(env, arg)) {
        return;
    }
    out.push(fanOutDiagnostic(call, aggregator));
}

function checkOwnership(env: Env, call: ts.CallExpression | ts.NewExpression, out: Diagnostic[]): void {
    if (isChainContinuation(call) || !producesPromise(env, call)) {
        return;
    }
    const ownership = classifyOwnership(call);
    if (ownership === "orphan") {
        if (!chainHandlesRejection(call)) {
            out.push(orphanDiagnostic(call));
        }
    } else if (ownership === "opaque" && env.dispatch === "pessimist") {
        out.push(degradedDiagnostic(call));
    }
}

// A cancellable callee awaited without forwarding a signal the function holds
// leaves uncancellable work; a function holding no signal is never flagged.
function checkCancellation(env: Env, call: ts.CallExpression, out: Diagnostic[]): void {
    if (env.held.size === 0 || !callRequiresSignal(env, call) || !isAwaited(call)) {
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

function bodyOf(node: FunctionLike): ts.Node | undefined {
    return (node as { body?: ts.Node }).body;
}

export function createAsyncChannel(): Channel<AsyncValue> {
    return {
        name: "async",
        version: "1",
        bottom,
        join,
        equals,
        widen,
        transfer(ctx: TransferContext<AsyncValue>): Summary<AsyncValue> {
            const value = returnsPromise(ctx.checker, ctx.fn.node) ? promise() : bottom();
            return { value, fromCallbacks: new Set() };
        },
        diagnose(ctx: DiagnoseContext<AsyncValue>): ReadonlyArray<Diagnostic> {
            const body = bodyOf(ctx.fn.node);
            if (!body) {
                return [];
            }
            const env: Env = {
                checker: ctx.checker,
                dispatch: ctx.dispatch,
                options: parseOptions(ctx.channelConfig),
                summaryOf: ctx.summaryOf,
                resolveCall: ctx.resolveCall,
                held: heldSignalNames(ctx.checker, ctx.fn.node),
            };
            const out: Diagnostic[] = [];
            walk(env, body, out);
            return out;
        },
    };
}
