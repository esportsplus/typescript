import fs from 'node:fs';
import path from 'node:path';

import { createFixtureDir } from '../cli/fixtures';
import { analyzeProgram } from '~/guard/kernel/analyze';
import { configFromObject } from '~/guard/kernel/config';
import { buildProgram } from '~/guard/kernel/program';

import type { Diagnostic } from '~/guard/kernel/types';


// Test-facing shape: a `channels` map still written in the pre-hoist style
// (`{ enabled, dispatch, ...options }`), translated below to the flat per-channel
// `tsc-guard` config (`enabled:false` -> `severity:"off"`, else `severity:"error"`).
// `entryPoints` is ignored — analysis is always whole-project.
type AnalyzeOptions = {
    channels: Record<string, unknown>;
    entryPoints?: ReadonlyArray<string>;
};

function toFlatConfig(channels: Record<string, unknown>): Record<string, unknown> {
    let flat: Record<string, unknown> = {};

    for (let [name, raw] of Object.entries(channels)) {
        let entry = typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, unknown>) } : {},
            enabled = entry['enabled'],
            severity = entry['severity'];

        delete entry['enabled'];
        delete entry['severity'];

        flat[name] = { severity: enabled === false ? 'off' : (severity ?? 'error'), ...entry };
    }

    return flat;
}


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


let analyzeFixture = (sources: Record<string, string>, { channels }: AnalyzeOptions): ReadonlyArray<Diagnostic> => {
    let dir = createFixtureDir('.fixture-guard-');

    try {
        fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
        writeSources(dir, sources);

        let built = buildProgram(path.join(dir, 'tsconfig.json'));

        try {
            let config = configFromObject(toFlatConfig(channels), dir);

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
