const BACKSLASH_REGEX = /\\/g;
const CR_REGEX = /\r/g;
const LINE_SEPARATOR_REGEX = /\u2028/g;
const NEWLINE_REGEX = /\n/g;
const PARAGRAPH_SEPARATOR_REGEX = /\u2029/g;
const SINGLE_QUOTE_REGEX = /'/g;


const code = (literals: TemplateStringsArray, ...values: unknown[]): string => {
    let buffer = '';

    for (let i = 0, n = literals.length; i < n; i++) {
        buffer += literals[i];

        let value = values[i];

        if (value == null || value === false) {
            value = '';
        }

        buffer += value;
    }

    return buffer;
};

code.escape = (str: string): string => {
    return str
        .replace(BACKSLASH_REGEX, '\\\\')
        .replace(SINGLE_QUOTE_REGEX, "\\'")
        .replace(NEWLINE_REGEX, '\\n')
        .replace(CR_REGEX, '\\r')
        .replace(LINE_SEPARATOR_REGEX, '\\u2028')
        .replace(PARAGRAPH_SEPARATOR_REGEX, '\\u2029');
};


export default code;
