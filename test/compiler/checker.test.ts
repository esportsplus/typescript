import { afterAll, describe, expect, it } from 'vitest';
import { isIdentifier } from 'typescript/ast/is';
import type { Node } from 'typescript/ast';
import type { API, Checker, Program, Project, Type } from 'typescript/async';

import checker from '~/compiler/checker';
import fs from 'fs';
import languageService from '~/compiler/language-service';
import path from 'path';


// Test doubles stand in for a checker, so the wrapper is seen through their own loose type
type Fake = Record<string, (...args: unknown[]) => Promise<unknown>>;


// A stand-in checker: every method answers a fresh object and counts its calls; the batch forms
// record what each call was sent
function fake() {
    let batches: unknown[][] = [],
        calls: Record<string, number> = {},
        method = (name: string) => async (...args: unknown[]) => {
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
            getTypeOfSymbol: method('getTypeOfSymbol'),
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
    ])('answers a repeated %s from its cache', async (name) => {
        let { calls, checker: double } = fake(),
            memo = wrap(double),
            node = {};

        let first = await memo[name](node);

        expect(await memo[name](node)).toBe(first);
        expect(calls[name]).toBe(1);
        expect(await memo[name]({})).not.toBe(first);
        expect(calls[name]).toBe(2);
    });

    it('sends a question asked again while in flight once', async () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double),
            node = {};

        let [a, b] = await Promise.all([memo.getTypeAtLocation(node), memo.getTypeAtLocation(node)]);

        expect(a).toBe(b);
        expect(calls.getTypeAtLocation).toBe(1);
    });

    it('keys on both arguments', async () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double),
            a = {},
            b = {},
            c = {};

        let ab = await memo.isTypeAssignableTo(a, b);

        expect(await memo.isTypeAssignableTo(a, b)).toBe(ab);
        expect(await memo.isTypeAssignableTo(a, c)).not.toBe(ab);
        expect(await memo.isTypeAssignableTo(b, a)).not.toBe(ab);
        expect(calls.isTypeAssignableTo).toBe(3);
    });

    it('caches a call with one argument apart from the same first argument with a second', async () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double),
            node = {},
            kind = 1;

        let one = await memo.getSignaturesOfType(node),
            two = await memo.getSignaturesOfType(node, kind);

        expect(two).not.toBe(one);
        expect(await memo.getSignaturesOfType(node, kind)).toBe(two);
        expect(await memo.getSignaturesOfType(node)).toBe(one);
        expect(calls.getSignaturesOfType).toBe(2);
    });

    it('answers a call with more than two arguments from the checker every time', async () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double),
            location = {};

        let first = await memo.resolveName('Node', 1, location),
            second = await memo.resolveName('Node', 1, location);

        expect(second).not.toBe(first);
        expect(calls.resolveName).toBe(2);

        let cachedCall = await memo.resolveName('Node', 1);

        expect(await memo.resolveName('Node', 1)).toBe(cachedCall);
        expect(calls.resolveName).toBe(3);
    });

    it('passes other methods and properties through uncached', async () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double),
            symbol = {};

        await memo.getTypeOfSymbol(symbol);
        await memo.getTypeOfSymbol(symbol);

        expect(calls.getTypeOfSymbol).toBe(2);
        expect((checker.cached({ label: 'fake' } as unknown as Checker) as unknown as { label: string }).label).toBe('fake');
    });

    it('caches undefined answers', async () => {
        let count = 0,
            memo = wrap({ getTypeAtLocation: async () => { count++; return undefined; } }),
            node = {};

        expect(await memo.getTypeAtLocation(node)).toBeUndefined();
        expect(await memo.getTypeAtLocation(node)).toBeUndefined();
        expect(count).toBe(1);
    });

    it('asks a failed question again', async () => {
        let count = 0,
            memo = wrap({
                getTypeAtLocation: async () => {
                    if (++count === 1) {
                        throw new Error('snapshot disposed');
                    }

                    return 'type';
                }
            }),
            node = {};

        await expect(memo.getTypeAtLocation(node)).rejects.toThrow('snapshot disposed');
        expect(await memo.getTypeAtLocation(node)).toBe('type');
        expect(count).toBe(2);
    });

    it('scopes each cache to its own wrapper without a program', async () => {
        let { calls, checker: double } = fake(),
            node = {};

        await wrap(double).getTypeAtLocation(node);
        await wrap(double).getTypeAtLocation(node);

        expect(calls.getTypeAtLocation).toBe(2);
    });

    it('shares one cache between the views of a program, and wrapping a view returns it', async () => {
        let { calls, checker: double } = fake(),
            program = {} as Program,
            memo = wrap(double, program),
            node = {};

        await memo.getTypeAtLocation(node);
        await wrap(double, program).getTypeAtLocation(node);

        expect(wrap(memo, program)).toBe(memo);
        expect(calls.getTypeAtLocation).toBe(1);

        await wrap(fake().checker, program).getTypeAtLocation(node);

        expect(calls.getTypeAtLocation).toBe(1);
    });

    it('binds methods to the underlying checker', async () => {
        let double = {
                async getTypeAtLocation(this: { self: unknown }) {
                    this.self = this;

                    return 1;
                },
                self: null as unknown
            },
            memo = wrap(double as unknown as Fake);

        await memo.getTypeAtLocation({});

        expect(double.self).toBe(double);
    });

    describe.each(['getSymbolAtLocation', 'getTypeAtLocation'])('%s batch form', (name) => {
        it('sends only the misses and answers in order', async () => {
            let { batches, calls, checker: double } = fake(),
                memo = wrap(double),
                a = {},
                b = {},
                c = {};

            let single = await memo[name](b),
                batch = await memo[name]([a, b, c, a]) as unknown[];

            expect(batches).toEqual([[a, c]]);
            expect(batch).toHaveLength(4);
            expect(batch[1]).toBe(single);
            expect(batch[3]).toBe(batch[0]);
            expect(await memo[name](a)).toBe(batch[0]);
            expect(await memo[name](c)).toBe(batch[2]);
            expect(calls[name]).toBe(2);
        });

        it('sends nothing when every node is cached', async () => {
            let { batches, checker: double } = fake(),
                memo = wrap(double),
                a = {},
                b = {};

            let first = await memo[name]([a, b]) as unknown[];

            expect(await memo[name]([b, a])).toEqual([first[1], first[0]]);
            expect(batches).toHaveLength(1);
        });
    });

    it('counts the requests it sends: what one view misses in one turn is one request', async () => {
        let { checker: double } = fake(),
            memo = wrap(double),
            node = {};

        await Promise.all([memo.getSymbolAtLocation(node), memo.getTypeOfSymbol(node), memo.getTypeOfSymbol(node)]);
        await memo.getSymbolAtLocation(node);
        await memo.getSymbolAtLocation([node, {}, {}]);

        expect(checker.sent(memo as unknown as Checker)).toBe(2);
        expect(checker.sent(double as unknown as Checker)).toBe(0);
    });
});

