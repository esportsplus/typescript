import * as ts from '../adapter';

import { hasModifier, unwrap } from './ast';
import { isFunctionLike, makeFunctionInfo } from './ids';
import type {
    CalleeResolution,
    CallGraph,
    FunctionInfo,
    FunctionLike,
    OverlaySet,
} from './types';

// Channel-independent facts about one call site, computed once and cached. The
// per-channel overlay lookup is layered on top in `resolveCall`.
type CallCore  = {
    readonly symbol: ts.Symbol | undefined;
    readonly targets: ReadonlyArray<FunctionInfo>;
    readonly functionArgs: () => ReadonlyMap<number, ReadonlyArray<FunctionInfo>>;
    // Callee cannot be pinned to a declaration: `any`, an untracked function
    // value (a parameter/variable holding a function), or an abstract method.
    readonly unresolved: boolean;
};

function buildCallGraph(
    program: ts.Program,
    checker: ts.TypeChecker,
    overlays: OverlaySet,
): CallGraph {
    const entryFiles = ts.getEntrySourceFiles(program);
    const analyzableFiles = new Set(entryFiles);
    const reached = new Map<FunctionLike, FunctionInfo>();
    const worklist: FunctionInfo[] = [];

    const coreCache = new Map<ts.CallExpression | ts.NewExpression, CallCore>();
    const resolutionCache = new Map<ts.CallExpression | ts.NewExpression, Map<string, CalleeResolution>>();
    const callsCache = new Map<
        string,
        ReadonlyArray<ts.CallExpression | ts.NewExpression>
    >();
    const calleesCache = new Map<string, ReadonlyArray<FunctionInfo>>();

    // --- interning ----------------------------------------------------------

    function isAnalyzable(node: FunctionLike): boolean {
        const sf = node.getSourceFile();
        return analyzableFiles.has(sf) && (node as { body?: ts.Node }).body != null;
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
                const members =
                    (decl as { members?: readonly ts.Node[] }).members ?? [];
                for (const member of members) {
                    if (ts.isConstructorDeclaration(member)) {
                        out.push(member);
                    }
                }
            }
        }
        return out;
    }

    function argExpressions(
        call: ts.CallExpression | ts.NewExpression,
    ): ReadonlyArray<ts.Expression> {
        return call.arguments ? Array.from(call.arguments) : [];
    }

    function computeCore(call: ts.CallExpression | ts.NewExpression): CallCore {
        const isNew = ts.isNewExpression(call);
        const sym = calleeSymbol(call);
        let functionArgs: Map<number, ReadonlyArray<FunctionInfo>> | undefined;

        const resolveFunctionArgs = (): ReadonlyMap<number, ReadonlyArray<FunctionInfo>> => {
            if (functionArgs) {
                return functionArgs;
            }

            const resolved = new Map<number, ReadonlyArray<FunctionInfo>>();

            functionArgs = resolved;
            argExpressions(call).forEach((arg, index) => {
                const infos = resolveFunctionValue(arg);

                if (infos.length > 0) {
                    resolved.set(index, infos);
                }
            });

            return functionArgs;
        };

        if (!sym) {
            // No symbol: the callee flows through `any` or an untracked value.
            return {
                functionArgs: resolveFunctionArgs,
                symbol: undefined,
                targets: [],
                unresolved: true,
            };
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
            return { functionArgs: resolveFunctionArgs, symbol: sym, targets, unresolved: false };
        }
        if (fns.length === 0) {
            // Symbol resolves to a non-function (parameter/variable holding a
            // function) — an untracked function value.
            return { functionArgs: resolveFunctionArgs, symbol: sym, targets: [], unresolved: true };
        }
        if (fns.some((fn) => hasModifier(fn, ts.SyntaxKind.AbstractKeyword))) {
            // Abstract/overridable with no single implementation.
            return { functionArgs: resolveFunctionArgs, symbol: sym, targets: [], unresolved: true };
        }
        // Real declaration, no analyzable body: an external/lib leaf.
        return { functionArgs: resolveFunctionArgs, symbol: sym, targets: [], unresolved: false };
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

    function resolveFunctionValue(
        expr: ts.Expression,
    ): ReadonlyArray<FunctionInfo> {
        const e = unwrap(expr, { assertions: true });
        if (isFunctionLike(e)) {
            const info = intern(e);
            return info ? [info] : [];
        }
        if (
            ts.isIdentifier(e) ||
            ts.isPropertyAccessExpression(e) ||
            ts.isElementAccessExpression(e)
        ) {
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

    // --- entry discovery ----------------------------------------------------

    // Every function-like node in a file, nested ones included — the roots for
    // whole-project mode, where each function is analyzed and reported on directly.
    function allFunctionLikesIn(sf: ts.SourceFile): FunctionLike[] {
        const out: FunctionLike[] = [];
        const visit = (node: ts.Node): void => {
            if (
                isFunctionLike(node) &&
                (!ts.isFunctionDeclaration(node) || node.body)
            ) {
                out.push(node);
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(sf, visit);
        return out;
    }

    // --- prefetch -----------------------------------------------------------

    // Identifier binding names a parameter declares, destructured object
    // properties included (the async channel types each one).
    function bindingIdentifiers(name: ts.BindingName, out: ts.Node[]): void {
        if (ts.isIdentifier(name)) {
            out.push(name);
            return;
        }
        if (ts.isObjectBindingPattern(name)) {
            for (const el of name.elements) {
                if (el.name) {
                    bindingIdentifiers(el.name, out);
                }
            }
        }
    }

    // Every checker query is a synchronous round-trip to tsgo. Ask the questions
    // the graph and channels will ask about a file's functions in two batches; the
    // memoized checker then answers each later single query from its cache. The
    // answers are the same as asking one node at a time.
    function prefetch(fns: ReadonlyArray<FunctionInfo>): void {
        const callees: ts.Node[] = [];
        const symbols: ts.Node[] = [];
        const types: ts.Node[] = [];
        for (const fn of fns) {
            if (!hasModifier(fn.node, ts.SyntaxKind.AsyncKeyword)) {
                types.push(fn.node);
            }
            // The async channel counts a declaration's symbol declarations to
            // rule out overloads before reading its return type off syntax.
            if (
                (ts.isFunctionDeclaration(fn.node) || ts.isMethodDeclaration(fn.node)) &&
                fn.node.name &&
                !ts.isComputedPropertyName(fn.node.name)
            ) {
                symbols.push(fn.node.name);
            }
            for (const param of fn.node.parameters) {
                if (ts.isIdentifier(param.name)) {
                    symbols.push(param.name);
                }
                bindingIdentifiers(param.name, types);
            }
            for (const call of callsIn(fn)) {
                callees.push(call.expression);
                types.push(call);
            }
        }
        if (callees.length + symbols.length > 0) {
            checker.getSymbolAtLocation([...callees, ...symbols]);
        }
        if (types.length > 0) {
            checker.getTypeAtLocation(types);
        }
    }

    // --- build --------------------------------------------------------------

    // Whole-project analysis: every function of every entry file is an entry, so
    // any uncaught effect is reported wherever it is.
    for (const sf of entryFiles) {
        const fns: FunctionInfo[] = [];
        for (const node of allFunctionLikesIn(sf)) {
            const info = intern(node);
            if (info) {
                fns.push(info);
            }
        }
        prefetch(fns);
    }

    for (let workIndex = 0; workIndex < worklist.length; workIndex++) {
        const fn = worklist[workIndex];
        for (const call of callsIn(fn)) {
            // getCore reaches the callee targets and any function-valued arguments.
            getCore(call);
        }
    }

    const reachedList: ReadonlyArray<FunctionInfo> = Array.from(
        reached.values(),
    );

    // --- public interface ---------------------------------------------------

    function resolveCall(
        call: ts.CallExpression | ts.NewExpression,
        channel: string,
    ): CalleeResolution {
        let cached = resolutionCache.get(call)?.get(channel);

        if (cached) {
            return cached;
        }

        const core = getCore(call);
        let result: CalleeResolution;

        if (core.targets.length > 0) {
            result = {
                get functionArgs() { return core.functionArgs(); },
                overlay: undefined,
                targets: core.targets,
                unresolved: false,
            };
        }
        else {
            const overlay = core.symbol
                ? overlays.lookup(core.symbol, channel)
                : undefined;

            result = overlay ? {
                get functionArgs() { return core.functionArgs(); },
                overlay,
                targets: [],
                unresolved: false,
            } : {
                get functionArgs() { return core.functionArgs(); },
                overlay: undefined,
                targets: [],
                unresolved: core.unresolved,
            };
        }

        let resolutions = resolutionCache.get(call);

        if (!resolutions) {
            resolutions = new Map();
            resolutionCache.set(call, resolutions);
        }

        resolutions.set(channel, result);

        return result;
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
        calleesOf,
        reachedFunctions() {
            return reachedList;
        },
        resolveCall,
    };
}


export { buildCallGraph };
