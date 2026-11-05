import * as ts from '../adapter';
import { PACKAGE_NAME } from '../../constants';

import checkers from '../checker';
import path from 'path';

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
    const configFileName = path.resolve(tsconfigPath).replace(/\\/g, '/');
    const api = new ts.API({ cwd: path.dirname(configFileName) });
    const snapshot = api.createSnapshot({ openProjects: [configFileName] });
    const project = snapshot.getConfiguredProject(configFileName);

    const dispose = (): void => {
        if (!snapshot.isDisposed()) {
            snapshot.dispose();
        }

        api.close();
    };

    if (!project) {
        dispose();
        throw new Error(`${PACKAGE_NAME}: project not found for ${configFileName}`);
    }

    for (const diagnostic of project.program.getConfigFileParsingDiagnostics()) {
        if (diagnostic.category === ts.DiagnosticCategory.Error) {
            dispose();
            throw new Error(`${PACKAGE_NAME}: error parsing tsconfig.json ${diagnostic.text}`);
        }
    }

    checkers.attach(api, project);

    return {
        checker: project.checker,
        dispose,
        program: project.program,
    };
}


export { buildProgram };
