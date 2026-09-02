import { describe, expect, it } from "vitest";

import { analyzeFixture } from "./harness";

import type { Diagnostic } from "~/probe/kernel/types";

function messages(diags: ReadonlyArray<Diagnostic>): string[] {
    return diags.map((d) => d.message);
}

function toBoundary(diags: ReadonlyArray<Diagnostic>, fn: string): ReadonlyArray<Diagnostic> {
    return diags.filter((d) => d.message.includes(`path to \`${fn}\``));
}

describe("exceptions channel — boundaries and calls", () => {
    it("flags an uncaught call reaching a boundary", () => {
        const diags = analyzeFixture({
            "a.ts": `export function boundary(): void {
    inner();
}
function inner(): void {
    throw new TypeError('boom');
}
`,
        }, { report: "all" });
        const atBoundary = toBoundary(diags, "boundary");
        expect(atBoundary.length).toBe(1);
        expect(atBoundary[0]!.message).toContain("Call may throw TypeError");
        expect(atBoundary[0]!.message).toContain("from inner");
    });

    it("reports the throw itself in `all` mode but not in `consumers` mode", () => {
        const sources = {
            "a.ts": `export function producer(): void { throw new TypeError('x'); }
export function consumer(): void { producer(); }
`,
        };
        const all = analyzeFixture(sources, { report: "all" });
        expect(messages(all).some((m) => m.startsWith("Throw may throw TypeError"))).toBe(true);

        const consumers = analyzeFixture(sources, { report: "consumers" });
        expect(messages(consumers).some((m) => m.startsWith("Throw may throw"))).toBe(false);
        expect(toBoundary(consumers, "consumer").length).toBe(1);
    });

    it("in `cross-module` mode a call whose targets share the caller's package stays silent", () => {
        const sources = {
            "a.ts": `export function producer(): void { throw new TypeError('x'); }
export function consumer(): void { producer(); }
`,
        };
        // `consumers` reports the internal call; `cross-module` suppresses it
        // because producer lives in the same package as consumer.
        expect(toBoundary(analyzeFixture(sources, { report: "consumers" }), "consumer").length).toBe(1);
        expect(toBoundary(analyzeFixture(sources, { report: "cross-module" }), "consumer").length).toBe(0);
    });
});

describe("exceptions channel — catch discharge", () => {
    it("a catch with no rethrow discharges the try set", () => {
        const diags = analyzeFixture({
            "a.ts": `export function b(): void {
    try { risky(); } catch (e) { console.log(e); }
}
function risky(): void { throw new TypeError('x'); }
`,
        }, { report: "all" });
        expect(toBoundary(diags, "b").length).toBe(0);
    });

    it("a positive instanceof rethrow leaks only the matched type", () => {
        const diags = analyzeFixture({
            "a.ts": `class AppError extends Error {}
export function b(): void {
    try { risky(); } catch (e) { if (e instanceof AppError) { throw e; } }
}
function risky(): void { throw new AppError(); }
`,
        }, { report: "all" });
        const atB = toBoundary(diags, "b");
        expect(atB.length).toBe(1);
        expect(atB[0]!.message).toContain("AppError");
    });

    it("a negated instanceof rethrow discharges the matched type", () => {
        const diags = analyzeFixture({
            "a.ts": `class AppError extends Error {}
export function b(): void {
    try { risky(); } catch (e) { if (!(e instanceof AppError)) { throw e; } }
}
function risky(): void { throw new AppError(); }
`,
        }, { report: "all" });
        expect(toBoundary(diags, "b").length).toBe(0);
    });

    it("a guarded early-exit before a bare rethrow discharges the peeled type", () => {
        const diags = analyzeFixture({
            "a.ts": `class AppError extends Error {}
export function b(): void {
    try { risky(); } catch (e) { if (e instanceof AppError) { return; } throw e; }
}
function risky(): void { throw new AppError(); }
`,
        }, { report: "all" });
        expect(toBoundary(diags, "b").length).toBe(0);
    });

    it("a finally is never a sink — its try body still escapes", () => {
        const diags = analyzeFixture({
            "a.ts": `export function b(): void {
    try { risky(); } finally { cleanup(); }
}
function risky(): void { throw new TypeError('x'); }
function cleanup(): void {}
`,
        }, { report: "all" });
        const atB = toBoundary(diags, "b");
        expect(atB.length).toBe(1);
        expect(atB[0]!.message).toContain("TypeError");
    });
});

describe("exceptions channel — @throws declarations", () => {
    it("flags an inferred escape wider than the declaration", () => {
        const diags = analyzeFixture({
            "a.ts": `/**
 * @throws {TypeError}
 */
export function b(): void {
    throw new RangeError('x');
}
`,
        }, { report: "all" });
        const under = diags.filter((d) => d.message.startsWith("Throws"));
        expect(under.length).toBe(1);
        expect(under[0]!.message).toBe("Throws RangeError but declares only TypeError");
    });

    it("does not flag when the declaration covers the inferred escape", () => {
        const diags = analyzeFixture({
            "a.ts": `/**
 * @throws {RangeError}
 */
export function b(): void {
    throw new RangeError('x');
}
`,
        }, { report: "all" });
        expect(diags.filter((d) => d.message.startsWith("Throws")).length).toBe(0);
    });
});

