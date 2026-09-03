import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';

import { createRequire, isBuiltin } from 'node:module';

// Only real JavaScript is scannable. `.node` native addons, `.json`, and pure
// `.d.ts` type packages carry no throw behavior we can read syntactically.
const SCANNABLE = new Set(['.cjs', '.js', '.mjs']);

// Resolve the installed backing `.js` for `(importerFileName, specifier)` using
// Node's own resolver (`exports` conditions, main field, workspace symlinks). A
// builtin (`node:*`), a native addon, a type-only package, or an unresolvable
// specifier yields undefined — the caller falls back to the built-in table or
// treats the call as effect-free.
function resolveBackingJs(
    importerFileName: string,
    specifier: string,
): string | undefined {
    if (isBuiltin(specifier)) {
        return undefined;
    }
    let resolved: string;
    try {
        resolved = createRequire(importerFileName).resolve(specifier);
    } catch {
        return undefined;
    }
    if (isBuiltin(resolved)) {
        return undefined;
    }
    if (!SCANNABLE.has(NodePath.extname(resolved).toLowerCase())) {
        return undefined;
    }
    try {
        return NodeFS.realpathSync(resolved);
    } catch {
        return resolved;
    }
}


export { resolveBackingJs };
