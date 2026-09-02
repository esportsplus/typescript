import fs from 'node:fs';
import path from 'node:path';

import { createFixtureDir } from '../cli/fixtures';
import { analyzeProgram } from '~/probe/kernel/analyze';
import { configFromObject } from '~/probe/kernel/config';
import { buildProgram } from '~/probe/kernel/program';

import type { Diagnostic } from '~/probe/kernel/types';


type AnalyzeOptions = {
    channels: Record<string, unknown>;
    entryPoints?: ReadonlyArray<string>;
};


let tsconfig = {
    compilerOptions: {
        lib: ['esnext', 'dom'],
        module: 'esnext',
        moduleResolution: 'bundler',
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: 'esnext'
    },
    include: ['src']
};


function writeSources(dir: string, sources: Record<string, string>): void {
    for (let [relative, text] of Object.entries(sources)) {
        let target = path.join(dir, 'src', relative);

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
    }
}


let analyzeFixture = (sources: Record<string, string>, { channels, entryPoints = ['src/**/*.ts'] }: AnalyzeOptions): ReadonlyArray<Diagnostic> => {
    let dir = createFixtureDir('.fixture-probe-');

    try {
        fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
        writeSources(dir, sources);

        let built = buildProgram(path.join(dir, 'tsconfig.json'));

        try {
            let config = configFromObject({ channels, entryPoints }, dir);

            return analyzeProgram(built.program, built.checker, config).diagnostics;
        }
        finally {
            built.dispose();
        }
    }
    finally {
        fs.rmSync(dir, { force: true, recursive: true });
    }
};


export { analyzeFixture };
