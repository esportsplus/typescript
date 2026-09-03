import { afterEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";

import * as ts from "~/guard/adapter";
import { buildProgram } from "~/guard/kernel/program";
import { createFixtureDir } from "../../cli/fixtures";
import { loadOverlays, mergeOverlayData, overlayKey } from "~/guard/overlay/load";

describe("overlay key format", () => {
    it("renders a bare global, a namespace member, and an interface method", () => {
        expect(overlayKey(undefined, "parseInt", false)).toBe("parseInt");
        expect(overlayKey("JSON", "parse", true)).toBe("JSON.parse");
        expect(overlayKey("Array", "map", false)).toBe("Array#map");
    });
});

describe("overlay merge", () => {
    it("treats a bare file as the exceptions section and a bundle as channel-keyed", () => {
        const merged = mergeOverlayData([
            { name: "bare", text: JSON.stringify({ "lib.es5": { "JSON.parse": { exceptions: ["SyntaxError"] } } }) },
            { name: "bundle", text: JSON.stringify({ overlay: { async: { global: { fetch: { cancellable: true } } } } }) },
        ]);
        expect(merged.entry("exceptions", "lib.es5", "JSON.parse")).toEqual({ exceptions: ["SyntaxError"] });
        expect(merged.entry("async", "global", "fetch")).toEqual({ cancellable: true });
    });

    it("lets a later file win on a colliding key", () => {
        const merged = mergeOverlayData([
            { name: "first", text: JSON.stringify({ "lib.es5": { "JSON.parse": { exceptions: ["SyntaxError"] } } }) },
            { name: "second", text: JSON.stringify({ "lib.es5": { "JSON.parse": { exceptions: [] } } }) },
        ]);
        expect(merged.entry("exceptions", "lib.es5", "JSON.parse")).toEqual({ exceptions: [] });
    });

    it("merges sections across files without dropping earlier keys", () => {
        const merged = mergeOverlayData([
            { name: "a", text: JSON.stringify({ "lib.es5": { RegExp: { exceptions: ["SyntaxError"] } } }) },
            { name: "b", text: JSON.stringify({ "lib.es5": { decodeURI: { exceptions: ["URIError"] } } }) },
        ]);
        expect(merged.entry("exceptions", "lib.es5", "RegExp")).toEqual({ exceptions: ["SyntaxError"] });
        expect(merged.entry("exceptions", "lib.es5", "decodeURI")).toEqual({ exceptions: ["URIError"] });
    });
});

describe("overlay lookup — global fallback for node-declared globals", () => {
    let dispose: (() => void) | undefined;

    afterEach(() => {
        dispose?.();
        dispose = undefined;
    });

    it("resolves `URL` for a Node-only program with no dom lib via the global section", () => {
        const dir = createFixtureDir(".fixture-overlay-");
        try {
            fs.writeFileSync(
                path.join(dir, "tsconfig.json"),
                JSON.stringify({
                    compilerOptions: {
                        lib: ["esnext"],
                        module: "esnext",
                        moduleResolution: "bundler",
                        noEmit: true,
                        skipLibCheck: true,
                        strict: true,
                        target: "esnext",
                        types: ["node"],
                    },
                    include: ["src"],
                }),
            );
            fs.mkdirSync(path.join(dir, "src"), { recursive: true });
            fs.writeFileSync(path.join(dir, "src", "a.ts"), "export function f(x: string): void { new URL(x); }\n");

            const built = buildProgram(path.join(dir, "tsconfig.json"));
            dispose = () => {
                built.dispose();
                fs.rmSync(dir, { force: true, recursive: true });
            };

            const checker = built.checker;
            let sym: ts.Symbol | undefined;
            for (const sf of ts.getSourceFiles(built.program)) {
                if (!sf.fileName.endsWith("/a.ts") && !sf.fileName.endsWith("\\a.ts")) {
                    continue;
                }
                const visit = (node: ts.Node): void => {
                    if (ts.isNewExpression(node)) {
                        let s = checker.getSymbolAtLocation(node.expression);
                        if (s && s.flags & ts.SymbolFlags.Alias) {
                            s = checker.getAliasedSymbol(s);
                        }
                        sym = s ?? sym;
                    }
                    ts.forEachChild(node, visit);
                };
                ts.forEachChild(sf, visit);
            }

            expect(sym).toBeDefined();
            const found = loadOverlays().lookup(sym!, "exceptions");
            expect(found?.pkg).toBe("global");
            expect((found?.entry as { exceptions: string[] }).exceptions).toEqual(["TypeError"]);
        }
        finally {
            if (!dispose) {
                fs.rmSync(dir, { force: true, recursive: true });
            }
        }
    });
});
