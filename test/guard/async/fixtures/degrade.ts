const bucket: Promise<void>[] = [];

export async function make(): Promise<void> {}

export function storePromise(): void {
    bucket.push(make());
}
