import * as ts from "~/probe/adapter";

import { channelFor } from "../channels";
import { buildCallGraph } from "./graph";
import { buildProgram } from "./program";
import { runChannel } from "./fixpoint";
import { loadOverlays } from "../overlay/load";

import type {
  Analysis,
  Channel,
  ChannelConfig,
  Diagnostic,
  SummaryStore,
  AnalyzeConfig,
} from "./types";

export interface AnalyzeResult {
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

// Analyze an already-built Program — the path the language-service plugin takes,
// reusing the editor's incrementally-updated program instead of building one.
export function analyzeProgram(
  program: ts.Program,
  checker: ts.TypeChecker,
  config: AnalyzeConfig,
): AnalyzeResult {
  const overlays = loadOverlays(config);

  // Preset handler boundaries are kernel config; fold them in before the graph
  // expands boundaries so preset-declared callbacks are analyzed as entries.
  const effectiveConfig: AnalyzeConfig = {
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

  const diagnostics: Diagnostic[] = [];

  const runnable = new Map<string, { config: ChannelConfig; channel: Channel<unknown> }>();
  for (const [name, channelConfig] of Object.entries(effectiveConfig.channels)) {
    if (!channelConfig.enabled) {
      continue;
    }
    runnable.set(name, { config: channelConfig, channel: channelFor(name)! });
  }

  // Order so a channel's declared peer dependencies run first, making their
  // summaries available; a disabled/unimplemented dependency is simply absent.
  const ordered: string[] = [];
  const placed = new Set<string>();
  const place = (name: string, stack: ReadonlySet<string>): void => {
    if (placed.has(name) || !runnable.has(name) || stack.has(name)) {
      return;
    }
    const next = new Set(stack).add(name);
    for (const dep of runnable.get(name)!.channel.dependsOn ?? []) {
      place(dep, next);
    }
    placed.add(name);
    ordered.push(name);
  };
  for (const name of runnable.keys()) {
    place(name, new Set());
  }

  const peers = new Map<string, SummaryStore<unknown>>();
  for (const name of ordered) {
    const { config, channel } = runnable.get(name)!;
    const result = runChannel(analysis, channel, config.dispatch, config.options, peers);
    peers.set(name, result.store);
    diagnostics.push(...result.diagnostics);
  }

  return { diagnostics };
}

// Build a Program from the config's tsconfig, then analyze it — the CLI path.
export function analyze(config: AnalyzeConfig): AnalyzeResult {
  const built = buildProgram(config.tsconfigPath);
  try {
    return analyzeProgram(built.program, built.checker, config);
  } finally {
    built.dispose();
  }
}
