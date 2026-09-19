import { expect, it } from 'vitest';
import { stripJsonc } from '../src/jsonc';

it.each([
    ['{"a": [1, /* comment */ ],}', { a: [1] }],
    ['{"a": 1, // comment\r\n}', { a: 1 }],
    ['{"a": ",} // /*", "b": "escaped\\\"quote",}', { a: ',} // /*', b: 'escaped"quote' }],
    ['[1, /* comment */ 2,\n]', [1, 2]],
    ['{"nested": {"a": [],}, "b": true}', { nested: { a: [] }, b: true }],
])('parses comments and trailing commas: %s', (input, expected) => {
    expect(JSON.parse(stripJsonc(input as string))).toEqual(expected);
});

it.each(['[1,,]', '{"a":', '"unterminated', '{bad}', '[1 2]'])('preserves invalid JSON errors: %s', (input) => {
    expect(() => JSON.parse(stripJsonc(input))).toThrow();
});
