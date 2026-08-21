const items: number[] = [1, 2, 3];

function mapBounded<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
}

export async function work(x: number): Promise<number> {
    return x;
}

export async function boundedOk(): Promise<void> {
    await Promise.all([work(1), work(2)]);
}

export async function dynamicBad(): Promise<void> {
    await Promise.all(items.map((x) => work(x)));
}

export async function pooledOk(): Promise<void> {
    await Promise.all(items.map((x) => mapBounded(() => work(x))));
}
