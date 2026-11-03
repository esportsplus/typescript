import { describe, expect, it } from 'vitest';

import { analyzeProgram } from '~/guard/kernel/analyze';
import { loadConfigFromTsconfig } from '~/guard/kernel/config';

import crypto from 'node:crypto';
import cp from 'node:child_process';
import fs from 'node:fs';
import languageService from '~/compiler/language-service';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import type { Diagnostic, SourceLocation } from '~/guard/kernel/types';


type Analyzer = {
    analyzeProgram: typeof analyzeProgram;
    loadConfigFromTsconfig: typeof loadConfigFromTsconfig;
};

type Recording = {
    findings: unknown[];
    fingerprint: string;
};


// Commit the `self` project is frozen at: analyzing the live tree would change its findings with every
// edit to this repository (this test included), so it analyzes the base commit's sources instead
const BASE = '79643b2';

const DIRECTORY = path.join(import.meta.dirname, 'golden');

// Real projects on the development machine whose findings are pinned; absent ones are skipped
const PROJECTS: Record<string, () => string | undefined> = {
    reactivity: () => existing('G:/reactivity/tsconfig.json'),
    routing: () => existing('G:/routing/tsconfig.json'),
    self: () => frozen(),
    template: () => existing('G:/template/tsconfig.json')
};

// `GOLDEN_RECORD=1` records with this tree's analyzer; `GOLDEN_RECORD=<build directory>` with a built
// one, so a project whose sources moved on is re-recorded by the baseline rather than the code under test
const RECORD = process.env.GOLDEN_RECORD;

const ROOT = path.resolve(import.meta.dirname, '..', '..');


async function analyzer(): Promise<Analyzer> {
    if (RECORD === undefined || RECORD === '1') {
        return { analyzeProgram, loadConfigFromTsconfig };
    }

    let build = url.pathToFileURL(path.resolve(RECORD)).href,
        [analyze, config] = await Promise.all([
            import(`${build}/guard/kernel/analyze.js`) as Promise<Pick<Analyzer, 'analyzeProgram'>>,
            import(`${build}/guard/kernel/config.js`) as Promise<Pick<Analyzer, 'loadConfigFromTsconfig'>>
        ]);

    return { analyzeProgram: analyze.analyzeProgram, loadConfigFromTsconfig: config.loadConfigFromTsconfig };
}

function existing(tsconfig: string): string | undefined {
    return fs.existsSync(tsconfig) ? tsconfig : undefined;
}

// Content hash of every in-project file the program holds, so a recording is only compared against
// the sources it was taken from
function fingerprint(names: readonly string[]): string {
    let hash = crypto.createHash('sha256'),
        files = names.filter((name) => !name.replace(/\\/g, '/').includes('/node_modules/')).sort();

    for (let i = 0, n = files.length; i < n; i++) {
        hash.update(files[i]);
        hash.update('\0');
        hash.update(fs.readFileSync(files[i]));
        hash.update('\0');
    }

    return hash.digest('hex');
}

function frozen(): string | undefined {
    let dir = path.join(os.tmpdir(), `esportsplus-typescript-golden-${BASE}`),
        tsconfig = path.join(dir, 'tsconfig.json');

    if (fs.existsSync(tsconfig)) {
        return tsconfig;
    }

    let archive: Buffer;

    try {
        archive = cp.execFileSync('git', ['archive', '--format=tar', BASE], { cwd: ROOT, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });
    }
    catch {
        return undefined;
    }

    let staging = `${dir}.${process.pid}`;

    fs.mkdirSync(staging, { recursive: true });
    cp.execFileSync('tar', ['-x', '-C', staging], { input: archive });
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(staging, 'node_modules'), 'junction');
    fs.renameSync(staging, dir);

    return tsconfig;
}

function location(value: SourceLocation, root: string): SourceLocation {
    return { ...value, fileName: relative(value.fileName, root) };
}

function relative(fileName: string, root: string): string {
    return path.relative(root, fileName).replace(/\\/g, '/');
}

function serialize(diagnostics: readonly Diagnostic[], root: string): unknown[] {
    let out: unknown[] = [];

    for (let i = 0, n = diagnostics.length; i < n; i++) {
        let diagnostic = diagnostics[i];

        out.push({
            ...diagnostic,
            fixes: diagnostic.fixes?.map((fix) => ({
                ...fix,
                edits: fix.edits.map((edit) => ({ ...edit, fileName: relative(edit.fileName, root) }))
            })),
            location: location(diagnostic.location, root),
            related: diagnostic.related.map((related) => ({ ...related, location: location(related.location, root) }))
        });
    }

    return out;
}


describe('guard golden findings', () => {
    for (let [name, resolve] of Object.entries(PROJECTS)) {
        it(name, async (context) => {
            let tsconfig = resolve();

            if (tsconfig === undefined) {
                context.skip();

                return;
            }

            let guard = await analyzer(),
                config = guard.loadConfigFromTsconfig(tsconfig),
                file = path.join(DIRECTORY, `${name}.json`),
                opened = languageService.open(tsconfig);

            if (config === undefined) {
                throw new Error(`golden: ${tsconfig} has no tsc-guard config`);
            }

            try {
                let recording: Recording = {
                        findings: serialize(guard.analyzeProgram(opened.project.program, opened.project.checker, config).diagnostics, path.dirname(tsconfig)),
                        fingerprint: fingerprint(opened.project.program.getSourceFileNames())
                    },
                    text = JSON.stringify(recording, null, 4) + '\n';

                if (RECORD !== undefined) {
                    fs.mkdirSync(DIRECTORY, { recursive: true });
                    fs.writeFileSync(file, text);

                    return;
                }

                // A checkout with autocrlf turns the recording's line endings into CRLF
                let content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'),
                    expected = JSON.parse(content) as Recording;

                if (expected.fingerprint !== recording.fingerprint) {
                    throw new Error(`golden: ${name} sources changed since recording; re-record against the baseline analyzer`);
                }

                expect(text).toBe(content);
            }
            finally {
                opened.dispose();
            }
        }, 120_000);
    }
});
