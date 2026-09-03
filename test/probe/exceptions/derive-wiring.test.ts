import { afterEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";

import { analyzeProgram } from "~/probe/kernel/analyze";
import { buildProgram } from "~/probe/kernel/program";
import { configFromObject } from "~/probe/kernel/config";
import { createFixtureDir } from "../../cli/fixtures";
import { createThrowIndex, disposeThrowIndex } from "~/probe/exceptions/derive";

import type { Diagnostic } from "~/probe/kernel/types";

const TSCONFIG = {
    compilerOptions: { allowJs: true, lib: ["esnext"], module: "esnext", moduleResolution: "bundler", noEmit: true, skipLibCheck: true, strict: true, target: "esnext", types: [] as string[] },
    include: ["src"],
};

let dir: string | undefined;

afterEach(() => {
    if (dir) {
        fs.rmSync(dir, { force: true, recursive: true });
        dir = undefined;
    }
});

// Build a fixture project whose `src/a.ts` imports `dep`, run the exceptions
// channel, and return its findings anchored at `b`.
function analyze(dep: { dts: string; js: string }, callee: string): ReadonlyArray<Diagnostic> {
    dir = createFixtureDir(".fixture-derivewire-");
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.ts"), `import { ${callee} } from 'dep';\nexport function b(): void { ${callee}(); }\n`);

    const pkg = path.join(dir, "node_modules", "dep");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ main: "index.js", name: "dep", types: "index.d.ts", version: "1.0.0" }));
    fs.writeFileSync(path.join(pkg, "index.d.ts"), dep.dts);
    fs.writeFileSync(path.join(pkg, "index.js"), dep.js);

    const built = buildProgram(path.join(dir, "tsconfig.json"));
    const index = createThrowIndex();
    try {
        const config = configFromObject({ exceptions: { report: "all", severity: "error" } }, dir);
        return analyzeProgram(built.program, built.checker, config, index)
            .diagnostics.filter((d) => d.channel === "exceptions" && d.message.includes("path to `b`"));
    }
    finally {
        disposeThrowIndex(index);
        built.dispose();
    }
}

describe("exceptions derive — wired into the channel", () => {
    it("derives a third-party throw from the installed .js", () => {
        const diags = analyze(
            { dts: "export declare function boom(): void;\n", js: "exports.boom = function () { throw new Error('x'); };\n" },
            "boom",
        );
        expect(diags.length).toBe(1);
        expect(diags[0]!.message).toContain("Call may throw Error");
    });

    it("prefers a tier-0 @throws declaration over the .js scan", () => {
        const diags = analyze(
            {
                dts: "/**\n * @throws {RangeError}\n */\nexport declare function warn(): void;\n",
                js: "exports.warn = function () { throw new Error('x'); };\n",
            },
            "warn",
        );
        expect(diags.length).toBe(1);
        expect(diags[0]!.message).toContain("RangeError");
    });

    it("relates the finding to the throw site inside node_modules", () => {
        const diags = analyze(
            { dts: "export declare function boom(): void;\n", js: "exports.boom = function () { throw new TypeError('x'); };\n" },
            "boom",
        );
        expect(diags.length).toBe(1);
        expect(diags[0]!.message).toContain("TypeError");
        expect(diags[0]!.related.some((r) => r.location.fileName.replace(/\\/g, "/").includes("/node_modules/dep/index.js"))).toBe(true);
    });
});
