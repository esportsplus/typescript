import * as NodePath from 'node:path';

import * as ts from '~/guard/adapter';

import { analyzeProgram } from '~/guard/kernel/analyze';
import { createThrowIndex, disposeThrowIndex } from '~/guard/exceptions/derive';
import { loadConfigFromTsconfig } from '~/guard/kernel/config';
import { open } from '~/compiler/language-service';

import type { AnalyzeResult } from '~/guard/kernel/analyze';
import type { ThrowIndex } from '~/guard/exceptions/derive';
import type { AnalyzeConfig } from '~/guard/kernel/types';

type Snapshot = ReturnType<ts.API['updateSnapshot']>;

// Owns one long-lived native compiler session for a project and re-runs analyze's
// whole-project analysis against its incrementally-updated program. The API/snapshot
// are live IPC handles; call dispose() when the server shuts the project down.
class AnalyzeWorkspace {
    private api: ts.API;
    readonly configPath: string;
    private snapshot: Snapshot | undefined;
    // Long-lived across saves: the cross-module `.js` scan cache (parsed files +
    // per-export summaries), so incremental re-analysis does not re-read deps.
    private throwIndex: ThrowIndex = createThrowIndex();

    // The parsed `tsc-guard` config, or undefined when the tsconfig opts out of
    // analyze. A configless workspace stays inert — analyze() yields nothing.
    config: AnalyzeConfig | undefined;

    // A rejected/legacy config key: the message the server surfaces as a
    // tsconfig.json diagnostic. Undefined once the config loads cleanly.
    configError: string | undefined;

    constructor(tsconfigPath: string) {
        this.configPath = NodePath.resolve(tsconfigPath);
        this.loadConfig();
        // Open the project once — opens are ref-counted and persist across snapshots,
        // so later refreshes only report the files that changed.
        let opened = open(this.configPath);

        this.api = opened.api;
        this.snapshot = opened.snapshot;
    }

    private loadConfig(): void {
        try {
            this.config = loadConfigFromTsconfig(this.configPath);
            this.configError = undefined;
        }
        catch (error) {
            this.config = undefined;
            this.configError = error instanceof Error ? error.message : String(error);
        }
    }

    // Re-read the `tsc-guard` config after the tsconfig itself changes on disk.
    reloadConfig(): void {
        this.loadConfig();
    }

    // Advance to a fresh snapshot reflecting on-disk edits. `changed` names the
    // saved files; an empty list invalidates everything (e.g. a watched-file batch).
    refresh(changed: ReadonlyArray<string>): void {
        let previous = this.snapshot;

        this.snapshot = this.api.updateSnapshot(
            changed.length === 0
                ? { fileChanges: { invalidateAll: true } }
                : { fileChanges: { changed: changed.map((fileName) => NodePath.resolve(fileName)) } },
        );

        if (previous && !previous.isDisposed()) {
            previous.dispose();
        }
    }

    analyze(): AnalyzeResult | undefined {
        if (!this.config || !this.snapshot) {
            return undefined;
        }

        let project = this.snapshot.getProject(this.configPath);

        if (!project) {
            return undefined;
        }

        return analyzeProgram(project.program, project.checker, this.config, this.throwIndex);
    }

    dispose(): void {
        disposeThrowIndex(this.throwIndex);

        if (this.snapshot && !this.snapshot.isDisposed()) {
            this.snapshot.dispose();
        }

        this.api.close();
    }
}

export { AnalyzeWorkspace };
