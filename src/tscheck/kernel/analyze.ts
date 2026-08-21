import * as ts from "~/tscheck/adapter";

import { channelFor, implementedChannels } from "../channels/registry";
import { buildCallGraph } from "./graph";
import { buildProgram } from "./program";
import { runChannel } from "./fixpoint";
import { loadOverlays } from "../overlay/load";

import type { Analysis, Diagnostic, FunctionInfo, TscheckConfig } from "./types";

export interface AnalyzeResult {
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly reachedFunctions: ReadonlyArray<FunctionInfo>;
  // Non-error, one-time messages (e.g. the non-strict guarantee-floor notice).
  readonly notices: ReadonlyArray<string>;
  // Channels requested in config that have no landed implementation yet.
  readonly skippedChannels: ReadonlyArray<string>;
}

// Whether a program's options prove the null-safety floor the notice keys off.
function isStrict(options: ts.CompilerOptions): boolean {
  return options.strict === true || options.strictNullChecks === true;
}

// Analyze an already-built Program — the path the language-service plugin takes,
// reusing the editor's incrementally-updated program instead of building one.
export function analyzeProgram(
  program: ts.Program,
  checker: ts.TypeChecker,
  config: TscheckConfig,
): AnalyzeResult {
  const strict = isStrict(program.getCompilerOptions());
  const overlays = loadOverlays(config);

  // Preset handler boundaries are kernel config; fold them in before the graph
  // expands boundaries so preset-declared callbacks are analyzed as entries.
  const effectiveConfig: TscheckConfig = {
    ...config,
    handlerBoundaries: [
      ...config.handlerBoundaries,
      ...overlays.boundariesFromPresets(),
    ],
  };

  const graph = buildCallGraph(program, checker, effectiveConfig, overlays);
  const analysis: Analysis = {
    program,
    checker,
    config: effectiveConfig,
    overlays,
    graph,
  };

  const notices: string[] = [];
  if (!strict) {
    notices.push(
      "tscheck: tsconfig is not strict — the guarantee floor is whatever your tsconfig proves.",
    );
  }

  const diagnostics: Diagnostic[] = [];
  const skippedChannels: string[] = [];
  const implemented = new Set(implementedChannels());

  for (const [name, channelConfig] of Object.entries(effectiveConfig.channels)) {
    if (!channelConfig.enabled) {
      continue;
    }
    if (!implemented.has(name)) {
      skippedChannels.push(name);
      continue;
    }
    const channel = channelFor(name)!;
    const result = runChannel(
      analysis,
      channel,
      channelConfig.dispatch,
      channelConfig.options,
    );
    diagnostics.push(...result.diagnostics);
  }

  return {
    diagnostics,
    reachedFunctions: graph.reachedFunctions(),
    notices,
    skippedChannels,
  };
}

// Build a Program from the config's tsconfig, then analyze it — the CLI path.
export function analyze(config: TscheckConfig): AnalyzeResult {
  const built = buildProgram(config.tsconfigPath);
  try {
    return analyzeProgram(built.program, built.checker, config);
  } finally {
    built.dispose();
  }
}