describe("exceptions channel — errorCause", () => {
    it("flags a rethrow of a new error without `{ cause }` when enabled", () => {
        const sources = {
            "a.ts": `export function b(): void {
    try { risky(); } catch (e) { throw new Error('wrapped'); }
}
function risky(): void { throw new TypeError('x'); }
`,
        };
        const on = analyzeFixture(sources, { report: "all", errorCause: true });
        expect(messages(on).some((m) => m.includes("Rethrow drops the caught error"))).toBe(true);

        const off = analyzeFixture(sources, { report: "all", errorCause: false });
        expect(messages(off).some((m) => m.includes("Rethrow drops the caught error"))).toBe(false);
    });

    it("does not flag a rethrow that passes `{ cause }`", () => {
        const diags = analyzeFixture({
            "a.ts": `export function b(): void {
    try { risky(); } catch (e) { throw new Error('wrapped', { cause: e }); }
}
function risky(): void { throw new TypeError('x'); }
`,
        }, { report: "all", errorCause: true });
        expect(messages(diags).some((m) => m.includes("Rethrow drops the caught error"))).toBe(false);
    });
});

describe("exceptions channel — sinks", () => {
    it("a sink with no `absorbs` swallows every escape", () => {
        const diags = analyzeFixture({
            "a.ts": `export function b(): void { absorb(); }
function absorb(): void { throw new TypeError('x'); }
`,
        }, { report: "all", sinks: [{ callee: "absorb" }] });
        expect(toBoundary(diags, "b").length).toBe(0);
    });

    it("a sink absorbs only its listed types and leaks the rest", () => {
        const matched = analyzeFixture({
            "a.ts": `export function b(): void { absorb(); }
function absorb(): void { throw new TypeError('x'); }
`,
        }, { report: "all", sinks: [{ callee: "absorb", absorbs: ["TypeError"] }] });
        expect(toBoundary(matched, "b").length).toBe(0);

        const leaked = analyzeFixture({
            "a.ts": `export function b(): void { absorb(); }
function absorb(): void { throw new TypeError('x'); }
`,
        }, { report: "all", sinks: [{ callee: "absorb", absorbs: ["RangeError"] }] });
        const atB = toBoundary(leaked, "b");
        expect(atB.length).toBe(1);
        expect(atB[0]!.message).toContain("TypeError");
    });
});

describe("exceptions channel — overlays and presets", () => {
    it("models the base overlay JSON.parse as throwing SyntaxError", () => {
        const diags = analyzeFixture({
            "a.ts": `export function b(x: string): unknown {
    return JSON.parse(x);
}
`,
        }, { report: "all" });
        const atB = toBoundary(diags, "b");
        expect(atB.length).toBe(1);
        expect(atB[0]!.message).toContain("SyntaxError");
        expect(atB[0]!.message).toContain("from JSON.parse");
    });

    it("applies a user overlay bundle entry", () => {
        const diags = analyzeFixture({
            "a.ts": `export function b(): void { doThrow(); }
declare function doThrow(): void;
`,
        }, {
            report: "all",
            overlays: {
                "overlay.jsonc": JSON.stringify({
                    overlay: { exceptions: { app: { doThrow: { exceptions: ["RangeError"] } } } },
                }),
            },
        });
        const atB = toBoundary(diags, "b");
        expect(atB.length).toBe(1);
        expect(atB[0]!.message).toContain("RangeError");
    });

    it("applies the node preset to readFileSync", () => {
        const diags = analyzeFixture({
            "a.ts": `import { readFileSync } from 'node:fs';
export function b(): string {
    return readFileSync('x', 'utf8');
}
`,
        }, { report: "all", presets: ["node"], nodeTypes: true });
        const atB = toBoundary(diags, "b");
        expect(atB.length).toBe(1);
        expect(atB[0]!.message).toContain("Error");
        expect(atB[0]!.message).toContain("from readFileSync");
    });
});

describe("exceptions channel — dispatch and widening", () => {
    it("pessimist degrades an unresolved `any` callee to an unknown error; optimist stays silent", () => {
        const sources = {
            "a.ts": `export function b(x: any): void {
    x.doThing();
}
`,
        };
        const pessimist = analyzeFixture(sources, { report: "all", dispatch: "pessimist" });
        const atB = toBoundary(pessimist, "b");
        expect(atB.length).toBe(1);
        expect(atB[0]!.message).toContain("an unknown error");

        const optimist = analyzeFixture(sources, { report: "all", dispatch: "optimist" });
        expect(toBoundary(optimist, "b").length).toBe(0);
    });

    it("widens a callee that throws more than eight types to an unknown error", () => {
        const diags = analyzeFixture({
            "a.ts": `class E1 extends Error {} class E2 extends Error {} class E3 extends Error {}
class E4 extends Error {} class E5 extends Error {} class E6 extends Error {}
class E7 extends Error {} class E8 extends Error {} class E9 extends Error {}
function nine(n: number): void {
    if (n === 1) throw new E1(); if (n === 2) throw new E2(); if (n === 3) throw new E3();
    if (n === 4) throw new E4(); if (n === 5) throw new E5(); if (n === 6) throw new E6();
    if (n === 7) throw new E7(); if (n === 8) throw new E8(); if (n === 9) throw new E9();
}
export function caller(): void { nine(1); }
`,
        }, { report: "all" });
        const atCaller = toBoundary(diags, "caller");
        expect(atCaller.length).toBe(1);
        expect(atCaller[0]!.message).toContain("an unknown error");
    });
});
