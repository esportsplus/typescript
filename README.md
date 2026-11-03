# @esportsplus/typescript

TypeScript compiler plugin framework with coordinated AST transformations, import management, and build tool integration.

## Install

```bash
pnpm add @esportsplus/typescript
```

## Overview

Extends the TypeScript compiler with a plugin architecture for custom AST transformations. Every plugin analyses the same type-checked program and returns declarative intents (replacements, imports, prepends) against its AST; the coordinator composes them in one pass.

**Key features:**
- Multi-plugin composition on one program: nested replacements from different plugins compose, no second program per stage
- Declarative import management (add/remove specifiers, namespace imports)
- Vite plugin for dev/build integration
- CLI wrapper for `tsc` with automatic plugin detection
- Language service caching for incremental compilation
- `analyze` throw-safety analysis on the `tsc` passthrough and over LSP

## Usage

### Plugin

```typescript
import type { Plugin } from '@esportsplus/typescript/compiler';

let plugin: Plugin = {
    // Optional: skip files that don't contain these strings
    patterns: ['myFunction'],

    transform({ checker, code, sourceFile, shared }) {
        // Return declarative transformation intents
        return {
            imports: [
                { package: 'my-lib', add: ['helper'], remove: ['deprecated'] }
            ],
            prepend: [
                'let __cache = new Map();'
            ],
            replacements: [
                {
                    node: someAstNode,
                    // text(node): the node's source with every nested replacement applied
                    generate: (sf, text) => `transformed(${text(someAstNode)})`
                }
            ]
        };
    }
};
```

### Vite

```typescript
import { plugin } from '@esportsplus/typescript/compiler';

export default defineConfig({
    plugins: [
        plugin.vite({
            name: 'my-transforms',
            plugins: [myPlugin]
        })
    ]
});
```

The returned plugin's `transform` is the object form (`{ filter, handler }`): Rolldown applies `filter` natively (`.[cm]?[tj]sx?` ids, excluding `node_modules` and `\0` virtual modules), so other modules never call into JavaScript. A wrapper that delegates to it calls `transform.handler(code, id)`.

