import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Checker, Program } from 'typescript/async';
import type { ImportIntent, Plugin, ReplacementIntent, SharedContext, TransformContext } from '~/compiler/types';
import { isCallExpression, isIdentifier, isImportDeclaration, isNamedImports } from 'typescript/ast/is';
import type { Node, SourceFile } from 'typescript/ast';

import coordinator from '~/compiler/coordinator';
import languageService from '~/compiler/language-service';
import path from 'path';
import sourcemap from '~/compiler/sourcemap';


const root = process.cwd().split(path.sep).join('/');

const fileName = root + '/src/coordinator-fixture.ts';


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


describe('coordinator.transform', () => {
    afterAll(async () => {
        await languageService.dispose();
    });

    it('returns unchanged when no plugins', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            result = await coordinator.transform([], code, file, project, root, new Map());

        expect(result.changed).toBe(false);
        expect(result.code).toBe(code);
    });

    it('hands every plugin one memoized checker per program', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            calls = 0,
            project = {
                checker: { getTypeAtLocation: () => ++calls } as unknown as Checker,
                program: { getSourceFile: () => file } as unknown as Program
            },
            seen: Checker[] = [],
            plugin: Plugin = {
                transform: async (ctx) => {
                    seen.push(ctx.checker);
                    await ctx.checker.getTypeAtLocation(file);

                    return {};
                }
            };

        await coordinator.transform([plugin, plugin], code, file, project, root, new Map());

        expect(seen).toHaveLength(2);
        expect(seen[0]).toBe(seen[1]);
        expect(seen[0]).not.toBe(project.checker);
        expect(calls).toBe(1);
    });

    it('applies replacement intents', async () => {
        let code = 'let x = OLD;',
            file = await parse(code),
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
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('NEW');
        expect(result.code).not.toContain('OLD');
    });

    it('applies prepend after imports', async () => {
        let code = "import { a } from 'pkg';\nlet x = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                prepend: ['const GENERATED = true;']
            })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const GENERATED = true;');

        let importIdx = result.code.indexOf("import { a } from 'pkg';"),
            generatedIdx = result.code.indexOf('const GENERATED = true;'),
            letIdx = result.code.indexOf('let x = 1;');

        expect(importIdx).toBeLessThan(generatedIdx);
        expect(generatedIdx).toBeLessThan(letIdx);
    });

    it('applies import intents', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            intents: ImportIntent[] = [{
                add: ['foo'],
                package: 'my-pkg'
            }],
            plugin = makePlugin(() => ({ imports: intents })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain("import { foo } from 'my-pkg';");
    });

    it('skips plugin when patterns do not match', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            plugin: Plugin = {
                patterns: ['MAGIC_TOKEN'],
                transform: async () => ({ prepend: ['SHOULD_NOT_APPEAR'] })
            },
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(false);
        expect(result.code).not.toContain('SHOULD_NOT_APPEAR');
    });

    it('runs plugin when patterns match', async () => {
        let code = 'let MAGIC_TOKEN = 1;',
            file = await parse(code),
            project = makeProject(file),
            plugin: Plugin = {
                patterns: ['MAGIC_TOKEN'],
                transform: async () => ({ prepend: ['const FOUND = true;'] })
            },
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const FOUND = true;');
    });

    it('re-parses AST between replacements and prepend (F-001 fix)', async () => {
        let code = "import { a } from 'pkg';\nlet OLD = 1;\nlet y = 2;",
            file = await parse(code),
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
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('REPLACED_LONGER_NAME');
        expect(result.code).toContain('const PREPENDED = true;');

        // Prepend should be after imports, not corrupted by replacement
        let importEnd = result.code.indexOf("';") + 2,
            prependIdx = result.code.indexOf('const PREPENDED = true;');

        expect(prependIdx).toBeGreaterThan(importEnd);
    });

    it('chains multiple plugins', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            plugin1 = makePlugin(() => ({ prepend: ['const A = 1;'] })),
            plugin2 = makePlugin(() => ({ prepend: ['const B = 2;'] })),
            result = await coordinator.transform([plugin1, plugin2], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const A = 1;');
        expect(result.code).toContain('const B = 2;');
    });

    it('shares context between plugins', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            shared: SharedContext = new Map(),
            plugin1 = makePlugin((ctx) => {
                ctx.shared.set('key', 'value');
                return { prepend: ['const A = 1;'] };
            }),
            plugin2 = makePlugin((ctx) => {
                let val = ctx.shared.get('key');

                return { prepend: [`const B = '${String(val)}';`] };
            }),
            result = await coordinator.transform([plugin1, plugin2], code, file, project, root, shared);

        expect(result.changed).toBe(true);
        expect(result.code).toContain("const B = 'value';");
    });

    it('applies replacements + imports together with AST re-parse', async () => {
        let code = 'let OLD = 1;',
            file = await parse(code),
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
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('REPLACED');
        expect(result.code).toContain("import { helper } from 'utils';");
    });

    // F-TEST-001: Coordinator integration tests with real-world patterns

    it('plugin producing replacements + prepend + imports simultaneously', async () => {
        let code = "import { reactive } from 'my-pkg';\nlet x = reactive(1);",
            file = await parse(code),
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
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

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

    it('plugin with generate() closures capturing scope variables', async () => {
        let code = 'let myVar = 1;',
            file = await parse(code),
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
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('NS.write(myVar, myVar.value)');
    });

    it('file with existing imports, plugin adds namespace + removes specifier', async () => {
        let code = "import { other, reactive } from 'my-pkg';\nlet x = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ namespace: 'NS', package: 'my-pkg', remove: ['reactive'] }]
            })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain("import * as NS from 'my-pkg';");
        expect(result.code).toContain('other');
        expect(result.code).not.toMatch(/import\s*\{[^}]*reactive[^}]*\}\s*from\s*'my-pkg'/);
    });

    it('preserves a type-only import when rewriting a package\'s imports', async () => {
        let code = "import { html } from 'my-pkg';\nimport type { Renderable } from 'my-pkg';\nlet x = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ namespace: 'NS', package: 'my-pkg', remove: ['html'] }]
            })),
            result = await coordinator.transform([plugin], code, file, project, '/root', new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain("import * as NS from 'my-pkg';");
        // Renderable must stay type-only (import type { ... } or inline `type Renderable`) so it is
        // erased at runtime — a runtime `import { Renderable }` fails when it has no runtime export.
        expect(result.code).toMatch(/import\s+type\s*\{[^}]*Renderable|import\s*\{[^}]*type\s+Renderable/);
        expect(result.code).not.toMatch(/import\s*\{\s*Renderable\s*\}\s*from\s*'my-pkg'/);
    });

    // F-TEST-003: Import manipulation integration tests

    it('adds specifiers to existing import', async () => {
        let code = "import { a } from 'pkg';\nlet x = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ add: ['b', 'c'], package: 'pkg' }]
            })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('a');
        expect(result.code).toContain('b');
        expect(result.code).toContain('c');
        expect(result.code).toMatch(/import\s*\{[^}]*a[^}]*b[^}]*c[^}]*\}\s*from\s*'pkg'/);
    });

    it('preserves a default import when adding named imports', async () => {
        let code = "import React, { a } from 'pkg';\nlet x = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({ imports: [{ add: ['b'], package: 'pkg' }] })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.code).toContain("import React, { a, b } from 'pkg';");
    });

    it('keeps a namespace import when adding named imports', async () => {
        let code = "import * as ns from 'pkg';\nlet x = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({ imports: [{ add: ['a'], package: 'pkg' }] })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.code).toContain("import * as ns from 'pkg';");
        expect(result.code).toContain("import { a } from 'pkg';");
    });

    it('does not duplicate a requested namespace import that already exists', async () => {
        let code = "import * as ns from 'pkg';\nlet x = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({ imports: [{ namespace: 'ns', package: 'pkg' }] })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toBe(code);
    });

    it('rewrites a side-effect-only import when adding named imports', async () => {
        let code = "import 'pkg';\nlet x = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({ imports: [{ add: ['a'], package: 'pkg' }] })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.code).toContain("import { a } from 'pkg';");
        expect(result.code).not.toContain("import 'pkg';");
    });

    it('removes specifier from import keeping others', async () => {
        let code = "import { a, b, reactive } from 'my-pkg';\nlet x = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ package: 'my-pkg', remove: ['reactive'] }]
            })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('a');
        expect(result.code).toContain('b');
        expect(result.code).not.toMatch(/import\s*\{[^}]*reactive[^}]*\}\s*from\s*'my-pkg'/);
    });

    it('adds namespace import to file without package imports', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ namespace: 'NS', package: 'my-pkg' }]
            })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain("import * as NS from 'my-pkg';");
    });

    it('merges duplicate import statements', async () => {
        let code = "import { a } from 'pkg';\nimport { b } from 'pkg';\nlet x = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ add: ['c'], package: 'pkg' }]
            })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);

        let importMatches = result.code.match(/import\s*\{[^}]+\}\s*from\s*'pkg'/g);

        expect(importMatches).toHaveLength(1);
        expect(result.code).toContain('a');
        expect(result.code).toContain('b');
        expect(result.code).toContain('c');
    });

    it('namespace + remove specifier combined', async () => {
        let code = "import { reactive } from 'my-pkg';\nlet x = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ namespace: 'NS', package: 'my-pkg', remove: ['reactive'] }]
            })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain("import * as NS from 'my-pkg';");
        expect(result.code).not.toMatch(/import\s*\{[^}]*reactive[^}]*\}\s*from\s*'my-pkg'/);
    });

    it('adds import to file with different package imports', async () => {
        let code = "import { x } from 'other';\nlet a = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ add: ['y'], package: 'new-pkg' }]
            })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain("import { x } from 'other';");
        expect(result.code).toContain("import { y } from 'new-pkg';");
    });

    // F-TEST-004: replaceReverse edge cases

    it('multiple non-overlapping replacements', async () => {
        let code = 'let OLD1 = 1; let OLD2 = 2;',
            file = await parse(code),
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
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('NEW1');
        expect(result.code).toContain('NEW2');
        expect(result.code).not.toContain('OLD1');
        expect(result.code).not.toContain('OLD2');
    });

    it('replacement with empty string deletes a node', async () => {
        let code = 'let DELETEME = 1;',
            file = await parse(code),
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
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).not.toContain('DELETEME');
    });

    it('replacement at file start', async () => {
        let code = 'FIRST_TOKEN;',
            file = await parse(code),
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
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('REPLACED_FIRST');
        expect(result.code.indexOf('REPLACED_FIRST')).toBe(0);
    });

    // F-TEST-006: Multi-plugin pipeline

    it('every plugin receives the original code and source file', async () => {
        let code = 'let OLD = 1;',
            file = await parse(code),
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
            seen: [string, SourceFile][] = [],
            plugin2 = makePlugin((ctx) => {
                seen.push([ctx.code, ctx.sourceFile]);

                return {};
            }),
            result = await coordinator.transform([plugin1, plugin2], code, file, project, root, new Map());

        expect(result.code).toBe('let TRANSFORMED = 1;');
        expect(seen).toEqual([[code, file]]);
    });

    it('three plugins — first skipped, second and third run', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            plugin1: Plugin = {
                patterns: ['MISSING'],
                transform: async () => ({ prepend: ['const SHOULD_NOT_APPEAR = true;'] })
            },
            plugin2 = makePlugin(() => ({ prepend: ['const A = 1;'] })),
            plugin3 = makePlugin(() => ({ prepend: ['const B = 2;'] })),
            result = await coordinator.transform([plugin1, plugin2, plugin3], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).not.toContain('SHOULD_NOT_APPEAR');
        expect(result.code).toContain('const A = 1;');
        expect(result.code).toContain('const B = 2;');
    });

    // F-TEST-009: generate() sourceFile correctness

    it('generate() receives correct sourceFile after prior replacement', async () => {
        let code = "let TARGET = 'hello';",
            file = await parse(code),
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
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain(`REPLACED_IN_${fileName}`);
    });

    // F-TEST-005: Pattern filtering edge cases

    it('pattern in string literal still matches', async () => {
        let code = 'let x = "reactive(";',
            file = await parse(code),
            project = makeProject(file),
            plugin: Plugin = {
                patterns: ['reactive('],
                transform: async () => ({ prepend: ['const MATCHED = true;'] })
            },
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const MATCHED = true;');
    });

    it('multiple patterns, only one matches', async () => {
        let code = 'let PRESENT = 1;',
            file = await parse(code),
            project = makeProject(file),
            plugin: Plugin = {
                patterns: ['MISSING', 'PRESENT'],
                transform: async () => ({ prepend: ['const FOUND = true;'] })
            },
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const FOUND = true;');
    });

    it('no patterns property — plugin always runs', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({ prepend: ['const ALWAYS = true;'] })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const ALWAYS = true;');
    });

    // F-TEST-010: applyPrepend edge cases

    it('no imports — prepend goes to start', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({ prepend: ['const A = 1;'] })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);

        let prependIdx = result.code.indexOf('const A = 1;'),
            letIdx = result.code.indexOf('let x = 1;');

        expect(prependIdx).toBeLessThan(letIdx);
    });

    it('multiple prepend strings appear in order', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({ prepend: ['const A = 1;', 'const B = 2;'] })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('const A = 1;');
        expect(result.code).toContain('const B = 2;');

        let aIdx = result.code.indexOf('const A = 1;'),
            bIdx = result.code.indexOf('const B = 2;');

        expect(aIdx).toBeLessThan(bIdx);
    });

    // F-TEST-011: applyImports multi-intent

    it('two ImportIntents for different packages', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [
                    { add: ['a'], package: 'pkg-1' },
                    { add: ['b'], package: 'pkg-2' }
                ]
            })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toBe("import { b } from 'pkg-2';\nimport { a } from 'pkg-1';\nlet x = 1;");
    });

    it('ImportIntent with only remove', async () => {
        let code = "import { a, b } from 'pkg';\nlet x = 1;",
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => ({
                imports: [{ package: 'pkg', remove: ['a'] }]
            })),
            result = await coordinator.transform([plugin], code, file, project, root, new Map());

        expect(result.changed).toBe(true);
        expect(result.code).toContain('b');
        expect(result.code).not.toMatch(/import\s*\{[^}]*a[^}]*\}\s*from\s*'pkg'/);
        expect(result.code).toContain("import { b } from 'pkg';");
    });

    it('propagates plugin.transform() exception', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            plugin = makePlugin(() => { throw new Error('plugin crashed'); });

        await expect(coordinator.transform([plugin], code, file, project, root, new Map())).rejects.toThrow('plugin crashed');
    });

    it('every plugin analyses the project program, which stays in place', async () => {
        let code = 'let x = 1;',
            file = await parse(code),
            project = makeProject(file),
            seen: Program[] = [],
            plugin1 = makePlugin((ctx) => {
                seen.push(ctx.program);

                return { prepend: ['const A = 1;'] };
            }),
            plugin2 = makePlugin((ctx) => {
                seen.push(ctx.program);

                return {};
            });

        await coordinator.transform([plugin1, plugin2], code, file, project, root, new Map());

        expect(seen).toEqual([project.program, project.program]);
    });

    describe('replacement composition', () => {
        function nodes(file: SourceFile, predicate: (node: Node) => boolean): Node[] {
            let found: Node[] = [];

            file.forEachChild(function visit(n) {
                if (predicate(n)) {
                    found.push(n);
                }

                n.forEachChild(visit);
            });

            return found;
        }

        function wrapping(predicate: (node: Node) => boolean, wrap: (inner: string) => string): Plugin {
            return makePlugin(ctx => ({
                replacements: nodes(ctx.sourceFile, predicate).map(node => ({
                    generate: (_sf: SourceFile, text: (node: Node) => string) => wrap(text(node)),
                    node
                }))
            }));
        }

        it("nests one plugin's intents, the outer generating from the inner's output", async () => {
            let code = 'let v = f(g(1));',
                file = await parse(code),
                result = await coordinator.transform(
                    [wrapping(isCallExpression, inner => `[${inner}]`)],
                    code,
                    file,
                    makeProject(file),
                    root,
                    new Map()
                );

            expect(result.code).toBe('let v = [f([g(1)])];');
        });

        it('nests replacements across plugins both ways', async () => {
            let code = 'let v = f(a);',
                file = await parse(code),
                outerFirst = wrapping(isCallExpression, inner => `outer(${inner})`),
                innerSecond = wrapping(n => isIdentifier(n) && n.text === 'a', inner => `${inner}.value`),
                result = await coordinator.transform([outerFirst, innerSecond], code, file, makeProject(file), root, new Map());

            expect(result.code).toBe('let v = outer(f(a.value));');

            result = await coordinator.transform([innerSecond, outerFirst], code, file, makeProject(file), root, new Map());

            expect(result.code).toBe('let v = outer(f(a.value));');
        });

        it('treats a later plugin as the outer of two equal ranges', async () => {
            let code = 'let v = a;',
                file = await parse(code),
                isA = (n: Node) => isIdentifier(n) && n.text === 'a',
                result = await coordinator.transform(
                    [wrapping(isA, inner => `first(${inner})`), wrapping(isA, inner => `second(${inner})`)],
                    code,
                    file,
                    makeProject(file),
                    root,
                    new Map()
                );

            expect(result.code).toBe('let v = second(first(a));');
        });

        it('applies the replacements inside any node text() is asked for', async () => {
            let code = 'let a = 1;\nlet b = x;',
                file = await parse(code),
                [x] = nodes(file, n => isIdentifier(n) && n.text === 'x'),
                [literal] = nodes(file, n => n.getText(file) === '1'),
                source = file.statements[0],
                copy = makePlugin(() => ({
                    replacements: [
                        { generate: () => 'one', node: literal },
                        { generate: (_sf: SourceFile, text: (node: Node) => string) => JSON.stringify(text(source)), node: x }
                    ]
                })),
                result = await coordinator.transform([copy], code, file, makeProject(file), root, new Map());

            expect(result.code).toBe('let a = one;\nlet b = "let a = one;";');
        });

        it('evaluates function prepends after composition, with text()', async () => {
            let code = 'let v = a;',
                file = await parse(code),
                [statement] = file.statements,
                recorded: string[] = [],
                reads = wrapping(n => isIdentifier(n) && n.text === 'a', inner => `${inner}.value`),
                hoisting = makePlugin(() => ({
                    prepend: [
                        'const plain = 1;',
                        (text) => `const hoisted = ${JSON.stringify(text(statement))}; // ${recorded.join(',')}`
                    ],
                    replacements: nodes(file, n => isIdentifier(n) && n.text === 'v').map(node => ({
                        generate: () => {
                            recorded.push('generated');

                            return 'w';
                        },
                        node
                    }))
                })),
                result = await coordinator.transform([hoisting, reads], code, file, makeProject(file), root, new Map());

            expect(result.code).toBe('const plain = 1;\nconst hoisted = "let w = a.value;"; // generated\nlet w = a.value;');
        });

        it('fails naming both plugins when two replacements overlap without nesting', async () => {
            let code = 'let value = 1;',
                file = await parse(code),
                span = (start: number, end: number) => ({ end, getStart: () => start, parent: undefined }) as unknown as Node,
                first: Plugin = { name: 'first-plugin', transform: async () => ({ replacements: [{ generate: () => 'A', node: span(4, 9) }] }) },
                second: Plugin = { transform: async () => ({ replacements: [{ generate: () => 'B', node: span(6, 13) }] }) };

            await expect(coordinator.transform([first, second], code, file, makeProject(file), root, new Map())).rejects
                .toThrow(/first-plugin \(4-9\) and plugin #2 \(6-13\).*overlap/);
        });
    });

    describe('import layout', () => {
        afterEach(async () => {
            vi.restoreAllMocks();
        });

        function replacing(name: string, text: string, rest: Omit<Awaited<ReturnType<Plugin['transform']>>, 'replacements'>) {
            return makePlugin((ctx) => {
                let node: Node | undefined;

                ctx.sourceFile.forEachChild(function visit(n) {
                    if (isIdentifier(n) && n.text === name) {
                        node = n;
                    }

                    n.forEachChild(visit);
                });

                return { ...rest, replacements: [{ generate: () => text, node: node! }] };
            });
        }

        it('follows an import declared after other statements through the edits before it', async () => {
            let code = "import { a } from 'x';\nlet v = OLD;\nimport { b } from 'y';\nb(v, a);",
                file = await parse(code),
                reparse = vi.spyOn(languageService, 'parse'),
                plugin = replacing('OLD', 'A_LONGER_REPLACEMENT', {
                    imports: [{ add: ['c'], package: 'y' }],
                    prepend: ['const P = 1;']
                }),
                result = await coordinator.transform([plugin], code, file, makeProject(file), root, new Map());

            expect(result.code).toBe("import { a } from 'x';\nconst P = 1;\n\nlet v = A_LONGER_REPLACEMENT;\nimport { b, c } from 'y';\nb(v, a);");
            expect(reparse).not.toHaveBeenCalled();
        });

        it('re-parses when a replacement may itself declare an import', async () => {
            let code = "import { b } from 'y';\nOLD;\nb();",
                file = await parse(code),
                reparse = vi.spyOn(languageService, 'parse'),
                plugin = replacing('OLD', "0;\nimport { z } from 'y'", { imports: [{ add: ['c'], package: 'y' }] }),
                result = await coordinator.transform([plugin], code, file, makeProject(file), root, new Map());

            expect(result.code).toContain("import { b, c, z } from 'y';");
            expect(reparse).toHaveBeenCalledTimes(1);
        });

        it('re-parses when a replacement starts the first statement after the imports', async () => {
            let code = "import { b } from 'y';\nOLD();",
                file = await parse(code),
                reparse = vi.spyOn(languageService, 'parse'),
                plugin = replacing('OLD', 'NEW', { imports: [{ add: ['c'], package: 'y' }] }),
                result = await coordinator.transform([plugin], code, file, makeProject(file), root, new Map());

            expect(result.code).toBe("import { b, c } from 'y';\nNEW();");
            expect(reparse).toHaveBeenCalledTimes(1);
        });
    });

    // F-003: applyImports batching

    describe('applyImports batching', () => {
        it('resolves barrel removals before reparsing and preserves unrelated bindings and source positions', async () => {
            let code = [
                    "import fallback, { html, reactive, other, type Value } from './app';",
                    "import * as app from './app';",
                    "import { reactive as untouched } from './other';",
                    'export const value = 1;'
                ].join('\n'),
                file = await parse(code),
                origins = new Map<Node, string>(),
                project = makeProject(file);

            for (let statement of file.statements) {
                if (!isImportDeclaration(statement)) {
                    continue;
                }

                let bindings = statement.importClause?.namedBindings;

                if (bindings && isNamedImports(bindings)) {
                    for (let element of bindings.elements) {
                        if (element.name.text === 'html' || element.name.text === 'reactive') {
                            origins.set(element.name, element.name.text === 'html' ? 'template-pkg' : 'reactivity-pkg');
                        }
                    }
                }
            }

            project.checker = {
                getSymbolAtLocation: (node: Node) => ({
                    declarations: [{ path: `${root}/node_modules/${origins.get(node) ?? 'other-pkg'}/index.d.ts` }]
                })
            } as unknown as Checker;

            let plugin = makePlugin(() => ({
                    imports: [
                        { namespace: 'template', package: 'template-pkg', remove: ['html'] },
                        { namespace: 'reactivity', package: 'reactivity-pkg', remove: ['reactive'] }
                    ],
                    prepend: ['const generated = true;']
                })),
                result = await coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.code).toContain("import fallback, { other, type Value } from './app';");
            expect(result.code).toContain("import * as app from './app';");
            expect(result.code).toContain("import { reactive as untouched } from './other';");
            expect(result.code).toContain("import * as template from 'template-pkg';");
            expect(result.code).toContain("import * as reactivity from 'reactivity-pkg';");
            expect(result.code).not.toContain('{ html');
            expect(sourcemap.resolveOffset(result.map, result.code.indexOf('export const value'))).toBe(code.indexOf('export const value'));
        });

        it('batches multiple intents for the same package into one modify call', async () => {
            let code = 'let x = 1;',
                file = await parse(code),
                project = makeProject(file),
                plugin = makePlugin(() => ({
                    imports: [
                        { add: ['foo'], package: '@pkg/a' },
                        { add: ['bar'], package: '@pkg/a' },
                        { add: ['baz'], package: '@pkg/a' }
                    ]
                })),
                result = await coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toContain("import { bar, baz, foo } from '@pkg/a';");

            let importMatches = result.code.match(/import\s*\{[^}]+\}\s*from\s*'@pkg\/a'/g);

            expect(importMatches).toHaveLength(1);
        });

        it('re-parses only between distinct packages', async () => {
            let code = 'let x = 1;',
                file = await parse(code),
                project = makeProject(file),
                plugin = makePlugin(() => ({
                    imports: [
                        { add: ['foo'], package: '@pkg/a' },
                        { add: ['bar'], package: '@pkg/a' },
                        { add: ['qux'], package: '@pkg/b' }
                    ]
                })),
                result = await coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toContain("import { bar, foo } from '@pkg/a';");
            expect(result.code).toContain("import { qux } from '@pkg/b';");
        });

        it('merges add and remove for same package', async () => {
            let code = "import { bar, foo } from '@pkg/a';\nlet x = 1;",
                file = await parse(code),
                project = makeProject(file),
                plugin = makePlugin(() => ({
                    imports: [
                        { add: ['baz'], package: '@pkg/a' },
                        { package: '@pkg/a', remove: ['bar'] }
                    ]
                })),
                result = await coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toContain("import { baz, foo } from '@pkg/a';");
            expect(result.code).not.toMatch(/import\s*\{[^}]*bar[^}]*\}\s*from\s*'@pkg\/a'/);
        });

        it('preserves namespace across merged intents', async () => {
            let code = 'let x = 1;',
                file = await parse(code),
                project = makeProject(file),
                plugin = makePlugin(() => ({
                    imports: [
                        { namespace: 'utils', package: '@pkg/a' },
                        { add: ['foo'], package: '@pkg/a' }
                    ]
                })),
                result = await coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toContain("import * as utils from '@pkg/a';");
            expect(result.code).toContain("import { foo } from '@pkg/a';");
        });
    });

    // Sourcemap composition: the coordinator surfaces an original->transformed mapping.

    describe('surfaced mapping', () => {
        it('surfaces an identity mapping when no plugins run', async () => {
            let code = 'let x = 1;\nlet y = 2;',
                file = await parse(code),
                project = makeProject(file),
                result = await coordinator.transform([], code, file, project, root, new Map());

            expect(result.map.generations).toEqual([]);
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 1, 4)).toEqual({ column: 4, line: 1 });
        });

        it('prepend-only: shifts post-injection lines back to their real source lines', async () => {
            let code = 'let a = 1;\nlet b = 2;',
                file = await parse(code),
                project = makeProject(file),
                plugin = makePlugin(() => ({ prepend: ['const INJECTED = 0;'] })),
                result = await coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 1, 4)).toEqual({ column: 4, line: 0 });
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 2, 4)).toEqual({ column: 4, line: 1 });
        });

        it('import-injection: the untouched body maps back past the injected import', async () => {
            let code = 'let x = 1;',
                file = await parse(code),
                project = makeProject(file),
                plugin = makePlugin(() => ({ imports: [{ add: ['foo'], package: 'my-pkg' }] })),
                result = await coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toContain("import { foo } from 'my-pkg';");
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 1, 4)).toEqual({ column: 4, line: 0 });
        });

        it('replacement with line growth: text after the grown span maps to the real line', async () => {
            let code = 'let x = OLD;',
                file = await parse(code),
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
                result = await coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toBe('let x = NEW\nEXTRA;');
            // Untouched prefix maps identically.
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 0, 0)).toEqual({ column: 0, line: 0 });
            // The trailing ';' (now on a new line) still maps to its real column on the single original line.
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 1, 5)).toEqual({ column: 11, line: 0 });
        });

        it('replacement with line shrink: a multi-line node collapses and later text keeps its real line', async () => {
            let code = 'let x = foo(\n    1\n);',
                file = await parse(code),
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
                result = await coordinator.transform([plugin], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.code).toBe('let x = BAR;');
            // The ';' following the collapsed call maps back to original line 2.
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 0, 11)).toEqual({ column: 1, line: 2 });
        });

        it('multi-plugin chaining: two prepend generations compose into one mapping', async () => {
            let code = 'let a = 1;\nlet b = 2;',
                file = await parse(code),
                project = makeProject(file),
                plugin1 = makePlugin(() => ({ prepend: ['const P1 = 1;'] })),
                plugin2 = makePlugin(() => ({ prepend: ['const P2 = 2;'] })),
                result = await coordinator.transform([plugin1, plugin2], code, file, project, root, new Map());

            expect(result.changed).toBe(true);
            expect(result.map.generations.length).toBe(2);
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 2, 4)).toEqual({ column: 4, line: 0 });
            expect(sourcemap.originalPositionFor(result.map, result.code, code, 3, 4)).toEqual({ column: 4, line: 1 });
        });
    });
});

describe('coordinator.accepts', () => {
    it('is false when no plugin pattern occurs in the code', async () => {
        let plugins: Plugin[] = [{ patterns: ['reactive('], transform: async () => ({}) }, { patterns: ['html`'], transform: async () => ({}) }];

        expect(coordinator.accepts(plugins, 'let x = 1;')).toBe(false);
    });

    it('is true when any plugin pattern occurs in the code', async () => {
        let plugins: Plugin[] = [{ patterns: ['reactive('], transform: async () => ({}) }, { patterns: ['html`'], transform: async () => ({}) }];

        expect(coordinator.accepts(plugins, 'let x = html`<b></b>`;')).toBe(true);
    });

    it('is true for a plugin without patterns, which runs on every file', async () => {
        expect(coordinator.accepts([{ transform: async () => ({}) }], 'let x = 1;')).toBe(true);
    });

    it('is false with no plugins', async () => {
        expect(coordinator.accepts([], 'let x = 1;')).toBe(false);
    });
});
