import { afterAll, describe, test } from 'vitest';
import type { Checker, Program } from 'typescript/async';
import { isBinaryExpression, isIdentifier } from 'typescript/ast/is';
import type { Node, SourceFile } from 'typescript/ast';
import type { Plugin, ReplacementIntent, TransformContext } from '~/compiler/types';

import coordinator from '~/compiler/coordinator';
import languageService from '~/compiler/language-service';
import { buildGeneration, toSourceMapV3 } from '~/compiler/sourcemap';
import path from 'path';


const root = process.cwd().split(path.sep).join('/');

const fileName = root + '/src/coordinator-bench-fixture.ts';


let code = 'let x = 1;',
    file = await parse(code),
    project = makeProject(file);

const sourceMapOriginal = Array.from(
    { length: 2_000 },
    (_, index) => `let value${index} = ${index};`,
).join('\n');
const sourceMapEdits = Array.from({ length: 2_000 }, (_, index) => {
    const start = sourceMapOriginal.indexOf(`let value${index}`);
    return { end: start, newText: '/* transformed */ ', start };
});
const sourceMapTransformed = sourceMapEdits
    .toReversed()
    .reduce((text, edit) => text.slice(0, edit.start) + edit.newText + text.slice(edit.end), sourceMapOriginal);
const sourceMapGeneration = buildGeneration(sourceMapOriginal, sourceMapEdits);


function makePlugin(transformFn: (ctx: TransformContext) => Awaited<ReturnType<Plugin['transform']>>): Plugin {
    return { transform: async (ctx) => transformFn(ctx) };
}

function makeProject(file: SourceFile): { checker: Checker; program: Program } {
    return {
        checker: {} as unknown as Checker,
        program: { getSourceFile: () => file } as unknown as Program
    };
}

function parse(code: string, name = fileName): Promise<SourceFile> {
    return languageService.parse(name, code);
}


describe('applyImports batching', () => {
    afterAll(async () => {
        await languageService.dispose();
    });

    test('10 intents, 1 package', async ({ bench }) => {
        await bench('10 intents, 1 package', async () => {
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

            await coordinator.transform([plugin], code, file, project, '/root', new Map());
        }).run();
    });

    test('10 intents, 3 packages', async ({ bench }) => {
        await bench('10 intents, 3 packages', async () => {
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

            await coordinator.transform([plugin], code, file, project, '/root', new Map());
        }).run();
    });

    test('10 intents, 10 packages', async ({ bench }) => {
        await bench('10 intents, 10 packages', async () => {
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

            await coordinator.transform([plugin], code, file, project, '/root', new Map());
        }).run();
    });
});

// Many intents, each generating from text(): one plugin rewrites every read, another every
// initializer around them through text()
let statements = 2_000,
    source = Array.from({ length: statements }, (_, index) => `let v${index} = a${index} + b${index};`).join('\n'),
    tree = await parse(source, root + '/src/coordinator-bench-composition.ts');

describe('replacement composition', () => {
    let initializers: Node[] = [],
        reads: Node[] = [];

    tree.forEachChild(function visit(node) {
        if (isBinaryExpression(node)) {
            initializers.push(node);
        }
        else if (isIdentifier(node) && node.text.startsWith('a')) {
            reads.push(node);
        }

        node.forEachChild(visit);
    });

    let inner = makePlugin(() => ({
            replacements: reads.map((node): ReplacementIntent => ({ generate: () => `${(node as Node & { text: string }).text}.value`, node }))
        })),
        outer = makePlugin(() => ({
            replacements: initializers.map((node): ReplacementIntent => ({ generate: (_sf, text) => `wrap(${text(node)})`, node }))
        }));

    test(`${statements * 2} intents, ${statements} text() calls`, async ({ bench }) => {
        await bench(`${statements * 2} intents, ${statements} text() calls`, async () => {
            await coordinator.transform([inner, outer], source, tree, makeProject(tree), '/root', new Map());
        }).run();
    });
});

describe('toSourceMapV3', () => {
    test('2,000 transformed lines', async ({ bench }) => {
        await bench('2,000 transformed lines', () => {
            toSourceMapV3(
                { generations: [sourceMapGeneration] },
                sourceMapTransformed,
                sourceMapOriginal,
                'fixture.ts',
            );
        }).run();
    });
});
