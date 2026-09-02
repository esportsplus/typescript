import * as NodeFS from "node:fs";

import * as ts from "~/probe/adapter";

import type {
  CalleeResolution,
  Channel,
  Diagnostic,
  DiagnosticRelated,
  DiagnoseContext,
  Dispatch,
  FunctionInfo,
  SinkConfig,
  Summary,
  TransferContext,
} from "../kernel/types";
import { bodyOf, calleeSelectors, paramSymbols } from "../kernel/ast";
import { isFunctionLike, locationOf } from "../kernel/ids";
import { declaredExceptions } from "./jsdoc";
import {
  bottom,
  constituentsOf,
  equals,
  isEmpty,
  join,
  originsOf,
  refOfType,
  render,
  single,
  subtract,
  top,
  TOP_KEY,
  widen,
  withOrigin,
  type ExceptionOrigin,
  type ExceptionsValue,
} from "./value";

interface ExceptionsOverlayEntry {
  exceptions?: unknown;
  exceptionsFromCallbacks?: unknown;
}

// Whether a call to a symbol modeled by this channel's overlay can throw: it
// either declares thrown types or inherits throws from a callback argument.
// Exposed for peer channels (resources) that consult exception behavior.
export function overlayThrows(entry: unknown): boolean {
  const e = (entry ?? {}) as ExceptionsOverlayEntry;
  return (
    (Array.isArray(e.exceptions) && e.exceptions.length > 0) ||
    (Array.isArray(e.exceptionsFromCallbacks) && e.exceptionsFromCallbacks.length > 0)
  );
}

// Per-analysis working state shared by every helper. `typeTable` retains the
// concrete `ts.Type` behind each key so subtype-based catch discharge can run.
interface Env {
  readonly checker: ts.TypeChecker;
  readonly dispatch: Dispatch;
  readonly sinks: ReadonlyArray<SinkConfig>;
  readonly fn: FunctionInfo;
  readonly summaryOf: (fn: FunctionInfo) => Summary<ExceptionsValue>;
  readonly resolveCall: (call: ts.CallExpression | ts.NewExpression) => CalleeResolution;
  readonly typeTable: Map<string, ts.Type>;
  readonly paramSymbols: Map<ts.Symbol, number>;
  readonly fromCallbacks: Set<number>;
  // Present only in "cross-module" diagnose: the throw origins that reach a
  // call-graph root uncaught (so a call whose origins are all absent is handled
  // by some ancestor and stays silent), plus whether any root exists at all.
  readonly unhandled?: { readonly origins: ReadonlySet<string>; readonly active: boolean };
}

