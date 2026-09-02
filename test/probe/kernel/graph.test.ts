import { afterEach, describe, expect, it } from "vitest";

import { buildAnalysis, reachedNames, type BuiltAnalysis } from "./harness";

const IMPORT_TREE = {
    "a.ts": `import { deep } from './sub/c';
export function entryA(): void { helperA(); deep(); }
function helperA(): void {}
export function orphanA(): void {}
`,
    "sub/c.ts": `export function deep(): void {}
export function isolatedC(): void {}
`,
};

let built: BuiltAnalysis | undefined;

afterEach(() => {
    built?.dispose();
    built = undefined;
});

describe("call graph — entry-point globs", () => {
    it("`src/*.ts` matches one directory level but `src/**/*.ts` recurses", () => {
        built = buildAnalysis(IMPORT_TREE, { entryPoints: ["src/*.ts"] });
        const single = reachedNames(built.graph);
        built.dispose();
        built = undefined;
        // isolatedC lives in src/sub and is never called, so a single-level glob
        // never reaches it; the recursive glob makes it an entry.
        expect(single.has("isolatedC")).toBe(false);

        built = buildAnalysis(IMPORT_TREE, { entryPoints: ["src/**/*.ts"] });
        expect(reachedNames(built.graph).has("isolatedC")).toBe(true);
    });
});

describe("call graph — worklist reachability", () => {
    it("reaches transitive callees across an import but not unreferenced functions", () => {
        built = buildAnalysis(IMPORT_TREE, { entryPoints: ["src/a.ts"] });
        const names = reachedNames(built.graph);
        expect(names.has("entryA")).toBe(true);
        expect(names.has("helperA")).toBe(true);
        expect(names.has("deep")).toBe(true);
        expect(names.has("isolatedC")).toBe(false);
    });
});

describe("call graph — selector-driven handler boundaries", () => {
    const BARE = {
        "b.ts": `declare function onRequest(cb: () => void): void;
export function register(): void { onRequest(() => { work(); }); }
function work(): void {}
`,
    };
    const DOTTED = {
        "d.ts": `type Router = { get(path: string, cb: () => void): void };
declare const router: Router;
export function setup(): void { router.get('/x', () => { handler(); }); }
function handler(): void {}
`,
    };

    it("promotes a bare-name selector's callback argument to a boundary", () => {
        built = buildAnalysis(BARE, { entryPoints: ["src/b.ts"] });
        expect(built.graph.boundaries().size).toBe(1);
        built.dispose();
        built = buildAnalysis(BARE, {
            entryPoints: ["src/b.ts"],
            handlerBoundaries: [{ callee: "onRequest", callbackArgs: [0] }],
        });
        expect(built.graph.boundaries().size).toBe(2);
    });

    it("promotes a dotted `Interface#method` selector's callback argument", () => {
        built = buildAnalysis(DOTTED, { entryPoints: ["src/d.ts"] });
        expect(built.graph.boundaries().size).toBe(1);
        built.dispose();
        built = buildAnalysis(DOTTED, {
            entryPoints: ["src/d.ts"],
            handlerBoundaries: [{ callee: "Router#get", callbackArgs: [1] }],
        });
        expect(built.graph.boundaries().size).toBe(2);
    });
});
