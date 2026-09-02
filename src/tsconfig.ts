import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { stripJsonc } from './jsonc';

let require = createRequire(import.meta.url);

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

function legacyStripJsonc(text: string): string {
    let escaped = false,
        inBlockComment = false,
        inLineComment = false,
        inString = false,
        stripped = '';

    for (let i = 0, n = text.length; i < n; i++) {
        let char = text[i],
            next = text[i + 1];

        if (inLineComment) {
            if (char === '\n') {
                inLineComment = false;
                stripped += char;
            }

            continue;
        }

        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }

            continue;
        }

        if (inString) {
            stripped += char;

            if (escaped) {
                escaped = false;
            }
            else if (char === '\\') {
                escaped = true;
            }
            else if (char === '"') {
                inString = false;
            }

            continue;
        }

        if (char === '"') {
            inString = true;
            stripped += char;

            continue;
        }

        if (char === '/' && next === '/') {
            inLineComment = true;
            i++;

            continue;
        }

        if (char === '/' && next === '*') {
            inBlockComment = true;
            i++;

            continue;
        }

        stripped += char;
    }

    escaped = false;
    inString = false;

    let result = '';

    for (let i = 0, n = stripped.length; i < n; i++) {
        let char = stripped[i];

        if (inString) {
            result += char;

            if (escaped) {
                escaped = false;
            }
            else if (char === '\\') {
                escaped = true;
            }
            else if (char === '"') {
                inString = false;
            }

            continue;
        }

        if (char === '"') {
            inString = true;
            result += char;

            continue;
        }

        if (char === ',') {
            let j = i + 1;

            while (j < n && /\s/.test(stripped[j]!)) {
                j++;
            }

            if (stripped[j] === ']' || stripped[j] === '}') {
                continue;
            }
        }

        result += char;
    }

    return result;
}

void legacyStripJsonc;

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

export { readPlugins };
