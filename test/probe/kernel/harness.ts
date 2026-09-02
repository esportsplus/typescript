import fs from "node:fs";
import path from "node:path";

import { buildCallGraph } from "~/probe/kernel/graph";
import { buildProgram } from "~/probe/kernel/program";
import { configFromObject } from "~/probe/kernel/config";
import { createFixtureDir } from "../../cli/fixtures";
import { loadOverlays } from "~/probe/overlay/load";

import type { Analysis, CallGraph } from "~/probe/kernel/types";

const TSCONFIG = {
    compilerOptions: {
        lib: ["esnext"],
        module: "esnext",
        moduleResolution: "bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "esnext",
        types: [],
    },
    include: ["src"],
};

interface GraphOptions {
    readonly entryPoints?: ReadonlyArray<string>;
    readonly handlerBoundaries?: unknown;
}

export interface BuiltAnalysis {
    readonly analysis: Analysis;
    readonly graph: CallGraph;
    dispose(): void;
}

// Build a full kernel Analysis (program + checker + graph + overlays) from inline
// sources so graph and fixpoint units can drive the real pipeline.
export const buildAnalysis = (
    sources: Record<string, string>,
    opts: GraphOptions = {},
): BuiltAnalysis => {
    const dir = createFixtureDir(".fixture-kernel-");
    let disposed = false;
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG));
    for (const [rel, text] of Object.entries(sources)) {
        const target = path.join(dir, "src", rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
    }
    const built = buildProgram(path.join(dir, "tsconfig.json"));
    const config = configFromObject(
        {
            channels: { exceptions: { enabled: true } },
            entryPoints: opts.entryPoints ?? [],
            ...(opts.handlerBoundaries !== undefined ? { handlerBoundaries: opts.handlerBoundaries } : {}),
        },
        dir,
    );
    const overlays = loadOverlays(config);
    const graph = buildCallGraph(built.program, built.checker, config, overlays);
    const analysis: Analysis = {
        program: built.program,
        checker: built.checker,
        config,
        overlays,
        graph,
    };

    return {
        analysis,
        graph,
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            built.dispose();
            fs.rmSync(dir, { force: true, recursive: true });
        },
    };
};

export const reachedNames = (graph: CallGraph): Set<string> => {
    return new Set(graph.reachedFunctions().map((f) => f.name));
};
