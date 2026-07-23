import { SyntaxKind } from 'typescript/unstable/ast';
import { afterAll, describe, expect, it } from 'vitest';

import languageService from '~/compiler/language-service';

import fs from 'fs';


const root = process.cwd().replace(/\\/g, '/');


afterAll(() => {
    languageService.dispose();
});

describe('language-service', () => {
    describe('update', () => {
        it('returns a checker and program when given valid root + fileName + content', () => {
            let fileName = root + '/src/test-virtual-update.ts',
                content = 'let x: number = 42;',
                result = languageService.update(root, fileName, content);

            expect(result.program).toBeDefined();
            expect(result.checker).toBeDefined();
        });

        it('updated content is reflected in the program SourceFile', () => {
            let fileName = root + '/src/test-virtual-reflect.ts',
                content = 'let hello = "world";',
                { program } = languageService.update(root, fileName, content),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe(content);
        });

        it('reflects the latest content across repeated updates', () => {
            let fileName = root + '/src/test-virtual-version.ts';

            languageService.update(root, fileName, 'let a = 1;');

            let { program } = languageService.update(root, fileName, 'let a = 2;'),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let a = 2;');
        });

        it('adds new files to the program', () => {
            let fileName = root + '/src/test-virtual-new-root.ts',
                content = 'export const value = 1;',
                { program } = languageService.update(root, fileName, content),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe(content);
        });
    });

    describe('invalidate', () => {
        it('removes content so the next update reflects fresh content', () => {
            let fileName = root + '/src/test-virtual-invalidate.ts';

            languageService.update(root, fileName, 'let val = 99;');
            languageService.invalidate(root, fileName);

            let { program } = languageService.update(root, fileName, 'let val = 100;'),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let val = 100;');
        });

        it('reflects new content for invalidated files', () => {
            let fileName = root + '/src/test-virtual-inv-version.ts';

            languageService.update(root, fileName, 'let a = 1;');
            languageService.invalidate(root, fileName);

            let { program } = languageService.update(root, fileName, 'let a = 3;'),
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
    });

    describe('findConfig', () => {
        it('finds the repository tsconfig from a nested directory', () => {
            let config = languageService.findConfig(root + '/src/compiler');

            expect(config).not.toBeNull();
            expect(config!.endsWith('tsconfig.json')).toBe(true);
            expect(fs.existsSync(config!)).toBe(true);
        });

        it('returns null when no tsconfig exists up the tree', () => {
            let drive = ['Z', 'Y', 'X', 'W', 'V'].find((letter) => !fs.existsSync(letter + ':/'));

            expect(drive).toBeDefined();
            expect(languageService.findConfig(drive + ':/no-tsconfig/nested/deep')).toBeNull();
        });
    });

    describe('dispose', () => {
        it('is idempotent and recreates the entry on the next update', () => {
            let fileName = root + '/src/test-virtual-dispose.ts';

            languageService.update(root, fileName, 'let a = 1;');
            languageService.dispose(root);
            languageService.dispose(root);

            let { program } = languageService.update(root, fileName, 'let a = 2;'),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let a = 2;');
        });
    });
});
