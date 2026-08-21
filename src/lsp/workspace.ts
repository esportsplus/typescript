import * as NodePath from 'node:path';

import * as ts from '~/tscheck/adapter';

import { analyzeProgram } from '~/tscheck/kernel/analyze';
import { loadConfigFromTsconfig } from '~/tscheck/kernel/config';

import type { AnalyzeResult } from '~/tscheck/kernel/analyze';
import type { TscheckConfig } from '~/tscheck/kernel/types';

type Snapshot = ReturnType<ts.API['updateSnapshot']>;

// Owns one long-lived native compiler session for a project and re-runs tscheck's
// whole-project analysis against its incrementally-updated program. The API/snapshot
// are live IPC handles; call dispose() when the server shuts the project down.
class TscheckWorkspace {
    private api: ts.API;
    private configPath: string;
    private snapshot: Snapshot | undefined;

    // The parsed tscheck plugin entry, or undefined when the tsconfig opts out of
    // tscheck. A configless workspace stays inert — analyze() yields nothing.
    config: TscheckConfig | undefined;

    constructor(tsconfigPath: string) {
        this.configPath = NodePath.resolve(tsconfigPath);
        this.api = new ts.API({ cwd: NodePath.dirname(this.configPath) });
        this.config = loadConfigFromTsconfig(this.configPath);
        // Open the project once — opens are ref-counted and persist across snapshots,
        // so later refreshes only report the files that changed.
        this.snapshot = this.api.updateSnapshot({ openProjects: [this.configPath] });
    }

    // Re-read the tsconfig plugin entry after the config file itself changes on disk.
    reloadConfig(): void {
        this.config = loadConfigFromTsconfig(this.configPath);
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

        return analyzeProgram(project.program, project.checker, this.config);
    }

    dispose(): void {
        if (this.snapshot && !this.snapshot.isDisposed()) {
            this.snapshot.dispose();
        }

        this.api.close();
    }
}

export { TscheckWorkspace };
