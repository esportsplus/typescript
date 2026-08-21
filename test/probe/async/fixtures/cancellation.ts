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

async function inner(u: string, signal?: AbortSignal): Promise<void> {
    await fetch(u, { signal });
}

export async function wrapperDrops(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return;
    }
    await inner("/x");
}

export async function wrapperForwards(signal: AbortSignal): Promise<void> {
    await inner("/x", signal);
}
