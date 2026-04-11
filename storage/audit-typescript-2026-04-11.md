# Audit: @esportsplus/typescript

- **Status**: CONVERGED
- **Date**: 2026-04-11
- **Project**: @esportsplus/typescript
- **Runs**: 6 (all 5 categories converged)
- **Tests**: 101 passing across 7 test files

## Remaining Findings

#### F-003: Redundant SourceFile recreation in applyImports loop (DEFERRED)
- **File**: src/compiler/coordinator.ts
- **Symbol**: applyImports()
- **Category**: optimize
- **Evidence**: Lines 16-34 — `ts.createSourceFile()` called N-1 times between ImportIntents. Could batch by package to reduce re-parses.
- **Impact**: 15-25% improvement on transform hot path for multi-intent plugins.
- **Priority Score**: 44 (P1)
- **Status**: DEFERRED (recurring across 4 runs)

##### Spec

`applyImports` iterates over `ImportIntent[]` and calls `modify()` for each intent. After every intent except the last it re-parses the entire source via `ts.createSourceFile()` so the next `modify()` call gets accurate AST positions. When multiple intents target the **same package**, the intermediate re-parses are wasted because `modify()` already merges specifiers for a given package in a single pass.

**Approach — batch by package before iterating**:

1. Group `ImportIntent[]` by `intent.package` into a `Map<string, ImportIntent[]>`.
2. For each unique package, merge all `add` arrays, `remove` arrays, and `namespace` values from that group into a single `ModifyOptions`.
3. Call `modify()` once per unique package (not once per intent).
4. Re-parse between unique packages only (not between intents targeting the same package).

This reduces `ts.createSourceFile()` calls from `N-1` (where N = total intents) to `P-1` (where P = unique packages, typically 1-3).

**Implementation**:

```
function applyImports(code: string, file: ts.SourceFile, intents: ImportIntent[]): string {
    let merged = new Map<string, ModifyOptions>();

    for (let i = 0, n = intents.length; i < n; i++) {
        let intent = intents[i],
            existing = merged.get(intent.package);

        if (existing) {
            if (intent.add) {
                (existing.add ??= []).push(...intent.add);
            }
            if (intent.namespace) {
                existing.namespace = intent.namespace;
            }
            if (intent.remove) {
                (existing.remove ??= []).push(...intent.remove);
            }
        }
        else {
            merged.set(intent.package, {
                add: intent.add ? [...intent.add] : undefined,
                namespace: intent.namespace,
                remove: intent.remove ? [...intent.remove] : undefined
            });
        }
    }

    let keys = [...merged.keys()];

    for (let i = 0, n = keys.length; i < n; i++) {
        code = modify(code, file, keys[i], merged.get(keys[i])!);

        if (i < n - 1) {
            file = ts.createSourceFile(file.fileName, code, file.languageVersion, true);
        }
    }

    return code;
}
```

**Tests** — add to `tests/compiler/coordinator.test.ts`:

1. `batches multiple intents for the same package into one modify call` — 3 intents targeting `'@pkg/a'` with different specifiers → result contains single merged import statement, no duplicates.
2. `re-parses only between distinct packages` — 2 intents for `'@pkg/a'` + 1 for `'@pkg/b'` → code is correct with both imports present.
3. `merges add and remove for same package` — intent1 adds `foo`, intent2 removes `bar` on same package → result has `foo` but not `bar`.
4. `preserves namespace across merged intents` — intent1 sets namespace, intent2 adds specifiers on same package → both namespace import and named import present.

**Validation**: Run `pnpm test`, then benchmark with a 10-intent / 3-package scenario to verify reduced `createSourceFile` calls.

---

#### F-005: cli/tsc.ts has 0 test coverage (P2)
- **File**: src/cli/tsc.ts
- **Symbol**: build, isPlugin, loadPlugins, main, normalizePath, passthrough (internal)
- **Category**: coverage
- **Evidence**: CLI entry point with 6 internal functions, none exported. Core build logic (plugin loading, transform, emit) is untested. Hard to unit test (requires FS mocking, child process mocking).
- **Priority Score**: 35 (P2)

##### Spec

All functions in `cli/tsc.ts` are internal (`function` keyword, not exported). The file calls `main()` at the bottom as a side effect. Testing requires:

1. **Export the testable functions** — refactor to export `build`, `isPlugin`, `loadPlugins`, `normalizePath`, and `runTscAlias` as named exports (keep `main` and `passthrough` internal since they call `process.exit`).
2. **Guard the `main()` side effect** — wrap the bottom `main()` call so it only executes when the module is the entry point, not when imported by tests. Use an environment variable or check `import.meta.url` against `process.argv[1]`.
3. **Create `tests/cli/tsc.test.ts`**.

**Functions to test**:

`isPlugin(value)`:
1. Returns `true` for `{ transform: () => {} }`
2. Returns `false` for `null`
3. Returns `false` for `{}`
4. Returns `false` for `{ transform: 'not a function' }`
5. Returns `false` for primitives (string, number)

`normalizePath(fileName)`:
1. Converts backslashes to forward slashes (`C:\foo\bar` → `C:/foo/bar`)
2. Resolves relative paths to absolute
3. No-op on already-normalized paths

`loadPlugins(configs, root)`:
1. Loads a valid plugin module with `{ transform: fn }` export
2. Loads a plugin that exports a factory function returning `{ transform: fn }`
3. Loads a plugin that exports an array of plugins
4. Logs error and skips invalid plugin format (not `{ transform: fn }`)
5. Logs error and skips invalid array element
6. Resolves relative paths (`./ ` prefix) from root
7. Resolves package names via `require.resolve`

`build(config, tsconfig, pluginConfigs)`:
1. Transforms files and emits output (needs temp dir with valid tsconfig + source files)
2. Calls `process.exit(1)` on parse errors
3. Calls `process.exit(1)` on emit failure
4. Passes transformed code through custom compiler host

`runTscAlias(args)`:
1. Returns 0 immediately when args contain skip flags (`--noEmit`, `--help`, etc.)
2. Spawns `tsc-alias` for non-skip args

**Implementation approach**:

Step 1 — Make functions exportable without breaking CLI usage:

```typescript
// Bottom of cli/tsc.ts — replace bare `main()` call:
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
    main();
}

// Add named exports for testable functions:
export { build, isPlugin, loadPlugins, normalizePath, runTscAlias };
```

Step 2 — Create `tests/cli/tsc.test.ts` with mocks for `child_process.spawn`, `coordinator.transform`, and `ts.sys` filesystem operations. Use `vi.spyOn(process, 'exit').mockImplementation()` to catch exit calls.

Step 3 — Tests for `isPlugin` and `normalizePath` are pure functions, no mocking needed. Tests for `loadPlugins` need temp plugin files or `vi.mock` on dynamic imports. Tests for `build` need a temp directory with a real tsconfig.json and `.ts` files.

**Validation**: `pnpm test`, `pnpm tsc --noEmit`.
