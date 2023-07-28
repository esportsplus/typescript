type Function = (...args: unknown[]) => Promise<unknown> | unknown;

type NeverAsync<T> =
    T extends Promise<unknown>
        ? never
        : T extends (...args: unknown[]) => unknown
            ? (...args: Parameters<T>) => ReturnType<T> extends NeverAsync<ReturnType<T>>
                ? ReturnType<T>
                : NeverAsync<ReturnType<T>>
            : T;

type Prettify<T> = {
    [K in keyof T]: T[K];
} & {};


export { Function, NeverAsync, Prettify };