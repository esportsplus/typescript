import type * as ts from "~/tscheck/adapter";

// ---------------------------------------------------------------------------
// Function identity
// ---------------------------------------------------------------------------

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
export interface FunctionInfo {
  readonly id: string;
  readonly node: FunctionLike;
  readonly sourceFile: ts.SourceFile;
  // Best-effort human name for diagnostics ("<anonymous>" when there is none).
  readonly name: string;
  readonly fileName: string;
  // Node position of the function's name (or the function keyword) for links.
  readonly pos: number;
}

// ---------------------------------------------------------------------------
// Summary algebra (kernel-wide contract)
// ---------------------------------------------------------------------------

// Every channel summary is a plain lattice value `V` plus the kernel-standard
// conditional part: the set of this function's own parameter indices whose
// effect is inherited by callers (the "my effect includes whatever the function
// you passed at param 2 does" contract). One level of conditionality in v1.
export interface Summary<V> {
  readonly value: V;
  readonly fromCallbacks: ReadonlySet<number>;
}

export type Dispatch = "optimist" | "pessimist";

// ---------------------------------------------------------------------------
// Call resolution (kernel structure; the channel supplies the semantics)
// ---------------------------------------------------------------------------

// The kernel answers "who does this call reach and what function values flow
// into it"; the channel decides what those facts mean for its lattice `V`.
export interface CalleeResolution {
  // App functions with analyzable bodies this call can reach.
  readonly targets: ReadonlyArray<FunctionInfo>;
  // Overlay/preset model for a bodyless leaf (external/lib), when modeled.
  readonly overlay: OverlayLookup | undefined;
  // Function-valued arguments passed at this call, keyed by parameter index.
  // Powers one level of callback-conditional resolution.
  readonly functionArgs: ReadonlyMap<number, ReadonlyArray<FunctionInfo>>;
  // The callee could not be resolved (through `any`, an untracked function
  // value, or an abstract/overridable method). The channel degrades by the
  // dispatch knob when this is set and there is no overlay.
  readonly unresolved: boolean;
  // The unmodeled bodyless leaf's display name, when there is one and it is
  // neither resolved nor overlaid — the channel logs it as worklist material.
  readonly unmodeledLeaf: string | undefined;
}

// A per-channel overlay entry for one modeled symbol. `entry` is the raw
// channel-specific JSON (the throws channel reads `{ throws, throwsFromCallbacks }`).
export interface OverlayLookup {
  readonly pkg: string;
  readonly symbol: string;
  readonly entry: unknown;
}

// ---------------------------------------------------------------------------
// Channel plugin interface
// ---------------------------------------------------------------------------

// Context handed to `transfer`. Exposes the checker plus the kernel's structural
// services; all lattice semantics stay in the channel.
export interface TransferContext<V> {
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly fn: FunctionInfo;
  readonly dispatch: Dispatch;
  readonly channelConfig: unknown;
  readonly sinks: ReadonlyArray<SinkConfig>;
  // Current-iteration summary of a reachable callee (bottom until analyzed).
  summaryOf(fn: FunctionInfo): Summary<V>;
  // Resolve a call/new expression to targets + function args + overlay.
  resolveCall(call: ts.CallExpression | ts.NewExpression): CalleeResolution;
  // Resolve an expression used as a function value to the functions it may be.
  resolveFunctionValue(expr: ts.Expression): ReadonlyArray<FunctionInfo>;
  // Record an unmodeled bodyless leaf for the growth worklist.
  logUnmodeledLeaf(name: string): void;
}

// Context handed to `diagnose` after the fixpoint has converged. Same structural
// services, plus final summaries and the boundary chain for escape reporting.
export interface DiagnoseContext<V> {
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly fn: FunctionInfo;
  readonly dispatch: Dispatch;
  readonly channelConfig: unknown;
  readonly sinks: ReadonlyArray<SinkConfig>;
  // True when `fn` is an entry point or handler-boundary callback — the place
  // an escaping effect becomes a diagnostic.
  readonly isBoundary: boolean;
  summaryOf(fn: FunctionInfo): Summary<V>;
  resolveCall(call: ts.CallExpression | ts.NewExpression): CalleeResolution;
  resolveFunctionValue(expr: ts.Expression): ReadonlyArray<FunctionInfo>;
  // A path of functions from `fn` out to the nearest reaching boundary, for the
  // diagnostic's related-information chain.
  pathToBoundary(fn: FunctionInfo): ReadonlyArray<FunctionInfo>;
  // Call-graph roots: reached functions with no callers (the "tops of the stack").
  // A channel can use these plus `summaryOf` to tell whether an effect escapes all
  // the way up uncaught, or is handled by some ancestor.
  roots(): ReadonlyArray<FunctionInfo>;
}

