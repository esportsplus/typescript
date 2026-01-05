import { uuid } from '@esportsplus/utilities';
import { BRACES_CONTENT_REGEX, REGEX_ESCAPE_PATTERN, UUID_DASH_REGEX } from './constants.js';
import type { QuickCheckPattern, Replacement } from './types.js';
import program from './program';


let i = 0,
    uidSuffix = uuid().replace(UUID_DASH_REGEX, '');


function buildImportRegex(escapedModule: string): RegExp {
    return new RegExp(`(import\\s*\\{[^}]*\\}\\s*from\\s*['"]${escapedModule}['"])`);
}

function mergeAndSort(a: string[], b: Set<string>): string {
    let combined = new Array<string>(a.length + b.size),
        idx = 0,
        n = a.length;

    for (let i = 0; i < n; i++) {
        if (a[i]) {
            combined[idx++] = a[i];
        }
    }

    for (let item of b) {
        if (item) {
            combined[idx++] = item;
        }
    }

    combined.length = idx;
    combined.sort();

    return combined.join(', ');
}

function parseSpecifiers(str: string): Set<string> {
    let parts = str.split(','),
        result = new Set<string>();

    for (let i = 0, n = parts.length; i < n; i++) {
        let trimmed = parts[i].trim();

        if (trimmed) {
            result.add(trimmed);
        }
    }

    return result;
}

function updateImportsWithRegex(code: string, specifiers: Set<string>, importRegex: RegExp): string {
    let match = code.match(importRegex);

    if (!match) {
        return code;
    }

    let bracesMatch = match[1].match(BRACES_CONTENT_REGEX),
        existing = bracesMatch?.[1] ? parseSpecifiers(bracesMatch[1]) : new Set<string>(),
        toAdd: string[] = [];

    for (let spec of specifiers) {
        if (!existing.has(spec)) {
            toAdd.push(spec);
        }
    }

    if (toAdd.length === 0) {
        return code;
    }

    return code.replace(
        match[1],
        match[1].replace(BRACES_CONTENT_REGEX, `{ ${mergeAndSort(toAdd, existing)} }`)
    );
}


const addImport = (code: string, module: string, specifiers: string[]): string => {
    if (specifiers.length === 0) {
        return code;
    }

    let regex = buildImportRegex( module.replace(REGEX_ESCAPE_PATTERN, '\\$&') );

    if (regex.test(code)) {
        return updateImportsWithRegex(code, new Set(specifiers), regex);
    }

    let adding = `import { ${specifiers.sort().join(', ')} } from '${module}';\n`,
        first = code.indexOf('import ');

    if (first === -1) {
        return adding + code;
    }

    return code.substring(0, first) + adding + code.substring(first);
};

const applyReplacements = (code: string, replacements: Replacement[]): string => {
    if (replacements.length === 0) {
        return code;
    }

    replacements.sort((a, b) => a.start - b.start);

    let parts: string[] = [],
        pos = 0;

    for (let i = 0, n = replacements.length; i < n; i++) {
        let r = replacements[i];

        if (r.start > pos) {
            parts.push(code.substring(pos, r.start));
        }

        parts.push(r.newText);
        pos = r.end;
    }

    if (pos < code.length) {
        parts.push(code.substring(pos));
    }

    return parts.join('');
};

const applyReplacementsReverse = (code: string, replacements: Replacement[]): string => {
    if (replacements.length === 0) {
        return code;
    }

    replacements.sort((a, b) => b.start - a.start);

    let result = code;

    for (let i = 0, n = replacements.length; i < n; i++) {
        let r = replacements[i];

        result = result.substring(0, r.start) + r.newText + result.substring(r.end);
    }

    return result;
};

const mightNeedTransform = (code: string, check: QuickCheckPattern): boolean => {
    if (check.regex) {
        return check.regex.test(code);
    }

    if (check.patterns) {
        for (let i = 0, n = check.patterns.length; i < n; i++) {
            if (code.indexOf(check.patterns[i]) !== -1) {
                return true;
            }
        }
    }

    return false;
};

const uid = (prefix: string, updateUUID = false): string => {
    return prefix + '_' + (updateUUID ? uuid().replace(UUID_DASH_REGEX, '') : uidSuffix) + '_' + (i++).toString(36);
};


export {
    addImport, applyReplacements, applyReplacementsReverse,
    mightNeedTransform,
    program,
    uid
};
export type * from './types';
export * from './constants';
