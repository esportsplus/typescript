import * as ts from '~/probe/adapter';

// One `throw` site a type escaped from: enough to render and jump to it inline.
export interface ExceptionOrigin {
    readonly fileName: string;
    readonly pos: number;
    readonly end: number;
    readonly line: number; // 1-based
    readonly column: number; // 1-based
    readonly text: string; // the throw statement source, one line, truncated
}

// The exceptions lattice: a set of error type references keyed by a stable canonical
// identity, or TOP ("an unknown error") which absorbs everything. `origins` runs
// in parallel with `types` (same keys) so each escaping type carries the throw
// site(s) it came from, propagated across the call graph.
export interface ExceptionsValue {
    readonly top: boolean;
    readonly types: ReadonlyMap<string, string>; // canonical key -> display name
    readonly origins: ReadonlyMap<string, ReadonlyArray<ExceptionOrigin>>; // key -> throw sites
}

// Reserved key/display for `any`/`unknown` thrown values, which collapse to TOP.
export const TOP_KEY = '\u0000top';
const TOP_DISPLAY = 'an unknown error';

// Cap on distinct types before a set widens to TOP (termination + noise control).
const WIDEN_CAP = 8;
// Cap on retained origin sites per type (a few examples suffice).
const ORIGIN_CAP = 4;

const NO_ORIGINS: ReadonlyMap<
    string,
    ReadonlyArray<ExceptionOrigin>
> = new Map();

function originId(o: ExceptionOrigin): string {
    return `${o.fileName}:${o.pos}`;
}

function mergeOrigins(
    a: ReadonlyMap<string, ReadonlyArray<ExceptionOrigin>>,
    b: ReadonlyMap<string, ReadonlyArray<ExceptionOrigin>>,
): Map<string, ReadonlyArray<ExceptionOrigin>> {
    const m = new Map<string, ReadonlyArray<ExceptionOrigin>>(a);
    for (const [k, list] of b) {
        const prev = m.get(k);
        if (!prev) {
            m.set(k, list.slice(0, ORIGIN_CAP));
            continue;
        }
        const seen = new Set(prev.map(originId));
        const out = [...prev];
        for (const o of list) {
            if (!seen.has(originId(o)) && out.length < ORIGIN_CAP) {
                seen.add(originId(o));
                out.push(o);
            }
        }
        m.set(k, out);
    }
    return m;
}

export function bottom(): ExceptionsValue {
    return { top: false, types: new Map(), origins: NO_ORIGINS };
}

export function top(): ExceptionsValue {
    return { top: true, types: new Map(), origins: NO_ORIGINS };
}

export function single(key: string, display: string): ExceptionsValue {
    return {
        top: false,
        types: new Map([[key, display]]),
        origins: NO_ORIGINS,
    };
}

// Attach a throw site to every type currently in `v` — used where a `throw`
// statement produces `v`, so the site rides along as the value propagates.
export function withOrigin(
    v: ExceptionsValue,
    origin: ExceptionOrigin,
): ExceptionsValue {
    if (v.top) return v;
    const origins = new Map<string, ReadonlyArray<ExceptionOrigin>>(v.origins);
    for (const k of v.types.keys()) {
        const prev = origins.get(k) ?? [];
        if (prev.some((o) => originId(o) === originId(origin))) continue;
        origins.set(k, prev.length < ORIGIN_CAP ? [...prev, origin] : prev);
    }
    return { top: false, types: v.types, origins };
}

// Every distinct origin across all types, deduped — the diagnostic's throw list.
export function originsOf(v: ExceptionsValue): ReadonlyArray<ExceptionOrigin> {
    const out: ExceptionOrigin[] = [];
    const seen = new Set<string>();
    for (const list of v.origins.values()) {
        for (const o of list) {
            if (!seen.has(originId(o))) {
                seen.add(originId(o));
                out.push(o);
            }
        }
    }
    return out;
}

