import type { API, Checker, Program, Project } from 'typescript/async';

import shared from '../shared';


// Answers keyed on (second argument, first argument)
type Memo = Map<unknown, Map<unknown, Promise<unknown>>>;

type Query = (...args: unknown[]) => Promise<unknown>;

// One program's answers, shared by every view of its checker
type Store = {
    answers: Map<PropertyKey, Memo>;
    api: API | undefined;
    sent: { count: number };
    target: Checker;
};

// One transform's lane to tsgo: the queries it misses in one turn are sent as one request
type View = {
    methods: Map<PropertyKey, Query>;
    pending: (() => void)[];
    scheduled: boolean;
    store: Store;
};


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
    'getMemberInModuleExports',
    'getNonNullableType',
    'getPropertiesOfType',
    'getPropertyOfType',
    'getReturnTypeOfSignature',
    'getShorthandAssignmentValueSymbol',
    'getSignaturesOfType',
    'getSymbolAtLocation',
    'getTypeArguments',
    'getTypeAtLocation',
    'isArrayLikeType',
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
    'getMemberInModuleExports',
    'getNonNullableType',
    'getPropertiesOfType',
    'getPropertyOfType',
    'getReturnTypeOfSignature',
    'getSignaturesOfType',
    'getTypeArguments',
    'isArrayLikeType',
    'isArrayType',
    'isTupleType',
    'isTypeAssignableTo'
]);


// The API each attached project's checker answers through; shared with every copy of this package,
// whose language service may be the one that attached it
let apis = shared('checker-apis', () => new WeakMap<object, API>());

// The answers kept for each program, dropped with the program
let programs = new WeakMap<Program, Store>();

let views = new WeakMap<Checker, View>();


// Sends every query the view missed this turn in one batch: opening a batch context first sends
// what other views queued, so tsgo receives each transform's queries as a request of its own and
// answers concurrent transforms in parallel (it answers the items of one batch in order)
function flush(view: View): void {
    let pending = view.pending;

    view.pending = [];
    view.scheduled = false;

    if (pending.length === 0) {
        return;
    }

    view.store.sent.count++;

    let context = view.store.api?.batchContext();

    try {
        for (let i = 0, n = pending.length; i < n; i++) {
            pending[i]();
        }
    }
    finally {
        context?.[Symbol.dispose]();
    }
}

// A type argument's identity: its id rather than the object holding it
function identity(value: unknown): unknown {
    return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number'
        ? `#${(value as { id: number }).id}`
        : value;
}

function keep(memo: Memo, typed: boolean, args: unknown[], answer: Promise<unknown>): void {
    let inner = typed ? identity(args[1]) : args[1],
        outer = typed ? identity(args[0]) : args[0],
        found = memo.get(inner);

    if (!found) {
        found = new Map();
        memo.set(inner, found);
    }

    found.set(outer, answer);

    // A failed query (its snapshot disposed underneath it) is asked again by the next caller
    answer.catch(() => {
        if (found.get(outer) === answer) {
            found.delete(outer);
        }
    });
}

function lookup(memo: Memo, typed: boolean, args: unknown[]): Promise<unknown> | undefined {
    return memo.get(typed ? identity(args[1]) : args[1])?.get(typed ? identity(args[0]) : args[0]);
}

// A call passing more than two arguments (e.g. resolveName's optional location) is answered by the
// checker directly rather than risk a wrong cache hit. A batched query's array form shares the
// single form's entries and sends only the misses; a query already in flight is awaited, not sent.
function memoize(view: View, key: PropertyKey, query: Query): Query {
    if (!CACHED.has(key)) {
        return (...args) => send(view, query, args);
    }

    let batched = BATCHED.has(key),
        typed = TYPED.has(key);

    return (...args) => {
        if (args.length > 2) {
            return send(view, query, args);
        }

        let memo = view.store.answers.get(key);

        if (!memo) {
            memo = new Map();
            view.store.answers.set(key, memo);
        }

        if (batched && Array.isArray(args[0])) {
            let items = args[0] as unknown[],
                misses: unknown[] = [],
                seen = new Set<unknown>();

            for (let i = 0, n = items.length; i < n; i++) {
                if (!seen.has(items[i]) && !lookup(memo, typed, [items[i], args[1]])) {
                    misses.push(items[i]);
                }

                seen.add(items[i]);
            }

            if (misses.length > 0) {
                let found = send(view, query, args.length > 1 ? [misses, args[1]] : [misses]) as Promise<unknown[]>;

                for (let i = 0, n = misses.length; i < n; i++) {
                    keep(memo, typed, [misses[i], args[1]], found.then((answers) => answers[i]));
                }
            }

            let result: Promise<unknown>[] = [];

            for (let i = 0, n = items.length; i < n; i++) {
                result.push(lookup(memo, typed, [items[i], args[1]])!);
            }

            return Promise.all(result);
        }

        let found = lookup(memo, typed, args);

        if (found) {
            return found;
        }

        found = send(view, query, args);
        keep(memo, typed, args, found);

        return found;
    };
}

function send(view: View, query: Query, args: unknown[]): Promise<unknown> {
    let { promise, reject, resolve } = Promise.withResolvers<unknown>();

    view.pending.push(() => {
        try {
            Promise.resolve(query(...args)).then(resolve, reject);
        }
        catch (error) {
            reject(error);
        }
    });

    if (!view.scheduled) {
        view.scheduled = true;
        setImmediate(flush, view);
    }

    return promise;
}

function wrap(store: Store): Checker {
    let view: View = { methods: new Map(), pending: [], scheduled: false, store };

    let wrapper = new Proxy(store.target, {
        get(target, key) {
            let value = Reflect.get(target, key);

            if (typeof value !== 'function') {
                return value;
            }

            let method = view.methods.get(key);

            if (!method) {
                method = memoize(view, key, value.bind(target) as Query);
                view.methods.set(key, method);
            }

            return method;
        }
    });

    views.set(wrapper, view);

    return wrapper;
}


// Records the API a project answers through, so a view can send its queries as one request
const attach = <P extends Project>(api: API, project: P): P => {
    apis.set(project.checker, api);

    return project;
};

// A transform's view of a program's checker. Plugins ask the same question about the same node
// repeatedly (and of each other's nodes), and concurrent transforms ask the same questions: one
// memo serves every view of a program, since its answers are fixed for that snapshot, and a query
// in flight is awaited rather than sent again. Each view sends what it misses in one turn as one
// request. A new program, or a new checker for it, starts a new memo; a view is returned unchanged.
const cached = (checker: Checker, program?: Program): Checker => {
    if (views.has(checker)) {
        return checker;
    }

    let store = program === undefined ? undefined : programs.get(program);

    if (!store || store.target !== checker) {
        store = { answers: new Map(), api: apis.get(checker), sent: { count: 0 }, target: checker };

        if (program !== undefined) {
            programs.set(program, store);
        }
    }

    return wrap(store);
};

// Requests the views of a checker's memo have sent so far; 0 for a checker `cached` did not create
const sent = (checker: Checker): number => {
    return views.get(checker)?.store.sent.count ?? 0;
};


export default { attach, cached, sent };