export function createExceptionsChannel(): Channel<ExceptionsValue> {
  // Origins that escape to a call-graph root uncaught — computed once per run,
  // only when "cross-module" mode needs it.
  let unhandledCache: { origins: ReadonlySet<string>; active: boolean } | undefined;
  const computeUnhandled = (
    ctx: DiagnoseContext<ExceptionsValue>,
  ): { origins: ReadonlySet<string>; active: boolean } => {
    if (unhandledCache) return unhandledCache;
    const roots = ctx.roots();
    const origins = new Set<string>();
    for (const r of roots) {
      for (const o of originsOf(ctx.summaryOf(r).value)) origins.add(`${o.fileName}:${o.pos}`);
    }
    unhandledCache = { origins, active: roots.length > 0 };
    return unhandledCache;
  };
  return {
    name: "exceptions",
    bottom,
    equals,
    widen,
    transfer(ctx: TransferContext<ExceptionsValue>): Summary<ExceptionsValue> {
      const env = makeEnv(ctx.checker, ctx.dispatch, ctx.sinks, ctx.fn, ctx.summaryOf, ctx.resolveCall);
      const body = bodyOf(ctx.fn.node);
      let value = body ? escapeOf(env, body, undefined) : bottom();
      // A `@throws` declaration is taken as the checked summary; inference beyond
      // it is reported in diagnose, not folded back into the summary.
      const decl = declaredExceptions(ctx.fn.node, ctx.checker);
      if (decl.declared) value = decl.value;
      return { value, fromCallbacks: env.fromCallbacks };
    },
    diagnose(ctx: DiagnoseContext<ExceptionsValue>): ReadonlyArray<Diagnostic> {
      const out: Diagnostic[] = [];
      const base = makeEnv(ctx.checker, ctx.dispatch, ctx.sinks, ctx.fn, ctx.summaryOf, ctx.resolveCall);
      const env: Env =
        reportMode(ctx) === "cross-module" ? { ...base, unhandled: computeUnhandled(ctx) } : base;
      const body = bodyOf(ctx.fn.node);

      // @throws under-declaration: emit on any reached function whose inferred
      // escapes exceed its declaration.
      const decl = declaredExceptions(ctx.fn.node, ctx.checker);
      if (decl.declared && body) {
        const inferred = escapeOf(env, body, undefined);
        const excess = subtract(inferred, new Set(decl.value.types.keys()));
        if (!isEmpty(excess)) {
          const nn = (ctx.fn.node as { name?: ts.Node }).name;
          out.push({
            channel: "exceptions",
            message: `Throws ${render(excess)} but declares only ${render(decl.value)}`,
            location: locationOf(nn ?? ctx.fn.node, ctx.fn.sourceFile),
            related: [],
          });
        }
      }

      // Rethrowing a new error inside a catch without `{ cause }` drops the
      // original — a local smell, checked on every function when opted in.
      if (errorCauseEnabled(ctx) && body) checkErrorCause(body, out);

      // Escapes only become findings where they reach a boundary uncaught.
      if (ctx.isBoundary && body) walkDiagnostics(env, ctx, body, undefined, undefined, out);
      return out;
    },
  };
}

