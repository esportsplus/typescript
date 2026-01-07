const SINGLE_QUOTE_REGEX = /'/g;


const code = (literals: TemplateStringsArray, ...values: unknown[]): string => {
    let buffer = '';

    for (let i = 0, n = literals.length; i < n; i++) {
        buffer += literals[i];

        if (values[i] !== undefined) {
            buffer += values[i];
        }
    }

    return buffer;
};

code.escape = (str: string): string => {
    return str.replace(SINGLE_QUOTE_REGEX, "\\'");
};


export default code;