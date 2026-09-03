import type * as ts from '~/guard/adapter';
// Function identity

// Every function-like node the kernel can treat as a call-graph node. Entry
// points, callbacks promoted to boundaries, methods, and plain declarations all
// collapse to this union.
export type FunctionLike =
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.ConstructorDeclaration;

// A reached function in the call graph. `id` is stable across a run and is the
// key everything else (summaries, cache, diagnostics) hangs off of.
type FunctionInfo  = {
    readonly id: string;
    readonly node: FunctionLike;
    readonly sourceFile: ts.SourceFile;
    // Best-effort human name for diagnostics ("<anonymous>" when there is none).
    readonly name: string;
    readonly fileName: string;
};
// Summary algebra (kernel-wide contract)

// Every channel summary is a plain lattice value `V` plus the kernel-standard
// conditional part: the set of this function's own parameter indices whose
// effect is inherited by callers (the "my effect includes whatever the function
// you passed at param 2 does" contract). One level of conditionality in v1.
type Summary<V>  = {
    readonly value: V;
    readonly fromCallbacks: ReadonlySet<number>;
};

// Per-channel report/gate level. `error` reports and fails the build for the
// channel; `warn` reports without failing; `off` skips the channel (except as a
// silent peer whose summaries an enabled channel depends on).
export type Severity = 'error' | 'info' | 'off' | 'warn';
// Call resolution (kernel structure; the channel supplies the semantics)

// The kernel answers "who does this call reach and what function values flow
// into it"; the channel decides what those facts mean for its lattice `V`.
type CalleeResolution  = {
    // App functions with analyzable bodies this call can reach.
    readonly targets: ReadonlyArray<FunctionInfo>;
    // Overlay/preset model for a bodyless leaf (external/lib), when modeled.
    readonly overlay: OverlayLookup | undefined;
    // Function-valued arguments passed at this call, keyed by parameter index.
    // Powers one level of callback-conditional resolution.
    readonly functionArgs: ReadonlyMap<number, ReadonlyArray<FunctionInfo>>;
    // The callee could not be pinned to a declaration (through `any`, an
    // untracked function value, or an abstract/overridable method).
    readonly unresolved: boolean;
};

// A per-channel overlay entry for one modeled symbol. `entry` is the raw
// channel-specific JSON (the exceptions channel reads `{ exceptions, exceptionsFromCallbacks }`).
type OverlayLookup  = {
    readonly pkg: string;
    readonly symbol: string;
    readonly entry: unknown;
};
// Channel plugin interface

// Context handed to `transfer`. Exposes the checker plus the kernel's structural
// services; all lattice semantics stay in the channel.
type TransferContext<V>  = {
    readonly checker: ts.TypeChecker;
    readonly fn: FunctionInfo;
    // Current-iteration summary of a reachable callee (bottom until analyzed).
    summaryOf(fn: FunctionInfo): Summary<V>;
    // Resolve a call/new expression to targets + function args + overlay.
    resolveCall(call: ts.CallExpression | ts.NewExpression): CalleeResolution;
    // Resolve a call against a named peer channel's overlay section — targets are
    // channel-independent; only the overlay layer differs.
    resolveCallFor(
        channel: string,
        call: ts.CallExpression | ts.NewExpression,
    ): CalleeResolution;
    // Converged summary value of a peer channel for a function id, or undefined
    // when that peer channel did not run (peer dependencies are optional).
    peerSummaryValue(channel: string, fnId: string): unknown;
};

// Context handed to `diagnose` after the fixpoint has converged.
type DiagnoseContext<V>  = {
    readonly checker: ts.TypeChecker;
    readonly fn: FunctionInfo;
    readonly channelConfig: unknown;
    summaryOf(fn: FunctionInfo): Summary<V>;
    resolveCall(call: ts.CallExpression | ts.NewExpression): CalleeResolution;
    resolveCallFor(
        channel: string,
        call: ts.CallExpression | ts.NewExpression,
    ): CalleeResolution;
    peerSummaryValue(channel: string, fnId: string): unknown;
    // Call-graph roots: reached functions with no callers (the "tops of the stack").
    // A channel can use these plus `summaryOf` to tell whether an effect escapes all
    // the way up uncaught, or is handled by some ancestor.
    roots(): ReadonlyArray<FunctionInfo>;
};