describe('compiler/checker lanes', () => {
    // A stand-in API recording the batch contexts the views open and the calls made in each
    function attached(double: Fake) {
        let contexts: string[][] = [],
            open: string[] | null = null,
            program = {} as Program,
            api = {
                batchContext: () => {
                    open = [];
                    contexts.push(open);

                    return { [Symbol.dispose]: () => { open = null; } };
                }
            } as unknown as API;

        for (let name of Object.keys(double)) {
            let method = double[name];

            double[name] = (...args) => {
                open?.push(name);

                return method(...args);
            };
        }

        checker.attach(api, { checker: double, program } as unknown as Project);

        return { contexts, program };
    }

    it('sends what one view asks in one turn in one batch, and each view in its own', async () => {
        let { checker: double } = fake(),
            { contexts, program } = attached(double),
            first = wrap(double, program),
            second = wrap(double, program);

        await Promise.all([
            first.getTypeAtLocation({}),
            first.getPropertyOfType({ id: 1 }, 'then'),
            second.getTypeAtLocation({}),
            second.getApparentType({ id: 2 })
        ]);

        expect(contexts).toEqual([['getTypeAtLocation', 'getPropertyOfType'], ['getTypeAtLocation', 'getApparentType']]);
    });

    it('lets a view await a question another view has in flight', async () => {
        let { calls, checker: double } = fake(),
            { contexts, program } = attached(double),
            node = {},
            [a, b] = await Promise.all([wrap(double, program).getTypeAtLocation(node), wrap(double, program).getTypeAtLocation(node)]);

        expect(a).toBe(b);
        expect(calls.getTypeAtLocation).toBe(1);
        expect(contexts).toEqual([['getTypeAtLocation']]);
    });
});

