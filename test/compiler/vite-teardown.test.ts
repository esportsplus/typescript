import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { isCallExpression, isIdentifier } from 'typescript/ast/is';
import type { Node } from 'typescript/ast';
import type { Plugin } from '~/compiler/types';
import { build, createServer } from 'vite';

import fs from 'fs';
import languageService from '~/compiler/language-service';
import path from 'path';
import vite from '~/compiler/plugins/vite';


let directory = fs.mkdtempSync(path.join(process.cwd(), 'test/.vite-teardown-')).replace(/\\/g, '/'),
    entry = directory + '/src/app.ts';


// Live tsgo API clients this process spawned
function clients(): number {
    let count = 0,
        handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();

    for (let i = 0, n = handles.length; i < n; i++) {
        let handle = handles[i] as { constructor: { name: string }; spawnargs?: string[] };

        if (handle.constructor.name === 'ChildProcess' && handle.spawnargs?.includes('--api')) {
            count++;
        }
    }

    return count;
}

function each(node: Node, visit: (node: Node) => void): void {
    visit(node);
    node.forEachChild((child) => {
        each(child, visit);
    });
}

// Renames the call opening the module and prepends a statement: the edit reaches the first
// statement, so the coordinator re-parses through the language service's parse client
function renaming(): Plugin {
    return {
        name: 'rename',
        async transform({ sourceFile }) {
            let replacements: NonNullable<Awaited<ReturnType<Plugin['transform']>>['replacements']> = [];

            each(sourceFile, (node) => {
                if (isCallExpression(node) && isIdentifier(node.expression) && node.expression.text === 'start') {
                    replacements.push({ generate: () => 'begin', node: node.expression });
                }
            });

            return { prepend: ['const begin = () => 1;'], replacements };
        }
    };
}

function settled(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 50);
    });
}


fs.mkdirSync(directory + '/src', { recursive: true });
fs.writeFileSync(directory + '/tsconfig.json', JSON.stringify({
    compilerOptions: { module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true, strict: true, target: 'esnext' },
    include: ['src']
}));
fs.writeFileSync(entry, 'start();\ndeclare function start(): number;\nexport const value = 1;\n');


afterAll(async () => {
    await languageService.dispose();
    fs.rmSync(directory, { force: true, recursive: true });
});

afterEach(() => {
    vi.restoreAllMocks();
});


describe('plugin.vite teardown', () => {
    it('closes every tsgo client it started, the parse client included, when the build ends', async () => {
        let parse = vi.spyOn(languageService, 'parse');

        await build({
            build: { lib: { entry, formats: ['es'] }, minify: false, write: false },
            configFile: false,
            logLevel: 'silent',
            plugins: [vite({ name: 'teardown', plugins: [renaming()] })({ root: directory })],
            root: directory
        });
        await settled();

        expect(parse).toHaveBeenCalled();
        expect(clients()).toBe(0);
    });

    it('keeps its tsgo clients while serving, and closes them with the server', async () => {
        let server = await createServer({
                configFile: false,
                logLevel: 'silent',
                plugins: [vite({ name: 'teardown', plugins: [renaming()] })({ root: directory })],
                root: directory,
                server: { middlewareMode: true, ws: false }
            }),
            result = await server.transformRequest('/src/app.ts');

        expect(result?.code).toContain('begin()');
        expect(clients()).toBeGreaterThan(0);

        await server.close();
        await settled();

        expect(clients()).toBe(0);
    });
});