- **Build cache.** During `vite build`, results are cached by host `name`, root, module id and content hash, process-wide, so every instance of a host (from one factory or from a fresh `plugin.vite(...)` call per instance) shares them and a nested build (a worker bundle re-transforming the main graph's modules) costs a hash per module. Serving never caches; HMR invalidation covers that path.
- **Nested builds.** The language service is disposed when the outermost build closes, not when a nested build does.
- **Processes.** A build runs at most two tsgo processes: one per project (every plugin analyses its program) and the lazily started scratch parser for files outside it.
- **`shared` invalidation.** On a file change the host drops only the changed module's state: its cached result, the results of modules compiled against it, and the `shared` entries keyed by those modules' paths (`sourceFile.fileName`). Other `shared` entries live as long as the host.

### CLI

```bash
# Compiles with plugins from tsconfig.json
tsc
```

The CLI detects plugins in `tsconfig.json` `compilerOptions.plugins`, loads them and runs coordinated compilation. The package installs a `tsc` bin (also under the unambiguous `esportsplus-tsc` name).

The wrapper does **not** rewrite path aliases (`tsc-alias` and its bins were removed): emit keeps every specifier verbatim, declarations included. In a package that emits, every import in `src` — `import type` too — must be relative; `~/` aliases are for code that is never emitted (tests, benches, apps bundled by Vite).

## analyze

`analyze` is a static analyzer for effects TypeScript's types leave implicit. It runs a per-function summary fixpoint over the call graph — so a finding points at the *consumer*, the call site where a caller should be careful — and is organised into **channels**, each checking one class of effect:

- **`exceptions`** — calls that may throw with no `catch` on the path to a handler boundary, `@throws` under-declaration, and `catch` rethrows that drop the caught error's `cause`. Carries the throw origin as related information.
- **`resources`** — acquired resources (timers, event listeners, file handles, sockets, `Disposable`s, …) that can leak: not released, transferred, or `using`-bound on every path — including throwing paths, which it derives from the `exceptions` channel's summaries.
- **`async`** — unbounded `Promise.all(…)`-style fan-out, orphaned promises whose rejections go unhandled, and awaited cancellable calls that drop an `AbortSignal` the function holds.

Only channels you configure run; a channel is otherwise off. It rides the `tsc` passthrough (build/CI), and ships an LSP server so editors can render the same findings.

### Enable

Add a top-level `tsc-guard` key to `tsconfig.json` (a sibling of `compilerOptions`). Analysis is always whole-project and covers every file the tsconfig includes (ignoring excludes). Its only root keys are the channel names — `exceptions`, `resources`, and `async` — with no `channels` wrapper. An absent channel is off; a present channel with no `severity` is `error`. Consequently, a bare `"tsc-guard": {}` analyzes nothing: the minimum useful config is the three-line per-channel shape below.

Unlike `compilerOptions.plugins` — which `extends` **replaces** wholesale — `tsc-guard` is **deep-merged down the `extends` chain**: a shared base can carry the defaults and a package override a single channel key (e.g. `tsc-guard.exceptions.report`) without restating the rest. Set an inherited key to `null` to delete it.

`enabled`, top-level `severity`/`failOnFindings`, `presets`, `overlays`, `sinks`, `handlerBoundaries`, `entryPoints`, and the `channels` wrapper are removed; leaving one in the config fails the build with a diagnostic naming its replacement. Platform effect models (Node/DOM globals, `node:fs`, and so on) are built in, so there is nothing to select. `dispatch` is recognised on every channel.

```jsonc
{
    "compilerOptions": { /* … */ },
    "tsc-guard": {
        "exceptions": {
            "severity": "error",            // "error" reports + fails the build; "warn"/"info" report only; "off" skips
            // "consumers": uncaught calls only, when the throwing callee is in another PACKAGE.
            // "cross-module": like "consumers" but the boundary is the FILE.
            // "all": throws AND every uncaught call.
            "report": "cross-module"         // "consumers" | "cross-module" | "all"
        },
        "resources": { "severity": "error" },
        "async":     { "severity": "warn" }
    }
}
```

Each channel's `severity` is `"error"`, `"warn"`, `"info"`, or `"off"` — `error` reports and fails the build; `warn`/`info` report without gating (a `warn` squiggle vs a subtler `info` one in the editor); `off` skips the channel. The only remaining channel option is `exceptions.report` (`"consumers"` | `"cross-module"` | `"all"`, default `"consumers"`). Everything else is inferred from the code and unconditional: the exceptions channel traces third-party throws from the installed `.js` and flags the catch-`{ cause }` smell; the resources channel infers ownership by tracing releases/transfers and reports any resource that escapes somewhere untrackable; the async channel flags orphaned promises, dropped `AbortSignal`s, and `Promise.all`/`race`/… over a **dynamically-sized** input (a statically-sized array literal or fixed tuple is always fine).

### CLI / build

The `tsc` wrapper checks each project once: it opens one API program, runs analyze and gathers the compiler's diagnostics from it, then emits with `tsc.js --noCheck` (a project with transformer plugins first transforms its files and checks the transformed program). `tsc.js` checks on its own only when the invocation is something the API program cannot honor: no tsconfig, informational flags, `--watch`, or compiler flags on the command line. Findings print to stderr.

Analyze's findings are cached under `node_modules/.cache/@esportsplus/typescript/guard/`, one entry per tsconfig, keyed by every file the program reads, the guard config, the lockfile and this package's own build; any change re-runs the whole analysis, an unchanged project costs a hash. `ESPORTSPLUS_ANALYZE_CACHE=0` disables the cache; `ESPORTSPLUS_TIMINGS=1` prints how long each phase took (open, analyze per channel, transform, diagnostics, emit).

The wrapper exits non-zero (`1`) when any finding is in a channel whose `severity` is `"error"`; `warn` channels never fail the build. A rejected or removed config key is a hard error and also exits `1`.

```bash
tsc   # compiles, then reports analyze findings
```

### Editor (LSP)

The package ships a standalone language server (`esportsplus-tsc-lsp` bin, or the `@esportsplus/typescript/lsp` export) that publishes analyze findings over LSP. It runs as a *second* server **beside** the TypeScript language server — it is not a tsserver plugin — and the editor merges both diagnostic streams; each finding's squiggle color comes from its own channel's `severity`. Analysis runs against saved files on open and save. Beyond diagnostics it serves **hovers** (the finding plus its origin→boundary chain) and **quick-fixes** — `void`/`await` an orphaned promise, forward an `AbortSignal`, or fix a leaked handle by converting it to `using` or wrapping the region in `try/finally`.

Wiring it up:

- **Config-driven LSP editors** (Neovim, Emacs, Helix, Zed, Sublime LSP): register `esportsplus-tsc-lsp` as an additional server for `typescript`/`typescriptreact`. It attaches to the same buffers as the TypeScript server; no tsconfig change.
- **VS Code**: install the client extension under [`editor/vscode`](editor/vscode) — it resolves and spawns the server from the workspace's own install.

```typescript
import { startServer } from '@esportsplus/typescript/lsp';

startServer(); // stdio LSP server
```

### Accepted false negatives

- A library function that returns a resource the caller must release (for example, `db.connect()` → `.close()`) is not modeled unless it is in the built-in table.
- Third-party throws are derived by syntactically reading installed `.js`; cross-file/transitive throws beyond a small depth, dynamically dispatched calls, and non-standard export shapes are missed (optimistically, without false positives).
- Backing `.js` files that are minified or larger than 512 KiB are skipped.
- A bare `"tsc-guard": {}` is inert.

## API

### `@esportsplus/typescript`

| Export | Description |
|---|---|
| `ts` | The vended compiler API: `typescript/unstable/ast` and `typescript/unstable/sync` as one namespace, so consumer packages pin no `typescript` of their own |

### `@esportsplus/typescript/compiler`

| Export | Description |
|---|---|
| `ast` | AST utilities — expression names, property paths, node testing |
| `checker` | `checker.cached(checker, program?)`: memoizing checker proxy, one cache per program; type-keyed queries (`isArrayType`, `isTupleType`, `getPropertyOfType`, `getNonNullableType`, `getBaseConstraintOfType`, `getSignaturesOfType`, `getTypeArguments`, `isTypeAssignableTo`) are keyed by `type.id`, stable within a snapshot; `getSymbolAtLocation(nodes[])` / `getTypeAtLocation(nodes[])` send only cache misses. `coordinator.transform` already hands plugins this proxy as `ctx.checker` |
| `code` | Template literal code generation with escaping |
| `coordinator` | Multi-plugin transformation orchestrator |
| `imports` | Import detection and modification (WeakMap cached) |
| `plugin` | Built-in plugins (`tsc`, `vite`) |
| `uid` | Unique identifier generation |

### `@esportsplus/typescript/lsp`

| Export | Description |
|---|---|
| `startServer` | Start the stdio analyze LSP server |
| `createServer` | Wire the server onto an existing JSON-RPC connection |
| `AnalyzeWorkspace` | Long-lived native session that re-runs the analysis |

### Types

```typescript
type Plugin = {
    name?: string;                     // names the plugin in coordinator errors
    patterns?: string[];               // tested against the original source
    transform: (ctx: TransformContext) => TransformResult;
};

type TransformContext = {
    checker: Checker;                  // memoized per program (checker.cached), shared by every plugin
    code: string;                      // the original source, for every plugin
    program: Program;
    shared: SharedContext;
    sourceFile: SourceFile;            // the original AST, for every plugin
};

type TransformResult = {
    dependencies?: string[];
    imports?: ImportIntent[];
    prepend?: Prepend[];               // string | ((text: (node: Node) => string) => string)
    replacements?: ReplacementIntent[];
};

type ImportIntent = {
    add?: string[];
    namespace?: string;
    package: string;
    remove?: string[];
};

type ReplacementIntent = {
    generate: (sourceFile: SourceFile, text: (node: Node) => string) => string;
    node: Node;
};
```

**Composition.** All plugins' replacements are placed by range against the original source and applied in one generation. A replacement inside another nests: the outer intent's `text(node)` returns `node`'s source with every replacement inside it (from any plugin, or the same plugin's other intents) already applied, so any expression a generator copies into its output must be read with `text()`, not `node.getText()` (which returns the original source and drops nested replacements). On two equal ranges the ancestor node, then the later plugin, is outer. Ranges that overlap without nesting fail the transform naming both plugins. **Order is a contract:** (1) every plugin's `transform()` runs on the original program; (2) all replacements compose in one generation, running every `generate()`; (3) then, plugin by plugin, its `prepend` entries are inserted after the opening imports and its `imports` intents applied. A `prepend` entry may be a function: it is called in step 3 with the same `text()` helper, so it can read sources other plugins rewrote and anything this plugin's generators recorded (hoisted handlers, template factories). Plain strings work as before. There is no staged second program: a later plugin never sees an earlier plugin's output.

