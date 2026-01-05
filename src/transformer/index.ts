import { uuid } from '@esportsplus/utilities';
import { UUID_DASH_REGEX } from './constants.js';
import type { QuickCheckPattern, Replacement } from './types.js';
import program from './program';


let i = 0,
    uidSuffix = uuid().replace(UUID_DASH_REGEX, '');


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
    return prefix + '_' + (updateUUID ? uuid().replace(UUID_DASH_REGEX, '') : uidSuffix) + (i++).toString(36);
};


export {
    applyReplacements, applyReplacementsReverse,
    mightNeedTransform,
    program,
    uid
};
export type * from './types';
export * from './constants';
