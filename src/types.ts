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


export { Function, NeverAsync, NeverFunction, Prettify };