export function join(a: ExceptionsValue, b: ExceptionsValue): ExceptionsValue {
    if (a.top || b.top) return top();
    const m = new Map(a.types);
    for (const [k, d] of b.types) if (!m.has(k)) m.set(k, d);
    // Hard cap: any set that grows past WIDEN_CAP collapses to TOP immediately,
    // even in a single pass (a function that directly throws 9 types never waits
    // for the fixpoint's `widen`).
    if (m.size > WIDEN_CAP) return top();
    return {
        top: false,
        types: m,
        origins: mergeOrigins(a.origins, b.origins),
    };
}

export function equals(a: ExceptionsValue, b: ExceptionsValue): boolean {
    if (a.top || b.top) return a.top === b.top;
    if (a.types.size !== b.types.size) return false;
    for (const k of a.types.keys()) if (!b.types.has(k)) return false;
    return true;
}

// Cap at WIDEN_CAP distinct types; on overflow or after 3 growing rounds, TOP.
export function widen(
    prev: ExceptionsValue,
    next: ExceptionsValue,
    round: number,
): ExceptionsValue {
    if (next.top) return next;
    if (next.types.size > WIDEN_CAP) return top();
    if (round >= 3 && !prev.top && next.types.size > prev.types.size)
        return top();
    return next;
}

// Catch discharge: TOP minus anything stays TOP (an unknown error is never fully
// handled by a finite catch); a finite set drops the discharged keys.
export function subtract(
    a: ExceptionsValue,
    keys: ReadonlySet<string>,
): ExceptionsValue {
    if (a.top) return a;
    const m = new Map<string, string>();
    const origins = new Map<string, ReadonlyArray<ExceptionOrigin>>();
    for (const [k, d] of a.types) {
        if (keys.has(k)) continue;
        m.set(k, d);
        const o = a.origins.get(k);
        if (o) origins.set(k, o);
    }
    return { top: false, types: m, origins };
}

export function isEmpty(v: ExceptionsValue): boolean {
    return !v.top && v.types.size === 0;
}

// Human-readable rendering for diagnostics/hovers.
export function render(v: ExceptionsValue): string {
    if (v.top) return TOP_DISPLAY;
    return Array.from(v.types.values()).sort().join(' | ');
}

// A union type contributes each constituent; everything else is itself.
export function constituentsOf(type: ts.Type): ReadonlyArray<ts.Type> {
    return ts.unionTypes(type) ?? [type];
}

function basename(p: string): string {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
}

// Canonical identity for a single (non-union) type: `<decl-file-basename>:<qname>`
// from its symbol (stable across runs and serializable), falling back to the
// checker's textual rendering. `any`/`unknown` become TOP.
export function refOfType(
    checker: ts.TypeChecker,
    t: ts.Type,
): { top: true } | { top: false; key: string; display: string } {
    if ((t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
        return { top: true };
    const sym = t.getAliasSymbol() ?? t.getSymbol();
    if (sym) {
        const decl = ts.symbolDeclarations(sym)[0];
        const file = decl ? basename(decl.getSourceFile().fileName) : '?';
        const name = sym.name;
        const qname =
            name && name !== '__type' ? name : checker.typeToString(t);
        const display =
            name && name !== '__type' ? name : checker.typeToString(t);
        return { top: false, key: `${file}:${qname}`, display };
    }
    const s = checker.typeToString(t);
    return { top: false, key: s, display: s };
}

// Union-split reference list; `any`/`unknown` constituents surface the TOP marker.
export function typeRef(
    checker: ts.TypeChecker,
    type: ts.Type,
): ReadonlyArray<{ key: string; display: string }> {
    const out: { key: string; display: string }[] = [];
    for (const t of constituentsOf(type)) {
        const r = refOfType(checker, t);
        if (r.top) out.push({ key: TOP_KEY, display: TOP_DISPLAY });
        else out.push({ key: r.key, display: r.display });
    }
    return out;
}