describe('compiler/checker type-keyed queries', () => {
    it.each([
        'getAliasedSymbol',
        'getApparentType',
        'getBaseConstraintOfType',
        'getImmediateAliasedSymbol',
        'getNonNullableType',
        'getPropertiesOfType',
        'getReturnTypeOfSignature',
        'getTypeArguments',
        'isArrayType',
        'isTupleType'
    ])('answers %s for any object carrying the same id from one round-trip', async (name) => {
        let { calls, checker: double } = fake(),
            memo = wrap(double);

        let first = await memo[name]({ id: 7 });

        expect(await memo[name]({ id: 7 })).toBe(first);
        expect(await memo[name]({ id: 8 })).not.toBe(first);
        expect(calls[name]).toBe(2);
    });

    it('keys getPropertyOfType and getSignaturesOfType on the type id and the second argument', async () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double);

        let length = await memo.getPropertyOfType({ id: 1 }, 'length');

        expect(await memo.getPropertyOfType({ id: 1 }, 'length')).toBe(length);
        expect(await memo.getPropertyOfType({ id: 1 }, 'push')).not.toBe(length);
        expect(await memo.getSignaturesOfType({ id: 1 }, 0)).toBe(await memo.getSignaturesOfType({ id: 1 }, 0));
        expect(await memo.getSignaturesOfType({ id: 1 }, 1)).not.toBe(await memo.getSignaturesOfType({ id: 1 }, 0));
        expect(calls.getPropertyOfType).toBe(2);
        expect(calls.getSignaturesOfType).toBe(2);
    });

    it('keys isTypeAssignableTo on both type ids', async () => {
        let { calls, checker: double } = fake(),
            memo = wrap(double);

        await memo.isTypeAssignableTo({ id: 1 }, { id: 2 });
        await memo.isTypeAssignableTo({ id: 1 }, { id: 2 });
        await memo.isTypeAssignableTo({ id: 2 }, { id: 1 });

        expect(calls.isTypeAssignableTo).toBe(2);
    });
});

// Round-trips counted against a real tsgo program: every call reaching the checker under the cache
describe('compiler/checker round-trips', () => {
    let fixture = fs.mkdtempSync(path.join(process.cwd(), 'test/.checker-')).replace(/\\/g, '/');

    afterAll(async () => {
        await languageService.dispose();
        fs.rmSync(fixture, { force: true, recursive: true });
    });

    it('sends each distinct type-keyed question once per program', async () => {
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

        let { checker: raw, program, release } = await languageService.update(fixture + '/tsconfig.json', fixture + '/src/a.ts', source),
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
            reads: Node[] = [];

        (await program.getSourceFile(fixture + '/src/a.ts'))!.forEachChild(function visit(node) {
            if (isIdentifier(node)) {
                reads.push(node);
            }

            node.forEachChild(visit);
        });

        let ask = async (): Promise<Set<number>> => {
            let memo = checker.cached(counting, program),
                types = await memo.getTypeAtLocation(reads),
                ids = new Set<number>();

            await Promise.all(types.map(async (type: Type | undefined) => {
                if (!type) {
                    return [];
                }

                ids.add(type.id);

                return Promise.all([
                    memo.isArrayType(type),
                    memo.isTupleType(type),
                    memo.getPropertyOfType(type, 'length'),
                    memo.getNonNullableType(type),
                    memo.getBaseConstraintOfType(type),
                    memo.getSignaturesOfType(type, 0)
                ]);
            }));

            return ids;
        };

        let distinct = (await ask()).size,
            first = calls;

        await ask();
        release();

        // One batched getTypeAtLocation, then six questions per distinct type, whichever view asks
        expect(first).toBe(1 + 6 * distinct);
        expect(calls).toBe(first);
        expect(distinct).toBeLessThan(reads.length);
    });
});
