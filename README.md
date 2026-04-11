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

The CLI detects plugins in `tsconfig.json` `compilerOptions.plugins`, loads them, runs coordinated compilation, and automatically calls `tsc-alias` afterward.

## API

### `@esportsplus/typescript`

Re-exports the TypeScript compiler API (`ts`).

### `@esportsplus/typescript/compiler`

| Export | Description |
|---|---|
| `ast` | AST utilities — expression names, property paths, node testing |
| `code` | Template literal code generation with escaping |
| `coordinator` | Multi-plugin transformation orchestrator |
| `imports` | Import detection and modification (WeakMap cached) |
| `plugin` | Built-in plugins (`tsc`, `vite`) |
| `uid` | Unique identifier generation |
| `languageService` | Cached TypeScript language service |

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

## Scripts

```bash
pnpm build       # tsc && tsc-alias
pnpm test        # vitest run
pnpm bench:run   # vitest bench --run
```