import { describe, expect, it } from 'vitest';

import * as root from '~/index';


describe('root export surface', () => {
    it('exposes zero exported keys', () => {
        expect(Object.keys(root)).toEqual([]);
    });

    it('has no `ts` binding', () => {
        expect('ts' in root).toBe(false);
    });
});
