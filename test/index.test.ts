import { describe, expect, it } from 'vitest';

import * as root from '~/index';
import * as ts from '~/ts';


describe('index', () => {
    it('exposes ts and nothing else', () => {
        expect(Object.keys(root)).toEqual(['ts']);
    });

    it('vends the same surface as the ts module', () => {
        expect(Object.keys(root.ts).sort()).toEqual(Object.keys(ts).sort());
    });
});
