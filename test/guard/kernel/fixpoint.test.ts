import { afterEach, describe, expect, it } from "vitest";

import { buildAnalysis, type BuiltAnalysis } from "./harness";
import { runChannel } from "~/guard/kernel/fixpoint";

import type { Channel, Diagnostic } from "~/guard/kernel/types";

interface Growable {
    readonly count: number;
    readonly top: boolean;
}

let built: BuiltAnalysis | undefined;

afterEach(() => {
    built?.dispose();
    built = undefined;
});

// A channel that records the order in which the engine asks it to transfer each
// function, so a test can assert reverse-topological (callee-before-caller) order.
function orderRecorder(order: string[]): Channel<Growable> {
    return {
        name: "recorder",
        bottom: () => ({ count: 0, top: false }),
        equals: (a, b) => (a.top || b.top ? a.top === b.top : a.count === b.count),
        widen: (_prev, next) => next,
        transfer(ctx) {
            order.push(ctx.fn.name);
            return { value: { count: 0, top: false }, fromCallbacks: new Set() };
        },
        diagnose: (): ReadonlyArray<Diagnostic> => [],
    };
}

// A channel whose value strictly grows every round so the fixpoint can never
// settle on its own — the widening backstop must fold it to `top`.
function everGrowing(): Channel<Growable> {
    return {
        name: "grower",
        bottom: () => ({ count: 0, top: false }),
        equals: (a, b) => (a.top || b.top ? a.top === b.top : a.count === b.count),
        widen: (prev, next, round) => {
            if (next.top) {
                return next;
            }
            if (round >= 3 && !prev.top && next.count > prev.count) {
                return { count: next.count, top: true };
            }
            return next;
        },
        transfer(ctx) {
            const cur = ctx.summaryOf(ctx.fn).value;
            if (cur.top) {
                return { value: cur, fromCallbacks: new Set() };
            }
            return { value: { count: cur.count + 1, top: false }, fromCallbacks: new Set() };
        },
        diagnose: (): ReadonlyArray<Diagnostic> => [],
    };
}

describe("fixpoint — SCC ordering", () => {
    it("processes a callee's SCC before its callers on a cycle", () => {
        built = buildAnalysis({
            "a.ts": `export function a(): void { b(); }
function b(): void { a(); c(); }
function c(): void {}
`,
        });
        const order: string[] = [];
        runChannel(built.analysis, orderRecorder(order), {}, new Map());
        // c (leaf) is its own SCC and comes out before the {a, b} cycle.
        const firstC = order.indexOf("c");
        expect(firstC).toBeGreaterThanOrEqual(0);
        expect(firstC).toBeLessThan(order.indexOf("a"));
        expect(firstC).toBeLessThan(order.indexOf("b"));
    });
});

describe("fixpoint — widening backstop", () => {
    it("folds an ever-growing summary to top and terminates", () => {
        built = buildAnalysis({
            "a.ts": `export function grows(): void { grows(); }
`,
        });
        const { store } = runChannel(built.analysis, everGrowing(), {}, new Map());
        const fn = built.graph.reachedFunctions().find((f) => f.name === "grows")!;
        expect(store.get(fn.id).value.top).toBe(true);
    });
});
