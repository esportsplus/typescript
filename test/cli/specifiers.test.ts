import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtureDir } from './fixtures';

import fs from 'fs';
import path from 'path';
import specifiers from '~/cli/specifiers';


function write(root: string, files: Record<string, string>): string[] {
    let written: string[] = [];

    for (let [relative, content] of Object.entries(files)) {
        let target = path.join(root, relative);

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        written.push(target);
    }

    return written;
}


describe('specifiers.rewrite', async () => {
    let root: string;

    beforeEach(() => {
        root = createFixtureDir('.fixture-specifiers-');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(root, { force: true, recursive: true });
    });

    it('reads but never writes a file without aliases or extensionless relative specifiers', async () => {
        let files = write(root, {
                'build/a.js': 'export const a = 1;\n',
                'build/index.js': "import fs from 'fs';\nimport { a } from './a.js';\nexport * from '@scope/pkg';\n",
                'src/a.ts': 'export const a = 1;\n'
            }),
            config = specifiers.configure({ outDir: path.join(root, 'build'), paths: { '~/*': [path.join(root, 'src', '*')] }, rootDir: path.join(root, 'src') }, []),
            spy = vi.spyOn(fs.promises, 'writeFile');

        await specifiers.rewrite(files, config);

        expect(spy).not.toHaveBeenCalled();
    });

    it('rewrites static, dynamic and require specifiers in every module format', async () => {
        let files = write(root, {
                'build/a/index.cjs': "const b = require('~/b');\nmodule.exports = b;\n",
                'build/a/index.d.cts': "export type B = typeof import('~/b');\n",
                'build/a/index.d.mts': "export type { C } from '~/c';\n",
                'build/a/index.mjs': "export { c } from '~/c';\nexport const lazy = () => import('~/b');\n",
                'src/b.cts': 'export const b = 1;\n',
                'src/c.mts': 'export const c = 1;\n'
            }),
            config = specifiers.configure({ outDir: path.join(root, 'build'), paths: { '~/*': ['./src/*'] }, pathsBasePath: root, rootDir: path.join(root, 'src') }, []);

        await specifiers.rewrite(files, config);

        expect(fs.readFileSync(files[0], 'utf8')).toContain("require('../b.cjs')");
        expect(fs.readFileSync(files[1], 'utf8')).toContain("import('../b.cjs')");
        expect(fs.readFileSync(files[2], 'utf8')).toContain("from '../c.mjs'");
        expect(fs.readFileSync(files[3], 'utf8')).toContain("from '../c.mjs'");
        expect(fs.readFileSync(files[3], 'utf8')).toContain("import('../b.cjs')");
    });

    it('prefers an exact key, then the longest wildcard prefix, then the first target that resolves', async () => {
        let files = write(root, {
                'build/index.js': "import '~/storage/data';\nimport '~/util';\nimport 'config';\nimport '~/util.js';\n",
                'lib/util.ts': 'export {};\n',
                'src/config.ts': 'export {};\n',
                'src/util.ts': 'export {};\n',
                'storage/data.json': '{}\n'
            }),
            config = specifiers.configure({
                baseUrl: root,
                outDir: path.join(root, 'build'),
                paths: {
                    'config': ['src/config'],
                    '~/*': ['missing/*', 'src/*', 'lib/*'],
                    '~/storage/*': ['storage/*']
                },
                rootDir: path.join(root, 'src')
            }, []);

        await specifiers.rewrite(files, config);

        expect(fs.readFileSync(files[0], 'utf8')).toBe("import '../storage/data.json';\nimport './util.js';\nimport './config.js';\nimport './util.js';\n");
    });

    it('defaults rootDir to the common directory of the inputs and outDir to rootDir', async () => {
        let files = write(root, {
                'src/a.ts': 'export const a = 1;\n',
                'src/deep/use.js': "import { a } from '#a';\n",
                'src/deep/use.ts': "import { a } from '#a';\n"
            }),
            config = specifiers.configure({ paths: { '#a': [path.join(root, 'src', 'a')] } }, [files[0], files[2]]);

        await specifiers.rewrite([files[1]], config);

        expect(fs.readFileSync(files[1], 'utf8')).toBe("import { a } from '../a.js';\n");
    });

    it('resolves a bare . or .. specifier to the directory index', async () => {
        let files = write(root, {
                'build/a/b/index.js': 'export default 1;\n',
                'build/a/b/use.js': "import x from '..';\nimport y from '.';\n",
                'build/a/index.js': 'export default 1;\n'
            }),
            config = specifiers.configure({ outDir: path.join(root, 'build'), rootDir: path.join(root, 'src') }, []);

        await specifiers.rewrite(files, config);

        expect(fs.readFileSync(files[1], 'utf8')).toBe("import x from '../index.js';\nimport y from './index.js';\n");
    });

    it('leaves an alias that resolves to nothing untouched', async () => {
        let files = write(root, { 'build/index.js': "import '~/gone';\n" }),
            config = specifiers.configure({ outDir: path.join(root, 'build'), paths: { '~/*': [path.join(root, 'src', '*')] }, rootDir: path.join(root, 'src') }, []);

        await specifiers.rewrite(files, config);

        expect(fs.readFileSync(files[0], 'utf8')).toBe("import '~/gone';\n");
    });
});