function makeEnv(
  checker: ts.TypeChecker,
  dispatch: Dispatch,
  sinks: ReadonlyArray<SinkConfig>,
  fn: FunctionInfo,
  summaryOf: (fn: FunctionInfo) => Summary<ExceptionsValue>,
  resolveCall: (call: ts.CallExpression | ts.NewExpression) => CalleeResolution,
): Env {
  const symbols = paramSymbols(checker, fn.node);
  return {
    checker,
    dispatch,
    sinks,
    fn,
    summaryOf,
    resolveCall,
    typeTable: new Map(),
    paramSymbols: symbols,
    fromCallbacks: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Aggregate escape computation (summary + try scoping)
// ---------------------------------------------------------------------------

// Walk `node`, NOT descending into nested function bodies (their own graph
// nodes). `binding`, when set, is the enclosing catch variable — a bare rethrow
// of it contributes nothing (its effect is carried by the try remainder).
function escapeOf(env: Env, node: ts.Node, binding: ts.Symbol | undefined): ExceptionsValue {
  let acc = bottom();
  const visit = (n: ts.Node): void => {
    if (isFunctionLike(n)) return;
    if (ts.isTryStatement(n)) {
      acc = join(acc, tryEscape(env, n, binding));
      return;
    }
    if (ts.isThrowStatement(n)) {
      if (n.expression && !isBindingRef(env, n.expression, binding)) {
        const thrown = valueOfType(env, env.checker.getTypeAtLocation(n.expression));
        acc = join(acc, withOrigin(thrown, originOf(n)));
      }
      if (n.expression) ts.forEachChild(n.expression, visit);
      return;
    }
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      acc = join(acc, callEscape(env, n));
      ts.forEachChild(n, visit);
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return acc;
}

function tryEscape(env: Env, node: ts.TryStatement, binding: ts.Symbol | undefined): ExceptionsValue {
  const tryEsc = escapeOf(env, node.tryBlock, binding);
  let result: ExceptionsValue;
  if (node.catchClause) {
    const bindSym = bindingSymOf(env, node.catchClause) ?? binding;
    const discharge = dischargedKeys(env, node.catchClause, tryEsc, bindSym);
    // Catch-block throws (incl. wrap-and-throw) contribute; the discharged set is
    // subtracted from the try body.
    const catchEsc = escapeOf(env, node.catchClause.block, bindSym);
    result = join(subtract(tryEsc, discharge), catchEsc);
  } else {
    result = tryEsc;
  }
  // A finally is never a sink: its escapes are added unconditionally, replacing
  // any in-flight completion.
  if (node.finallyBlock) result = join(result, escapeOf(env, node.finallyBlock, binding));
  return result;
}

// The keys a catch discharges = try set minus what it rethrows. Bare rethrows of
// the binding under `instanceof` narrowing rethrow only the consistent types;
// unconditional/unresolvable rethrows rethrow everything (discharge nothing).
function dischargedKeys(
  env: Env,
  cc: ts.CatchClause,
  tryEsc: ExceptionsValue,
  bindSym: ts.Symbol | undefined,
): Set<string> {
  if (tryEsc.top) return new Set();
  const allKeys = new Set(tryEsc.types.keys());

  const rethrows: ts.ThrowStatement[] = [];
  const find = (n: ts.Node): void => {
    if (isFunctionLike(n)) return;
    if (ts.isThrowStatement(n) && n.expression && isBindingRef(env, n.expression, bindSym)) {
      rethrows.push(n);
    }
    ts.forEachChild(n, find);
  };
  ts.forEachChild(cc.block, find);

  if (rethrows.length === 0) return allKeys; // catch handles everything reachable

  const rethrown = new Set<string>();
  for (const rt of rethrows) {
    const g = guardsFor(env, rt, cc.block, bindSym);
    if (g.unresolved || (g.positives.length === 0 && g.negatives.length === 0)) {
      return new Set(); // unconditional / unresolvable rethrow -> discharge nothing
    }
    for (const key of allKeys) {
      const c = env.typeTable.get(key) ?? resolveKeyType(env, key);
      if (!c) {
        rethrown.add(key); // cannot test subtype -> conservatively assume rethrown
        continue;
      }
      // `instanceof` is nominal (prototype chain), so discharge uses subclass
      // identity, not structural assignability (sibling empty error classes are
      // structurally equal but never discharge each other).
      const okPos = g.positives.every((p) => isSubclassOf(c, p));
      const okNeg = g.negatives.every((neg) => !isSubclassOf(c, neg));
      if (okPos && okNeg) rethrown.add(key);
    }
  }
  const discharge = new Set<string>();
  for (const key of allKeys) if (!rethrown.has(key)) discharge.add(key);
  return discharge;
}

// Collect the instanceof constraints on the binding at a rethrow site by walking
// enclosing `if` branches. `positives` = binding must BE the type, `negatives` =
// must NOT be. `unresolved` when a guard is not a plain instanceof of the binding.
function guardsFor(
  env: Env,
  rethrow: ts.ThrowStatement,
  catchBlock: ts.Block,
  bindSym: ts.Symbol | undefined,
): { positives: ts.Type[]; negatives: ts.Type[]; unresolved: boolean } {
  const positives: ts.Type[] = [];
  const negatives: ts.Type[] = [];
  let unresolved = false;
  let child: ts.Node = rethrow;
  let parent = rethrow.parent;
  const stop = catchBlock.parent;
  while (parent && parent !== stop) {
    if (ts.isIfStatement(parent) && (child === parent.thenStatement || child === parent.elseStatement)) {
      const info = parseInstanceof(env, parent.expression, bindSym);
      if (!info) {
        unresolved = true;
      } else {
        const condTrue = child === parent.thenStatement;
        // condTrue===info.positive means the binding IS the type on this branch.
        if (condTrue === info.positive) positives.push(info.type);
        else negatives.push(info.type);
      }
    }
    // A preceding guarded early-exit peels its type off what reaches this site:
    // `if (e instanceof Foo) return;` before a fall-through `throw e` means Foo
    // is no longer rethrown here (same discharge as an `else` branch).
    if (ts.isBlock(parent)) {
      for (const stmt of parent.statements) {
        if (stmt === child) break;
        const g = guardExit(env, stmt, bindSym);
        if (g) (g.positive ? positives : negatives).push(g.type);
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return { positives, negatives, unresolved };
}

// Parse `e instanceof T` / `!(e instanceof T)` where `e` is the binding into the
// instance type and whether a true condition means "e IS T".
function parseInstanceof(
  env: Env,
  expr: ts.Expression,
  bindSym: ts.Symbol | undefined,
): { type: ts.Type; positive: boolean } | undefined {
  if (ts.isParenthesizedExpression(expr)) return parseInstanceof(env, expr.expression, bindSym);
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = parseInstanceof(env, expr.operand, bindSym);
    return inner ? { type: inner.type, positive: !inner.positive } : undefined;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
    if (!isBindingRef(env, expr.left, bindSym)) return undefined;
    const rhsType = env.checker.getTypeAtLocation(expr.right);
    if (!rhsType) return undefined;
    const ctorSig = env.checker.getSignaturesOfType(rhsType, ts.SignatureKind.Construct)[0];
    const type = ctorSig ? (env.checker.getReturnTypeOfSignature(ctorSig) ?? rhsType) : rhsType;
    return { type, positive: true };
  }
  return undefined;
}

// A preceding `if (e instanceof T) { <exits> }` (no else) narrows the binding
// below it. `positive` = the binding IS the type on the fall-through path.
function guardExit(
  env: Env,
  stmt: ts.Statement,
  bindSym: ts.Symbol | undefined,
): { type: ts.Type; positive: boolean } | undefined {
  if (!ts.isIfStatement(stmt) || stmt.elseStatement) return undefined;
  if (!exits(stmt.thenStatement)) return undefined;
  const info = parseInstanceof(env, stmt.expression, bindSym);
  if (!info) return undefined;
  // then-branch runs (and exits) when the condition holds; below, it does not.
  return { type: info.type, positive: !info.positive };
}

// True when control cannot fall through the statement (return/throw/break/continue).
function exits(stmt: ts.Statement): boolean {
  if (ts.isBlock(stmt)) {
    const last = stmt.statements[stmt.statements.length - 1];
    return last ? exits(last) : false;
  }
  return (
    ts.isReturnStatement(stmt) ||
    ts.isThrowStatement(stmt) ||
    ts.isBreakStatement(stmt) ||
    ts.isContinueStatement(stmt)
  );
}

// Recover the concrete type behind a canonical key (`file:qname`) by resolving
// its name in scope — needed for subtype discharge of types that arrived through
// a callee summary and so are absent from this function's local type table.
function resolveKeyType(env: Env, key: string): ts.Type | undefined {
  if (key === TOP_KEY) return undefined;
  const colon = key.indexOf(":");
  const qname = colon >= 0 ? key.slice(colon + 1) : key;
  // qname is `<module>.Name` for module exports; the simple trailing identifier
  // is what resolves in the function's scope.
  const dot = qname.lastIndexOf(".");
  const simple = dot >= 0 ? qname.slice(dot + 1) : qname;
  if (!/^[A-Za-z_$][\w$]*$/.test(simple)) return undefined;
  const sym = env.checker.resolveName(simple, ts.SymbolFlags.Type | ts.SymbolFlags.Value, env.fn.node, false);
  if (!sym) return undefined;
  const t = env.checker.getDeclaredTypeOfSymbol(sym);
  if (t) env.typeTable.set(key, t);
  return t;
}

// Nominal subclass test over the class/interface heritage (`extends` chain),
// matching `instanceof` semantics rather than structural assignability.
function isSubclassOf(c: ts.Type, base: ts.Type, seen = new Set<ts.Type>()): boolean {
  if (c === base) return true;
  const cs = c.getSymbol();
  const bs = base.getSymbol();
  if (cs && bs && cs === bs) return true;
  if (seen.has(c)) return false;
  seen.add(c);
  const bases = (c as ts.InterfaceType).getBaseTypes() ?? [];
  for (const b of bases) if (isSubclassOf(b, base, seen)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Call sites
// ---------------------------------------------------------------------------

function callEscape(env: Env, call: ts.CallExpression | ts.NewExpression): ExceptionsValue {
  detectParamCall(env, call);
  const res = env.resolveCall(call);
  let v = bottom();
  for (const target of res.targets) {
    const s = env.summaryOf(target);
    v = join(v, s.value);
    for (const i of s.fromCallbacks) {
      for (const f of res.functionArgs.get(i) ?? []) v = join(v, env.summaryOf(f).value);
    }
  }
  if (res.overlay) v = join(v, overlayValue(env, res, call));
  // Unresolved callee with no model: degrade by dispatch.
  if (res.unresolved && !res.overlay && env.dispatch === "pessimist") v = join(v, top());
  const sink = matchSink(env, call);
  if (sink) v = applySink(v, sink);
  return v;
}

function overlayValue(env: Env, res: CalleeResolution, call: ts.CallExpression | ts.NewExpression): ExceptionsValue {
  const entry = (res.overlay?.entry ?? {}) as ExceptionsOverlayEntry;
  let v = bottom();
  if (Array.isArray(entry.exceptions)) {
    for (const name of entry.exceptions) if (typeof name === "string") v = join(v, namedValue(env, name, call));
  }
  if (Array.isArray(entry.exceptionsFromCallbacks)) {
    for (const i of entry.exceptionsFromCallbacks) {
      if (typeof i !== "number") continue;
      for (const f of res.functionArgs.get(i) ?? []) v = join(v, env.summaryOf(f).value);
    }
  }
  return v;
}

// Resolve an overlay/JSDoc type name against the lib/global scope so its key
// matches thrown values; fall back to the raw name when unresolved.
function namedValue(env: Env, name: string, location: ts.Node): ExceptionsValue {
  const sym = env.checker.resolveName(name, ts.SymbolFlags.Type, location, false);
  if (sym) {
    const t = env.checker.getDeclaredTypeOfSymbol(sym);
    if (t) return valueOfType(env, t);
  }
  return single(name, name);
}

// A call to one of the function's own parameters makes the caller inherit that
// parameter's effect (one level of conditional summary).
function detectParamCall(env: Env, call: ts.CallExpression | ts.NewExpression): void {
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return;
  const sym = env.checker.getSymbolAtLocation(call.expression);
  if (!sym) return;
  const idx = env.paramSymbols.get(sym);
  if (idx !== undefined) env.fromCallbacks.add(idx);
}

function matchSink(env: Env, call: ts.CallExpression | ts.NewExpression): SinkConfig | undefined {
  if (!ts.isCallExpression(call)) return undefined;
  const names = calleeSelectors(call.expression);
  for (const s of env.sinks) if (names.has(s.callee)) return s;
  return undefined;
}

// Absent `absorbs` swallows everything; otherwise only listed type displays are
// discharged and the rest leak. TOP leaks past a partial sink.
function applySink(v: ExceptionsValue, sink: SinkConfig): ExceptionsValue {
  if (!sink.absorbs) return bottom();
  if (v.top) return v;
  const absorb = new Set(sink.absorbs);
  const kept = new Map<string, string>();
  const keptOrigins = new Map<string, ReadonlyArray<ExceptionOrigin>>();
  for (const [k, d] of v.types) {
    if (absorb.has(d)) continue;
    kept.set(k, d);
    const o = v.origins.get(k);
    if (o) keptOrigins.set(k, o);
  }
  return { top: false, types: kept, origins: keptOrigins };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

// Anchor each escape at the statement where it actually leaves the function.
// `binding`/`remainder` describe the enclosing catch: a bare rethrow of `binding`
// carries `remainder` (the un-discharged try set) and is reported at the rethrow.
// Channel `report` mode (default "all"):
//  - "all":          throws AND uncaught calls.
//  - "consumers":    uncaught calls only (not the `throw`s themselves) — the site
//                    where a caller should be careful, not where errors originate.
//  - "cross-module": like "consumers", but only when the throwing callee lives in
//                    a DIFFERENT module (package) — internal calls are yours to see.
function reportMode(ctx: DiagnoseContext<ExceptionsValue>): string {
  const cc = ctx.channelConfig;
  if (typeof cc === "object" && cc !== null) {
    const r = (cc as Record<string, unknown>)["report"];
    if (typeof r === "string") return r;
  }
  return "consumers";
}

function consumersOnly(ctx: DiagnoseContext<ExceptionsValue>): boolean {
  const mode = reportMode(ctx);
  return mode === "consumers" || mode === "cross-module";
}

// `errorCause: true` (channel config) enables the use-error-cause check.
function errorCauseEnabled(ctx: DiagnoseContext<ExceptionsValue>): boolean {
  const cc = ctx.channelConfig;
  return typeof cc === "object" && cc !== null && (cc as Record<string, unknown>)["errorCause"] === true;
}

// A `new Error(msg, { cause })` argument list mentions `cause` in an options
// object — the way to preserve a caught error when rethrowing.
function hasCauseArg(node: ts.NewExpression): boolean {
  for (const arg of node.arguments ?? []) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const p of arg.properties) {
      const name = (p as { name?: ts.Node }).name;
      if (name && ts.isIdentifier(name) && name.text === "cause") return true;
    }
  }
  return false;
}

// Flag `catch (e) { … throw new X(…) }` where the new error carries no `cause`,
// so the caught error (and its stack) is silently dropped.
function checkErrorCause(node: ts.Node, out: Diagnostic[]): void {
  const visit = (n: ts.Node): void => {
    if (isFunctionLike(n)) return;
    if (ts.isCatchClause(n) && n.variableDeclaration) {
      const scan = (m: ts.Node): void => {
        if (isFunctionLike(m) || ts.isCatchClause(m)) return; // nested catches own their throws
        if (
          ts.isThrowStatement(m) &&
          m.expression &&
          ts.isNewExpression(m.expression) &&
          !hasCauseArg(m.expression)
        ) {
          out.push({
            channel: "exceptions",
            message: "Rethrow drops the caught error — pass `{ cause }` to preserve it",
            location: locationOf(m, m.getSourceFile()),
            related: [],
          });
        }
        ts.forEachChild(m, scan);
      };
      ts.forEachChild(n.block, scan);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
}

// Nearest ancestor directory containing a package.json — a file's "module".
const packageRootCache = new Map<string, string>();
function packageRootOf(fileName: string): string {
  let dir = fileName.replace(/\\/g, "/");
  const slash = dir.lastIndexOf("/");
  dir = slash >= 0 ? dir.slice(0, slash) : dir;
  for (let cur = dir; ; ) {
    const cached = packageRootCache.get(cur);
    if (cached !== undefined) return cached;
    if (NodeFS.existsSync(`${cur}/package.json`)) {
      packageRootCache.set(dir, cur);
      return cur;
    }
    const up = cur.lastIndexOf("/");
    if (up <= 0) {
      packageRootCache.set(dir, dir);
      return dir;
    }
    cur = cur.slice(0, up);
  }
}

// A call worth reporting under "cross-module": it reaches an external/overlay
// thrower, or an app function in a different package than the caller. When every
// resolved target is in the caller's own package, the throw is internal — skip.
function crossesModuleBoundary(
  env: Env,
  ctx: DiagnoseContext<ExceptionsValue>,
  call: ts.CallExpression | ts.NewExpression,
): boolean {
  const res = env.resolveCall(call);
  if (res.targets.length === 0) return true; // overlay / external / unresolved
  const home = packageRootOf(ctx.fn.fileName);
  return res.targets.some((t) => packageRootOf(t.fileName) !== home);
}

// Up-stack filter: true unless every throw behind `rem` is caught before reaching
// any call-graph root (i.e. handled by some ancestor). No roots => not applicable.
function reachesTop(env: Env, rem: ExceptionsValue): boolean {
  const u = env.unhandled;
  if (!u || !u.active) return true;
  for (const o of originsOf(rem)) if (u.origins.has(`${o.fileName}:${o.pos}`)) return true;
  return false;
}

function walkDiagnostics(
  env: Env,
  ctx: DiagnoseContext<ExceptionsValue>,
  node: ts.Node,
  binding: ts.Symbol | undefined,
  remainder: ExceptionsValue | undefined,
  out: Diagnostic[],
): void {
  const visit = (n: ts.Node): void => {
    if (isFunctionLike(n)) return;
    if (ts.isTryStatement(n)) {
      handleTry(env, ctx, n, binding, remainder, out);
      return;
    }
    if (ts.isThrowStatement(n)) {
      if (n.expression) {
        // "consumers" mode reports only where a throwing callee is *called*
        // uncaught, never where an error is produced — so the throw itself is
        // silent, but we still descend to flag any risky calls inside it.
        if (!consumersOnly(ctx)) {
          if (isBindingRef(env, n.expression, binding)) {
            // Rethrow of the catch binding: the un-discharged remainder leaves here.
            if (remainder && !isEmpty(remainder)) out.push(throwDiagnostic(ctx, n, remainder));
          } else {
            const rem = valueOfType(env, env.checker.getTypeAtLocation(n.expression));
            if (!isEmpty(rem)) out.push(throwDiagnostic(ctx, n, rem));
          }
        }
        ts.forEachChild(n.expression, visit);
      }
      return;
    }
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const rem = callEscape(env, n);
      // In "cross-module" mode a call is reported only when its throwing callee is
      // in another package (the author can't see it) AND the throw isn't caught by
      // some ancestor up the stack.
      const report =
        reportMode(ctx) !== "cross-module" ||
        (crossesModuleBoundary(env, ctx, n) && reachesTop(env, rem));
      if (!isEmpty(rem) && report) out.push(callDiagnostic(env, ctx, n, rem));
      ts.forEachChild(n, visit);
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
}

// A try whose catch catches everything: its tryBlock sites never escape THIS
// function directly, so we do not report them. The catch discharges some types;
// the remainder is attributed to the rethrow inside the catch. A try with no
// catch lets its body escape normally; a finally always escapes.
function handleTry(
  env: Env,
  ctx: DiagnoseContext<ExceptionsValue>,
  n: ts.TryStatement,
  binding: ts.Symbol | undefined,
  remainder: ExceptionsValue | undefined,
  out: Diagnostic[],
): void {
  if (n.catchClause) {
    const tryEsc = escapeOf(env, n.tryBlock, binding);
    const bindSym = bindingSymOf(env, n.catchClause) ?? binding;
    const discharge = dischargedKeys(env, n.catchClause, tryEsc, bindSym);
    const rem = subtract(tryEsc, discharge);
    walkDiagnostics(env, ctx, n.catchClause.block, bindSym, rem, out);
  } else {
    walkDiagnostics(env, ctx, n.tryBlock, binding, remainder, out);
  }
  if (n.finallyBlock) walkDiagnostics(env, ctx, n.finallyBlock, binding, remainder, out);
}

// A `throw` statement as a portable origin record: location + one-line source.
function originOf(node: ts.ThrowStatement): ExceptionOrigin {
  const sf = node.getSourceFile();
  const start = node.getStart(sf);
  const { line, character } = sf.getLineAndCharacterOfPosition(start);
  const raw = node.getText(sf).replace(/\s+/g, " ").trim();
  return {
    fileName: sf.fileName,
    pos: start,
    end: node.getEnd(),
    line: line + 1,
    column: character + 1,
    text: raw.length > 120 ? `${raw.slice(0, 117)}…` : raw,
  };
}

// The throw sites behind an escape, as related-information entries: each carries
// the throw's source text and a click-to-jump location, so a reader sees every
// potential throw without opening the files.
function relatedFromOrigins(origins: ReadonlyArray<ExceptionOrigin>): DiagnosticRelated[] {
  return origins.slice(0, 8).map((o) => ({
    message: o.text,
    location: { fileName: o.fileName, line: o.line, column: o.column, pos: o.pos, end: o.end },
  }));
}

function callDiagnostic(
  env: Env,
  ctx: DiagnoseContext<ExceptionsValue>,
  call: ts.CallExpression | ts.NewExpression,
  rem: ExceptionsValue,
): Diagnostic {
  const res = env.resolveCall(call);
  const from = calleeDisplay(res, call);
  const suffix = from ? ` (from ${from})` : "";
  const origins = originsOf(rem);
  return {
    channel: "exceptions",
    message: `Call may throw ${render(rem)}${suffix} with no catch on the path to \`${ctx.fn.name}\``,
    location: locationOf(call, call.getSourceFile()),
    related: origins.length > 0 ? relatedFromOrigins(origins) : buildRelated(ctx, res.targets),
  };
}

function throwDiagnostic(
  ctx: DiagnoseContext<ExceptionsValue>,
  node: ts.ThrowStatement,
  rem: ExceptionsValue,
): Diagnostic {
  return {
    channel: "exceptions",
    message: `Throw may throw ${render(rem)} with no catch on the path to \`${ctx.fn.name}\``,
    location: locationOf(node, node.getSourceFile()),
    related: buildRelated(ctx, []),
  };
}

function calleeDisplay(res: CalleeResolution, call: ts.CallExpression | ts.NewExpression): string | undefined {
  if (res.overlay) return res.overlay.symbol;
  if (res.targets[0]) return res.targets[0].name;
  const callee = ts.isCallExpression(call) || ts.isNewExpression(call) ? call.expression : undefined;
  if (callee && ts.isPropertyAccessExpression(callee)) return callee.getText();
  if (callee && ts.isIdentifier(callee)) return callee.text;
  return undefined;
}

// Related chain: where the effect originates (each callee target) plus the path
// out to the reaching boundary.
function buildRelated(
  ctx: DiagnoseContext<ExceptionsValue>,
  targets: ReadonlyArray<FunctionInfo>,
): ReadonlyArray<DiagnosticRelated> {
  const related: DiagnosticRelated[] = [];
  for (const t of targets) {
    related.push({ message: `may throw here in ${t.name}`, location: locationOf(t.node, t.sourceFile) });
  }
  for (const f of ctx.pathToBoundary(ctx.fn)) {
    related.push({ message: `on the path to boundary via ${f.name}`, location: locationOf(f.node, f.sourceFile) });
  }
  return related;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Convert a thrown/error type to a lattice value, retaining each constituent's
// concrete type for later subtype discharge.
function valueOfType(env: Env, type: ts.Type | undefined): ExceptionsValue {
  let v = bottom();
  if (!type) return v;
  for (const t of constituentsOf(type)) {
    const r = refOfType(env.checker, t);
    if (r.top) {
      v = join(v, top());
      continue;
    }
    env.typeTable.set(r.key, t);
    v = join(v, single(r.key, r.display));
  }
  return v;
}

function bindingSymOf(env: Env, cc: ts.CatchClause): ts.Symbol | undefined {
  const vd = cc.variableDeclaration;
  if (vd && ts.isIdentifier(vd.name)) return env.checker.getSymbolAtLocation(vd.name);
  return undefined;
}

function isBindingRef(env: Env, expr: ts.Expression, bindSym: ts.Symbol | undefined): boolean {
  if (!bindSym || !ts.isIdentifier(expr)) return false;
  return env.checker.getSymbolAtLocation(expr) === bindSym;
}
