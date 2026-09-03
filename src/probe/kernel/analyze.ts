import * as ts from '~/probe/adapter';

import { channelFor } from '../channels';
import { buildCallGraph } from './graph';
import { buildProgram } from './program';
import { createThrowIndex, disposeThrowIndex } from '../exceptions/derive';
import { runChannel } from './fixpoint';
import { loadOverlays } from '../overlay/load';

import type {
    Analysis,
    Channel,
    ChannelConfig,
    Diagnostic,
    SummaryStore,
    AnalyzeConfig,
} from './types';
import type { ThrowIndex } from '../exceptions/derive';

type AnalyzeResult  = {
    readonly diagnostics: ReadonlyArray<Diagnostic>;
};

type Runnable = { config: ChannelConfig; channel: Channel<unknown> };

// Analyze an already-built Program — the path the language-service plugin takes,
// reusing the editor's incrementally-updated program instead of building one.
// `throwIndex` (the cross-module `.js` scan cache) is owned by a long-lived caller
// (AnalyzeWorkspace in the LSP) so it survives across saves; when absent, a
// short-lived one is created and disposed per call (the CLI path).
function analyzeProgram(
    program: ts.Program,
    checker: ts.TypeChecker,
    config: AnalyzeConfig,
    throwIndex?: ThrowIndex,
): AnalyzeResult {
    const index = throwIndex ?? createThrowIndex();
    try {
        return runAnalysis(program, checker, config, index);
    } finally {
        if (!throwIndex) {
            disposeThrowIndex(index);
        }
    }
}

function runAnalysis(
    program: ts.Program,
    checker: ts.TypeChecker,
    config: AnalyzeConfig,
    throwIndex: ThrowIndex,
): AnalyzeResult {
    const overlays = loadOverlays();
    const graph = buildCallGraph(program, checker, overlays);
    const analysis: Analysis = { program, checker, config, overlays, graph };

    const built = new Map<string, Runnable>();
    const instance = (name: string): Runnable | undefined => {
        const cached = built.get(name);
        if (cached) {
            return cached;
        }
        const channelConfig = config.channels[name];
        const channel = channelConfig
            ? channelFor(name, channelConfig.options, throwIndex)
            : undefined;
        if (!channelConfig || !channel) {
            return undefined;
        }
        const entry: Runnable = { config: channelConfig, channel };
        built.set(name, entry);
        return entry;
    };

    // Enabled = every channel not turned `off`. Its diagnostics are reported.
    const enabled = new Set<string>();
    for (const [name, channelConfig] of Object.entries(config.channels)) {
        if (channelConfig.severity !== 'off') {
            enabled.add(name);
        }
    }

    // Runnable = enabled channels plus any channel they transitively `dependsOn`,
    // even when that dependency is `off` (a silent peer: it runs so its summaries
    // exist, but its diagnostics are discarded).
    const runnable = new Set<string>();
    const include = (name: string, stack: ReadonlySet<string>): void => {
        if (runnable.has(name) || stack.has(name)) {
            return;
        }
        const inst = instance(name);
        if (!inst) {
            return;
        }
        const next = new Set(stack).add(name);
        for (const dep of inst.channel.dependsOn ?? []) {
            include(dep, next);
        }
        runnable.add(name);
    };
    for (const name of enabled) {
        include(name, new Set());
    }

    // Order so a channel's declared peer dependencies run first, making their
    // summaries available.
    const ordered: string[] = [];
    const placed = new Set<string>();
    const place = (name: string, stack: ReadonlySet<string>): void => {
        if (placed.has(name) || !runnable.has(name) || stack.has(name)) {
            return;
        }
        const next = new Set(stack).add(name);
        for (const dep of instance(name)!.channel.dependsOn ?? []) {
            place(dep, next);
        }
        placed.add(name);
        ordered.push(name);
    };
    for (const name of runnable) {
        place(name, new Set());
    }

    const diagnostics: Diagnostic[] = [];
    const peers = new Map<string, SummaryStore<unknown>>();
    for (const name of ordered) {
        const { config: channelConfig, channel } = instance(name)!;
        const result = runChannel(
            analysis,
            channel,
            channelConfig.dispatch,
            channelConfig.options,
            peers,
        );
        peers.set(name, result.store);
        // Silent peer: pulled in only as a dependency of an enabled channel; keep
        // its summaries for that channel, discard its own diagnostics.
        if (enabled.has(name)) {
            diagnostics.push(...result.diagnostics);
        }
    }

    return { diagnostics };
}

// Build a Program from the config's tsconfig, then analyze it — the CLI path.
function analyze(config: AnalyzeConfig): AnalyzeResult {
    const built = buildProgram(config.tsconfigPath);
    try {
        return analyzeProgram(built.program, built.checker, config);
    } finally {
        built.dispose();
    }
}


export { analyze, analyzeProgram, type AnalyzeResult };
