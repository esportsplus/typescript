import { describe, expect, it } from 'vitest';

import uid from '~/compiler/uid';


describe('uid', () => {
    it('generates unique ids', () => {
        let a = uid('test'),
            b = uid('test');

        expect(a).not.toBe(b);
    });

    it('prefixes with given name', () => {
        let result = uid('myPrefix');

        expect(result.startsWith('myPrefix_')).toBe(true);
    });

    it('contains only alphanumeric characters after prefix', () => {
        let result = uid('x'),
            suffix = result.slice(2); // after 'x_'

        expect(suffix).toMatch(/^[A-Za-z0-9]+$/);
    });

    // F-TEST-008: uid sequential guarantees

    it('sequential calls produce different suffixes (5 calls)', () => {
        let results = new Set<string>();

        for (let i = 0; i < 5; i++) {
            results.add(uid('x'));
        }

        expect(results.size).toBe(5);
    });

    it('different prefixes share same namespace', () => {
        let a1 = uid('a'),
            a2 = uid('a'),
            b1 = uid('b'),
            suffixA1 = a1.slice(2), // after 'a_'
            suffixA2 = a2.slice(2),
            suffixB1 = b1.slice(2); // after 'b_'

        // Find common prefix between two 'a' calls — that's the namespace
        let common = '';

        for (let i = 0, n = Math.min(suffixA1.length, suffixA2.length); i < n; i++) {
            if (suffixA1[i] !== suffixA2[i]) {
                break;
            }

            common += suffixA1[i];
        }

        expect(common.length).toBeGreaterThan(0);
        expect(suffixB1.startsWith(common)).toBe(true);
    });

    it('suffix contains valid base-36 characters', () => {
        let result = uid('z'),
            parts = result.slice(2), // after 'z_'
            base36Suffix = parts.match(/[0-9a-z]+$/);

        expect(base36Suffix).not.toBeNull();
        expect(base36Suffix![0]).toMatch(/^[0-9a-z]+$/);
    });
});

describe('uid.scope', () => {
    it('derives the same namespace for the same file and source', () => {
        uid.scope('/project', '/project/src/a.ts', 'let value = 1;');

        let first = uid('x');

        uid.scope('/project', '/project/src/a.ts', 'let value = 1;');

        expect(uid('x')).toBe(first);
    });

    it('derives the namespace from the project-relative path', () => {
        uid.scope('/one', '/one/src/a.ts', '');

        let first = uid('x');

        uid.scope('/two', '/two/src/a.ts', '');

        expect(uid('x')).toBe(first);
    });

    it('derives different namespaces for different files', () => {
        uid.scope('/project', '/project/src/a.ts', '');

        let first = uid('x');

        uid.scope('/project', '/project/src/b.ts', '');

        expect(uid('x')).not.toBe(first);
    });

    it('resets the counter on every scope', () => {
        uid.scope('/project', '/project/src/a.ts', '');
        uid('x');
        uid('x');
        uid.scope('/project', '/project/src/a.ts', '');

        expect(uid('x').endsWith('0')).toBe(true);
    });

    it('salts the namespace until it is absent from the source', () => {
        uid.scope('/project', '/project/src/a.ts', '');

        let natural = uid('x').slice(2, -1),
            code = `let ${natural} = 1;`;

        uid.scope('/project', '/project/src/a.ts', code);

        let generated = uid('x');

        expect(generated.slice(2, -1)).not.toBe(natural);
        expect(code.includes(generated)).toBe(false);
        expect(code.includes(uid('other'))).toBe(false);
    });
});
