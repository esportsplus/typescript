import type { QuickCheckPattern, Replacement } from './types.js';


const contains = (code: string, { regex, patterns }: QuickCheckPattern): boolean => {
    if (regex) {
        return regex.test(code);
    }

    if (patterns) {
        for (let i = 0, n = patterns.length; i < n; i++) {
            if (code.indexOf(patterns[i]) !== -1) {
                return true;
            }
        }
    }

    return false;
};

const replace = (code: string, replacements: Replacement[]): string => {
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

const replaceReverse =(code: string, replacements: Replacement[]): string => {
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


export default { contains, replace, replaceReverse };