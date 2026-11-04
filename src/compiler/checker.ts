import type { AnyAPIRequestGenerator, API, Checker, Program, Project } from 'typescript/sync';


type Call<O, K extends keyof O> = O[K] extends (...args: infer A) => unknown ? A : never;

type Memo = {
    get(args: unknown[]): unknown;
    has(args: unknown[]): boolean;
    set(args: unknown[], value: unknown): void;
};

type Method<O> = { [K in keyof O]: O[K] extends (...args: never[]) => unknown ? K : never }[keyof O];

type Proxied = {
    memo: (key: PropertyKey) => Memo | undefined;
    sent: { count: number };
    target: Checker;
};

type Query = (...args: unknown[]) => unknown;

type Result<O, K extends keyof O> = O[K] extends (...args: never[]) => infer R ? R : never;


// Queries whose array form answers each element as the single form would, in order
const BATCHED = new Set<PropertyKey>([
    'getSymbolAtLocation',
    'getTypeAtLocation'
]);

// Pure queries: answers are fixed for the program snapshot a transform runs against
const CACHED = new Set<PropertyKey>([
    'getAliasedSymbol',
    'getApparentType',
    'getBaseConstraintOfType',
    'getDeclaredTypeOfSymbol',
    'getImmediateAliasedSymbol',
    'getNonNullableType',
    'getPropertiesOfType',
    'getPropertyOfType',
    'getReturnTypeOfSignature',
    'getShorthandAssignmentValueSymbol',
    'getSignaturesOfType',
    'getSymbolAtLocation',
    'getTypeArguments',
    'getTypeAtLocation',
    'isArrayType',
    'isTupleType',
    'isTypeAssignableTo',
    'resolveName'
]);

// Queries about a type, symbol or signature, keyed by its id: within one program snapshot tsgo gives
// each one id however it was reached (a node, another query), so equal objects share an entry
const TYPED = new Set<PropertyKey>([
    'getAliasedSymbol',
    'getApparentType',
    'getBaseConstraintOfType',
    'getImmediateAliasedSymbol',
    'getNonNullableType',
    'getPropertiesOfType',
    'getPropertyOfType',
    'getReturnTypeOfSignature',
    'getSignaturesOfType',
    'getTypeArguments',
    'isArrayType',
    'isTupleType',
    'isTypeAssignableTo'
]);


// The API each attached project's checker and program answer through
let apis = new WeakMap<object, API>();

// The cached checker of each program, dropped with the program
let programs = new WeakMap<Program, { checker: Checker; proxy: Checker }>();

// What each cached checker wraps, the answers it holds and the round-trips it made
let proxies = new WeakMap<Checker, Proxied>();


// A type argument's identity: its id rather than the object holding it
function identity(value: unknown): unknown {
    return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number'
        ? `#${(value as { id: number }).id}`
        : value;
}

// Answers keyed on (first argument, second argument); a batched query's array form keeps one entry
// per element under the same key its single form would use
function memo(typed: boolean): Memo {
    let results = new Map<unknown, Map<unknown, unknown>>();

    let entries = (args: unknown[]): Map<unknown, unknown> => {
        let key = typed ? identity(args[1]) : args[1],
            found = results.get(key);

        if (!found) {
            found = new Map();
            results.set(key, found);
        }

        return found;
    };

    let first = (args: unknown[]): unknown => {
        return typed ? identity(args[0]) : args[0];
    };

    return {
        get: (args) => entries(args).get(first(args)),
        has: (args) => entries(args).has(first(args)),
        set: (args, value) => {
            entries(args).set(first(args), value);
        }
    };
}

