import type { Channel } from './kernel/types';
import { createAsyncChannel } from './async/channel';
import { createExceptionsChannel } from './exceptions/channel';
import { createResourcesChannel } from './resources/channel';

// Channel factories by name. Values are erased to `Channel<unknown>` because the
// fixpoint engine is generic over the lattice and only ever feeds a channel the
// values it produced itself.
const FACTORIES: Readonly<Record<string, () => Channel<unknown>>> = {
    async: () => createAsyncChannel() as unknown as Channel<unknown>,
    exceptions: () => createExceptionsChannel() as unknown as Channel<unknown>,
    resources: () => createResourcesChannel() as unknown as Channel<unknown>,
};

export function channelFor(name: string): Channel<unknown> | undefined {
    const factory = FACTORIES[name];
    return factory ? factory() : undefined;
}

export function implementedChannels(): ReadonlyArray<string> {
    return Object.keys(FACTORIES);
}
