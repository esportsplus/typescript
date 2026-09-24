import { afterAll, describe, test } from 'vitest';

import languageService from '~/compiler/language-service';
import path from 'path';


const root = process.cwd().split(path.sep).join('/');

const SOURCE = 'export const value = 1;\nexport function add(a: number) { return a + value; }\n';


// Every host that transforms more than one file parses a different file on each call; that path
// must stay as cheap as re-parsing the same file (it once respawned the tsgo process per file)
describe('language-service', () => {
    afterAll(() => {
        languageService.dispose();
    });

    test('parse', async ({ bench }) => {
        let i = 0;

        await bench.compare(
            bench('same file', () => {
                languageService.parse(root + '/src/bench-parse-same.ts', SOURCE + '//' + i++);
            }),
            bench('alternating files', () => {
                languageService.parse(root + '/src/bench-parse-' + (i++ % 2) + '.ts', SOURCE);
            })
        );
    });
});
