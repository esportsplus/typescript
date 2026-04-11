import { describe, expect, it } from 'vitest';

import languageService from '~/compiler/language-service';


describe('language-service', () => {
    describe('update', () => {
        it('returns a Program when given valid root + fileName + content', () => {
            let root = process.cwd().replace(/\\/g, '/'),
                fileName = root + '/test-virtual-update.ts',
                content = 'let x: number = 42;',
                program = languageService.update(root, fileName, content);

            expect(program).toBeDefined();
            expect(program.getTypeChecker).toBeDefined();
        });

        it('updated content is reflected in the program SourceFile', () => {
            let root = process.cwd().replace(/\\/g, '/'),
                fileName = root + '/test-virtual-reflect.ts',
                content = 'let hello = "world";',
                program = languageService.update(root, fileName, content),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe(content);
        });

        it('increments version for updated files', () => {
            let root = process.cwd().replace(/\\/g, '/'),
                fileName = root + '/test-virtual-version.ts';

            languageService.update(root, fileName, 'let a = 1;');

            let program = languageService.update(root, fileName, 'let a = 2;'),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let a = 2;');
        });

        it('adds new files to rootFiles', () => {
            let root = process.cwd().replace(/\\/g, '/'),
                fileName = root + '/test-virtual-new-root.ts',
                content = 'export const value = 1;',
                program = languageService.update(root, fileName, content),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe(content);
        });
    });

    describe('invalidate', () => {
        it('removes content so next getProgram reads from disk', () => {
            let root = process.cwd().replace(/\\/g, '/'),
                fileName = root + '/test-virtual-invalidate.ts',
                content = 'let val = 99;';

            languageService.update(root, fileName, content);
            languageService.invalidate(root, fileName);

            let program = languageService.update(root, fileName, 'let val = 100;'),
                sourceFile = program.getSourceFile(fileName);

            expect(sourceFile).toBeDefined();
            expect(sourceFile!.text).toBe('let val = 100;');
        });

        it('increments version for invalidated files', () => {
            let root = process.cwd().replace(/\\/g, '/'),
                fileName = root + '/test-virtual-inv-version.ts';

            languageService.update(root, fileName, 'let a = 1;');
            languageService.invalidate(root, fileName);

            let program = languageService.update(root, fileName, 'let a = 3;'),
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
});
