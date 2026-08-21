import * as ts from "~/probe/adapter";

import { isFunctionLike, makeFunctionInfo } from "./ids";
import type {
  CalleeResolution,
  CallGraph,
  FunctionInfo,
  FunctionLike,
  HandlerBoundary,
  OverlaySet,
  AnalyzeConfig,
} from "./types";

// Channel-independent facts about one call site, computed once and cached. The
// per-channel overlay lookup is layered on top in `resolveCall`.
interface CallCore {
  readonly symbol: ts.Symbol | undefined;
  readonly targets: ReadonlyArray<FunctionInfo>;
  readonly functionArgs: ReadonlyMap<number, ReadonlyArray<FunctionInfo>>;
  // Callee cannot be pinned to a declaration: `any`, an untracked function
  // value (a parameter/variable holding a function), or an abstract method.
  readonly unresolved: boolean;
  // A real declaration exists but has no analyzable body — overlay/worklist
  // material. Its display name, else undefined.
  readonly bodylessLeafName: string | undefined;
}

// A parsed handler-boundary selector. `module` is the package the callee must
// come from (undefined for a bare name that carries no `.` segment); `names` is
// the ordered member/method chain, so "express.Router#get" ->
// { module: "express", names: ["Router", "get"] }, "pkg.fn" ->
// { module: "pkg", names: ["fn"] }, and "onRequest" ->
// { module: undefined, names: ["onRequest"] }.
interface Selector {
  readonly module: string | undefined;
  readonly names: ReadonlyArray<string>;
}

