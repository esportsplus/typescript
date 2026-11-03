import { afterAll, describe, expect, it } from 'vitest';
import { isIdentifier } from 'typescript/unstable/ast/is';
import type { Node } from 'typescript/unstable/ast';
import type { Checker, Program, Type } from 'typescript/unstable/sync';

import checker from '~/compiler/checker';
import fs from 'fs';
import languageService from '~/compiler/language-service';
import path from 'path';


// Test doubles stand in for a checker, so the wrapper is seen through their own loose type
type Fake = Record<string, (...args: unknown[]) => unknown>;


// A stand-in checker: every method returns a fresh object and counts its calls; the batch forms
// record what each call was sent
function fake() {
    let batches: unknown[][] = [],
        calls: Record<string, number> = {},
        method = (name: string) => (...args: unknown[]) => {
            calls[name] = (calls[name] ?? 0) + 1;

            if (Array.isArray(args[0])) {
                batches.push(args[0]);

                return args[0].map(node => ({ args: [node], name }));
            }

            return { args, name };
        };

    let double = {
            getAliasedSymbol: method('getAliasedSymbol'),
            getApparentType: method('getApparentType'),
            getBaseConstraintOfType: method('getBaseConstraintOfType'),
            getDeclaredTypeOfSymbol: method('getDeclaredTypeOfSymbol'),
            getImmediateAliasedSymbol: method('getImmediateAliasedSymbol'),
            getNonNullableType: method('getNonNullableType'),
            getPropertiesOfType: method('getPropertiesOfType'),
            getPropertyOfType: method('getPropertyOfType'),
            getReturnTypeOfSignature: method('getReturnTypeOfSignature'),
            getShorthandAssignmentValueSymbol: method('getShorthandAssignmentValueSymbol'),
            getSignaturesOfType: method('getSignaturesOfType'),
            getSymbolAtLocation: method('getSymbolAtLocation'),
            getTypeArguments: method('getTypeArguments'),
            getTypeAtLocation: method('getTypeAtLocation'),
            isArrayType: method('isArrayType'),
            isTupleType: method('isTupleType'),
            isTypeAssignableTo: method('isTypeAssignableTo'),
            resolveName: method('resolveName')
        };

    return { batches, calls, checker: double as Fake };
}

function wrap(double: Fake, program?: Program): Fake {
    return checker.cached(double as unknown as Checker, program) as unknown as Fake;
}


