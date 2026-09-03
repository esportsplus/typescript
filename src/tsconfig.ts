import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { stripJsonc } from './jsonc';

let require = createRequire(import.meta.url);

// Recursive merge with child (override) winning per key. Plain objects merge
// deeply so a package can set `tsc-probe.channels.exceptions.report` without
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

const readPlugins = (tsconfigPath: string): ReadonlyArray<unknown> | undefined => {
    let seen = new Set<string>();

    function read(configPath: string): ReadonlyArray<unknown> | undefined {
        let id = path.resolve(configPath);

        if (seen.has(id)) {
            return undefined;
        }

        seen.add(id);

        let config: { compilerOptions?: { plugins?: unknown[] }; extends?: unknown };

        try {
            config = JSON.parse(stripJsonc(fs.readFileSync(id, 'utf8')));
        }
        catch {
            return undefined;
        }

        let plugins: ReadonlyArray<unknown> | undefined;

        if (config.extends !== undefined) {
            let bases = Array.isArray(config.extends) ? config.extends : [config.extends];

            for (let base of bases) {
                let target = extendsTarget(base, path.dirname(id));

                if (target) {
                    let inherited = read(target);

                    if (inherited !== undefined) {
                        plugins = inherited;
                    }
                }
            }
        }

        return Array.isArray(config.compilerOptions?.plugins) ? config.compilerOptions.plugins : plugins;
    }

    return read(tsconfigPath);
};

// Resolve the analyze config from the top-level `tsc-probe` key, deep-merged down
// the `extends` chain (base first, each extending config overriding). Unlike the
// `plugins` array — which `extends` replaces wholesale — this lets a shared base
// carry the defaults and a package tweak a single channel key. Undefined when no
// config in the chain declares `tsc-probe` (analyze stays inert).
const readProbeConfig = (tsconfigPath: string): Record<string, unknown> | undefined => {
    let seen = new Set<string>();

    function read(configPath: string): Record<string, unknown> | undefined {
        let id = path.resolve(configPath);

        if (seen.has(id)) {
            return undefined;
        }

        seen.add(id);

        let config: { extends?: unknown; 'tsc-probe'?: unknown };

        try {
            config = JSON.parse(stripJsonc(fs.readFileSync(id, 'utf8')));
        }
        catch {
            return undefined;
        }

        let merged: Record<string, unknown> | undefined;

        if (config.extends !== undefined) {
            let bases = Array.isArray(config.extends) ? config.extends : [config.extends];

            for (let base of bases) {
                let target = extendsTarget(base, path.dirname(id));

                if (!target) {
                    continue;
                }

                let inherited = read(target);

                if (inherited !== undefined) {
                    merged = merged === undefined ? inherited : deepMerge(merged, inherited) as Record<string, unknown>;
                }
            }
        }

        let own = config['tsc-probe'];

        if (isPlainObject(own)) {
            merged = merged === undefined ? own : deepMerge(merged, own) as Record<string, unknown>;
        }

        return merged;
    }

    return read(tsconfigPath);
};

export { readPlugins, readProbeConfig };
