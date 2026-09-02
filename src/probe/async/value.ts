// The async lattice value. `returnsPromise` is the one call-graph fact this
// channel publishes for its callers: whether invoking the function yields a
// promise the caller must own. Callback-conditionality is subsumed by the
// checker's inferred signature return type (a function that returns a callback's
// promise already types as promise-returning), so the summary carries no
// `fromCallbacks` obligations of its own.
export interface AsyncValue {
    readonly returnsPromise: boolean;
}

export function bottom(): AsyncValue {
    return { returnsPromise: false };
}

export function promise(): AsyncValue {
    return { returnsPromise: true };
}

export function join(a: AsyncValue, b: AsyncValue): AsyncValue {
    return { returnsPromise: a.returnsPromise || b.returnsPromise };
}

export function equals(a: AsyncValue, b: AsyncValue): boolean {
    return a.returnsPromise === b.returnsPromise;
}

// A two-point lattice has no infinite ascending chain, so widening never fires:
// `next` is already the fixpoint after a single pass.
export function widen(
    _prev: AsyncValue,
    next: AsyncValue,
    _round: number,
): AsyncValue {
    return next;
}
