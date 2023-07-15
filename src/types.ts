type ExtractMethods<T> = {
    [K in keyof T as T[K] extends Function ? K : never]: T[K]
};

type Mutable<T> = {
    -readonly [P in keyof T]: T[P];
};

type Prettify<T> = {
    [K in keyof T]: T[K];
} & {};


export { ExtractMethods, Mutable, Prettify };