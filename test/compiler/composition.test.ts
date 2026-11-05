import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Node, SourceFile } from 'typescript/ast';
import {
    isArrowFunction, isCallExpression, isIdentifier, isPropertyAccessExpression, isTaggedTemplateExpression,
    isTemplateExpression, isVariableDeclaration
} from 'typescript/ast/is';
import type { Plugin, ReplacementIntent } from '~/compiler/types';

import coordinator from '~/compiler/coordinator';
import fs from 'fs';
import languageService from '~/compiler/language-service';
import path from 'path';
import references from '~/compiler/references';


type Text = (node: Node) => string;


const FILES: Record<string, string> = {
    'node_modules/fake-reactivity/index.d.ts': 'export declare function reactive<T>(value: T): T;',
    'node_modules/fake-reactivity/package.json': JSON.stringify({ name: 'fake-reactivity', types: './index.d.ts' }),
    'node_modules/fake-template/index.d.ts': [
        'export declare const html: (strings: TemplateStringsArray, ...values: unknown[]) => string;',
        'export declare const tpl: (id: number, values: unknown[]) => string;'
    ].join('\n'),
    'node_modules/fake-template/package.json': JSON.stringify({ name: 'fake-template', types: './index.d.ts' })
};

const VIEW = [
    "import { reactive } from 'fake-reactivity';",
    "import { html } from 'fake-template';",
    '',
    'let count = reactive(0),',
    '    view = reactive(() => html`<p>static ${1}</p>`);',
    '',
    'export const render = () => html`<div class=${count + 1}>${html`<span>${count}</span>`}${view}</div>`;',
    'export const total = count * 2;',
    ''
].join('\n');

// What the staged pipeline (the later plugin type-checking the earlier one's output on a second
// program) produced for VIEW
const STAGED = [
    "import * as ns from 'fake-reactivity';",
    "import { tpl } from 'fake-template';",
    'const templates = [["<p>static ","</p>"],["<div class=",">","","</div>"],["<span>","</span>"]];',
    '',
    'const reactivity = 1;',
    '',
    '',
    'let count = ns.reactive(0),',
    '    view = ns.reactive(() => tpl(0, [1]));',
    '',
    'export const render = () => tpl(1, [count.value + 1, tpl(2, [count.value]), view]);',
    'export const total = count.value * 2;',
    ''
].join('\n');


let fixture: string;


function walk(node: Node, visit: (node: Node) => void): void {
    visit(node);
    node.forEachChild(child => walk(child, visit));
}

// Rewrites `reactive(x)` to `ns.reactive(x)` and every read of `count` to `count.value`
function reactivity(): Plugin {
    return {
        transform: async ({ sourceFile }) => {
            let replacements: ReplacementIntent[] = [];

            walk(sourceFile, node => {
                if (isCallExpression(node) && isIdentifier(node.expression) && node.expression.text === 'reactive') {
                    let argument = node.arguments[0];

                    replacements.push({
                        generate: (sf: SourceFile, text?: Text) => `ns.reactive(${text ? text(argument) : argument.getText(sf)})`,
                        node
                    });
                }
                else if (
                    isIdentifier(node) &&
                    node.text === 'count' &&
                    !(node.parent && isVariableDeclaration(node.parent) && node.parent.name === node) &&
                    !(node.parent && isPropertyAccessExpression(node.parent))
                ) {
                    replacements.push({ generate: () => 'count.value', node });
                }
            });

            if (replacements.length === 0) {
                return {};
            }

            return {
                imports: [{ namespace: 'ns', package: 'fake-reactivity', remove: ['reactive'] }],
                prepend: ['const reactivity = 1;'],
                replacements
            };
        }
    };
}

// Lowers every outermost template whose tag resolves to fake-template's html, nested templates
// included, copying each expression it keeps into the generated call
function template(): Plugin {
    return {
        transform: async ({ checker, program, sourceFile }) => {
            let targets = new Set((await references.exported(checker, program, 'fake-template', 'html')).map(references.key)),
                tags = new Set<Node>(),
                strings: string[][] = [],
                replacements: ReplacementIntent[] = [];

            for (let [identifier, origin] of await references.origins(checker, program, sourceFile)) {
                if (await references.holds(checker, program, origin, targets)) {
                    tags.add(identifier);
                }
            }

            let ids = new Map<Node, number>(),
                lowered = (node: Node): node is Node & { tag: Node; template: Node } => isTaggedTemplateExpression(node) && tags.has(node.tag);

            let register = (node: Node & { template: Node }): void => {
                let parts: string[] = [];

                ids.set(node, strings.length);
                strings.push(parts);

                if (isTemplateExpression(node.template)) {
                    parts.push(node.template.head.text);

                    for (let i = 0, n = node.template.templateSpans.length; i < n; i++) {
                        let span = node.template.templateSpans[i];

                        if (lowered(span.expression)) {
                            register(span.expression);
                        }

                        parts.push(span.literal.text);
                    }
                }
            };

            let render = (node: Node & { template: Node }, sf: SourceFile, text?: Text): string => {
                let values: string[] = [];

                if (isTemplateExpression(node.template)) {
                    for (let i = 0, n = node.template.templateSpans.length; i < n; i++) {
                        let expression = node.template.templateSpans[i].expression;

                        values.push(lowered(expression) ? render(expression, sf, text) : text ? text(expression) : expression.getText(sf));
                    }
                }

                return `tpl(${ids.get(node)}, [${values.join(', ')}])`;
            };

            walk(sourceFile, node => {
                if (!lowered(node)) {
                    return;
                }

                for (let parent = node.parent; parent; parent = parent.parent) {
                    if (lowered(parent)) {
                        return;
                    }

                    if (isArrowFunction(parent) && parent.parent && isCallExpression(parent.parent)) {
                        break;
                    }
                }

                register(node);
                replacements.push({ generate: (sf: SourceFile, text?: Text) => render(node, sf, text), node });
            });

            if (replacements.length === 0) {
                return {};
            }

            return {
                imports: [{ add: ['tpl'], package: 'fake-template', remove: ['html'] }],
                prepend: [`const templates = ${JSON.stringify(strings)};`],
                replacements
            };
        }
    };
}


beforeAll(async () => {
    fixture = fs.mkdtempSync(path.join(process.cwd(), 'test/.composition-')).replace(/\\/g, '/');

    for (let [name, code] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(fixture, name)), { recursive: true });
        fs.writeFileSync(path.join(fixture, name), code);
    }

    fs.mkdirSync(path.join(fixture, 'src'));
    fs.writeFileSync(path.join(fixture, 'src/view.ts'), VIEW);
    fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true, target: 'esnext', types: [] },
        include: ['src']
    }));
});

afterAll(async () => {
    await languageService.dispose();
    fs.rmSync(fixture, { force: true, recursive: true });
});


describe('coordinator composition', () => {
    it('produces what the staged pipeline produced for a reactivity + template chain', async () => {
        let config = fixture + '/tsconfig.json',
            file = fixture + '/src/view.ts',
            { checker, program } = await languageService.update(config, file, VIEW),
            result = await coordinator.transform([reactivity(), template()], VIEW, (await program.getSourceFile(file))!, { checker, program }, fixture, new Map());

        expect(result.code).toBe(STAGED);
    });
});