describe('compiler/checker', () => {
    it.each([
        'getAliasedSymbol',
        'getApparentType',
        'getDeclaredTypeOfSymbol',
        'getPropertiesOfType',
        'getReturnTypeOfSignature',
        'getShorthandAssignmentValueSymbol',
        'getSignaturesOfType',
        'getSymbolAtLocation',
        'getTypeArguments',
        'getTypeAtLocation',
        'resolveName'
    ])('answers a repeated %s from its cache', (name) => {
        let { calls, checker: double } = fake(),
            memo = wrap(double),
            node = {};

        let first = memo[name](node);

        expect(memo[name](node)).toBe(first);
        expect(calls[name]).toBe(1);
        expect(memo[name]({})).not.toBe(first);
        expect(calls[name]).toBe(2);
    });

    it('keys on both arguments', () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double),
            a = {},
            b = {},
            c = {};

        let ab = memo.isTypeAssignableTo(a, b);

        expect(memo.isTypeAssignableTo(a, b)).toBe(ab);
        expect(memo.isTypeAssignableTo(a, c)).not.toBe(ab);
        expect(memo.isTypeAssignableTo(b, a)).not.toBe(ab);
        expect(calls.isTypeAssignableTo).toBe(3);
    });

    it('caches a call with one argument apart from the same first argument with a second', () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double),
            node = {},
            kind = 1;

        let one = memo.getSignaturesOfType(node),
            two = memo.getSignaturesOfType(node, kind);

        expect(two).not.toBe(one);
        expect(memo.getSignaturesOfType(node, kind)).toBe(two);
        expect(memo.getSignaturesOfType(node)).toBe(one);
        expect(calls.getSignaturesOfType).toBe(2);
    });

    it('answers a call with more than two arguments from the checker every time', () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double),
            location = {};

        let first = memo.resolveName('Node', 1, location),
            second = memo.resolveName('Node', 1, location);

        expect(second).not.toBe(first);
        expect(calls.resolveName).toBe(2);

        let cachedCall = memo.resolveName('Node', 1);

        expect(memo.resolveName('Node', 1)).toBe(cachedCall);
        expect(calls.resolveName).toBe(3);
    });

    it('passes other methods and properties through uncached', () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double),
            symbol = {};

        memo.getImmediateAliasedSymbol(symbol);
        memo.getImmediateAliasedSymbol(symbol);

        expect(calls.getImmediateAliasedSymbol).toBe(2);
        expect((checker.cached({ label: 'fake' } as unknown as Checker) as unknown as { label: string }).label).toBe('fake');
    });

    it('caches undefined answers', () => {
        let count = 0,
            memo = wrap({ getTypeAtLocation: () => { count++; return undefined; } }),
            node = {};

        expect(memo.getTypeAtLocation(node)).toBeUndefined();
        expect(memo.getTypeAtLocation(node)).toBeUndefined();
        expect(count).toBe(1);
    });

    it('scopes each cache to its own wrapper without a program', () => {
        let { calls, checker: double } = fake(),
            node = {};

        wrap(double).getTypeAtLocation(node);
        wrap(double).getTypeAtLocation(node);

        expect(calls.getTypeAtLocation).toBe(2);
    });

    it('shares one cache per program, and wrapping that cache returns it', () => {
        let { calls, checker: double } = fake(),
            program = {} as Program,
            memo = wrap(double, program),
            node = {};

        memo.getTypeAtLocation(node);
        wrap(double, program).getTypeAtLocation(node);

        expect(wrap(double, program)).toBe(memo);
        expect(wrap(memo, program)).toBe(memo);
        expect(calls.getTypeAtLocation).toBe(1);
        expect(wrap(fake().checker, program)).not.toBe(memo);
    });

    it('binds methods to the underlying checker', () => {
        let double = {
                getTypeAtLocation(this: { self: unknown }) {
                    this.self = this;

                    return 1;
                },
                self: null as unknown
            },
            memo = wrap(double as unknown as Fake);

        memo.getTypeAtLocation({});

        expect(double.self).toBe(double);
    });

    describe.each(['getSymbolAtLocation', 'getTypeAtLocation'])('%s batch form', (name) => {
        it('sends only the misses and answers in order', () => {
            let { batches, calls, checker: double } = fake(),
                memo = wrap(double),
                a = {},
                b = {},
                c = {};

            let single = memo[name](b),
                batch = memo[name]([a, b, c]) as unknown[];

            expect(batches).toEqual([[a, c]]);
            expect(batch).toHaveLength(3);
            expect(batch[1]).toBe(single);
            expect(memo[name](a)).toBe(batch[0]);
            expect(memo[name](c)).toBe(batch[2]);
            expect(calls[name]).toBe(2);
        });

        it('sends nothing when every node is cached', () => {
            let { batches, checker: double } = fake(),
                memo = wrap(double),
                a = {},
                b = {};

            let first = memo[name]([a, b]) as unknown[];

            expect(memo[name]([b, a])).toEqual([first[1], first[0]]);
            expect(batches).toHaveLength(1);
        });
    });

    it('counts the calls it passes on to the checker', () => {
        let { checker: double } = fake(),
            memo = wrap(double),
            node = {};

        memo.getSymbolAtLocation(node);
        memo.getSymbolAtLocation(node);
        memo.getSymbolAtLocation([node, {}, {}]);
        memo.getImmediateAliasedSymbol(node);
        memo.getImmediateAliasedSymbol(node);

        expect(checker.sent(memo as unknown as Checker)).toBe(4);
        expect(checker.sent(double as unknown as Checker)).toBe(0);
    });
});

