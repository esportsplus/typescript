import { afterAll, describe, expect, it, vi } from 'vitest';
import path from 'path';
import type { Node, SourceFile } from 'typescript/unstable/ast';
import type { Checker, Program } from 'typescript/unstable/sync';
import { isCallExpression, isIdentifier } from 'typescript/unstable/ast/is';

import type { ImportIntent, Plugin, ReplacementIntent, SharedContext, TransformContext } from '~/compiler/types';

import coordinator from '~/compiler/coordinator';
import * as languageService from '~/compiler/language-service';
import sourcemap from '~/compiler/sourcemap';


const root = process.cwd().split(path.sep).join('/');

const fileName = root + '/src/coordinator-fixture.ts';


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


describe('coordinator.transform', () => {
    afterAll(() => {
        languageService.dispose();
    });

    it('returns unchanged when no plugins', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file),
            result = coordinator.transform([], code, file, project, root, new Map());

        expect(result.changed).toBe(false);
        expect(result.code).toBe(code);
    });

    it('applies replacement intents', () => {
        let code = 'let x = OLD;',
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin((ctx) => {
                let node: Node | undefined;

                ctx.sourceFile.forEachChild(function visit(n) {
                    if (isIdentifier(n) && n.text === 'OLD') {
                        node = n;
                    }

                    n.forEachChild(visit);
                });

                if (!node) {
                    return {};
                }

                let intents: ReplacementIntent[] = [{
                    generate: () => 'NEW',
                    node
                }];

                return { replacements: intents };
            }),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('NEW');
        expect(result.code).not.toContain('OLD');
    });

    it('applies prepend after imports', () => {
        let code = "import { a } from 'pkg';\nlet x = 1;",
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                prepend: ['const GENERATED = true;']
            })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const GENERATED = true;');

        let importIdx = result.code.indexOf("import { a } from 'pkg';"),
            generatedIdx = result.code.indexOf('const GENERATED = true;'),
            letIdx = result.code.indexOf('let x = 1;');

        expect(importIdx).toBeLessThan(generatedIdx);
        expect(generatedIdx).toBeLessThan(letIdx);
    });

    it('applies import intents', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file),
            intents: ImportIntent[] = [{
                add: ['foo'],
                package: 'my-pkg'
            }],
            plugin = makePlugin(() => ({ imports: intents })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain("import { foo } from 'my-pkg';");
    });

    it('skips plugin when patterns do not match', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin: Plugin = {
                patterns: ['MAGIC_TOKEN'],
                transform: () => ({ prepend: ['SHOULD_NOT_APPEAR'] })
            },
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(false);
        expect(result.code).not.toContain('SHOULD_NOT_APPEAR');
    });

    it('runs plugin when patterns match', () => {
        let code = 'let MAGIC_TOKEN = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin: Plugin = {
                patterns: ['MAGIC_TOKEN'],
                transform: () => ({ prepend: ['const FOUND = true;'] })
            },
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const FOUND = true;');
    });

    it('re-parses AST between replacements and prepend (F-001 fix)', () => {
        let code = "import { a } from 'pkg';\nlet OLD = 1;\nlet y = 2;",
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin((ctx) => {
                let node: Node | undefined;

                ctx.sourceFile.forEachChild(function visit(n) {
                    if (isIdentifier(n) && n.text === 'OLD') {
                        node = n;
                    }

                    n.forEachChild(visit);
                });

                if (!node) {
                    return {};
                }

                return {
                    prepend: ['const PREPENDED = true;'],
                    replacements: [{
                        generate: () => 'REPLACED_LONGER_NAME',
                        node
                    }]
                };
            }),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('REPLACED_LONGER_NAME');
        expect(result.code).toContain('const PREPENDED = true;');

        // Prepend should be after imports, not corrupted by replacement
        let importEnd = result.code.indexOf("';") + 2,
            prependIdx = result.code.indexOf('const PREPENDED = true;');

        expect(prependIdx).toBeGreaterThan(importEnd);
    });

    it('chains multiple plugins', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin1 = makePlugin(() => ({ prepend: ['const A = 1;'] })),
            plugin2 = makePlugin(() => ({ prepend: ['const B = 2;'] })),
            result = coordinator.transform([plugin1, plugin2], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const A = 1;');
        expect(result.code).toContain('const B = 2;');
    });

    it('shares context between plugins', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file),
            shared: SharedContext = new Map(),
            plugin1 = makePlugin((ctx) => {
                ctx.shared.set('key', 'value');
                return { prepend: ['const A = 1;'] };
            }),
            plugin2 = makePlugin((ctx) => {
                let val = ctx.shared.get('key');

                return { prepend: [`const B = '${val}';`] };
            }),
            result = coordinator.transform([plugin1, plugin2], code, file, project, root, shared);

        expect(result.changed).toBe(true);
        expect(result.code).toContain("const B = 'value';");
    });

    it('applies replacements + imports together with AST re-parse', () => {
        let code = "let OLD = 1;",
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin((ctx) => {
                let node: Node | undefined;

                ctx.sourceFile.forEachChild(function visit(n) {
                    if (isIdentifier(n) && n.text === 'OLD') {
                        node = n;
                    }

                    n.forEachChild(visit);
                });

                if (!node) {
                    return {};
                }

                return {
                    imports: [{ add: ['helper'], package: 'utils' }],
                    replacements: [{
                        generate: () => 'REPLACED',
                        node
                    }]
                };
            }),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('REPLACED');
        expect(result.code).toContain("import { helper } from 'utils';");
    });

    // F-TEST-001: Coordinator integration tests with real-world patterns

    it('plugin producing replacements + prepend + imports simultaneously', () => {
        let code = "import { reactive } from 'my-pkg';\nlet x = reactive(1);",
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin((ctx) => {
                let node: Node | undefined;

                ctx.sourceFile.forEachChild(function visit(n) {
                    if (isIdentifier(n) && n.text === 'reactive') {
                        node = n;
                    }

                    n.forEachChild(visit);
                });

                if (!node) {
                    return {};
                }

                return {
                    imports: [{ namespace: 'NS', package: 'my-pkg', remove: ['reactive'] }],
                    prepend: ['class ReactiveState {}'],
                    replacements: [{
                        generate: () => 'NS.reactive',
                        node
                    }]
                };
            }),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('NS.reactive');
        expect(result.code).toContain('class ReactiveState {}');
        expect(result.code).toContain("import * as NS from 'my-pkg';");
        expect(result.code).not.toMatch(/import\s*\{[^}]*reactive[^}]*\}\s*from\s*'my-pkg'/);

        let nsImportIdx = result.code.indexOf("import * as NS from 'my-pkg';"),
            classIdx = result.code.indexOf('class ReactiveState {}'),
            bodyIdx = result.code.indexOf('NS.reactive');

        expect(nsImportIdx).toBeLessThan(classIdx);
        expect(classIdx).toBeLessThan(bodyIdx);
    });

    it('plugin with generate() closures capturing scope variables', () => {
        let code = 'let myVar = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin((ctx) => {
                let node: Node | undefined,
                    varname = '';

                ctx.sourceFile.forEachChild(function visit(n) {
                    if (isIdentifier(n) && n.text === 'myVar') {
                        node = n;
                        varname = n.text;
                    }

                    n.forEachChild(visit);
                });

                if (!node) {
                    return {};
                }

                return {
                    replacements: [{
                        generate: () => `NS.write(${varname}, ${varname}.value)`,
                        node
                    }]
                };
            }),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('NS.write(myVar, myVar.value)');
    });

    it('file with existing imports, plugin adds namespace + removes specifier', () => {
        let code = "import { other, reactive } from 'my-pkg';\nlet x = 1;",
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ namespace: 'NS', package: 'my-pkg', remove: ['reactive'] }]
            })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain("import * as NS from 'my-pkg';");
        expect(result.code).toContain('other');
        expect(result.code).not.toMatch(/import\s*\{[^}]*reactive[^}]*\}\s*from\s*'my-pkg'/);
    });

    // F-TEST-003: Import manipulation integration tests

    it('adds specifiers to existing import', () => {
        let code = "import { a } from 'pkg';\nlet x = 1;",
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ add: ['b', 'c'], package: 'pkg' }]
            })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('a');
        expect(result.code).toContain('b');
        expect(result.code).toContain('c');
        expect(result.code).toMatch(/import\s*\{[^}]*a[^}]*b[^}]*c[^}]*\}\s*from\s*'pkg'/);
    });

    it('removes specifier from import keeping others', () => {
        let code = "import { a, b, reactive } from 'my-pkg';\nlet x = 1;",
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ package: 'my-pkg', remove: ['reactive'] }]
            })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('a');
        expect(result.code).toContain('b');
        expect(result.code).not.toMatch(/import\s*\{[^}]*reactive[^}]*\}\s*from\s*'my-pkg'/);
    });

    it('adds namespace import to file without package imports', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ namespace: 'NS', package: 'my-pkg' }]
            })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain("import * as NS from 'my-pkg';");
    });

    it('merges duplicate import statements', () => {
        let code = "import { a } from 'pkg';\nimport { b } from 'pkg';\nlet x = 1;",
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ add: ['c'], package: 'pkg' }]
            })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);

        let importMatches = result.code.match(/import\s*\{[^}]+\}\s*from\s*'pkg'/g);

        expect(importMatches).toHaveLength(1);
        expect(result.code).toContain('a');
        expect(result.code).toContain('b');
        expect(result.code).toContain('c');
    });

    it('namespace + remove specifier combined', () => {
        let code = "import { reactive } from 'my-pkg';\nlet x = 1;",
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ namespace: 'NS', package: 'my-pkg', remove: ['reactive'] }]
            })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain("import * as NS from 'my-pkg';");
        expect(result.code).not.toMatch(/import\s*\{[^}]*reactive[^}]*\}\s*from\s*'my-pkg'/);
    });

    it('adds import to file with different package imports', () => {
        let code = "import { x } from 'other';\nlet a = 1;",
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ add: ['y'], package: 'new-pkg' }]
            })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain("import { x } from 'other';");
        expect(result.code).toContain("import { y } from 'new-pkg';");
    });

    // F-TEST-004: replaceReverse edge cases

    it('multiple non-overlapping replacements', () => {
        let code = 'let OLD1 = 1; let OLD2 = 2;',
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin((ctx) => {
                let nodes: Node[] = [];

                ctx.sourceFile.forEachChild(function visit(n) {
                    if (isIdentifier(n) && (n.text === 'OLD1' || n.text === 'OLD2')) {
                        nodes.push(n);
                    }

                    n.forEachChild(visit);
                });

                return {
                    replacements: nodes.map(node => ({
                        generate: () => node.getText(ctx.sourceFile) === 'OLD1' ? 'NEW1' : 'NEW2',
                        node
                    }))
                };
            }),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('NEW1');
        expect(result.code).toContain('NEW2');
        expect(result.code).not.toContain('OLD1');
        expect(result.code).not.toContain('OLD2');
    });

    it('replacement with empty string deletes a node', () => {
        let code = 'let DELETEME = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin((ctx) => {
                let node: Node | undefined;

                ctx.sourceFile.forEachChild(function visit(n) {
                    if (isIdentifier(n) && n.text === 'DELETEME') {
                        node = n;
                    }

                    n.forEachChild(visit);
                });

                if (!node) {
                    return {};
                }

                return {
                    replacements: [{
                        generate: () => '',
                        node
                    }]
                };
            }),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).not.toContain('DELETEME');
    });

    it('replacement at file start', () => {
        let code = 'FIRST_TOKEN;',
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin((ctx) => {
                let node: Node | undefined;

                ctx.sourceFile.forEachChild(function visit(n) {
                    if (isIdentifier(n) && n.text === 'FIRST_TOKEN') {
                        node = n;
                    }

                    n.forEachChild(visit);
                });

                if (!node) {
                    return {};
                }

                return {
                    replacements: [{
                        generate: () => 'REPLACED_FIRST',
                        node
                    }]
                };
            }),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('REPLACED_FIRST');
        expect(result.code.indexOf('REPLACED_FIRST')).toBe(0);
    });

    // F-TEST-006: Multi-plugin pipeline

    it('first plugin modifies code, second receives updated code', () => {
        let code = 'let OLD = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin1 = makePlugin((ctx) => {
                let node: Node | undefined;

                ctx.sourceFile.forEachChild(function visit(n) {
                    if (isIdentifier(n) && n.text === 'OLD') {
                        node = n;
                    }

                    n.forEachChild(visit);
                });

                if (!node) {
                    return {};
                }

                return {
                    replacements: [{
                        generate: () => 'TRANSFORMED',
                        node
                    }]
                };
            }),
            plugin2 = makePlugin((ctx) => {
                if (ctx.code.includes('TRANSFORMED')) {
                    return { prepend: ['const SEEN_BY_PLUGIN2 = true;'] };
                }

                return {};
            }),
            result = coordinator.transform([plugin1, plugin2], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('TRANSFORMED');
        expect(result.code).toContain('const SEEN_BY_PLUGIN2 = true;');
    });

    it('three plugins — first skipped, second and third run', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin1: Plugin = {
                patterns: ['MISSING'],
                transform: () => ({ prepend: ['const SHOULD_NOT_APPEAR = true;'] })
            },
            plugin2 = makePlugin(() => ({ prepend: ['const A = 1;'] })),
            plugin3 = makePlugin(() => ({ prepend: ['const B = 2;'] })),
            result = coordinator.transform([plugin1, plugin2, plugin3], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).not.toContain('SHOULD_NOT_APPEAR');
        expect(result.code).toContain('const A = 1;');
        expect(result.code).toContain('const B = 2;');
    });

    // F-TEST-009: generate() sourceFile correctness

    it('generate() receives correct sourceFile after prior replacement', () => {
        let code = "let TARGET = 'hello';",
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin((ctx) => {
                let node: Node | undefined;

                ctx.sourceFile.forEachChild(function visit(n) {
                    if (isIdentifier(n) && n.text === 'TARGET') {
                        node = n;
                    }

                    n.forEachChild(visit);
                });

                if (!node) {
                    return {};
                }

                return {
                    replacements: [{
                        generate: (sf) => `REPLACED_IN_${sf.fileName}`,
                        node
                    }]
                };
            }),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain(`REPLACED_IN_${fileName}`);
    });

    // F-TEST-005: Pattern filtering edge cases

    it('pattern in string literal still matches', () => {
        let code = 'let x = "reactive(";',
            file = parse(code),
            project = makeProject(file),
            plugin: Plugin = {
                patterns: ['reactive('],
                transform: () => ({ prepend: ['const MATCHED = true;'] })
            },
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const MATCHED = true;');
    });

    it('multiple patterns, only one matches', () => {
        let code = 'let PRESENT = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin: Plugin = {
                patterns: ['MISSING', 'PRESENT'],
                transform: () => ({ prepend: ['const FOUND = true;'] })
            },
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const FOUND = true;');
    });

    it('no patterns property — plugin always runs', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({ prepend: ['const ALWAYS = true;'] })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const ALWAYS = true;');
    });

    // F-TEST-010: applyPrepend edge cases

    it('no imports — prepend goes to start', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({ prepend: ['const A = 1;'] })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);

        let prependIdx = result.code.indexOf('const A = 1;'),
            letIdx = result.code.indexOf('let x = 1;');

        expect(prependIdx).toBeLessThan(letIdx);
    });

    it('multiple prepend strings appear in order', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({ prepend: ['const A = 1;', 'const B = 2;'] })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const A = 1;');
        expect(result.code).toContain('const B = 2;');

        let aIdx = result.code.indexOf('const A = 1;'),
            bIdx = result.code.indexOf('const B = 2;');

        expect(aIdx).toBeLessThan(bIdx);
    });

    // F-TEST-011: applyImports multi-intent

    it('two ImportIntents for different packages', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [
                    { add: ['a'], package: 'pkg-1' },
                    { add: ['b'], package: 'pkg-2' }
                ]
            })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain("import { a } from 'pkg-1';");
        expect(result.code).toContain("import { b } from 'pkg-2';");
    });

    it('ImportIntent with only remove', () => {
        let code = "import { a, b } from 'pkg';\nlet x = 1;",
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ package: 'pkg', remove: ['a'] }]
            })),
            result = coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('b');
        expect(result.code).not.toMatch(/import\s*\{[^}]*a[^}]*\}\s*from\s*'pkg'/);
        expect(result.code).toContain("import { b } from 'pkg';");
    });

    it('propagates plugin.transform() exception', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => { throw new Error('plugin crashed'); });

        expect(() => coordinator.transform([plugin], code, file, project, root, new Map())).toThrow('plugin crashed');
    });

    it('falls back to parse when getSourceFile returns undefined', () => {
        let code = 'let x = 1;',
            file = parse(code),
            project = makeProject(file);

        vi.spyOn(languageService.default, 'update').mockReturnValueOnce({
            checker: {} as unknown as Checker,
            program: { getSourceFile: () => undefined } as unknown as Program
        });

        let plugin1 = makePlugin(() => ({ prepend: ['const A = 1;'] })),
            plugin2 = makePlugin((ctx) => {
                if (ctx.code.includes('const A = 1;')) {
                    return { prepend: ['const B = 2;'] };
                }

                return {};
            }),
            result = coordinator.transform([plugin1, plugin2], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const A = 1;');
        expect(result.code).toContain('const B = 2;');
    });

    // F-003: applyImports batching

    describe('applyImports batching', () => {
        it('batches multiple intents for the same package into one modify call', () => {
            let code = 'let x = 1;',
                file = parse(code),
                project = makeProject(file),
                plugin = makePlugin(() => ({
                    imports: [
                        { add: ['foo'], package: '@pkg/a' },
                        { add: ['bar'], package: '@pkg/a' },
                        { add: ['baz'], package: '@pkg/a' }
                    ]
                })),
                result = coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toContain("import { bar, baz, foo } from '@pkg/a';");

            let importMatches = result.code.match(/import\s*\{[^}]+\}\s*from\s*'@pkg\/a'/g);

            expect(importMatches).toHaveLength(1);
        });

        it('re-parses only between distinct packages', () => {
            let code = 'let x = 1;',
                file = parse(code),
                project = makeProject(file),
                plugin = makePlugin(() => ({
                    imports: [
                        { add: ['foo'], package: '@pkg/a' },
                        { add: ['bar'], package: '@pkg/a' },
                        { add: ['qux'], package: '@pkg/b' }
                    ]
                })),
                result = coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toContain("import { bar, foo } from '@pkg/a';");
            expect(result.code).toContain("import { qux } from '@pkg/b';");
        });

        it('merges add and remove for same package', () => {
            let code = "import { bar, foo } from '@pkg/a';\nlet x = 1;",
                file = parse(code),
                project = makeProject(file),
                plugin = makePlugin(() => ({
                    imports: [
                        { add: ['baz'], package: '@pkg/a' },
                        { package: '@pkg/a', remove: ['bar'] }
                    ]
                })),
                result = coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toContain("import { baz, foo } from '@pkg/a';");
            expect(result.code).not.toMatch(/import\s*\{[^}]*bar[^}]*\}\s*from\s*'@pkg\/a'/);
        });

        it('preserves namespace across merged intents', () => {
            let code = 'let x = 1;',
                file = parse(code),
                project = makeProject(file),
                plugin = makePlugin(() => ({
                    imports: [
                        { namespace: 'utils', package: '@pkg/a' },
                        { add: ['foo'], package: '@pkg/a' }
                    ]
                })),
                result = coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toContain("import * as utils from '@pkg/a';");
            expect(result.code).toContain("import { foo } from '@pkg/a';");
        });
    });

    // Sourcemap composition: the coordinator surfaces an original->transformed mapping.

    describe('surfaced mapping', () => {
        it('surfaces an identity mapping when no plugins run', () => {
            let code = 'let x = 1;\nlet y = 2;',
                file = parse(code),
                project = makeProject(file),
                result = coordinator.transform([], code, file, project, root, new Map());

            expect(result.map.generations).toEqual([]);
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 1, 4)).toEqual({ column: 4, line: 1 });
        });

        it('prepend-only: shifts post-injection lines back to their real source lines', () => {
            let code = 'let a = 1;\nlet b = 2;',
                file = parse(code),
                project = makeProject(file),
                plugin = makePlugin(() => ({ prepend: ['const INJECTED = 0;'] })),
                result = coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 1, 4)).toEqual({ column: 4, line: 0 });
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 2, 4)).toEqual({ column: 4, line: 1 });
        });

        it('import-injection: the untouched body maps back past the injected import', () => {
            let code = 'let x = 1;',
                file = parse(code),
                project = makeProject(file),
                plugin = makePlugin(() => ({ imports: [{ add: ['foo'], package: 'my-pkg' }] })),
                result = coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toContain("import { foo } from 'my-pkg';");
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 1, 4)).toEqual({ column: 4, line: 0 });
        });

        it('replacement with line growth: text after the grown span maps to the real line', () => {
            let code = 'let x = OLD;',
                file = parse(code),
                project = makeProject(file),
                plugin = makePlugin((ctx) => {
                    let node: Node | undefined;

                    ctx.sourceFile.forEachChild(function visit(n) {
                        if (isIdentifier(n) && n.text === 'OLD') {
                            node = n;
                        }

                        n.forEachChild(visit);
                    });

                    if (!node) {
                        return {};
                    }

                    return { replacements: [{ generate: () => 'NEW\nEXTRA', node }] };
                }),
                result = coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toBe('let x = NEW\nEXTRA;');
            // Untouched prefix maps identically.
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 0, 0)).toEqual({ column: 0, line: 0 });
            // The trailing ';' (now on a new line) still maps to its real column on the single original line.
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 1, 5)).toEqual({ column: 11, line: 0 });
        });

        it('replacement with line shrink: a multi-line node collapses and later text keeps its real line', () => {
            let code = 'let x = foo(\n    1\n);',
                file = parse(code),
                project = makeProject(file),
                plugin = makePlugin((ctx) => {
                    let node: Node | undefined;

                    ctx.sourceFile.forEachChild(function visit(n) {
                        if (isCallExpression(n)) {
                            node = n;
                        }

                        n.forEachChild(visit);
                    });

                    if (!node) {
                        return {};
                    }

                    return { replacements: [{ generate: () => 'BAR', node }] };
                }),
                result = coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toBe('let x = BAR;');
            // The ';' following the collapsed call maps back to original line 2.
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 0, 11)).toEqual({ column: 1, line: 2 });
        });

        it('multi-plugin chaining: two prepend generations compose into one mapping', () => {
            let code = 'let a = 1;\nlet b = 2;',
                file = parse(code),
                project = makeProject(file),
                plugin1 = makePlugin(() => ({ prepend: ['const P1 = 1;'] })),
                plugin2 = makePlugin(() => ({ prepend: ['const P2 = 2;'] })),
                result = coordinator.transform([plugin1, plugin2], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.map.generations.length).toBe(2);
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 2, 4)).toEqual({ column: 4, line: 0 });
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 3, 4)).toEqual({ column: 4, line: 1 });
        });
    });
});
