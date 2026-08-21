import * as NodePath from "node:path";

import * as ts from "~/probe/adapter";

export type BuiltProgram = {
    program: ts.Program;
    checker: ts.Checker;
    strict: boolean;
    // The snapshot/api own the compiler server; dispose once analysis is done.
    dispose(): void;
};

// Build a host Program + Checker from a tsconfig via the native sync API. `strict`
// reports whether the resolved options prove the null-safety floor the kernel's
// guarantee notice keys off of. The returned `dispose` must be called after all
// analysis is finished (the program/checker are live handles into a server).
export function buildProgram(tsconfigPath: string): BuiltProgram {
    const configPath = NodePath.resolve(tsconfigPath);
    const api = new ts.API({ cwd: NodePath.dirname(configPath) });
    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath);

    if (!project) {
        snapshot.dispose();
        api.close();
        throw new Error(`analyze program: project not found for ${configPath}`);
    }

    const { program, checker } = project;
    const options = program.getCompilerOptions();
    const strict = options.strict === true || options.strictNullChecks === true;

    return {
        program,
        checker,
        strict,
        dispose() {
            if (!snapshot.isDisposed()) {
                snapshot.dispose();
            }
            api.close();
        },
    };
}
