import * as ts from '~/probe/adapter';

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
    const sourceFiles = ts.getSourceFiles(program);
    const programFiles = new Set(sourceFiles);
    const reached = new Map<FunctionLike, FunctionInfo>();
    const boundaryIds = new Set<string>();
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
        // A body in a non-declaration file that the Program owns and that is not a
        // dependency. `.d.ts` and node_modules sources (reachable via allowJs) are
        // overlay/derivation leaves, never graph nodes.
        return (
            !sf.isDeclarationFile &&
            programFiles.has(sf) &&
            !sf.fileName.replace(/\\/g, '/').includes('/node_modules/') &&
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

    function isAbstract(node: FunctionLike): boolean {
        const mods = (
            node as { modifiers?: ReadonlyArray<{ kind: ts.SyntaxKind }> }
        ).modifiers;
        return (
            mods?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) ?? false
        );
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
                symbol: undefined,
                targets: [],
                functionArgs: resolveFunctionArgs,
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
            return { symbol: sym, targets, functionArgs: resolveFunctionArgs, unresolved: false };
        }
        if (fns.length === 0) {
            // Symbol resolves to a non-function (parameter/variable holding a
            // function) — an untracked function value.
            return { symbol: sym, targets: [], functionArgs: resolveFunctionArgs, unresolved: true };
        }
        if (fns.some(isAbstract)) {
            // Abstract/overridable with no single implementation.
            return { symbol: sym, targets: [], functionArgs: resolveFunctionArgs, unresolved: true };
        }
        // Real declaration, no analyzable body: an external/lib leaf.
        return { symbol: sym, targets: [], functionArgs: resolveFunctionArgs, unresolved: false };
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
            if (
                ts.isParenthesizedExpression(e) ||
                ts.isNonNullExpression(e) ||
                ts.isAsExpression(e)
            ) {
                e = e.expression;
                continue;
            }
            if (ts.isSatisfiesExpression(e)) {
                e = e.expression;
                continue;
            }
            break;
        }
        return e;
    }

    function resolveFunctionValue(
        expr: ts.Expression,
    ): ReadonlyArray<FunctionInfo> {
        const e = unwrap(expr);
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

    // Whole-project analysis: every in-project, non-declaration source file (the
    // native Program does not expose the tsconfig root set, so filter its files to
    // the project tree). Every function is an entry and a boundary, so any uncaught
    // effect is reported wherever it is.
    function entryFiles(): ReadonlyArray<ts.SourceFile> {
        return sourceFiles.filter(
            (sf) =>
                !sf.isDeclarationFile &&
                !sf.fileName.replace(/\\/g, '/').includes('/node_modules/'),
        );
    }

    // --- build --------------------------------------------------------------

    for (const sf of entryFiles()) {
        for (const node of allFunctionLikesIn(sf)) {
            const info = intern(node);
            if (info) {
                boundaryIds.add(info.id);
            }
        }
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
                targets: core.targets,
                overlay: undefined,
                get functionArgs() { return core.functionArgs(); },
                unresolved: false,
            };
        }
        else {
            const overlay = core.symbol
                ? overlays.lookup(core.symbol, channel)
                : undefined;

            result = overlay ? {
                targets: [],
                overlay,
                get functionArgs() { return core.functionArgs(); },
                unresolved: false,
            } : {
                targets: [],
                overlay: undefined,
                get functionArgs() { return core.functionArgs(); },
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
        reachedFunctions() {
            return reachedList;
        },
        boundaries() {
            return boundaryIds;
        },
        calleesOf,
        resolveCall,
        resolveFunctionValue,
    };
}


export { buildCallGraph };