export function buildCallGraph(
  program: ts.Program,
  checker: ts.TypeChecker,
  config: AnalyzeConfig,
  overlays: OverlaySet,
): CallGraph {
  const programFiles = new Set(ts.getSourceFiles(program));
  const reached = new Map<FunctionLike, FunctionInfo>();
  const byId = new Map<string, FunctionInfo>();
  const boundaryIds = new Set<string>();
  const worklist: FunctionInfo[] = [];
  // No configured entry points → analyze the whole project: every function is an
  // entry and a boundary, so any uncaught throw is reported wherever it is.
  const wholeProject = config.entryPoints.length === 0;

  const coreCache = new Map<ts.CallExpression | ts.NewExpression, CallCore>();
  const callsCache = new Map<string, ReadonlyArray<ts.CallExpression | ts.NewExpression>>();
  const calleesCache = new Map<string, ReadonlyArray<FunctionInfo>>();

  const boundaries: ReadonlyArray<{ boundary: HandlerBoundary; selector: Selector }> =
    config.handlerBoundaries.map((boundary) => ({
      boundary,
      selector: parseSelector(boundary.callee),
    }));

  // --- interning ----------------------------------------------------------

  function isAnalyzable(node: FunctionLike): boolean {
    const sf = node.getSourceFile();
    // A body in a non-declaration file that the Program actually owns. `.d.ts`
    // and out-of-program declarations are overlay leaves, never graph nodes.
    return (
      !sf.isDeclarationFile &&
      programFiles.has(sf) &&
      (node as { body?: ts.Node }).body != null
    );
  }

  function intern(node: FunctionLike): FunctionInfo | undefined {
    if (!isAnalyzable(node)) {
      return undefined;
    }
    const existing = reached.get(node);
    if (existing) {
      return existing;
    }
    const info = makeFunctionInfo(node, node.getSourceFile());
    reached.set(node, info);
    byId.set(info.id, info);
    worklist.push(info);
    return info;
  }

  // --- symbol / declaration resolution ------------------------------------

  function calleeSymbol(
    call: ts.CallExpression | ts.NewExpression,
  ): ts.Symbol | undefined {
    let sym = checker.getSymbolAtLocation(call.expression);
    // Follow `import { f } from "..."` aliases to the real declaration; call
    // resolution keys on declaration identity, never on names.
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      sym = checker.getAliasedSymbol(sym);
    }
    return sym;
  }

  // Function-like declarations a symbol can stand for: plain functions/methods,
  // `const f = () => {}` initializers, and (for `new`) class constructors.
  function functionLikesFromSymbol(
    sym: ts.Symbol,
    isNew: boolean,
  ): ReadonlyArray<FunctionLike> {
    const out: FunctionLike[] = [];
    for (const decl of ts.symbolDeclarations(sym)) {
      if (isFunctionLike(decl)) {
        out.push(decl);
        continue;
      }
      if (
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        isFunctionLike(decl.initializer)
      ) {
        out.push(decl.initializer);
        continue;
      }
      if (isNew && ts.isClassLike(decl)) {
        const members = (decl as { members?: readonly ts.Node[] }).members ?? [];
        for (const member of members) {
          if (ts.isConstructorDeclaration(member)) {
            out.push(member);
          }
        }
      }
    }
    return out;
  }

  function isAbstract(node: FunctionLike): boolean {
    const mods = (node as { modifiers?: ReadonlyArray<{ kind: ts.SyntaxKind }> }).modifiers;
    return mods?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) ?? false;
  }

  function displayName(
    call: ts.CallExpression | ts.NewExpression,
    sym: ts.Symbol | undefined,
  ): string {
    const name = sym?.name;
    if (name && name !== "__type" && name !== "__function") {
      return name;
    }
    return call.expression.getText(call.expression.getSourceFile());
  }

  function argExpressions(
    call: ts.CallExpression | ts.NewExpression,
  ): ReadonlyArray<ts.Expression> {
    return call.arguments ? Array.from(call.arguments) : [];
  }

  function computeCore(call: ts.CallExpression | ts.NewExpression): CallCore {
    const isNew = ts.isNewExpression(call);
    const sym = calleeSymbol(call);

    const functionArgs = new Map<number, ReadonlyArray<FunctionInfo>>();
    argExpressions(call).forEach((arg, index) => {
      const infos = resolveFunctionValue(arg);
      if (infos.length > 0) {
        functionArgs.set(index, infos);
      }
    });

    if (!sym) {
      // No symbol: the callee flows through `any` or an untracked value.
      return { symbol: undefined, targets: [], functionArgs, unresolved: true, bodylessLeafName: undefined };
    }

    const fns = functionLikesFromSymbol(sym, isNew);
    const seen = new Set<string>();
    const targets: FunctionInfo[] = [];
    for (const fn of fns) {
      const info = intern(fn);
      if (info && !seen.has(info.id)) {
        seen.add(info.id);
        targets.push(info);
      }
    }

    if (targets.length > 0) {
      return { symbol: sym, targets, functionArgs, unresolved: false, bodylessLeafName: undefined };
    }
    if (fns.length === 0) {
      // Symbol resolves to a non-function (parameter/variable holding a
      // function) — an untracked function value.
      return { symbol: sym, targets: [], functionArgs, unresolved: true, bodylessLeafName: undefined };
    }
    if (fns.some(isAbstract)) {
      // Abstract/overridable with no single implementation.
      return { symbol: sym, targets: [], functionArgs, unresolved: true, bodylessLeafName: undefined };
    }
    // Real declaration, no analyzable body: an external/lib leaf.
    return {
      symbol: sym,
      targets: [],
      functionArgs,
      unresolved: false,
      bodylessLeafName: displayName(call, sym),
    };
  }

  function getCore(call: ts.CallExpression | ts.NewExpression): CallCore {
    let core = coreCache.get(call);
    if (!core) {
      core = computeCore(call);
      coreCache.set(call, core);
    }
    return core;
  }

  // --- function-value resolution ------------------------------------------

  function unwrap(expr: ts.Expression): ts.Expression {
    let e = expr;
    while (true) {
      if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) {
        e = e.expression;
        continue;
      }
      if (ts.isSatisfiesExpression?.(e)) {
        e = e.expression;
        continue;
      }
      break;
    }
    return e;
  }

  function resolveFunctionValue(expr: ts.Expression): ReadonlyArray<FunctionInfo> {
    const e = unwrap(expr);
    if (isFunctionLike(e)) {
      const info = intern(e);
      return info ? [info] : [];
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      let sym = checker.getSymbolAtLocation(e);
      if (sym && sym.flags & ts.SymbolFlags.Alias) {
        sym = checker.getAliasedSymbol(sym);
      }
      if (!sym) {
        return [];
      }
      const seen = new Set<string>();
      const out: FunctionInfo[] = [];
      for (const fn of functionLikesFromSymbol(sym, false)) {
        const info = intern(fn);
        if (info && !seen.has(info.id)) {
          seen.add(info.id);
          out.push(info);
        }
      }
      return out;
    }
    return [];
  }

  // --- body walking -------------------------------------------------------

  // Calls made directly in `fn`'s own body — never descends into nested
  // function bodies, which are their own graph nodes analyzed separately.
  function callsIn(
    fn: FunctionInfo,
  ): ReadonlyArray<ts.CallExpression | ts.NewExpression> {
    const cached = callsCache.get(fn.id);
    if (cached) {
      return cached;
    }
    const calls: (ts.CallExpression | ts.NewExpression)[] = [];
    const visit = (node: ts.Node): void => {
      if (node !== fn.node && isFunctionLike(node)) {
        return;
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    const body = (fn.node as { body?: ts.Node }).body;
    if (body) {
      visit(body);
    }
    // Parameter default initializers execute in this function's frame.
    for (const param of fn.node.parameters) {
      if (param.initializer) {
        visit(param.initializer);
      }
    }
    callsCache.set(fn.id, calls);
    return calls;
  }

  // --- handler boundaries -------------------------------------------------

  // Package a symbol's declaration belongs to. Best-effort: the last
  // `node_modules/<pkg>` path segment (scoped names kept whole, `@types/x`
  // mapped back to `x`) plus any enclosing ambient `declare module "..."`.
  function modulesOfSymbol(sym: ts.Symbol): ReadonlyArray<string> {
    const mods = new Set<string>();
    for (const decl of ts.symbolDeclarations(sym)) {
      const sf = decl.getSourceFile();
      const parts = sf.fileName.split(/node_modules\//);
      if (parts.length > 1) {
        const tail = parts[parts.length - 1]!;
        const seg = tail.startsWith("@")
          ? tail.split("/").slice(0, 2).join("/")
          : tail.split("/")[0]!;
        mods.add(seg.startsWith("@types/") ? seg.slice("@types/".length) : seg);
      }
      let p: ts.Node | undefined = decl.parent;
      while (p) {
        if (ts.isModuleDeclaration(p) && ts.isStringLiteral(p.name)) {
          mods.add(p.name.text);
        }
        p = p.parent;
      }
    }
    return Array.from(mods);
  }

  // Enclosing class/interface/namespace/type names of a symbol's declarations,
  // used to match the leading segments of a selector chain.
  function ownerNames(sym: ts.Symbol): ReadonlyArray<string> {
    const names = new Set<string>();
    for (const decl of ts.symbolDeclarations(sym)) {
      let p: ts.Node | undefined = decl.parent;
      while (p) {
        if (
          (ts.isClassLike(p) ||
            ts.isInterfaceDeclaration(p) ||
            ts.isModuleDeclaration(p) ||
            ts.isTypeAliasDeclaration(p)) &&
          "name" in p &&
          p.name &&
          ts.isIdentifier(p.name as ts.Node)
        ) {
          names.add((p.name as ts.Identifier).text);
        }
        p = p.parent;
      }
    }
    return Array.from(names);
  }

  function isLocalSymbol(sym: ts.Symbol): boolean {
    for (const decl of ts.symbolDeclarations(sym)) {
      const sf = decl.getSourceFile();
      if (!sf.isDeclarationFile && programFiles.has(sf)) {
        return true;
      }
    }
    return false;
  }

  function matchesSelector(sym: ts.Symbol, selector: Selector): boolean {
    if (selector.names.length === 0) {
      return false;
    }
    const last = selector.names[selector.names.length - 1]!;
    if (sym.name !== last) {
      return false;
    }
    // A bare-name selector, or any callee declared locally in-program, matches
    // on the name chain alone — app-local handler registries are the common
    // case. The node_modules module check only gates selectors that name a
    // package for an external, out-of-program callee.
    if (selector.module !== undefined && !isLocalSymbol(sym)) {
      if (!modulesOfSymbol(sym).includes(selector.module)) {
        return false;
      }
    }
    const owners = ownerNames(sym);
    for (const name of selector.names.slice(0, -1)) {
      if (!owners.includes(name)) {
        return false;
      }
    }
    return true;
  }

  function markBoundaryCallbacks(call: ts.CallExpression | ts.NewExpression): void {
    const sym = getCore(call).symbol;
    if (!sym) {
      return;
    }
    const args = argExpressions(call);
    for (const { boundary, selector } of boundaries) {
      if (!matchesSelector(sym, selector)) {
        continue;
      }
      for (const index of boundary.callbackArgs) {
        const arg = args[index];
        if (!arg) {
          continue;
        }
        for (const info of resolveFunctionValue(arg)) {
          boundaryIds.add(info.id);
        }
      }
    }
  }

  // --- entry point discovery ----------------------------------------------

  // The function-like declarations a single exported symbol resolves to: a plain
  // `export function`, an `export const f = () => …` (the common "declare local,
  // export at the bottom" style), or `export default () => …`.
  function functionLikesOfSymbol(symbol: ts.Symbol): FunctionLike[] {
    const out: FunctionLike[] = [];
    for (const decl of ts.symbolDeclarations(symbol)) {
      if (decl.getSourceFile().isDeclarationFile) {
        continue;
      }
      if (isFunctionLike(decl)) {
        if (!ts.isFunctionDeclaration(decl) || decl.body) {
          out.push(decl);
        }
      } else if (
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        isFunctionLike(decl.initializer)
      ) {
        out.push(decl.initializer);
      } else if (ts.isExportAssignment(decl) && isFunctionLike(decl.expression)) {
        out.push(decl.expression);
      }
    }
    return out;
  }

  // Every function-like node in a file, nested ones included — the roots for
  // whole-project mode, where each function is analyzed and reported on directly.
  function allFunctionLikesIn(sf: ts.SourceFile): FunctionLike[] {
    const out: FunctionLike[] = [];
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node) && (!ts.isFunctionDeclaration(node) || node.body)) {
        out.push(node);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return out;
  }

  // Entry functions are the module's exported functions, resolved through the
  // checker so every export style — `export function`, export-at-the-bottom
  // `export { f }`, `export default`, and re-export barrels — is covered. This
  // is the plan's "exports auto-added"; it never depends on declaration syntax.
  // With no configured entry points, whole-project mode makes every function an
  // entry so uncaught throws are flagged everywhere, not just from a few roots.
  function entryFunctionsOf(sf: ts.SourceFile): ReadonlyArray<FunctionLike> {
    if (wholeProject) {
      return allFunctionLikesIn(sf);
    }
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) {
      return [];
    }
    const out: FunctionLike[] = [];
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const resolved =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      out.push(...functionLikesOfSymbol(resolved));
    }
    return out;
  }

  function entryFiles(): ReadonlyArray<ts.SourceFile> {
    if (wholeProject) {
      // Every in-project, non-declaration source file: the native Program does not
      // expose the tsconfig root set, so filter its files to the project tree.
      return ts
        .getSourceFiles(program)
        .filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/"));
    }
    const root = normalizeSlashes(config.projectRoot).replace(/\/+$/, "");
    const patterns = config.entryPoints.map((glob) => {
      const g = normalizeSlashes(glob);
      const absolute = /^([a-zA-Z]:)?\//.test(g) ? g : `${root}/${g}`;
      return globToRegExp(absolute);
    });
    const files: ts.SourceFile[] = [];
    for (const sf of ts.getSourceFiles(program)) {
      if (sf.isDeclarationFile) {
        continue;
      }
      if (patterns.some((re) => re.test(sf.fileName))) {
        files.push(sf);
      }
    }
    return files;
  }

  // --- build --------------------------------------------------------------

  for (const sf of entryFiles()) {
    for (const node of entryFunctionsOf(sf)) {
      const info = intern(node);
      if (info) {
        boundaryIds.add(info.id);
      }
    }
  }

  while (worklist.length > 0) {
    const fn = worklist.shift()!;
    for (const call of callsIn(fn)) {
      // getCore reaches the callee targets and any function-valued arguments.
      getCore(call);
      markBoundaryCallbacks(call);
    }
  }

  const reachedList: ReadonlyArray<FunctionInfo> = Array.from(reached.values());

  // --- public interface ---------------------------------------------------

  function resolveCall(
    call: ts.CallExpression | ts.NewExpression,
    channel: string,
  ): CalleeResolution {
    const core = getCore(call);
    if (core.targets.length > 0) {
      return {
        targets: core.targets,
        overlay: undefined,
        functionArgs: core.functionArgs,
        unresolved: false,
        unmodeledLeaf: undefined,
      };
    }
    const overlay = core.symbol
      ? overlays.lookup(core.symbol, checker, channel)
      : undefined;
    if (overlay) {
      return {
        targets: [],
        overlay,
        functionArgs: core.functionArgs,
        unresolved: false,
        unmodeledLeaf: undefined,
      };
    }
    if (core.unresolved) {
      return {
        targets: [],
        overlay: undefined,
        functionArgs: core.functionArgs,
        unresolved: true,
        unmodeledLeaf: undefined,
      };
    }
    return {
      targets: [],
      overlay: undefined,
      functionArgs: core.functionArgs,
      unresolved: false,
      unmodeledLeaf: core.bodylessLeafName ?? displayName(call, core.symbol),
    };
  }

  function calleesOf(fn: FunctionInfo): ReadonlyArray<FunctionInfo> {
    const cached = calleesCache.get(fn.id);
    if (cached) {
      return cached;
    }
    const seen = new Set<string>();
    const out: FunctionInfo[] = [];
    for (const call of callsIn(fn)) {
      for (const target of getCore(call).targets) {
        if (reached.has(target.node) && !seen.has(target.id)) {
          seen.add(target.id);
          out.push(target);
        }
      }
    }
    calleesCache.set(fn.id, out);
    return out;
  }

  return {
    reachedFunctions() {
      return reachedList;
    },
    boundaries() {
      return boundaryIds;
    },
    calleesOf,
    functionAt(node: FunctionLike) {
      return reached.get(node);
    },
    resolveCall,
    resolveFunctionValue,
  };
}

