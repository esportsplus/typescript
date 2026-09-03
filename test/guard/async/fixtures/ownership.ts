export async function syncUsers(): Promise<void> {}

function compute(): number {
    return 1;
}

export function droppedStatement(): void {
    syncUsers();
}

export async function awaitedOk(): Promise<void> {
    await syncUsers();
}

export function voidedOk(): void {
    void syncUsers();
}

export function returnedOk(): Promise<void> {
    return syncUsers();
}

export function thenChainReturned(): Promise<void> {
    return syncUsers().then(() => {});
}

export function thenChainHandled(): void {
    syncUsers().catch(() => {});
}

export function danglingThen(): void {
    syncUsers().then(() => {});
}

export function noPromiseOk(): void {
    compute();
}
