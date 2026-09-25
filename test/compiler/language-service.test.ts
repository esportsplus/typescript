import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyntaxKind } from 'typescript/unstable/ast';

import fs from 'fs';
import path from 'path';
import languageService from '~/compiler/language-service';


const root = process.cwd().replace(/\\/g, '/');
const config = root + '/tsconfig.json';


afterAll(() => {
    languageService.dispose();
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

        afterEach(() => {
            languageService.dispose();
            if (path.dirname(path.resolve(directory)) !== path.resolve(root, 'test')) {
                throw new Error('Fixture escaped the test directory');
            }
            fs.rmSync(directory, { recursive: true, force: true });
        });

        it('shares updates with the project opened through its canonical path', () => {
            languageService.open(canonicalConfig);
            languageService.update(configPath, fileName, 'export const value = 2;');
            expect(languageService.open(canonicalConfig).project.program.getSourceFile(fileName)?.text)
                .toBe('export const value = 2;');

            languageService.updateMany(configPath, new Map([[fileName, 'export const value = 3;']]));
            expect(languageService.open(configPath).project.program.getSourceFile(fileName)?.text)
                .toBe('export const value = 3;');
        });

        it('invalidates the existing overlay so the next snapshot reads disk', () => {
            languageService.update(canonicalConfig, fileName, 'export const value = 2;');
            languageService.invalidate(configPath, fileName);
            let { program } = languageService.updateMany(canonicalConfig, new Map());

            expect(program.getSourceFile(fileName)?.text).toBe('export const value = 1;');
        });

        it('disposes the existing project and drops its overlay', () => {
            languageService.update(canonicalConfig, fileName, 'export const value = 2;');
            let opened = languageService.open(canonicalConfig);

            languageService.dispose(configPath);
            expect(opened.snapshot.isDisposed()).toBe(true);
            expect(languageService.open(canonicalConfig).project.program.getSourceFile(fileName)?.text)
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

        afterEach(() => {
            languageService.dispose();
            fs.rmSync(directory, { force: true, recursive: true });
        });

        it('includes a project source file', () => {
            expect(languageService.contains(project, directory + '/src/entry.ts')).toBe(true);
        });

        it('excludes a file outside the config (e.g. a dependency linked from another checkout)', () => {
            expect(languageService.contains(project, root + '/src/compiler/ast.ts')).toBe(false);
        });

        it('includes a virtual module the config would match, and excludes one it would not', () => {
            expect(languageService.contains(project, directory + '/src/virtual.ts', 'export const v = 1;')).toBe(true);
            expect(languageService.contains(project, directory + '/outside.ts', 'export const v = 1;')).toBe(false);
        });

        it('admits a file created after a miss once it is invalidated', () => {
            let created = directory + '/src/created.ts';

            expect(languageService.contains(project, created)).toBe(false);

            fs.writeFileSync(created, 'export const created = 1;');
            languageService.invalidate(project, created);

            expect(languageService.contains(project, created)).toBe(true);
        });
    });

    describe('update', () => {
        it('returns a checker and program when given valid root + fileName + content', () => {
            let fileName = root + '/src/test-virtual-update.ts',
                content = 'let x: number = 42;',
                result = languageService.update(config, fileName, content);

            expect(result.program).toBeDefined();
            expect(result.checker).toBeDefined();
        });

        it('updated content is reflected in the program SourceFile', () => {
            let fileName = root + '/src/test-virtual-reflect.ts',
                content = 'let hello = "world";',
                { program } = languageService.update(config, fileName, content),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe(content);
        });

        it('keeps the current program when a file is synced with the content it already has', () => {
            let fileName = root + '/src/test-virtual-unchanged.ts',
                first = languageService.update(config, fileName, 'let a = 1;'),
                second = languageService.update(config, fileName, 'let a = 1;');

            expect(second.program).toBe(first.program);
            expect(languageService.update(config, fileName, 'let a = 2;').program).not.toBe(first.program);
        });

        it('reflects the latest content across repeated updates', () => {
            let fileName = root + '/src/test-virtual-version.ts';

            languageService.update(config, fileName, 'let a = 1;');

            let { program } = languageService.update(config, fileName, 'let a = 2;'),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let a = 2;');
        });

        it('adds new files to the program', () => {
            let fileName = root + '/src/test-virtual-new-root.ts',
                content = 'export const value = 1;',
                { program } = languageService.update(config, fileName, content),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe(content);
        });

        it('keeps an on-disk file listed once after overlaying it', () => {
            let fileName = root + '/src/compiler/imports.ts',
                content = fs.readFileSync(fileName, 'utf8'),
                { program } = languageService.update(config, fileName, content),
                matches = program.getSourceFileNames().filter(name => name.replace(/\\/g, '/') === fileName);

            expect(matches).toHaveLength(1);
        });

        it('updates multiple overlay files in one snapshot', () => {
            let first = root + '/src/test-virtual-batch-first.ts',
                second = root + '/src/test-virtual-batch-second.ts',
                { program } = languageService.updateMany(config, new Map([
                    [first, 'export let first = 1;'],
                    [second, 'export let second = 2;']
                ]));

            expect(program.getSourceFile(first)?.text).toBe('export let first = 1;');
            expect(program.getSourceFile(second)?.text).toBe('export let second = 2;');
        });
    });

    describe('invalidate', () => {
        it('removes content so the next update reflects fresh content', () => {
            let fileName = root + '/src/test-virtual-invalidate.ts';

            languageService.update(config, fileName, 'let val = 99;');
            languageService.invalidate(config, fileName);

            let { program } = languageService.update(config, fileName, 'let val = 100;'),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let val = 100;');
        });

        it('reflects new content for invalidated files', () => {
            let fileName = root + '/src/test-virtual-inv-version.ts';

            languageService.update(config, fileName, 'let a = 1;');
            languageService.invalidate(config, fileName);

            let { program } = languageService.update(config, fileName, 'let a = 3;'),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let a = 3;');
        });

        it('no-op when root does not exist in cache', () => {
            expect(() => {
                languageService.invalidate('/nonexistent/root', 'file.ts');
            }).not.toThrow();
        });
    });

    describe('parse', () => {
        it('returns a SourceFile whose text round-trips', () => {
            let fileName = root + '/src/test-virtual-parse.ts',
                content = 'let x: number = 42;\nfunction foo() { return 1; }',
                sourceFile = languageService.parse(fileName, content);

            expect(sourceFile.kind).toBe(SyntaxKind.SourceFile);
            expect(sourceFile.text).toBe(content);
        });

        it('parses the correct statement count', () => {
            let fileName = root + '/src/test-virtual-parse-count.ts',
                sourceFile = languageService.parse(fileName, 'const a = 1;\nconst b = 2;\nconst c = 3;');

            expect(sourceFile.statements.length).toBe(3);
        });

        it('produces usable positions', () => {
            let fileName = root + '/src/test-virtual-parse-pos.ts',
                content = 'let x = 1;\nfunction foo() {}',
                sourceFile = languageService.parse(fileName, content),
                second = sourceFile.statements[1];

            expect(second.kind).toBe(SyntaxKind.FunctionDeclaration);
            expect(second.getStart(sourceFile)).toBe(content.indexOf('function'));
        });

        it('keeps each file current while alternating between files', () => {
            let a = root + '/src/test-virtual-alternate-a.ts',
                b = root + '/src/test-virtual-alternate-b.ts';

            for (let i = 0; i < 3; i++) {
                expect(languageService.parse(a, `const a = ${i};`).text).toBe(`const a = ${i};`);
                expect(languageService.parse(b, `const b = ${i};`).text).toBe(`const b = ${i};`);
            }
        });
    });

    describe('scratch', () => {
        function declared(result: ReturnType<typeof languageService.scratch>): string {
            let statement = result.sourceFile.statements[0] as unknown as { declarationList: { declarations: { name: never }[] } };

            return result.checker.typeToString(result.checker.getTypeAtLocation(statement.declarationList.declarations[0].name)!);
        }

        it('answers type queries for a file after switching away from another', () => {
            languageService.scratch(root + '/src/test-virtual-scratch-a.ts', 'export const a: string = "a";');

            expect(declared(languageService.scratch(root + '/src/test-virtual-scratch-b.ts', 'export const b = 42 as const;'))).toBe('42');
        });

        it('sees new content when returning to an earlier file', () => {
            let a = root + '/src/test-virtual-scratch-return-a.ts';

            languageService.scratch(a, 'export const value = 1;');
            languageService.scratch(root + '/src/test-virtual-scratch-return-b.ts', 'export const other = 2;');

            let result = languageService.scratch(a, 'export const value = "changed" as const;');

            expect(result.sourceFile.text).toBe('export const value = "changed" as const;');
            expect(declared(result)).toBe('"changed"');
        });
    });

    describe('findConfig', () => {
        it('finds the repository tsconfig from a nested directory', () => {
            let config = languageService.findConfig(root + '/src/compiler');

            expect(config).not.toBeNull();
            expect(config!.endsWith('tsconfig.json')).toBe(true);
            expect(fs.existsSync(config!)).toBe(true);
        });

        it('returns null when no tsconfig exists up the tree', () => {
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
        it('is idempotent and recreates the entry on the next update', () => {
            let fileName = root + '/src/test-virtual-dispose.ts';

            languageService.update(config, fileName, 'let a = 1;');
            languageService.dispose(config);
            languageService.dispose(config);

            let { program } = languageService.update(config, fileName, 'let a = 2;'),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let a = 2;');
        });
    });
});