## Shared Config

Importable base tsconfig files, one per target:

```json
{ "extends": "@esportsplus/typescript/tsconfig.browser.json" }
{ "extends": "@esportsplus/typescript/tsconfig.node.json" }
{ "extends": "@esportsplus/typescript/tsconfig.package.json" }
```

Each target also ships a `.dev` variant that extends its build config, sets `noEmit` with `rootDir` at the config dir, and widens `include` to the whole repo (`src`, `test`, `bench`, `*.config.ts`) — for editor and full-typecheck passes over everything, not just the emitted sources:

```json
{ "extends": "@esportsplus/typescript/tsconfig.browser.dev.json" }
{ "extends": "@esportsplus/typescript/tsconfig.node.dev.json" }
{ "extends": "@esportsplus/typescript/tsconfig.package.dev.json" }
```

`tsconfig.package.dev.json` additionally sets `tsc-guard` to `warn` for `exceptions` and `resources`, so the analyzer reports over your sources during development without failing the typecheck.

### Lint

`oxlintrc.json` is the shared [oxlint](https://oxc.rs/docs/guide/usage/linter) config: the correctness category plus the house rules (`sort-imports` for members within braces, `sort-keys`) and type-aware TypeScript rules (`no-floating-promises`, `no-misused-promises`, `await-thenable`; tsgo-backed through `oxlint-tsgolint`). `no-unused-vars` is off: `noUnusedLocals`/`noUnusedParameters` already gate it. Install `oxlint` and `oxlint-tsgolint` and extend it:

```jsonc
// oxlintrc.json
{ "extends": ["./node_modules/@esportsplus/typescript/oxlintrc.json"] }
```

```json
{ "scripts": { "lint": "oxlint -c oxlintrc.json --type-aware --deny-warnings" } }
```

The shared publish workflow runs `pnpm run lint` (when defined) before `verify`. No formatter is shipped: oxfmt's Prettier-compatible output conflicts with the double blank lines between file sections.

## TypeScript 7 migration

This package targets `typescript@^7`, shipped as a regular `dependencies` entry. Breaking changes for consumers:

- **`ts` is the TypeScript 7 API.** The root `ts` export is `typescript/unstable/ast` + `typescript/unstable/sync`, not the classic compiler namespace; type guards live in `typescript/unstable/ast/is`.
- **Plugin-facing types.** `TransformContext` and `ReplacementIntent` now carry `typescript/unstable/ast` + `typescript/unstable/sync` identities instead of the classic `ts` namespace types.
- **`coordinator.transform` signature.** Takes the `{ checker, program }` project pair instead of a single `ts.Program`.
- **`imports.includes` signature.** Takes the API `Checker` type, and symbol declarations are represented as NodeHandles rather than `ts.Node`.

## Scripts

```bash
pnpm build       # tsc -p tsconfig.package.json
pnpm test        # vitest run
pnpm bench:run   # vitest bench --run
```
