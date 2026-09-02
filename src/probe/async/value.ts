// The async lattice value. `returnsPromise` is the one call-graph fact this
// channel publishes for its callers: whether invoking the function yields a
// promise the caller must own. Callback-conditionality is subsumed by the
// checker's inferred signature return type (a function that returns a callback's
// promise already types as promise-returning), so the summary carries no
// `fromCallbacks` obligations of its own.
type AsyncValue  = {
    readonly returnsPromise: boolean;
};

function bottom(): AsyncValue {
    return { returnsPromise: false };
}

function promise(): AsyncValue {
    return { returnsPromise: true };
}

function join(a: AsyncValue, b: AsyncValue): AsyncValue {
    return { returnsPromise: a.returnsPromise || b.returnsPromise };
}

function equals(a: AsyncValue, b: AsyncValue): boolean {
    return a.returnsPromise === b.returnsPromise;
}

// A two-point lattice has no infinite ascending chain, so widening never fires:
// `next` is already the fixpoint after a single pass.
function widen(
    _prev: AsyncValue,
    next: AsyncValue,
    _round: number,
): AsyncValue {
    return next;
}


export { bottom, equals, join, promise, type AsyncValue, widen };