// A channel is a plugin over the shared kernel. `V` is its lattice value type.
type Channel<V>  = {
    readonly name: string;
    // Peer channels whose summaries this channel reads; the kernel runs them first
    // when they are enabled. Optional — a disabled peer is absent, not an error.
    readonly dependsOn?: ReadonlyArray<string>;
    bottom(): V;
    // Convergence test for the fixpoint; `true` when `next` adds nothing to `prev`.
    equals(a: V, b: V): boolean;
    // Termination guard: fold `next` toward top after repeated growth. `round` is
    // the current SCC iteration count.
    widen(prev: V, next: V, round: number): V;
    // Analyze one function body against current callee summaries.
    transfer(ctx: TransferContext<V>): Summary<V>;
    // Emit diagnostics for one function once summaries are final.
    diagnose(ctx: DiagnoseContext<V>): ReadonlyArray<Diagnostic>;
};
// Diagnostics

type SourceLocation  = {
    readonly fileName: string;
    readonly line: number;
    readonly column: number;
    readonly pos: number;
    readonly end: number;
};

type DiagnosticRelated  = {
    readonly message: string;
    readonly location: SourceLocation;
};

// A single text replacement a quick-fix applies. `pos === end` is an insertion.
type DiagnosticEdit  = {
    readonly fileName: string;
    readonly pos: number;
    readonly end: number;
    readonly newText: string;
};

// An offered quick-fix: a title and the edits that apply it. Authored by the
// channel (which holds the AST); surfaced by the editor as a code action.
type DiagnosticFix  = {
    readonly title: string;
    readonly edits: ReadonlyArray<DiagnosticEdit>;
};

type Diagnostic  = {
    readonly channel: string;
    readonly message: string;
    readonly location: SourceLocation;
    // The escape chain (throw/acquire site → boundary), as related locations.
    readonly related: ReadonlyArray<DiagnosticRelated>;
    // Quick-fixes the editor can apply; omitted when none is offered.
    readonly fixes?: ReadonlyArray<DiagnosticFix>;
};
// Config (shared kernel concepts; channel sections are opaque here)

type ChannelConfig  = {
    // Report/gate level. `enabled` (run at all) is `severity !== 'off'`; the
    // build-failing gate is `severity === 'error'`.
    readonly severity: Severity;
    // Raw channel-specific options, validated by the channel.
    readonly options: unknown;
};

type AnalyzeConfig  = {
    readonly projectRoot: string;
    readonly tsconfigPath: string;
    // Every channel name maps to its config; an absent channel is `severity: 'off'`.
    readonly channels: Readonly<Record<string, ChannelConfig>>;
};
// Overlay set (implemented by src/overlay; consumed by graph + channels)

// The merged overlay+preset database. Lookups are by resolved symbol so name
// collisions across libraries never alias.
type OverlaySet  = {
    // The modeled entry for a symbol, if any, scoped to one channel section.
    lookup(symbol: ts.Symbol, channel: string): OverlayLookup | undefined;
};
// Call graph (implemented by src/kernel/graph; consumed by the fixpoint engine)

type CallGraph  = {
    // Every function reached from the configured entry points.
    reachedFunctions(): ReadonlyArray<FunctionInfo>;
    // App-function callees of `fn` (call-graph edges; excludes overlay leaves).
    calleesOf(fn: FunctionInfo): ReadonlyArray<FunctionInfo>;
    // Structural resolution of one call site (targets, function args, overlay).
    resolveCall(
        call: ts.CallExpression | ts.NewExpression,
        channel: string,
    ): CalleeResolution;
};
// Fixpoint engine result (implemented by src/kernel/fixpoint)

type SummaryStore<V>  = {
    get(id: string): Summary<V>;
};

// One built, ready-to-analyze program: checker and reachability graph.
type Analysis  = {
    readonly checker: ts.TypeChecker;
    readonly graph: CallGraph;
};


export { type Analysis, type AnalyzeConfig, type CallGraph, type CalleeResolution, type Channel, type ChannelConfig, type DiagnoseContext, type Diagnostic, type DiagnosticEdit, type DiagnosticFix, type DiagnosticRelated, type FunctionInfo, type OverlayLookup, type OverlaySet, type SourceLocation, type Summary, type SummaryStore, type TransferContext };
