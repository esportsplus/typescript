import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFixtures, inFile, runAsync, type AsyncRunOptions } from "./harness";
import type { BuiltProgram } from "~/probe/kernel/program";
import type { Diagnostic } from "~/probe/kernel/types";

let built: BuiltProgram;

beforeAll(() => {
    built = buildFixtures();
});

afterAll(() => {
    built.dispose();
});

function messages(diags: ReadonlyArray<Diagnostic>): string[] {
    return diags.map((d) => d.message);
}

function fanOutOf(opts: AsyncRunOptions): ReadonlyArray<Diagnostic> {
    return inFile(runAsync(built, opts), "fanout.ts").filter((d) => d.message.startsWith("unbounded fan-out"));
}

describe("async channel — A1 bounded fan-out", () => {
    it("does not flag a bounded array literal but flags dynamic map aggregations", () => {
        // boundedOk's literal (2 <= 16) is fine; dynamicBad and pooledOk are both
        // dynamic `.map` inputs with no pool sanction.
        const diags = fanOutOf({ fanOut: "warn", fanOutAllowLiteralUpTo: 16 });
        expect(diags.length).toBe(2);
        expect(diags.every((d) => d.message.includes("unbounded fan-out"))).toBe(true);
        expect(diags.every((d) => d.message.includes("Promise.all"))).toBe(true);
    });

    it("is satisfied when routed through a configured pool function", () => {
        // The pool sanction rescues pooledOk; only dynamicBad remains flagged.
        const withPool = fanOutOf({ fanOut: "warn", poolFunctions: ["mapBounded"] });
        expect(withPool.length).toBe(1);
    });

    it("treats an array literal beyond the allowance as unbounded", () => {
        // boundedOk's literal has 2 elements > allowance of 1, so all three flag.
        const strict = fanOutOf({ fanOut: "warn", fanOutAllowLiteralUpTo: 1 });
        expect(strict.length).toBe(3);
    });

    it("emits nothing in off mode and emits in warn and error modes", () => {
        expect(fanOutOf({ fanOut: "off" }).length).toBe(0);
        expect(fanOutOf({ fanOut: "warn" }).length).toBe(2);
        expect(fanOutOf({ fanOut: "error" }).length).toBe(2);
    });
});

describe("async channel — A2 promise ownership", () => {
    function ownership(opts: AsyncRunOptions = {}): ReadonlyArray<Diagnostic> {
        return inFile(runAsync(built, { fanOut: "off", ...opts }), "ownership.ts");
    }

    it("flags an orphan in statement position", () => {
        const diags = ownership();
        const orphans = diags.filter((d) => d.message.includes("syncUsers"));
        expect(orphans.some((d) => d.message.includes("neither awaited nor voided"))).toBe(true);
    });

    it("does not flag awaited, voided, returned, or rejection-handled promises", () => {
        const diags = ownership();
        const lines = new Set(diags.map((d) => d.location.line));
        // droppedStatement + danglingThen are the only orphans; everything else clean.
        expect(diags.length).toBe(2);
        expect(messages(diags).every((m) => m.includes("syncUsers"))).toBe(true);
        // No diagnostic for the non-promise call.
        expect(lines.size).toBe(2);
    });

    it("flags a dangling .then with no rejection handler but not a .catch chain", () => {
        const diags = ownership();
        // Exactly two orphans: droppedStatement and danglingThen.
        expect(diags.length).toBe(2);
    });

    it("flags an orphan whose return is ignored across a call boundary", () => {
        const diags = inFile(runAsync(built, { fanOut: "off" }), "cross_b.ts");
        expect(diags.length).toBe(1);
        expect(diags[0]!.message).toContain("remoteSync");
        expect(diags[0]!.message).toContain("neither awaited nor voided");
    });

    it("degrades a promise stored into an opaque structure by the dispatch knob", () => {
        const optimist = inFile(runAsync(built, { fanOut: "off", dispatch: "optimist" }), "degrade.ts");
        const pessimist = inFile(runAsync(built, { fanOut: "off", dispatch: "pessimist" }), "degrade.ts");
        expect(optimist.length).toBe(0);
        expect(pessimist.length).toBe(1);
        expect(pessimist[0]!.message).toContain("untracked structure");
    });
});
