import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API } from 'typescript/async';
import { SyntaxKind } from 'typescript/ast';
import { isImportDeclaration } from 'typescript/ast/is';

import fs from 'fs';
import path from 'path';
import languageService from '~/compiler/language-service';


const root = process.cwd().replace(/\\/g, '/');
const config = root + '/tsconfig.json';


afterAll(async () => {
    await languageService.dispose();
});


describe('language-service', () => {
    describe.each(['native', 'relative'])('%s config paths', (variant) => {
        let directory: string,
            configPath: string,
            canonicalConfig: string,
            fileName: string;

        beforeEach(() => {
            directory = fs.mkdtempSync(path.join(root, 'test/.language-service-'));
            canonicalConfig = directory.replace(/\\/g, '/') + '/tsconfig.json';
            configPath = variant === 'native'
                ? path.normalize(canonicalConfig)
                : path.relative(process.cwd(), canonicalConfig);
            fileName = directory.replace(/\\/g, '/') + '/entry.ts';
            fs.writeFileSync(canonicalConfig, JSON.stringify({
                compilerOptions: { noLib: true, types: [] },
                files: ['entry.ts']
            }));
            fs.writeFileSync(fileName, 'export const value = 1;');
        });

        afterEach(async () => {
            await languageService.dispose();
            if (path.dirname(path.resolve(directory)) !== path.resolve(root, 'test')) {
                throw new Error('Fixture escaped the test directory');
            }
            fs.rmSync(directory, { force: true, recursive: true });
        });

        it('shares updates with the project opened through its canonical path', async () => {
            await languageService.updateMany(canonicalConfig, new Map());
            await languageService.update(configPath, fileName, 'export const value = 2;');
            expect((await (await languageService.updateMany(canonicalConfig, new Map())).program.getSourceFile(fileName))?.text)
                .toBe('export const value = 2;');

            await languageService.updateMany(configPath, new Map([[fileName, 'export const value = 3;']]));
            expect((await (await languageService.updateMany(configPath, new Map())).program.getSourceFile(fileName))?.text)
                .toBe('export const value = 3;');
        });

        it('invalidates the existing overlay so the next snapshot reads disk', async () => {
            await languageService.update(canonicalConfig, fileName, 'export const value = 2;');
            languageService.invalidate(configPath, fileName);
            let { program } = await languageService.updateMany(canonicalConfig, new Map());

            expect((await program.getSourceFile(fileName))?.text).toBe('export const value = 1;');
        });

        it('disposes the existing project and drops its overlay', async () => {
            let lease = await languageService.update(canonicalConfig, fileName, 'export const value = 2;');

            lease.release();
            await languageService.dispose(configPath);
            await expect(lease.program.getSourceFile(fileName)).rejects.toThrow();
            expect((await (await languageService.updateMany(canonicalConfig, new Map())).program.getSourceFile(fileName))?.text)
                .toBe('export const value = 1;');
        });
    });

    describe('contains', () => {
        let directory: string,
            project: string;

        beforeEach(() => {
            directory = fs.mkdtempSync(path.join(root, 'test/.language-service-contains-')).replace(/\\/g, '/');
            project = directory + '/tsconfig.json';
            fs.mkdirSync(directory + '/src');
            fs.writeFileSync(project, JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['src'] }));
            fs.writeFileSync(directory + '/src/entry.ts', 'export const value = 1;');
        });

        afterEach(async () => {
            await languageService.dispose();
            fs.rmSync(directory, { force: true, recursive: true });
        });

        it('includes a project source file', async () => {
            expect(await languageService.contains(project, directory + '/src/entry.ts')).toBe(true);
        });

        it('excludes a file outside the config (e.g. a dependency linked from another checkout)', async () => {
            expect(await languageService.contains(project, root + '/src/compiler/ast.ts')).toBe(false);
        });

        it('includes a virtual module the config would match, and excludes one it would not', async () => {
            expect(await languageService.contains(project, directory + '/src/virtual.ts', 'export const v = 1;')).toBe(true);
            expect(await languageService.contains(project, directory + '/outside.ts', 'export const v = 1;')).toBe(false);
        });

        it('admits a file created after a miss once it is invalidated', async () => {
            let created = directory + '/src/created.ts';

            expect(await languageService.contains(project, created)).toBe(false);

            fs.writeFileSync(created, 'export const created = 1;');
            languageService.invalidate(project, created);

            expect(await languageService.contains(project, created)).toBe(true);
        });

        it('admits a file outside the config that a later snapshot imports', async () => {
            let entry = directory + '/src/entry.ts',
                linked = directory + '/lib/linked.ts';

            expect(await languageService.contains(project, entry)).toBe(true);

            fs.mkdirSync(directory + '/lib');
            fs.writeFileSync(linked, 'export const linked = 1;');
            languageService.invalidate(project, linked);
            await languageService.update(project, entry, "import { linked } from '../lib/linked';\nexport const value = linked;");

            expect(await languageService.contains(project, linked)).toBe(true);
        });
    });

    describe('update', () => {
        it('returns a checker and program when given valid root + fileName + content', async () => {
            let fileName = root + '/src/test-virtual-update.ts',
                content = 'let x: number = 42;',
                result = await languageService.update(config, fileName, content);

            expect(result.program).toBeDefined();
            expect(result.checker).toBeDefined();
        });

        it('updated content is reflected in the program SourceFile', async () => {
            let fileName = root + '/src/test-virtual-reflect.ts',
                content = 'let hello = "world";',
                { program } = await languageService.update(config, fileName, content),
                sourceFile = await program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe(content);
        });

        it('keeps the current program when a file is synced with the content it already has', async () => {
            let fileName = root + '/src/test-virtual-unchanged.ts',
                first = await languageService.update(config, fileName, 'let a = 1;'),
                second = await languageService.update(config, fileName, 'let a = 1;');

            expect(second.program).toBe(first.program);
            expect((await languageService.update(config, fileName, 'let a = 2;')).program).not.toBe(first.program);
        });

        it('reflects the latest content across repeated updates', async () => {
            let fileName = root + '/src/test-virtual-version.ts';

            await languageService.update(config, fileName, 'let a = 1;');

            let { program } = await languageService.update(config, fileName, 'let a = 2;'),
                sourceFile = await program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let a = 2;');
        });

        it('adds new files to the program', async () => {
            let fileName = root + '/src/test-virtual-new-root.ts',
                content = 'export const value = 1;',
                { program } = await languageService.update(config, fileName, content),
                sourceFile = await program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe(content);
        });

        it('keeps an on-disk file listed once after overlaying it', async () => {
            let fileName = root + '/src/compiler/imports.ts',
                content = fs.readFileSync(fileName, 'utf8'),
                { program } = await languageService.update(config, fileName, content),
                matches = (await program.getSourceFileNames()).filter(name => name.replace(/\\/g, '/') === fileName);

            expect(matches).toHaveLength(1);
        });

        it('updates multiple overlay files in one snapshot', async () => {
            let first = root + '/src/test-virtual-batch-first.ts',
                second = root + '/src/test-virtual-batch-second.ts',
                { program } = await languageService.updateMany(config, new Map([
                    [first, 'export let first = 1;'],
                    [second, 'export let second = 2;']
                ]));

            expect((await program.getSourceFile(first))?.text).toBe('export let first = 1;');
            expect((await program.getSourceFile(second))?.text).toBe('export let second = 2;');
        });

        it('shares one snapshot between concurrent transforms of files the program holds', async () => {
            let a = root + '/src/compiler/ast.ts',
                b = root + '/src/compiler/code.ts',
                [first, second] = await Promise.all([
                    languageService.update(config, a, fs.readFileSync(a, 'utf8')),
                    languageService.update(config, b, fs.readFileSync(b, 'utf8'))
                ]);

            expect(second.program).toBe(first.program);
            first.release();
            second.release();
        });

        it('keeps a leased snapshot readable after a later update replaces it', async () => {
            let fileName = root + '/src/test-virtual-leased.ts',
                leased = await languageService.update(config, fileName, 'export let leased = 1;'),
                later = await languageService.update(config, fileName, 'export let leased = 2;');

            expect(later.program).not.toBe(leased.program);
            expect((await leased.program.getSourceFile(fileName))?.text).toBe('export let leased = 1;');
            expect((await later.program.getSourceFile(fileName))?.text).toBe('export let leased = 2;');

            leased.release();
            later.release();
        });
    });

    describe('invalidate', () => {
        it('removes content so the next update reflects fresh content', async () => {
            let fileName = root + '/src/test-virtual-invalidate.ts';

            await languageService.update(config, fileName, 'let val = 99;');
            languageService.invalidate(config, fileName);

            let { program } = await languageService.update(config, fileName, 'let val = 100;'),
                sourceFile = await program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let val = 100;');
        });

        it('reflects new content for invalidated files', async () => {
            let fileName = root + '/src/test-virtual-inv-version.ts';

            await languageService.update(config, fileName, 'let a = 1;');
            languageService.invalidate(config, fileName);

            let { program } = await languageService.update(config, fileName, 'let a = 3;'),
                sourceFile = await program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let a = 3;');
        });

        it('no-op when root does not exist in cache', async () => {
            expect(() => {
                languageService.invalidate('/nonexistent/root', 'file.ts');
            }).not.toThrow();
        });
    });

    describe('membership and disk text', () => {
        let directory: string,
            project: string;

        beforeEach(() => {
            directory = fs.mkdtempSync(path.join(root, 'test/.language-service-members-')).replace(/\\/g, '/');
            project = directory + '/tsconfig.json';
            fs.mkdirSync(directory + '/src');
            fs.writeFileSync(project, JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['src'] }));
            fs.writeFileSync(directory + '/src/a.ts', 'export const a = 1;');
        });

        afterEach(async () => {
            await languageService.dispose();
            fs.rmSync(directory, { force: true, recursive: true });
        });

        it('admits a file created after the file list was read, and still rejects outsiders', async () => {
            expect(await languageService.contains(project, directory + '/outside.ts')).toBe(false);

            languageService.invalidate(project, directory + '/src/a.ts');
            fs.writeFileSync(directory + '/src/b.ts', 'export const b = 1;');
            languageService.invalidate(project, directory + '/src/b.ts');

            expect(await languageService.contains(project, directory + '/src/b.ts')).toBe(true);
            expect(await languageService.contains(project, directory + '/outside.ts')).toBe(false);
        });

        it('reloads a file whose disk text changed under the open program', async () => {
            let file = directory + '/src/a.ts',
                { program } = await languageService.update(project, file, 'export const a = 1;');

            expect((await languageService.update(project, file, 'export const a = 1;')).program).toBe(program);

            fs.writeFileSync(file, 'export const a = 22;');
            languageService.invalidate(project, file);

            expect((await (await languageService.update(project, file, 'export const a = 22;')).program.getSourceFile(file))?.text).toBe('export const a = 22;');
        });
    });

    describe('overlay-only files', () => {
        let directory: string,
            project: string;

        beforeEach(() => {
            directory = fs.mkdtempSync(path.join(root, 'test/.language-service-virtual-')).replace(/\\/g, '/');
            project = directory + '/tsconfig.json';
            fs.mkdirSync(directory + '/lib');
            fs.mkdirSync(directory + '/src');
            fs.writeFileSync(project, JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['src'] }));
            fs.writeFileSync(directory + '/src/entry.ts', 'export const value = 1;');
        });

        afterEach(async () => {
            await languageService.dispose();
            fs.rmSync(directory, { force: true, recursive: true });
        });

        it('resolves an import of a file that exists only in the overlay', async () => {
            let entry = directory + '/src/entry.ts',
                virtual = directory + '/lib/virtual.ts';

            let { checker, program } = await languageService.updateMany(project, new Map([
                    [virtual, 'export const v = 1;'],
                    [entry, "import { v } from '../lib/virtual';\nexport const value = v;"]
                ])),
                declaration = (await program.getSourceFile(entry))!.statements[0];

            expect(isImportDeclaration(declaration) && await checker.getSymbolAtLocation(declaration.moduleSpecifier)).toBeTruthy();
        });
    });

    describe('parse', () => {
        it('finishes a parse in flight when dispose() closes its client, then closes it', async () => {
            let close = vi.spyOn(API.prototype, 'close'),
                content = 'export const late = 1;',
                create = vi.spyOn(API.prototype, 'createSourceFile'),
                parsing = languageService.parse(root + '/src/test-virtual-parse-dispose.ts', content),
                disposing = languageService.dispose();

            expect((await parsing).text).toBe(content);

            await disposing;

            expect(create.mock.contexts).toHaveLength(1);
            expect(close.mock.contexts).toContain(create.mock.contexts[0]);
            create.mockRestore();
            close.mockRestore();
        });

        it('returns a SourceFile whose text round-trips', async () => {
            let fileName = root + '/src/test-virtual-parse.ts',
                content = 'let x: number = 42;\nfunction foo() { return 1; }',
                sourceFile = await languageService.parse(fileName, content);

            expect(sourceFile.kind).toBe(SyntaxKind.SourceFile);
            expect(sourceFile.text).toBe(content);
        });

        it('parses the correct statement count', async () => {
            let fileName = root + '/src/test-virtual-parse-count.ts',
                sourceFile = await languageService.parse(fileName, 'const a = 1;\nconst b = 2;\nconst c = 3;');

            expect(sourceFile.statements.length).toBe(3);
        });

        it('produces usable positions', async () => {
            let fileName = root + '/src/test-virtual-parse-pos.ts',
                content = 'let x = 1;\nfunction foo() {}',
                sourceFile = await languageService.parse(fileName, content),
                second = sourceFile.statements[1];

            expect(second.kind).toBe(SyntaxKind.FunctionDeclaration);
            expect(second.getStart(sourceFile)).toBe(content.indexOf('function'));
        });

        it('keeps each file current while alternating between files', async () => {
            let a = root + '/src/test-virtual-alternate-a.ts',
                b = root + '/src/test-virtual-alternate-b.ts';

            for (let i = 0; i < 3; i++) {
                expect((await languageService.parse(a, `const a = ${i};`)).text).toBe(`const a = ${i};`);
                expect((await languageService.parse(b, `const b = ${i};`)).text).toBe(`const b = ${i};`);
            }
        });

        it('keeps an earlier tree walkable once later parses release it', async () => {
            let fileName = root + '/src/test-virtual-parse-released.ts',
                earlier = await languageService.parse(fileName, 'export const a = 1;\nexport function f() {}');

            await languageService.parse(fileName, 'export const b = 2;');
            await languageService.parse(root + '/src/test-virtual-parse-released-other.ts', 'export {};');

            expect(earlier.statements.length).toBe(2);
            expect(earlier.statements[1].getText(earlier)).toBe('export function f() {}');
        });

        it('parses JSX by the file extension', async () => {
            let sourceFile = await languageService.parse(root + '/src/test-virtual-parse-jsx.tsx', 'export const v = <div class="x">{1}</div>;');

            expect(sourceFile.fileName).toBe(root + '/src/test-virtual-parse-jsx.tsx');
            expect(sourceFile.statements.length).toBe(1);
        });
    });

    describe('scratch', () => {
        async function declared(result: Awaited<ReturnType<typeof languageService.scratch>>): Promise<string> {
            let statement = result.sourceFile.statements[0] as unknown as { declarationList: { declarations: { name: never }[] } };

            return result.checker.typeToString(await result.checker.getTypeAtLocation(statement.declarationList.declarations[0].name));
        }

        it('answers type queries for a file after switching away from another', async () => {
            await languageService.scratch(root + '/src/test-virtual-scratch-a.ts', 'export const a: string = "a";');

            expect(await declared(await languageService.scratch(root + '/src/test-virtual-scratch-b.ts', 'export const b = 42 as const;'))).toBe('42');
        });

        it('sees new content when returning to an earlier file', async () => {
            let a = root + '/src/test-virtual-scratch-return-a.ts';

            await languageService.scratch(a, 'export const value = 1;');
            await languageService.scratch(root + '/src/test-virtual-scratch-return-b.ts', 'export const other = 2;');

            let result = await languageService.scratch(a, 'export const value = "changed" as const;');

            expect(result.sourceFile.text).toBe('export const value = "changed" as const;');
            expect(await declared(result)).toBe('"changed"');
        });
    });

    describe('findConfig', () => {
        it('finds the repository tsconfig from a nested directory', async () => {
            let config = languageService.findConfig(root + '/src/compiler');

            expect(config).not.toBeNull();
            expect(config!.endsWith('tsconfig.json')).toBe(true);
            expect(fs.existsSync(config!)).toBe(true);
        });

        it('returns null when no tsconfig exists up the tree', async () => {
            let directory = '/no-tsconfig/nested/deep';
            if (process.platform === 'win32') {
                const drive = ['Z', 'Y', 'X', 'W', 'V'].find((letter) => !fs.existsSync(letter + ':/'));
                expect(drive).toBeDefined();
                directory = drive + ':' + directory;
            }
            expect(languageService.findConfig(directory)).toBeNull();
        });
    });

    describe('dispose', () => {
        it('is idempotent and recreates the entry on the next update', async () => {
            let fileName = root + '/src/test-virtual-dispose.ts';

            await languageService.update(config, fileName, 'let a = 1;');
            await languageService.dispose(config);
            await languageService.dispose(config);

            let { program } = await languageService.update(config, fileName, 'let a = 2;'),
                sourceFile = await program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let a = 2;');
        });
    });
});
