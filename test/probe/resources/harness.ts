import fs from "node:fs";
import path from "node:path";

import { analyzeProgram } from "~/probe/kernel/analyze";
import { buildProgram } from "~/probe/kernel/program";
import { configFromObject } from "~/probe/kernel/config";
import { createFixtureDir } from "../../cli/fixtures";

import type { Diagnostic, Dispatch } from "~/probe/kernel/types";

// A self-contained on-disk fixture project: one tsconfig plus a set of source
// files. Fixtures live under storage/ (inside the repo) so lib resolution walks
// up to the repo node_modules, matching the CLI's own fixture strategy.
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
    readonly dispatch?: Dispatch;
    readonly options?: unknown;
    readonly entry?: string;
    // Enable the exceptions channel too, so resources can consult its throw
    // summaries via the kernel peer API. Callers filter to `channel === "resources"`.
    readonly exceptions?: boolean;
}

// Build a fixture project from `sources` (relative path -> TS text), run ONLY the
// resources channel over it, and return its diagnostics. `entry` selects the
// entry-point glob (default: the whole src tree).
export const analyzeFixture = (
    sources: Record<string, string>,
    opts: AnalyzeOptions = {},
): ReadonlyArray<Diagnostic> => {
    const dir = createFixtureDir(".fixture-resources-");
    try {
        fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG));
        for (const [rel, text] of Object.entries(sources)) {
            const target = path.join(dir, "src", rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, text);
        }
        const built = buildProgram(path.join(dir, "tsconfig.json"));
        try {
            const config = configFromObject(
                {
                    channels: {
                        exceptions: { enabled: opts.exceptions ?? false },
                        // parseChannels folds every key other than enabled/dispatch
                        // into the channel's opaque options, so spread them directly.
                        resources: {
                            dispatch: opts.dispatch ?? "pessimist",
                            enabled: true,
                            ...(typeof opts.options === "object" && opts.options !== null ? opts.options : {}),
                        },
                    },
                    entryPoints: [opts.entry ?? "src/**/*.ts"],
                },
                dir,
            );
            return analyzeProgram(built.program, built.checker, config).diagnostics;
        }
        finally {
            built.dispose();
        }
    }
    finally {
        fs.rmSync(dir, { force: true, recursive: true });
    }
};
