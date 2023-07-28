type Function = (...args: unknown[]) => Promise<unknown> | unknown;

type NeverAsync<T> =
    T extends Promise<unknown>
        ? never
        : T extends ((...args: unknown[]) => Promise<unknown> | unknown)
            ? NeverAsync<ReturnType<T>> extends never
                ? never
                : T
            : T;

type Prettify<T> = {
    [K in keyof T]: T[K];
} & {};


export { Function, NeverAsync, Prettify };