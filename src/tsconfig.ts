import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { stripJsonc } from './jsonc';

let require = createRequire(import.meta.url);

// Recursive merge with child (override) winning per key. Plain objects merge
// deeply so a package can set `tsc-guard.channels.exceptions.report` without
// restating the rest; scalars and arrays are replaced outright.
function deepMerge(base: unknown, override: unknown): unknown {
    if (!isPlainObject(base) || !isPlainObject(override)) {
        return override;
    }

    let result: Record<string, unknown> = { ...base };

    for (let key of Object.keys(override)) {
        result[key] = key in result
            ? deepMerge(result[key], override[key])
            : override[key];
    }

    return result;
}

function extendsTarget(specifier: unknown, fromDir: string): string | null {
    if (typeof specifier !== 'string') {
        return null;
    }

    if (specifier.startsWith('.')) {
        let resolved = path.resolve(fromDir, specifier);

        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            return resolved;
        }

        if (fs.existsSync(resolved + '.json')) {
            return resolved + '.json';
        }

        let nested = path.join(resolved, 'tsconfig.json');

        return fs.existsSync(nested) ? nested : null;
    }

    try {
        return require.resolve(specifier, { paths: [fromDir] });
    }
    catch {
        try {
            return require.resolve(specifier + '/tsconfig.json', { paths: [fromDir] });
        }
        catch {
            return null;
        }
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkExtends<T>(
    tsconfigPath: string,
    fold: (config: Record<string, unknown>, inherited: T | undefined) => T | undefined,
): T | undefined {
    const seen = new Set<string>();

    function read(configPath: string, inherited: T | undefined): T | undefined {
        const id = path.resolve(configPath);

        if (seen.has(id)) {
            return inherited;
        }

        seen.add(id);

        let config: Record<string, unknown>;

        try {
            config = JSON.parse(stripJsonc(fs.readFileSync(id, 'utf8'))) as Record<string, unknown>;
        }
        catch {
            return inherited;
        }

        if (config.extends !== undefined) {
            const bases = Array.isArray(config.extends) ? config.extends : [config.extends];

            for (const base of bases) {
                const target = extendsTarget(base, path.dirname(id));

                if (target) {
                    inherited = read(target, inherited);
                }
            }
        }

        return fold(config, inherited);
    }

    return read(tsconfigPath, undefined);
}

const readPlugins = (tsconfigPath: string): ReadonlyArray<unknown> | undefined =>
    walkExtends(tsconfigPath, (config, inherited) => {
        const compilerOptions = config['compilerOptions'];
        const plugins = isPlainObject(compilerOptions)
            ? compilerOptions['plugins']
            : undefined;
        return Array.isArray(plugins) ? plugins : inherited;
    });

// Resolve the analyze config from the top-level `tsc-guard` key, deep-merged down
// the `extends` chain (base first, each extending config overriding). Unlike the
// `plugins` array — which `extends` replaces wholesale — this lets a shared base
// carry the defaults and a package tweak a single channel key. Undefined when no
// config in the chain declares `tsc-guard` (analyze stays inert).
const readGuardConfig = (tsconfigPath: string): Record<string, unknown> | undefined =>
    walkExtends(tsconfigPath, (config, inherited) => {
        const own = config['tsc-guard'];
        if (!isPlainObject(own)) {
            return inherited;
        }
        return inherited === undefined
            ? own
            : deepMerge(inherited, own) as Record<string, unknown>;
    });

export { readPlugins, readGuardConfig };
