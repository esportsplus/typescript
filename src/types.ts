type DeepReadonly<T> = T extends (...args: any[]) => any
    ? T
    : T extends Array<infer R>
        ? ReadonlyArray<DeepReadonly<R>>
        : T extends object
            ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
            : T;

type Function = (...args: unknown[]) => Promise<unknown> | unknown;

type NeverAsync<T> =
    T extends Promise<unknown>
        ? never
        : T extends (...args: unknown[]) => unknown
            ? NeverAsync<ReturnType<T>> extends never
                ? never
                : T
            : T;

type NeverFunction<T> =
    T extends Promise<unknown>
        ? never
        : T extends (...args: unknown[]) => unknown
            ? never
            : T;

type Prettify<T> = {
    [K in keyof T]: T[K];
} & {};

type UnionRecord<U, V extends Record<string, unknown>> = Prettify<U & { [K in keyof U]?: undefined } & V>;


export type { DeepReadonly, Function, NeverAsync, NeverFunction, Prettify, UnionRecord };