// A channel is a plugin over the shared kernel. `V` is its lattice value type.
export interface Channel<V> {
  readonly name: string;
  readonly version: string;
  bottom(): V;
  join(a: V, b: V): V;
  // Convergence test for the fixpoint; `true` when `next` adds nothing to `prev`.
  equals(a: V, b: V): boolean;
  // Termination guard: fold `next` toward top after repeated growth. `round` is
  // the current SCC iteration count.
  widen(prev: V, next: V, round: number): V;
  // Analyze one function body against current callee summaries.
  transfer(ctx: TransferContext<V>): Summary<V>;
  // Emit diagnostics for one function once summaries are final.
  diagnose(ctx: DiagnoseContext<V>): ReadonlyArray<Diagnostic>;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface SourceLocation {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly pos: number;
  readonly end: number;
}

export interface DiagnosticRelated {
  readonly message: string;
  readonly location: SourceLocation;
}

export interface Diagnostic {
  readonly channel: string;
  readonly message: string;
  readonly location: SourceLocation;
  // The escape chain (throw/acquire site → boundary), as related locations.
  readonly related: ReadonlyArray<DiagnosticRelated>;
}

// ---------------------------------------------------------------------------
// Config (shared kernel concepts; channel sections are opaque here)
// ---------------------------------------------------------------------------

export interface HandlerBoundary {
  // Declaration-identity selector, e.g. "express.Router#get".
  readonly callee: string;
  // Which argument positions are the analyzed callbacks.
  readonly callbackArgs: ReadonlyArray<number>;
}

// A configured absorber: a call under which effects are discharged. `absorbs`
// restricts to a channel-declared subset; absent means "absorbs everything".
export interface SinkConfig {
  readonly callee: string;
  readonly absorbs: ReadonlyArray<string> | undefined;
}

export interface ChannelConfig {
  readonly enabled: boolean;
  readonly dispatch: Dispatch;
  // Raw channel-specific options, validated by the channel.
  readonly options: unknown;
}

export interface TscheckConfig {
  readonly projectRoot: string;
  readonly tsconfigPath: string;
  readonly entryPoints: ReadonlyArray<string>;
  readonly handlerBoundaries: ReadonlyArray<HandlerBoundary>;
  readonly sinks: ReadonlyArray<SinkConfig>;
  readonly presets: ReadonlyArray<string>;
  readonly overlays: ReadonlyArray<string>;
  readonly channels: Readonly<Record<string, ChannelConfig>>;
  // CLI/build gate: when true, a run with findings exits nonzero.
  readonly failOnFindings: boolean;
  // Editor squiggle severity. Findings surface as errors unless the tsconfig
  // plugin entry opts down with "severity": "warn". Ignored by the CLI gate.
  readonly severity: "error" | "warning";
}

// ---------------------------------------------------------------------------
// Overlay set (implemented by src/overlay; consumed by graph + channels)
// ---------------------------------------------------------------------------

// The merged overlay+preset database. Lookups are by resolved symbol so name
// collisions across libraries never alias.
export interface OverlaySet {
  // The modeled entry for a symbol, if any, scoped to one channel section.
  lookup(symbol: ts.Symbol, checker: ts.TypeChecker, channel: string): OverlayLookup | undefined;
}

// ---------------------------------------------------------------------------
// Call graph (implemented by src/kernel/graph; consumed by the fixpoint engine)
// ---------------------------------------------------------------------------

export interface CallGraph {
  // Every function reached from the configured entry points + boundaries.
  reachedFunctions(): ReadonlyArray<FunctionInfo>;
  // Entry points and handler-boundary callbacks — where escapes become findings.
  boundaries(): ReadonlySet<string>;
  // App-function callees of `fn` (call-graph edges; excludes overlay leaves).
  calleesOf(fn: FunctionInfo): ReadonlyArray<FunctionInfo>;
  // Look up a reached function by node identity, if it is in the graph.
  functionAt(node: FunctionLike): FunctionInfo | undefined;
  // Structural resolution of one call site (targets, function args, overlay).
  resolveCall(
    call: ts.CallExpression | ts.NewExpression,
    channel: string,
  ): CalleeResolution;
  // Resolve an expression used as a function value to reached functions.
  resolveFunctionValue(expr: ts.Expression): ReadonlyArray<FunctionInfo>;
}

// ---------------------------------------------------------------------------
// Fixpoint engine result (implemented by src/kernel/fixpoint)
// ---------------------------------------------------------------------------

export interface SummaryStore<V> {
  get(id: string): Summary<V>;
}

// One built, ready-to-analyze program: the host Program, checker, resolved
// config, merged overlays, and the reachability graph.
export interface Analysis {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly config: TscheckConfig;
  readonly overlays: OverlaySet;
  readonly graph: CallGraph;
}
