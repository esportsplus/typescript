export async function drops(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return;
    }
    await fetch("/x");
}

export async function forwards(signal: AbortSignal): Promise<void> {
    await fetch("/x", { signal });
}

export async function neverHadSignal(): Promise<void> {
    await fetch("/x");
}

export async function destructuredDrops({ signal }: { signal: AbortSignal }): Promise<void> {
    if (signal.aborted) {
        return;
    }
    await fetch("/x");
}

export async function destructuredForwards({ signal }: { signal: AbortSignal }): Promise<void> {
    await fetch("/x", { signal });
}
