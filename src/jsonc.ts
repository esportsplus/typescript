const stripJsonc = (text: string): string => {
    let escaped = false,
        inBlockComment = false,
        inLineComment = false,
        inString = false,
        stripped = '',
        commas: number[] = [];

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

        if (char === ',') {
            commas.push(stripped.length);
        }
        stripped += char;
    }

    let result = '', start = 0;
    for (const comma of commas) {
        let next = comma + 1;
        while (next < stripped.length && /\s/.test(stripped[next]!)) {
            next++;
        }
        if (stripped[next] === ']' || stripped[next] === '}') {
            result += stripped.slice(start, comma);
            start = comma + 1;
        }
    }
    return result + stripped.slice(start);
};

export { stripJsonc };
