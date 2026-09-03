import type {
    Analysis,
    Channel,
    Diagnostic,
    DiagnoseContext,
    Dispatch,
    FunctionInfo,
    Summary,
    SummaryStore,
    TransferContext,
} from './types';

// After this many rounds an SCC folds new values toward top via `widen`.
const WIDEN_AFTER = 3;
// Hard backstop so a misbehaving channel can never spin forever.
const MAX_ROUNDS = 12;

function setsEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    for (const x of a) {
        if (!b.has(x)) {
            return false;
        }
    }
    return true;
}

// Iterative Tarjan SCC. Emits components in reverse-topological order (a node's
// successors/callees come out before the node itself), so processing the returned
// list in order lets a caller's transfer read already-converged callee summaries.
// Iterative (not recursive) so a deep real-world call chain cannot blow the stack.
function tarjanSccs(
    nodes: ReadonlyArray<FunctionInfo>,
    successors: (fn: FunctionInfo) => ReadonlyArray<FunctionInfo>,
): FunctionInfo[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: FunctionInfo[] = [];
    const sccs: FunctionInfo[][] = [];
    let counter = 0;

    type Frame  = {
        readonly node: FunctionInfo;
        readonly succ: ReadonlyArray<FunctionInfo>;
        i: number;
    };

    const open = (node: FunctionInfo): Frame => {
        index.set(node.id, counter);
        low.set(node.id, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node.id);
        return { node, succ: successors(node), i: 0 };
    };

    for (const start of nodes) {
        if (index.has(start.id)) {
            continue;
        }
        const work: Frame[] = [open(start)];
        while (work.length > 0) {
            const frame = work[work.length - 1]!;
            const node = frame.node;
            if (frame.i < frame.succ.length) {
                const w = frame.succ[frame.i]!;
                frame.i += 1;
                if (!index.has(w.id)) {
                    work.push(open(w));
                } else if (onStack.has(w.id)) {
                    // Back/cross edge into the current stack: pull the low-link down.
                    low.set(
                        node.id,
                        Math.min(low.get(node.id)!, index.get(w.id)!),
                    );
                }
                continue;
            }
            // All successors visited: if `node` roots an SCC, pop it off the stack.
            if (low.get(node.id) === index.get(node.id)) {
                const component: FunctionInfo[] = [];
                for (;;) {
                    const w = stack.pop()!;
                    onStack.delete(w.id);
                    component.push(w);
                    if (w.id === node.id) {
                        break;
                    }
                }
                sccs.push(component);
            }
            work.pop();
            const parent = work[work.length - 1];
            if (parent) {
                low.set(
                    parent.node.id,
                    Math.min(low.get(parent.node.id)!, low.get(node.id)!),
                );
            }
        }
    }
    return sccs;
}

