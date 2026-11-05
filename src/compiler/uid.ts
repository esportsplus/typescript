import { AsyncLocalStorage } from 'node:async_hooks';

import path from 'path';


const BACKSLASH_REGEX = /\\/g;

const FNV_OFFSET_BASIS = 2166136261;

const FNV_PRIME = 16777619;

const NAMESPACE_WIDTH = 7;

const UNSCOPED_NAMESPACE = 'u';


// The scope of the transform running, which concurrent transforms each keep across their awaits
let scopes = new AsyncLocalStorage<{ counter: number; namespace: string }>(),
    unscoped = { counter: 0, namespace: UNSCOPED_NAMESPACE };


function derive(id: string, code: string): string {
    let candidate = format(id),
        salt = 0;

    while (code.includes(candidate)) {
        salt++;
        candidate = format(id + '#' + salt);
    }

    return candidate;
}

function format(id: string): string {
    return hash(id).toString(36).padStart(NAMESPACE_WIDTH, '0');
}

function hash(value: string): number {
    let h = FNV_OFFSET_BASIS;

    for (let i = 0, n = value.length; i < n; i++) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, FNV_PRIME);
    }

    return h >>> 0;
}


const uid = (name: string): string => {
    let scope = scopes.getStore() ?? unscoped;

    return name + '_' + scope.namespace + (scope.counter++).toString(36);
};

// Runs a file's transform with ids of its own: every id generated within `run` embeds the file's
// namespace, so proving the namespace absent from the file once makes all of them collision-free
uid.scope = <T>(root: string, fileName: string, code: string, run: () => T): T => {
    return scopes.run({ counter: 0, namespace: derive(path.relative(root, fileName).replace(BACKSLASH_REGEX, '/') || fileName, code) }, run);
};


export default uid;
