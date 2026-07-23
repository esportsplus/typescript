import { describe, expect, it } from 'vitest';

import * as root from '~/index';


describe('index', () => {
    it('exposes no exported keys', () => {
        expect(Object.keys(root)).toEqual([]);
    });

    it('does not export ts', () => {
        expect('ts' in root).toBe(false);
    });
});
