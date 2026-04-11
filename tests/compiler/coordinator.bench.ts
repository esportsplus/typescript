import { bench, describe, vi } from 'vitest';
import ts from 'typescript';

import type { Plugin, TransformContext } from '~/compiler/types';

import coordinator from '~/compiler/coordinator';


vi.mock('~/compiler/language-service', () => ({
    default: {
        invalidate: vi.fn(),
        update: vi.fn((_root: string, fileName: string, content: string) => {
            let file = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);

            return {
                getSourceFile: () => file,
                getTypeChecker: () => ({} as ts.TypeChecker)
            } as unknown as ts.Program;
        })
    }
}));


function parse(code: string, fileName = 'bench.ts'): ts.SourceFile {
    return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
}

function makeProgram(file: ts.SourceFile): ts.Program {
    return {
        getSourceFile: () => file,
        getTypeChecker: () => ({} as ts.TypeChecker)
    } as unknown as ts.Program;
}

function makePlugin(transformFn: (ctx: TransformContext) => ReturnType<Plugin['transform']>): Plugin {
    return { transform: transformFn };
}


let code = 'let x = 1;',
    file = parse(code),
    program = makeProgram(file);

describe('applyImports batching', () => {
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

        coordinator.transform([plugin], code, file, program, '/root', new Map());
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

        coordinator.transform([plugin], code, file, program, '/root', new Map());
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

        coordinator.transform([plugin], code, file, program, '/root', new Map());
    });
});
