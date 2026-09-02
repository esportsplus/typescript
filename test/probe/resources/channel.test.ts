import { describe, expect, it } from "vitest";

import { analyzeFixture as analyze } from '../harness';
import type { Diagnostic, Dispatch } from '~/probe/kernel/types';


type AnalyzeOptions = {
    dispatch?: Dispatch;
    entry?: string;
    exceptions?: boolean;
    options?: unknown;
};


function analyzeFixture(sources: Record<string, string>, options: AnalyzeOptions = {}): ReadonlyArray<Diagnostic> {
    return analyze(sources, {
        channels: {
            exceptions: { enabled: options.exceptions ?? false },
            resources: {
                dispatch: options.dispatch ?? 'pessimist',
                enabled: true,
                ...(typeof options.options === 'object' && options.options !== null ? options.options : {})
            }
        },
        entryPoints: [options.entry ?? 'src/**/*.ts']
    });
}

const MAKE_RESOURCE = "export function makeResource(): Disposable { return { [Symbol.dispose]() {} }; }\n";

describe("resources channel — R1", () => {
    it("flags a timer that leaks on an early return", () => {
        const diags = analyzeFixture({
            "index.ts": [
                "export function poll(stop: boolean) {",
                "    const h = setInterval(() => {}, 1000);",
                "    if (stop) {",
                "        return;",
                "    }",
                "    clearInterval(h);",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(1);
        expect(diags[0]!.message).toContain("can leak");
        expect(diags[0]!.channel).toBe("resources");
    });

    it("flags a timer that leaks on a throwing path", () => {
        const diags = analyzeFixture({
            "index.ts": [
                "export function parseThenClear(input: string) {",
                "    const h = setInterval(() => {}, 1000);",
                "    JSON.parse(input);",
                "    clearInterval(h);",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(1);
        expect(diags[0]!.message).toContain("can leak");
    });

    it("accepts a release guarded by finally", () => {
        const diags = analyzeFixture({
            "index.ts": [
                "function work() {}",
                "export function guarded() {",
                "    const h = setInterval(() => {}, 1000);",
                "    try {",
                "        work();",
                "    }",
                "    finally {",
                "        clearInterval(h);",
                "    }",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(0);
    });

    it("accepts a `using` binding and still flags the same resource without it", () => {
        const diags = analyzeFixture({
            "index.ts": [
                MAKE_RESOURCE,
                "export function withUsing() {",
                "    using r = makeResource();",
                "    void r;",
                "}",
                "export function withoutUsing() {",
                "    const r = makeResource();",
                "    r.valueOf();",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(1);
        expect(diags[0]!.message).toContain("Disposable");
    });

    it("accepts transfer by return", () => {
        const diags = analyzeFixture({
            "index.ts": [
                "export function grab() {",
                "    const h = setInterval(() => {}, 1000);",
                "    return h;",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(0);
    });

    it("accepts transfer to an ownership-taking app function", () => {
        const diags = analyzeFixture({
            "index.ts": [
                MAKE_RESOURCE,
                "function own(r: Disposable) {",
                "    r[Symbol.dispose]();",
                "}",
                "export function useOwn() {",
                "    const r = makeResource();",
                "    own(r);",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(0);
    });

    it("accepts transfer to a configured ownership-taking call", () => {
        const diags = analyzeFixture(
            {
                "index.ts": [
                    "declare function register(handle: number): void;",
                    "export function scheduled() {",
                    "    const h = setInterval(() => {}, 1000);",
                    "    register(h);",
                    "}",
                ].join("\n"),
            },
            { options: { ownership: [{ callee: "register", params: [0] }] } },
        );

        expect(diags).toHaveLength(0);
    });

    it("accepts the withResource(cb) pattern (acquire + finally release around a callback)", () => {
        const diags = analyzeFixture({
            "index.ts": [
                MAKE_RESOURCE,
                "export function withResource(cb: (r: Disposable) => void) {",
                "    const r = makeResource();",
                "    try {",
                "        cb(r);",
                "    }",
                "    finally {",
                "        r[Symbol.dispose]();",
                "    }",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(0);
    });

    it("matches a listener pair by key and flags an unmatched one", () => {
        const diags = analyzeFixture({
            "index.ts": [
                "export function balanced(t: EventTarget, fn: () => void) {",
                "    t.addEventListener('click', fn);",
                "    t.removeEventListener('click', fn);",
                "}",
                "export function unbalanced(t: EventTarget, fn: () => void) {",
                "    t.addEventListener('click', fn);",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(1);
        expect(diags[0]!.message).toContain("removeEventListener");
    });

    it("flags a class field resource with no disposal and accepts one with disposal", () => {
        const diags = analyzeFixture({
            "index.ts": [
                "export class Bad {",
                "    private t: number = 0;",
                "    constructor() {",
                "        this.t = setInterval(() => {}, 1000);",
                "    }",
                "}",
                "export class Good {",
                "    private t: number = 0;",
                "    constructor() {",
                "        this.t = setInterval(() => {}, 1000);",
                "    }",
                "    [Symbol.dispose]() {",
                "        clearInterval(this.t);",
                "    }",
                "}",
                "export function make() {",
                "    return [new Bad(), new Good()];",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(1);
        expect(diags[0]!.message).toContain("this.t");
        expect(diags[0]!.message).toContain("Bad");
    });

    it("degrades a push-to-array under pessimist (untrackable) but stays silent under optimist", () => {
        const source = {
            "index.ts": [
                "export function collect() {",
                "    const timers: number[] = [];",
                "    const h = setInterval(() => {}, 1000);",
                "    timers.push(h);",
                "}",
            ].join("\n"),
        };

        const pessimist = analyzeFixture(source, { dispatch: "pessimist" });
        const optimist = analyzeFixture(source, { dispatch: "optimist" });

        expect(pessimist).toHaveLength(1);
        expect(pessimist[0]!.message).toContain("untrackable");
        expect(optimist).toHaveLength(0);
    });

    it("a benign (non-throwing) app call between acquire and release does not force a leak", () => {
        const diags = analyzeFixture({
            "index.ts": [
                "export function pure() {}",
                "export function work() {",
                "    const h = setInterval(() => {}, 1000);",
                "    pure();",
                "    clearInterval(h);",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(0);
    });

    it("offers a `using` quick-fix on a leaked sync Disposable", () => {
        const diags = analyzeFixture({
            "index.ts": [
                MAKE_RESOURCE,
                "export function withoutUsing() {",
                "    const r = makeResource();",
                "    r.valueOf();",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(1);
        const fix = diags[0]!.fixes?.find((f) => f.title.includes("using"));
        expect(fix).toBeDefined();
        expect(fix!.edits[0]!.newText).toBe("using");
    });

    it("offers a try/finally quick-fix that wraps the region and releases the handle", () => {
        const diags = analyzeFixture({
            "index.ts": [
                "declare function work(): void;",
                "export function poll() {",
                "    const h = setInterval(() => {}, 1000);",
                "    work();",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(1);
        const fix = diags[0]!.fixes?.find((f) => f.title.includes("try/finally"));
        expect(fix).toBeDefined();
        expect(fix!.edits[0]!.newText).toBe(
            ["    try {", "        work();", "    }", "    finally {", "        clearInterval(h);", "    }"].join("\n"),
        );
    });

    it("tracks an acquire inside a loop body: released in-iteration is safe", () => {
        const diags = analyzeFixture({
            "index.ts": [
                "export function run(items: string[]) {",
                "    for (let i = 0, n = items.length; i < n; i++) {",
                "        const h = setInterval(() => {}, 1000);",
                "        clearInterval(h);",
                "    }",
                "}",
            ].join("\n"),
        });

        expect(diags).toHaveLength(0);
    });

    it("leaks an acquire in a loop when a throwing await bypasses the in-loop release", () => {
        const diags = analyzeFixture(
            {
                "index.ts": [
                    "export async function boom() {",
                    "    throw new Error('x');",
                    "}",
                    "export async function run(items: string[]) {",
                    "    for (let i = 0, n = items.length; i < n; i++) {",
                    "        const h = setInterval(() => {}, 1000);",
                    "        await boom();",
                    "        clearInterval(h);",
                    "    }",
                    "}",
                ].join("\n"),
            },
            { exceptions: true },
        ).filter((d) => d.channel === "resources");

        expect(diags).toHaveLength(1);
    });

    it("with exceptions enabled, a throwing helper leaks while a pure one stays safe", () => {
        const diags = analyzeFixture(
            {
                "index.ts": [
                    "export function pure() {}",
                    "export function boom() {",
                    "    throw new Error('x');",
                    "}",
                    "export function leaks() {",
                    "    const h = setInterval(() => {}, 1000);",
                    "    boom();",
                    "    clearInterval(h);",
                    "}",
                    "export function safe() {",
                    "    const h = setInterval(() => {}, 1000);",
                    "    pure();",
                    "    clearInterval(h);",
                    "}",
                ].join("\n"),
            },
            { exceptions: true },
        ).filter((d) => d.channel === "resources");

        expect(diags).toHaveLength(1);
        expect(diags[0]!.message).toContain("can leak");
    });
});
