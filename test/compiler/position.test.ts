import { expect, it } from 'vitest';
import { lineOfPosition } from '../../src/compiler/position';

it('uses the preceding line at boundaries and outside the source', () => {
    expect([-1, 0, 3, 4, 8, 9, 100].map((offset) => lineOfPosition([0, 4, 9], offset)))
        .toEqual([0, 0, 0, 1, 1, 2, 2]);
    expect(lineOfPosition([], 0)).toBe(0);
});
