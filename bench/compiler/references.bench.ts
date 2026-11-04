import type { Node } from 'typescript/ast';
import { isIdentifier } from 'typescript/ast/is';
import { afterAll, beforeAll, describe, test } from 'vitest';

import fs from 'fs';
import languageService from '~/compiler/language-service';
import path from 'path';
import references from '~/compiler/references';


const FILES = 8;

// Functions per file, each shaped like a UI component: a few imported calls among many locals,
// parameters, `this` members and DOM/property accesses that can never reach an import
const FUNCTIONS = 24;

const PACKAGES: Record<string, string> = {
    'node_modules/fake-reactivity/index.d.ts': [
        'export declare function effect(fn: () => void): void;',
        'export declare function reactive<T>(value: T): T;'
    ].join('\n'),
    'node_modules/fake-reactivity/package.json': JSON.stringify({ name: 'fake-reactivity', types: './index.d.ts' }),
    'node_modules/fake-template/index.d.ts': 'export declare const html: (strings: TemplateStringsArray, ...values: unknown[]) => Node;',
    'node_modules/fake-template/package.json': JSON.stringify({ name: 'fake-template', types: './index.d.ts' }),
    'src/util.ts': 'export const format = (value: string): string => value.trim();\n'
};


let fixture: string;


function component(index: number): string {
    return [
        `export function view${index}(props: { items: string[]; title: string }) {`,
        '    let state = reactive({ count: 0, open: false }),',
        '        store = new Store(),',
        '        local = props.items.map((item, position) => item.toUpperCase() + position),',
        "        element = document.createElement('div');",
        '',
        '    for (let i = 0, n = local.length; i < n; i++) {',
        '        store.add(local[i]);',
        '        element.dataset.index = String(i);',
        '        element.style.width = Math.max(store.count, i) + "px";',
        '    }',
        '',
        '    effect(() => {',
        '        element.textContent = props.title + state.count + store.items.length;',
        '    });',
        '',
        '    return html`<div class=${props.title}>${local.map(value => html`<span>${util.format(value)}</span>`)}</div>`;',
        '}'
    ].join('\n');
}

function file(): string {
    let parts = [
        "import { effect, reactive } from 'fake-reactivity';",
        "import { html } from 'fake-template';",
        "import * as util from './util';",
        '',
        'class Store {',
        '    count = 0;',
        '    items: string[] = [];',
        '',
        '    add(item: string) {',
        '        this.items.push(item);',
        '        this.count = this.items.length;',
        '    }',
        '}'
    ];

    for (let i = 0; i < FUNCTIONS; i++) {
        parts.push('', component(i));
    }

    return parts.join('\n') + '\n';
}

// Identifiers origins() sends to the checker for one file, counted on a fresh program
function sent(name: string): { identifiers: number; sent: number } {
    let count = 0,
        identifiers = 0,
        source = fs.readFileSync(path.join(fixture, name), 'utf8') + `\n// ${Math.random()}\n`,
        updated = languageService.update(fixture + '/tsconfig.json', fixture + '/' + name, source),
        sourceFile = updated.program.getSourceFile(fixture + '/' + name)!,
        counting = new Proxy(updated.checker, {
            get(target, key) {
                let value = Reflect.get(target, key);

                if (key === 'getSymbolAtLocation') {
                    return (nodes: unknown) => {
                        count += Array.isArray(nodes) ? nodes.length : 1;

                        return (value as (nodes: unknown) => unknown).call(target, nodes);
                    };
                }

                return typeof value === 'function' ? value.bind(target) : value;
            }
        });

    let visit = (node: Node): void => {
        if (isIdentifier(node)) {
            identifiers++;
        }

        node.forEachChild(visit);
    };

    visit(sourceFile);
    references.origins(counting, updated.program, sourceFile);

    return { identifiers, sent: count };
}


beforeAll(() => {
    fixture = fs.mkdtempSync(path.join(process.cwd(), 'bench/.references-')).replace(/\\/g, '/');

    for (let [name, code] of Object.entries(PACKAGES)) {
        fs.mkdirSync(path.dirname(path.join(fixture, name)), { recursive: true });
        fs.writeFileSync(path.join(fixture, name), code);
    }

    for (let i = 0; i < FILES; i++) {
        fs.writeFileSync(path.join(fixture, `src/view${i}.ts`), file());
    }

    fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { lib: ['es2024', 'dom'], module: 'esnext', moduleResolution: 'bundler', strict: true, target: 'esnext', types: [] },
        include: ['src']
    }));

    let { identifiers, sent: count } = sent('src/view0.ts');

    console.log(`references: ${count} of ${identifiers} identifiers sent to the checker per file`);
});

afterAll(() => {
    languageService.dispose();
    fs.rmSync(fixture, { force: true, recursive: true });
});


// Each iteration edits one file so the program, and every cached answer, is new
describe('references', () => {
    test('origins per file, fresh program', async ({ bench }) => {
        let i = 0;

        await bench('origins', () => {
            let name = `src/view${i++ % FILES}.ts`,
                updated = languageService.update(fixture + '/tsconfig.json', fixture + '/' + name, file() + `// ${i}\n`);

            references.origins(updated.checker, updated.program, updated.program.getSourceFile(fixture + '/' + name)!);
        }).run();
    });

    test('snapshot update alone (baseline for the line above)', async ({ bench }) => {
        let i = 0;

        await bench('update', () => {
            let name = `src/view${i++ % FILES}.ts`;

            languageService.update(fixture + '/tsconfig.json', fixture + '/' + name, file() + `// update ${i}\n`);
        }).run();
    });
});

