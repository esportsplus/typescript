type Function = (...args: unknown[]) => Promise<unknown> | unknown;

type Prettify<T> = {
    [K in keyof T]: T[K];
} & {};

type SyncFunction<T, R = T extends Function ? ReturnType<T> : T> =
    T extends Promise<unknown>
        ? never
        : T extends Function
            ? SyncFunction<R> extends never
                ? never
                : T
            : T;


export { Function, Prettify, SyncFunction };