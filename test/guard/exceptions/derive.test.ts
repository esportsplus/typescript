import { afterAll, describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createThrowIndex, deriveThrows, disposeThrowIndex, type DerivedSummary, type ThrowIndex } from "~/guard/exceptions/derive";

const IMPORTER = path.resolve(import.meta.dirname, "../../fixtures/importer.js");

let index: ThrowIndex = createThrowIndex();

afterAll(() => {
    disposeThrowIndex(index);
});

function classesOf(summary: DerivedSummary | undefined): string[] {
    return summary ? Array.from(summary.classes.keys()).sort() : [];
}

function derive(specifier: string, exportName: string, extra: { awaited?: boolean; importerFileName?: string; memberName?: string } = {}): DerivedSummary | undefined {
    return deriveThrows(index, {
        awaited: extra.awaited ?? false,
        exportName,
        importerFileName: extra.importerFileName ?? IMPORTER,
        memberName: extra.memberName,
        specifier,
    });
}

describe("exceptions derive — export forms", () => {
    it("reads an ESM `export function` throwing TypeError", () => {
        expect(classesOf(derive("esm-throws", "f"))).toEqual(["TypeError"]);
    });

    it("reads a CJS `exports.f` throwing RangeError", () => {
        expect(classesOf(derive("cjs-exports", "f"))).toEqual(["RangeError"]);
    });

    it("reads a CJS `module.exports = { f }` throwing Error", () => {
        expect(classesOf(derive("cjs-object", "f"))).toEqual(["Error"]);
    });

    it("reads a prototype method throwing TypeError", () => {
        expect(classesOf(derive("proto-pkg", "Client", { memberName: "connect" }))).toEqual(["TypeError"]);
    });

    it("resolves through package `exports` conditions", () => {
        expect(classesOf(derive("cond-pkg", "go"))).toEqual(["SyntaxError"]);
    });
});

describe("exceptions derive — reachability", () => {
    it("follows a same-file sibling call", () => {
        expect(classesOf(derive("sibling-pkg", "outer"))).toEqual(["TypeError"]);
    });

    it("follows an imported sibling call", () => {
        expect(classesOf(derive("cross-file-pkg", "run"))).toEqual(["TypeError"]);
    });

    it("terminates on a cycle and still collects the throw", () => {
        expect(classesOf(derive("cycle-pkg", "a"))).toEqual(["Error"]);
    });

    it("stops at the depth cap (a throw seven levels deep is missed)", () => {
        expect(derive("deep-pkg", "f1")).toBeUndefined();
    });
});

describe("exceptions derive — async and awaiting", () => {
    it("counts an async rejection only when the call is awaited", () => {
        expect(classesOf(derive("async-pkg", "load", { awaited: true }))).toEqual(["Error"]);
        expect(derive("async-pkg", "load", { awaited: false })).toBeUndefined();
    });
});

describe("exceptions derive — bounds and resolution", () => {
    it("reads a pure-JS package with no type declaration", () => {
        expect(classesOf(derive("no-types-pkg", "boom"))).toEqual(["Error"]);
    });

    it("skips a minified backing file", () => {
        expect(derive("mini-pkg", "f")).toBeUndefined();
    });

    it("returns undefined for a builtin and an unresolvable specifier", () => {
        expect(derive("node:fs", "readFileSync")).toBeUndefined();
        expect(derive("does-not-exist", "f")).toBeUndefined();
    });
});

describe("exceptions derive — cache invalidation", () => {
    it("re-scans a backing file after its contents change", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "derive-cache-"));
        try {
            const pkg = path.join(dir, "node_modules", "tmp-pkg");
            fs.mkdirSync(pkg, { recursive: true });
            fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ main: "index.js", name: "tmp-pkg", version: "1.0.0" }));
            fs.writeFileSync(path.join(pkg, "index.js"), "exports.f = function () { throw new TypeError('a'); };\n");
            const importer = path.join(dir, "importer.js");
            fs.writeFileSync(importer, "// anchor\n");

            const local = createThrowIndex();
            try {
                expect(classesOf(deriveThrows(local, { awaited: false, exportName: "f", importerFileName: importer, memberName: undefined, specifier: "tmp-pkg" }))).toEqual(["TypeError"]);

                // Different length so both size and mtime change, invalidating the cache.
                fs.writeFileSync(path.join(pkg, "index.js"), "exports.f = function () { throw new Error('b'); };\n");

                expect(classesOf(deriveThrows(local, { awaited: false, exportName: "f", importerFileName: importer, memberName: undefined, specifier: "tmp-pkg" }))).toEqual(["Error"]);
            }
            finally {
                disposeThrowIndex(local);
            }
        }
        finally {
            fs.rmSync(dir, { force: true, recursive: true });
        }
    });
});
