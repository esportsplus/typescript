import { afterEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";

import { analyzeProgram } from "~/guard/kernel/analyze";
import { buildProgram } from "~/guard/kernel/program";
import { configFromObject } from "~/guard/kernel/config";
import { createFixtureDir } from "../../cli/fixtures";
import { createThrowIndex, disposeThrowIndex } from "~/guard/exceptions/derive";

import type { Diagnostic } from "~/guard/kernel/types";

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
function analyze(dep: { js: string }, callee: string): ReadonlyArray<Diagnostic> {
    dir = createFixtureDir(".fixture-derivewire-");
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.ts"), `import { ${callee} } from 'dep';\nexport function b(): void { ${callee}(); }\n`);

    const pkg = path.join(dir, "node_modules", "dep");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ main: "index.js", name: "dep", version: "1.0.0" }));
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
            { js: "exports.boom = function () { throw new Error('x'); };\n" },
            "boom",
        );
        expect(diags.length).toBe(1);
        expect(diags[0]!.message).toContain("Call may throw Error");
    });

    it("relates the finding to the throw site inside node_modules", () => {
        const diags = analyze(
            { js: "exports.boom = function () { throw new TypeError('x'); };\n" },
            "boom",
        );
        expect(diags.length).toBe(1);
        expect(diags[0]!.message).toContain("TypeError");
        expect(diags[0]!.related.some((r) => r.location.fileName.replace(/\\/g, "/").includes("/node_modules/dep/index.js"))).toBe(true);
    });
});
