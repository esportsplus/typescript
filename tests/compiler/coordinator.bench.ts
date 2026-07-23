import { afterAll, bench, describe } from 'vitest';
import path from 'path';
import type { SourceFile } from 'typescript/unstable/ast';
import type { Checker, Program } from 'typescript/unstable/sync';

import type { Plugin, TransformContext } from '~/compiler/types';

import coordinator from '~/compiler/coordinator';
import * as languageService from '~/compiler/language-service';


const root = process.cwd().split(path.sep).join('/');

const fileName = root + '/src/coordinator-bench-fixture.ts';


function makePlugin(transformFn: (ctx: TransformContext) => ReturnType<Plugin['transform']>): Plugin {
    return { transform: transformFn };
}

function makeProject(file: SourceFile): { checker: Checker; program: Program } {
    return {
        checker: {} as unknown as Checker,
        program: { getSourceFile: () => file } as unknown as Program
    };
}

function parse(code: string, name = fileName): SourceFile {
    return languageService.parse(name, code);
}


let code = 'let x = 1;',
    file = parse(code),
    project = makeProject(file);

describe('applyImports batching', () => {
    afterAll(() => {
        languageService.dispose();
    });

    bench('10 intents, 1 package', () => {
        let plugin = makePlugin(() => ({
            imports: [
                { add: ['a'], package: '@pkg/a' },
                { add: ['b'], package: '@pkg/a' },
                { add: ['c'], package: '@pkg/a' },
                { add: ['d'], package: '@pkg/a' },
                { add: ['e'], package: '@pkg/a' },
                { add: ['f'], package: '@pkg/a' },
                { add: ['g'], package: '@pkg/a' },
                { add: ['h'], package: '@pkg/a' },
                { add: ['i'], package: '@pkg/a' },
                { add: ['j'], package: '@pkg/a' }
            ]
        }));

        coordinator.transform([plugin], code, file, project, '/root', new Map());
    });

    bench('10 intents, 3 packages', () => {
        let plugin = makePlugin(() => ({
            imports: [
                { add: ['a'], package: '@pkg/a' },
                { add: ['b'], package: '@pkg/a' },
                { add: ['c'], package: '@pkg/a' },
                { add: ['d'], package: '@pkg/b' },
                { add: ['e'], package: '@pkg/b' },
                { add: ['f'], package: '@pkg/b' },
                { add: ['g'], package: '@pkg/b' },
                { add: ['h'], package: '@pkg/c' },
                { add: ['i'], package: '@pkg/c' },
                { add: ['j'], package: '@pkg/c' }
            ]
        }));

        coordinator.transform([plugin], code, file, project, '/root', new Map());
    });

    bench('10 intents, 10 packages', () => {
        let plugin = makePlugin(() => ({
            imports: [
                { add: ['a'], package: '@pkg/a' },
                { add: ['b'], package: '@pkg/b' },
                { add: ['c'], package: '@pkg/c' },
                { add: ['d'], package: '@pkg/d' },
                { add: ['e'], package: '@pkg/e' },
                { add: ['f'], package: '@pkg/f' },
                { add: ['g'], package: '@pkg/g' },
                { add: ['h'], package: '@pkg/h' },
                { add: ['i'], package: '@pkg/i' },
                { add: ['j'], package: '@pkg/j' }
            ]
        }));

        coordinator.transform([plugin], code, file, project, '/root', new Map());
    });
});
