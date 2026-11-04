import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFixtureDir } from '../../cli/fixtures';
import { declaredReturnsPromise, inferredReturnsPromise } from '~/guard/async/returns';
import { isFunctionLike, makeFunctionInfo } from '~/guard/kernel/ids';
import { buildProgram } from '~/guard/kernel/program';
import type { Caches } from '~/guard/async/returns';
import type { FunctionLike } from '~/guard/kernel/types';

import * as ts from '~/guard/adapter';
import fs from 'node:fs';
import path from 'node:path';


type Row = {
    declared: boolean | undefined;
    inferred: boolean;
};


let sources: Record<string, string> = {
    'legacy.js': `
/** @returns {Promise<void>} */
export function documented() {}
`,
    'main.ts': `
type Alias = Promise<void>;
interface Thenable { then(onfulfilled: () => void): void; }
declare function load(): Promise<number>;

export function annotated(): Promise<void> { return Promise.resolve(); }
export function aliased(): Alias { return Promise.resolve(); }
export function promiseLike(): PromiseLike<void> { return Promise.resolve(); }
export function thenable(): Thenable { return { then() {} }; }
export const thenableLiteral = () => ({ then() {} });
export const spreadArrow = (o: object) => ({ ...o });
export function overloaded(): Promise<void>;
export function overloaded(value: number): void;
export function overloaded(value?: number): any { void value; }
export function overloadedAnnotated(value: string): any;
export function overloadedAnnotated(value?: string): Promise<void> { void value; return Promise.resolve(); }
export function* generator() { yield 1; }
export class Box {
    constructor() {}
    get value(): Promise<void> { return Promise.resolve(); }
    set value(next: Promise<void>) { void next; }
    method(): Promise<void> { return Promise.resolve(); }
    empty() {}
}
export interface Merged { run(): Promise<void>; }
export class Merged { run() {} }
export const callArrow = () => load();
export const objectArrow = () => ({ count: 1, 'name': 'x' });
export const stringArrow = () => 'text';
export const arrayArrow = () => [1, 2];
export const templateArrow = (n: number) => \`\${n}\`;
export function nested() { const inner = () => { return load(); }; void inner; }
export function bare() { return; }
export const throwing = () => { throw new Error('x'); };
export function voidAnnotated(): void { load(); }
export function booleanAnnotated(): boolean { return true; }
export function stringAnnotated(): string { return ''; }
export function isText(value: unknown): value is string { return typeof value === 'string'; }
export function assertText(value: unknown): asserts value is string { if (typeof value !== 'string') { throw new Error('x'); } }
export function anyAnnotated(): any { return load(); }
export function nullAnnotated(): null { return null; }
export function overloadedVoid(value: string): Promise<void>;
export function overloadedVoid(value?: string): void { void value; }
export const literal = { objectMethod(): Promise<void> { return Promise.resolve(); }, objectPlain() {} };
export function returnsCall() { return load(); }
export async function asyncFn() {}
`,
    'shadow.ts': `
type Promise<T> = { value: T };
export function shadowed(): Promise<void> { return { value: undefined }; }
`
};

let tsconfig = {
    compilerOptions: {
        allowJs: true,
        lib: ['esnext'],
        module: 'esnext',
        moduleResolution: 'bundler',
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: 'esnext'
    },
    include: ['src']
};


let dir = '',
    rows = new Map<string, Row>();


function functionsIn(sf: ts.SourceFile): FunctionLike[] {
    let out: FunctionLike[] = [];

    let visit = (node: ts.Node): void => {
        if (isFunctionLike(node) && (node as { body?: ts.Node }).body) {
            out.push(node);
        }

        ts.forEachChild(node, visit);
    };

    ts.forEachChild(sf, visit);

    return out;
}

function label(node: FunctionLike, sf: ts.SourceFile): string {
    let name = makeFunctionInfo(node, sf).name;

    if (ts.isGetAccessorDeclaration(node)) {
        return `get ${name}`;
    }

    if (ts.isSetAccessorDeclaration(node)) {
        return `set ${name}`;
    }

    return name;
}

function row(name: string): Row {
    let found = rows.get(name);

    if (!found) {
        throw new Error(`returns.test: no function '${name}' in the fixture`);
    }

    return found;
}