function runChannel<V>(
    analysis: Analysis,
    channel: Channel<V>,
    dispatch: Dispatch,
    channelConfig: unknown,
    peers: ReadonlyMap<string, SummaryStore<unknown>>,
): { store: SummaryStore<V>; diagnostics: Diagnostic[] } {
    const graph = analysis.graph;
    const reached = graph.reachedFunctions();
    const reachedById = new Map<string, FunctionInfo>();
    for (const fn of reached) {
        reachedById.set(fn.id, fn);
    }

    // Only edges that stay inside the reached set are call-graph edges for the SCC.
    const calleesOf = (fn: FunctionInfo): FunctionInfo[] =>
        graph.calleesOf(fn).filter((c) => reachedById.has(c.id));

    const summaries = new Map<string, Summary<V>>();
    const bottomSummary = (): Summary<V> => ({
        value: channel.bottom(),
        fromCallbacks: new Set<number>(),
    });
    const summaryOf = (fn: FunctionInfo): Summary<V> =>
        summaries.get(fn.id) ?? bottomSummary();

    const makeTransferContext = (fn: FunctionInfo): TransferContext<V> => ({
        checker: analysis.checker,
        fn,
        dispatch,
        channelConfig,
        summaryOf,
        resolveCall: (call) => graph.resolveCall(call, channel.name),
        resolveCallFor: (peerChannel, call) =>
            graph.resolveCall(call, peerChannel),
        peerSummaryValue: (peerChannel, fnId) =>
            peers.get(peerChannel)?.get(fnId).value,
    });

    // Reverse-topological order: callees before callers.
    const sccs = tarjanSccs(reached, calleesOf);

    for (const scc of sccs) {
        for (const fn of scc) {
            summaries.set(fn.id, bottomSummary());
        }
        let round = 0;
        for (;;) {
            round += 1;
            let changed = false;
            for (const fn of scc) {
                const prev = summaries.get(fn.id)!;
                const computed = channel.transfer(makeTransferContext(fn));
                // Widening trigger: after WIDEN_AFTER rounds the SCC has not settled, so
                // fold the growing value toward top to guarantee termination.
                const nextValue =
                    round > WIDEN_AFTER
                        ? channel.widen(prev.value, computed.value, round)
                        : computed.value;
                const next: Summary<V> = {
                    value: nextValue,
                    fromCallbacks: computed.fromCallbacks,
                };
                summaries.set(fn.id, next);
                if (
                    !channel.equals(prev.value, next.value) ||
                    !setsEqual(prev.fromCallbacks, next.fromCallbacks)
                ) {
                    changed = true;
                }
            }
            if (!changed) {
                break;
            }
            if (round >= MAX_ROUNDS) {
                // Backstop hit: accept the current (widened) values rather than loop.
                break;
            }
        }
    }

    // Reverse call-graph edges (callee id -> callers), for boundary chains.
    const reverse = new Map<string, FunctionInfo[]>();
    for (const fn of reached) {
        for (const callee of calleesOf(fn)) {
            const callers = reverse.get(callee.id);
            if (callers) {
                callers.push(fn);
            }
            else {
                reverse.set(callee.id, [fn]);
            }
        }
    }

    const boundaries = graph.boundaries();
    const pathToBoundary = (fn: FunctionInfo): FunctionInfo[] => {
        if (boundaries.has(fn.id)) {
            return [fn];
        }
        const parent = new Map<string, FunctionInfo>();
        const visited = new Set<string>([fn.id]);
        const queue: FunctionInfo[] = [fn];
        let head = 0;
        while (head < queue.length) {
            const cur = queue[head]!;
            head += 1;
            for (const caller of reverse.get(cur.id) ?? []) {
                if (visited.has(caller.id)) {
                    continue;
                }
                visited.add(caller.id);
                parent.set(caller.id, cur);
                if (boundaries.has(caller.id)) {
                    const rev: FunctionInfo[] = [];
                    let node: FunctionInfo | undefined = caller;
                    while (node) {
                        rev.push(node);
                        if (node.id === fn.id) {
                            break;
                        }
                        node = parent.get(node.id);
                    }
                    return rev.toReversed();
                }
                queue.push(caller);
            }
        }
        // No boundary reaches `fn`: best-effort single-element chain.
        return [fn];
    };

    // Call-graph roots: reached functions no reached function calls. Computed once.
    const roots = reached.filter(
        (fn) => (reverse.get(fn.id) ?? []).length === 0,
    );

    const diagnostics: Diagnostic[] = [];
    const seen = new Set<string>();
    for (const fn of reached) {
        const ctx: DiagnoseContext<V> = {
            checker: analysis.checker,
            fn,
            dispatch,
            channelConfig,
            isBoundary: boundaries.has(fn.id),
            summaryOf,
            resolveCall: (call) => graph.resolveCall(call, channel.name),
            resolveCallFor: (peerChannel, call) =>
                graph.resolveCall(call, peerChannel),
            peerSummaryValue: (peerChannel, fnId) =>
                peers.get(peerChannel)?.get(fnId).value,
            pathToBoundary,
            roots: () => roots,
        };
        for (const d of channel.diagnose(ctx)) {
            const key = `${d.channel}\u0000${d.location.fileName}\u0000${d.location.pos}\u0000${d.message}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            diagnostics.push(d);
        }
    }

    const store: SummaryStore<V> = {
        get: (id) => summaries.get(id) ?? bottomSummary(),
    };
    return { store, diagnostics };
}


export { runChannel };
