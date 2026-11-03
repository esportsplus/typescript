import type { Checker, Program } from 'typescript/unstable/sync';


type Query = (...args: unknown[]) => unknown;


// Queries whose array form answers each element as the single form would, in order
const BATCHED = new Set<PropertyKey>([
    'getSymbolAtLocation',
    'getTypeAtLocation'
]);

// Pure queries: answers are fixed for the program snapshot a transform runs against
const CACHED = new Set<PropertyKey>([
    'getDeclaredTypeOfSymbol',
    'getReturnTypeOfSignature',
    'getShorthandAssignmentValueSymbol',
    'getSignaturesOfType',
    'getSymbolAtLocation',
    'getTypeArguments',
    'getTypeAtLocation',
    'isTypeAssignableTo',
    'resolveName'
]);


// The cached checker of each program, dropped with the program
let programs = new WeakMap<Program, { checker: Checker; proxy: Checker }>();


// Keyed on (first argument, second argument); a call passing more arguments (e.g. resolveName's
// optional location) is answered by the checker directly rather than risk a wrong cache hit. A
// batched query's array form shares the single form's entries and sends only the misses.
function memoize(query: Query, batched: boolean): Query {
    let results = new Map<unknown, Map<unknown, unknown>>();

    let bucket = (key: unknown): Map<unknown, unknown> => {
        let found = results.get(key);

        if (!found) {
            found = new Map();
            results.set(key, found);
        }

        return found;
    };

    return (...args) => {
        if (args.length > 2) {
            return query(...args);
        }

        let entries = bucket(args[1]);

        if (batched && Array.isArray(args[0])) {
            let items = args[0] as unknown[],
                misses: unknown[] = [];

            for (let i = 0, n = items.length; i < n; i++) {
                if (!entries.has(items[i])) {
                    misses.push(items[i]);
                }
            }

            if (misses.length > 0) {
                let answers = query(...(args.length > 1 ? [misses, args[1]] : [misses])) as unknown[];

                for (let i = 0, n = misses.length; i < n; i++) {
                    entries.set(misses[i], answers[i]);
                }
            }

            let result: unknown[] = [];

            for (let i = 0, n = items.length; i < n; i++) {
                result.push(entries.get(items[i]));
            }

            return result;
        }

        if (entries.has(args[0])) {
            return entries.get(args[0]);
        }

        let result = query(...args);

        entries.set(args[0], result);

        return result;
    };
}

function proxy(checker: Checker): Checker {
    let methods = new Map<PropertyKey, Query>();

    return new Proxy(checker, {
        get(target, key) {
            let value = Reflect.get(target, key);

            if (typeof value !== 'function') {
                return value;
            }

            let method = methods.get(key);

            if (!method) {
                method = value.bind(target) as Query;

                if (CACHED.has(key)) {
                    method = memoize(method, BATCHED.has(key));
                }

                methods.set(key, method);
            }

            return method;
        }
    });
}


// Every checker query is a synchronous IPC round-trip to tsgo, and plugins ask the same question
// about the same node repeatedly (and of each other's nodes). One cache serves every transform of a
// program, since its answers are fixed for that snapshot; a new program, or a new checker for it,
// starts a new cache. Wrapping an already cached checker returns it unchanged.
const cached = (checker: Checker, program?: Program): Checker => {
    if (program === undefined) {
        return proxy(checker);
    }

    let entry = programs.get(program);

    if (entry !== undefined && (entry.checker === checker || entry.proxy === checker)) {
        return entry.proxy;
    }

    entry = { checker, proxy: proxy(checker) };
    programs.set(program, entry);

    return entry.proxy;
};


export default { cached };