beforeAll(() => {
    dir = createFixtureDir('.fixture-returns-');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));

    for (let [file, text] of Object.entries(sources)) {
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', file), text);
    }

    let built = buildProgram(path.join(dir, 'tsconfig.json'));

    try {
        let caches: Caches = { promiseTypes: new Map(), shadows: new Map() },
            files = built.program.getSourceFileNames().filter((name) => name.replace(/\\/g, '/').includes('/src/'));

        for (let i = 0, n = files.length; i < n; i++) {
            let sf = built.program.getSourceFile(files[i])!;

            for (let node of functionsIn(sf)) {
                rows.set(label(node, sf), {
                    declared: declaredReturnsPromise(built.checker, node, caches),
                    inferred: inferredReturnsPromise(built.checker, node, caches)
                });
            }
        }
    }
    finally {
        built.dispose();
    }
});

afterAll(() => {
    fs.rmSync(dir, { force: true, recursive: true });
});


describe('async returns — syntactic fast paths', () => {
    it('agrees with the checker wherever it answers', () => {
        expect(rows.size).toBeGreaterThan(25);

        for (let [name, { declared, inferred }] of rows) {
            if (declared !== undefined) {
                expect({ answer: declared, name }).toEqual({ answer: inferred, name });
            }
        }
    });

    it('answers a sole `Promise<…>` annotation without the checker', () => {
        expect(row('annotated')).toEqual({ declared: true, inferred: true });
        expect(row('method')).toEqual({ declared: true, inferred: true });
        expect(row('objectMethod').declared).toBe(true);
    });

    it('leaves aliases, PromiseLike, thenables and a shadowed Promise to the checker', () => {
        expect(row('aliased')).toEqual({ declared: undefined, inferred: true });
        expect(row('promiseLike')).toEqual({ declared: undefined, inferred: true });
        expect(row('thenable')).toEqual({ declared: undefined, inferred: true });
        expect(row('thenableLiteral')).toEqual({ declared: undefined, inferred: true });
        expect(row('spreadArrow').declared).toBeUndefined();
        expect(row('shadowed')).toEqual({ declared: undefined, inferred: false });
    });

    it('leaves overloads and class/interface merges to the checker', () => {
        expect(row('overloaded')).toEqual({ declared: undefined, inferred: true });
        expect(row('overloadedAnnotated').declared).toBeUndefined();
        expect(row('run')).toEqual({ declared: undefined, inferred: true });
    });

    it('leaves generators, accessors, constructors and JavaScript to the checker', () => {
        expect(row('generator')).toEqual({ declared: undefined, inferred: false });
        expect(row('get value').declared).toBeUndefined();
        expect(row('set value').declared).toBeUndefined();
        expect(row('Box.constructor').declared).toBeUndefined();
        expect(row('documented')).toEqual({ declared: undefined, inferred: true });
    });

    it('answers a block body that returns no value as void', () => {
        expect(row('empty')).toEqual({ declared: false, inferred: false });
        expect(row('nested')).toEqual({ declared: false, inferred: false });
        expect(row('bare')).toEqual({ declared: false, inferred: false });
        expect(row('throwing')).toEqual({ declared: false, inferred: false });
        expect(row('objectPlain').declared).toBe(false);
        expect(row('inner').declared).toBeUndefined();
    });

    it('answers a concise arrow returning a literal as not a promise', () => {
        expect(row('objectArrow')).toEqual({ declared: false, inferred: false });
        expect(row('stringArrow')).toEqual({ declared: false, inferred: false });
        expect(row('arrayArrow')).toEqual({ declared: false, inferred: false });
        expect(row('templateArrow')).toEqual({ declared: false, inferred: false });
        expect(row('callArrow')).toEqual({ declared: undefined, inferred: true });
        expect(row('returnsCall')).toEqual({ declared: undefined, inferred: true });
    });

    it('answers a sole primitive, void or predicate annotation as not a promise', () => {
        expect(row('voidAnnotated')).toEqual({ declared: false, inferred: false });
        expect(row('booleanAnnotated')).toEqual({ declared: false, inferred: false });
        expect(row('stringAnnotated')).toEqual({ declared: false, inferred: false });
        expect(row('isText')).toEqual({ declared: false, inferred: false });
        expect(row('assertText')).toEqual({ declared: false, inferred: false });
        expect(row('anyAnnotated').declared).toBeUndefined();
        expect(row('nullAnnotated').declared).toBeUndefined();
        expect(row('overloadedVoid')).toEqual({ declared: undefined, inferred: true });
    });

    it('keeps the async short-circuit', () => {
        expect(row('asyncFn').declared).toBe(true);
    });
});
