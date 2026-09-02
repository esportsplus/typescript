import * as ts from '~/probe/adapter';
import { open } from '~/compiler/language-service';

export type BuiltProgram = {
    program: ts.Program;
    checker: ts.Checker;
    // The snapshot/api own the compiler server; dispose once analysis is done.
    dispose(): void;
};

// Build a host Program + Checker from a tsconfig via the native sync API. The
// returned `dispose` must be called after all analysis is finished (the
// program/checker are live handles into a server).
function buildProgram(tsconfigPath: string): BuiltProgram {
    const opened = open(tsconfigPath);
    const { program, checker } = opened.project;

    return {
        program,
        checker,
        dispose() {
            opened.dispose();
        },
    };
}


export { buildProgram };