// A call passing more than two arguments (e.g. resolveName's optional location) is answered by the
// checker directly rather than risk a wrong cache hit. A batched query's array form shares the
// single form's entries and sends only the misses.
function memoize(query: Query, batched: boolean, answers: Memo): Query {
    return (...args) => {
        if (args.length > 2) {
            return query(...args);
        }

        if (batched && Array.isArray(args[0])) {
            let items = args[0] as unknown[],
                misses: unknown[] = [];

            for (let i = 0, n = items.length; i < n; i++) {
                if (!answers.has([items[i], args[1]])) {
                    misses.push(items[i]);
                }
            }

            if (misses.length > 0) {
                let found = query(...(args.length > 1 ? [misses, args[1]] : [misses])) as unknown[];

                for (let i = 0, n = misses.length; i < n; i++) {
                    answers.set([misses[i], args[1]], found[i]);
                }
            }

            let result: unknown[] = [];

            for (let i = 0, n = items.length; i < n; i++) {
                result.push(answers.get([items[i], args[1]]));
            }

            return result;
        }

        if (answers.has(args)) {
            return answers.get(args);
        }

        let result = query(...args);

        answers.set(args, result);

        return result;
    };
}

function proxy(checker: Checker): Checker {
    let memos = new Map<PropertyKey, Memo>(),
        methods = new Map<PropertyKey, Query>(),
        sent = { count: 0 };

    let answers = (key: PropertyKey): Memo | undefined => {
        if (!CACHED.has(key)) {
            return undefined;
        }

        let found = memos.get(key);

        if (!found) {
            found = memo(TYPED.has(key));
            memos.set(key, found);
        }

        return found;
    };

    let wrapper = new Proxy(checker, {
        get(target, key) {
            let value = Reflect.get(target, key);

            if (typeof value !== 'function') {
                return value;
            }

            let method = methods.get(key);

            if (!method) {
                let bound = value.bind(target) as Query,
                    cache = answers(key);

                method = (...args) => {
                    sent.count++;

                    return bound(...args);
                };

                if (cache) {
                    method = memoize(method, BATCHED.has(key), cache);
                }

                methods.set(key, method);
            }

            return method;
        }
    });

    proxies.set(wrapper, { memo: answers, sent, target: checker });

    return wrapper;
}


// Records the API a project answers through, so batch() can send its queries together
const attach = <P extends Project>(api: API, project: P): P => {
    apis.set(project.checker, api);
    apis.set(project.program, api);

    return project;
};

// Answers each call as `owner[method](...call)` would, in one round-trip. A cached checker answers
// what it already holds and keeps what it learns, so later single calls are answered from it; an
// owner of a project never attached sends each call alone.
const batch = <O extends Checker | Program, K extends Method<O>>(owner: O, method: K, calls: Call<O, K>[]): Result<O, K>[] => {
    let proxied = proxies.get(owner as Checker),
        target = (proxied?.target ?? owner) as unknown as Record<PropertyKey, Query & { gen: (...args: unknown[]) => AnyAPIRequestGenerator }>,
        answers = calls.every((call) => call.length <= 2) ? proxied?.memo(method) : undefined,
        misses: unknown[][] = [];

    for (let i = 0, n = calls.length; i < n; i++) {
        if (!answers?.has(calls[i])) {
            misses.push(calls[i]);
        }
    }

    if (misses.length === 0) {
        return calls.map((call) => answers!.get(call)) as Result<O, K>[];
    }

    let api = apis.get(target),
        query = target[method],
        found: unknown[];

    if (api === undefined || misses.length === 1) {
        found = misses.map((call) => query(...call));

        if (proxied) {
            proxied.sent.count += misses.length;
        }
    }
    else {
        let requests: AnyAPIRequestGenerator[] = [];

        for (let i = 0, n = misses.length; i < n; i++) {
            requests.push(query.gen(...misses[i]));
        }

        found = api.batch(...requests);

        if (proxied) {
            proxied.sent.count++;
        }
    }

    if (!answers) {
        return found as Result<O, K>[];
    }

    for (let i = 0, n = misses.length; i < n; i++) {
        answers.set(misses[i], found[i]);
    }

    return calls.map((call) => answers.get(call)) as Result<O, K>[];
};

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

// Round-trips a cached checker has made so far; 0 for a checker `cached` did not create
const sent = (checker: Checker): number => {
    return proxies.get(checker)?.sent.count ?? 0;
};


export default { attach, batch, cached, sent };
