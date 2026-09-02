const stripJsonc = (text: string): string => {
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
};

export { stripJsonc };
