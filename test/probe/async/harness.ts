import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { analyzeProgram } from "~/probe/kernel/analyze";
import { buildProgram, type BuiltProgram } from "~/probe/kernel/program";
import { configFromObject } from "~/probe/kernel/config";
import type { Diagnostic, Dispatch } from "~/probe/kernel/types";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const FIXTURES = NodePath.join(HERE, "fixtures");

export interface AsyncRunOptions {
    readonly dispatch?: Dispatch;
    readonly fanOut?: "error" | "off" | "warn";
    readonly fanOutAllowLiteralUpTo?: number;
    readonly poolFunctions?: ReadonlyArray<string>;
}

export function buildFixtures(): BuiltProgram {
    return buildProgram(NodePath.join(FIXTURES, "tsconfig.json"));
}

// Run only the async channel over the built fixture program with the given
// options, returning the async diagnostics (exceptions is disabled so noise from
// the fixtures' own throws never leaks in).
export function runAsync(built: BuiltProgram, opts: AsyncRunOptions = {}): ReadonlyArray<Diagnostic> {
    const { dispatch = "optimist", ...options } = opts;
    const config = configFromObject(
        {
            entryPoints: [],
            channels: {
                async: { enabled: true, dispatch, ...options },
                exceptions: { enabled: false },
            },
        },
        FIXTURES,
    );
    const result = analyzeProgram(built.program, built.checker, config);
    return result.diagnostics.filter((d) => d.channel === "async");
}

export function inFile(diags: ReadonlyArray<Diagnostic>, file: string): ReadonlyArray<Diagnostic> {
    return diags.filter((d) => d.location.fileName.replace(/\\/g, "/").endsWith(`/${file}`));
}
