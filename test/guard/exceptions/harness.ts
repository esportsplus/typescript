import fs from "node:fs";
import path from "node:path";

import { analyzeProgram } from "~/guard/kernel/analyze";
import { buildProgram } from "~/guard/kernel/program";
import { configFromObject } from "~/guard/kernel/config";
import { createFixtureDir } from "../../cli/fixtures";

import type { Diagnostic } from "~/guard/kernel/types";

const TSCONFIG = {
    compilerOptions: {
        lib: ["esnext", "dom"],
        module: "esnext",
        moduleResolution: "bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "esnext",
    },
    include: ["src"],
};

interface AnalyzeOptions {
    // Restrict @types to node so `node:*` built-in models resolve deterministically.
    readonly nodeTypes?: boolean;
    readonly report?: "all" | "consumers" | "cross-module";
}

// Build a fixture project from `sources` (relative path -> TS text), run ONLY the
// exceptions channel over it (whole-project mode: every function is a boundary),
// and return its diagnostics.
export const analyzeFixture = (
    sources: Record<string, string>,
    opts: AnalyzeOptions = {},
): ReadonlyArray<Diagnostic> => {
    const dir = createFixtureDir(".fixture-exceptions-");
    try {
        const tsconfig = opts.nodeTypes
            ? { ...TSCONFIG, compilerOptions: { ...TSCONFIG.compilerOptions, types: ["node"] } }
            : TSCONFIG;
        fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
        for (const [rel, text] of Object.entries(sources)) {
            const target = path.join(dir, "src", rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, text);
        }
        const built = buildProgram(path.join(dir, "tsconfig.json"));
        try {
            const config = configFromObject(
                {
                    exceptions: {
                        severity: "error",
                        ...(opts.report !== undefined ? { report: opts.report } : {}),
                    },
                },
                dir,
            );
            return analyzeProgram(built.program, built.checker, config)
                .diagnostics.filter((d) => d.channel === "exceptions");
        }
        finally {
            built.dispose();
        }
    }
    finally {
        fs.rmSync(dir, { force: true, recursive: true });
    }
};