describe('compiler/checker type-keyed queries', () => {
    it.each([
        'getAliasedSymbol',
        'getApparentType',
        'getBaseConstraintOfType',
        'getNonNullableType',
        'getPropertiesOfType',
        'getReturnTypeOfSignature',
        'getTypeArguments',
        'isArrayType',
        'isTupleType'
    ])('answers %s for any object carrying the same id from one round-trip', (name) => {
        let { calls, checker: double } = fake(),
            memo = wrap(double);

        let first = memo[name]({ id: 7 });

        expect(memo[name]({ id: 7 })).toBe(first);
        expect(memo[name]({ id: 8 })).not.toBe(first);
        expect(calls[name]).toBe(2);
    });

    it('keys getPropertyOfType and getSignaturesOfType on the type id and the second argument', () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double);

        let length = memo.getPropertyOfType({ id: 1 }, 'length');

        expect(memo.getPropertyOfType({ id: 1 }, 'length')).toBe(length);
        expect(memo.getPropertyOfType({ id: 1 }, 'push')).not.toBe(length);
        expect(memo.getSignaturesOfType({ id: 1 }, 0)).toBe(memo.getSignaturesOfType({ id: 1 }, 0));
        expect(memo.getSignaturesOfType({ id: 1 }, 1)).not.toBe(memo.getSignaturesOfType({ id: 1 }, 0));
        expect(calls.getPropertyOfType).toBe(2);
        expect(calls.getSignaturesOfType).toBe(2);
    });

    it('keys isTypeAssignableTo on both type ids', () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double);

        memo.isTypeAssignableTo({ id: 1 }, { id: 2 });
        memo.isTypeAssignableTo({ id: 1 }, { id: 2 });
        memo.isTypeAssignableTo({ id: 2 }, { id: 1 });

        expect(calls.isTypeAssignableTo).toBe(2);
    });
});

// Round-trips counted against a real tsgo program: every call reaching the checker under the cache
describe('compiler/checker round-trips', () => {
    let fixture = fs.mkdtempSync(path.join(process.cwd(), 'test/.checker-')).replace(/\\/g, '/');

    afterAll(() => {
        languageService.dispose();
        fs.rmSync(fixture, { force: true, recursive: true });
    });

    it('sends each distinct type-keyed question once per program', () => {
        let source = [
                'export let a: number[] = [];',
                'export let b: number[] = [];',
                'export let c = a;',
                'export let o: { x: number } | null = null;',
                'export let p = o;',
                'export function f<K extends string>(k: K) { return k; }'
            ].join('\n'),
            calls = 0;

        fs.mkdirSync(fixture + '/src', { recursive: true });
        fs.writeFileSync(fixture + '/src/a.ts', source);
        fs.writeFileSync(fixture + '/tsconfig.json', JSON.stringify({ compilerOptions: { lib: ['es2024'], strict: true, types: [] }, include: ['src'] }));

        let { checker: raw, program } = languageService.update(fixture + '/tsconfig.json', fixture + '/src/a.ts', source),
            counting = new Proxy(raw, {
                get(target, key) {
                    let value = Reflect.get(target, key);

                    return typeof value === 'function'
                        ? (...args: unknown[]) => {
                            calls++;

                            return (value as (...args: unknown[]) => unknown).apply(target, args);
                        }
                        : value;
                }
            }),
            memo = checker.cached(counting, program),
            reads: Node[] = [];

        program.getSourceFile(fixture + '/src/a.ts')!.forEachChild(function visit(node) {
            if (isIdentifier(node)) {
                reads.push(node);
            }

            node.forEachChild(visit);
        });

        let ask = (): void => {
            let types = memo.getTypeAtLocation(reads) as (Type | undefined)[];

            for (let i = 0, n = types.length; i < n; i++) {
                let type = types[i];

                if (!type) {
                    continue;
                }

                memo.isArrayType(type);
                memo.isTupleType(type);
                memo.getPropertyOfType(type, 'length');
                memo.getNonNullableType(type);
                memo.getBaseConstraintOfType(type);
                memo.getSignaturesOfType(type, 0);
            }
        };

        ask();

        let first = calls,
            distinct = new Set((memo.getTypeAtLocation(reads) as (Type | undefined)[]).filter(Boolean).map(type => type!.id)).size;

        ask();

        // One batched getTypeAtLocation, then six questions per distinct type
        expect(first).toBe(1 + 6 * distinct);
        expect(calls).toBe(first);
        expect(distinct).toBeLessThan(reads.length);
    });
});
