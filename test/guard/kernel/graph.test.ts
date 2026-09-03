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

describe("call graph — whole-project reachability", () => {
    it("interns every project function, whether called or not", () => {
        built = buildAnalysis(IMPORT_TREE);
        const names = reachedNames(built.graph);
        // Whole-project mode makes every function an entry, so even uncalled
        // (`orphanA`) and cross-file-unreferenced (`isolatedC`) functions are in.
        for (const name of ["entryA", "helperA", "deep", "orphanA", "isolatedC"]) {
            expect(names.has(name)).toBe(true);
        }
    });

});

describe("call graph — first-party guard", () => {
    it("never interns a function body that lives under node_modules", () => {
        built = buildAnalysis(
            {
                "a.ts": `import { dep } from 'dep';
export function useDep(): void { dep(); }
`,
            },
            {
                files: {
                    "node_modules/dep/package.json": JSON.stringify({ main: "index.js", name: "dep", version: "1.0.0" }),
                    "node_modules/dep/index.js": `function dep() { throw new Error('boom'); }
module.exports = { dep };
`,
                },
            },
        );
        const names = reachedNames(built.graph);
        expect(names.has("useDep")).toBe(true);
        expect(names.has("dep")).toBe(false);
    });
});
