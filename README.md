# @esportsplus/typescript

TypeScript compiler plugin framework with coordinated AST transformations, import management, and build tool integration.

## Install

```bash
pnpm add @esportsplus/typescript
```

## Overview

Extends the TypeScript compiler with a plugin architecture for custom AST transformations. Plugins receive type-checked AST nodes with accurate positions at every stage, return declarative intents (replacements, imports, prepends), and the coordinator applies them in the correct order.

**Key features:**
- Multi-plugin coordination with fresh AST positions between stages
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
                    generate: (sf) => `transformedCode()`
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

### CLI

```bash
# Compiles with plugins from tsconfig.json, then resolves path aliases
tsc
```

The CLI detects plugins in `tsconfig.json` `compilerOptions.plugins`, loads them, runs coordinated compilation, and automatically calls `tsc-alias` afterward. The package installs `tsc`/`tsc-alias` bins (also under the unambiguous `esportsplus-tsc`/`esportsplus-tsc-alias` names).

## analyze

`analyze` is a static analyzer for effects TypeScript's types leave implicit. It runs a per-function summary fixpoint over the call graph — so a finding points at the *consumer*, the call site where a caller should be careful — and is organised into **channels**, each checking one class of effect:

- **`exceptions`** — calls that may throw with no `catch` on the path to a handler boundary, `@throws` under-declaration, and `catch` rethrows that drop the caught error's `cause`. Carries the throw origin as related information.
- **`resources`** — acquired resources (timers, event listeners, file handles, sockets, `Disposable`s, …) that can leak: not released, transferred, or `using`-bound on every path — including throwing paths, which it derives from the `exceptions` channel's summaries.
- **`async`** — unbounded `Promise.all(…)`-style fan-out, orphaned promises whose rejections go unhandled, and awaited cancellable calls that drop an `AbortSignal` the function holds.

Only `exceptions` is on by default; enable the others per project. It rides the `tsc` passthrough (build/CI), and ships an LSP server so editors can render the same findings.

### Enable

Add an `analyze` entry to `compilerOptions.plugins`. Analysis covers every file the tsconfig includes (ignoring excludes); no config beyond the entry is required.

```jsonc
{
    "compilerOptions": {
        "plugins": [
            {
                "name": "ts-probe",
                // Editor squiggle color; "warn" opts down. CLI/build ignore this.
                "severity": "error",
                // Fail the tsc/build run when there are findings.
                "failOnFindings": true,
                // Per-channel config. `enabled` and `dispatch` are recognised on
                // every channel; other keys are that channel's own options.
                "channels": {
                    "exceptions": {
                        "enabled": true,
                        // "consumers" (default): uncaught calls only.
                        // "cross-module": only when the throwing callee is in another package.
                        // "all": throws AND uncaught calls.
                        "report": "consumers",
                        // Flag `throw`s inside `catch` that drop the caught error's cause.
                        "errorCause": true
                    },
                    "resources": {
                        "enabled": true,
                        // Untrackable handling when a resource escapes local analysis:
                        // "optimist" assumes transfer (silent), "pessimist" reports it.
                        "dispatch": "optimist",
                        // Calls that take ownership of a passed resource argument.
                        "ownership": [{ "callee": "registerCleanup", "params": [0] }]
                    },
                    "async": {
                        "enabled": true,
                        "fanOut": "warn",                     // "off" | "warn" | "error"
                        "fanOutAllowLiteralUpTo": 16,         // inline array/tuple size that is fine
                        "poolFunctions": ["p-limit", "p-map"] // sanctioned concurrency wrappers
                    }
                },
                // Model third-party throw behavior: "node", "express".
                "presets": ["node"]
            }
        ]
    }
}
```

### CLI / build

The `tsc` passthrough runs analyze after a successful compile and prints findings to stderr. With `failOnFindings: true`, a run with findings exits non-zero — drop it into CI as a gate.

```bash
tsc   # compiles, resolves aliases, then reports analyze findings
```

### Editor (LSP)

The package ships a standalone language server (`esportsplus-tsc-lsp` bin, or the `@esportsplus/typescript/lsp` export) that publishes analyze findings over LSP. A client spawns it beside the native TypeScript server and merges both diagnostic streams; `severity` drives the squiggle color. Analysis runs against saved files on open and save. Beyond diagnostics it serves **hovers** (the finding plus its origin→boundary chain) and **quick-fixes** — `void`/`await` an orphaned promise, forward an `AbortSignal`, or fix a leaked handle by converting it to `using` or wrapping the region in `try/finally`.

```typescript
import { startServer } from '@esportsplus/typescript/lsp';

startServer(); // stdio LSP server
```

## API

### `@esportsplus/typescript`

No exports. Import the TypeScript compiler API directly from `typescript/unstable/*` (see [TypeScript 7 migration](#typescript-7-migration)).

### `@esportsplus/typescript/compiler`

| Export | Description |
|---|---|
| `ast` | AST utilities — expression names, property paths, node testing |
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
    patterns?: string[];
    transform: (ctx: TransformContext) => TransformResult;
};

type TransformContext = {
    checker: ts.TypeChecker;
    code: string;
    program: ts.Program;
    shared: SharedContext;
    sourceFile: ts.SourceFile;
};

type TransformResult = {
    imports?: ImportIntent[];
    prepend?: string[];
    replacements?: ReplacementIntent[];
};

type ImportIntent = {
    add?: string[];
    namespace?: string;
    package: string;
    remove?: string[];
};

type ReplacementIntent = {
    generate: (sourceFile: ts.SourceFile) => string;
    node: ts.Node;
};
```

## Shared Config

Importable base tsconfig files:

```json
{ "extends": "@esportsplus/typescript/tsconfig.browser.json" }
{ "extends": "@esportsplus/typescript/tsconfig.node.json" }
{ "extends": "@esportsplus/typescript/tsconfig.package.json" }
```

## TypeScript 7 migration

This package targets `typescript@^7`, shipped as a regular `dependencies` entry. Breaking changes for consumers:

- **Root export removed.** `@esportsplus/typescript` no longer re-exports `ts`. Import the compiler API directly from the `typescript/unstable/*` subpaths you need — `typescript/unstable/ast`, `typescript/unstable/ast/is`, `typescript/unstable/sync`, `typescript/unstable/fs`, etc.
- **Plugin-facing types.** `TransformContext` and `ReplacementIntent` now carry `typescript/unstable/ast` + `typescript/unstable/sync` identities instead of the classic `ts` namespace types.
- **`coordinator.transform` signature.** Takes the `{ checker, program }` project pair instead of a single `ts.Program`.
- **`imports.includes` signature.** Takes the API `Checker` type, and symbol declarations are represented as NodeHandles rather than `ts.Node`.

## Scripts

```bash
pnpm build       # tsc && tsc-alias
pnpm test        # vitest run
pnpm bench:run   # vitest bench --run
```