// ---------------------------------------------------------------------------
// Glob matching (no external dep): `**` spans directories, `*` stays within a
// path segment, `?` is a single non-separator char.
// ---------------------------------------------------------------------------

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` consumes the separator so it can also match zero directories.
        if (glob[i + 2] === "/") {
          re += "(?:[^/]*(?:/|$))*";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  // Case-insensitive: on Windows/macOS the filesystem is, and tsserver hands back
  // a lowercase drive letter (`c:/…`) while the program's file names keep the
  // on-disk case (`C:/…`) — a case-sensitive match would drop every entry point.
  return new RegExp(`^${re}$`, "i");
}

function parseSelector(selector: string): Selector {
  const hashIndex = selector.indexOf("#");
  const dotted = hashIndex >= 0 ? selector.slice(0, hashIndex) : selector;
  const method = hashIndex >= 0 ? selector.slice(hashIndex + 1) : undefined;
  const segments = dotted.split(".").filter(Boolean);
  // Only a dotted selector carries a module segment; a bare name like
  // "onRequest" is a single member with no package qualifier.
  const hasModule = segments.length > 1;
  const module = hasModule ? segments[0] : undefined;
  const names = hasModule ? segments.slice(1) : segments.slice(0);
  if (method) {
    names.push(method);
  }
  return { module, names };
}
