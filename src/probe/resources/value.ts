// The resources lattice value for one function: the set of its parameter indices
// whose passed-in resource this function takes OWNERSHIP of — it discharges or
// transfers that argument on every path, so a caller passing its own tracked
// resource there has transferred the obligation. Leaks are a local property
// (reported where the resource is acquired), so they do not ride the summary;
// ownership is the only fact a caller inherits from a callee.
export interface ResourcesValue {
    readonly ownsParams: ReadonlySet<number>;
}

const EMPTY: ReadonlySet<number> = new Set();

export function bottom(): ResourcesValue {
    return { ownsParams: EMPTY };
}

export function fromParams(indices: Iterable<number>): ResourcesValue {
    const set = new Set(indices);
    return { ownsParams: set.size === 0 ? EMPTY : set };
}

export function join(a: ResourcesValue, b: ResourcesValue): ResourcesValue {
    if (a.ownsParams.size === 0) {
        return b;
    }

    if (b.ownsParams.size === 0) {
        return a;
    }

    const set = new Set(a.ownsParams);

    for (const i of b.ownsParams) {
        set.add(i);
    }

    return { ownsParams: set };
}

export function equals(a: ResourcesValue, b: ResourcesValue): boolean {
    if (a.ownsParams.size !== b.ownsParams.size) {
        return false;
    }

    for (const i of a.ownsParams) {
        if (!b.ownsParams.has(i)) {
            return false;
        }
    }

    return true;
}

// The ownership set is bounded by the (finite) parameter count, so it ascends to
// a fixed point on its own; widening is the identity.
export function widen(
    _prev: ResourcesValue,
    next: ResourcesValue,
    _round: number,
): ResourcesValue {
    return next;
}
