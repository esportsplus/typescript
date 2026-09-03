import type { Channel } from './kernel/types';
import type { ThrowIndex } from './exceptions/derive';
import { createAsyncChannel } from './async/channel';
import { createExceptionsChannel } from './exceptions/channel';
import { createResourcesChannel } from './resources/channel';

// Channel factories by name. Values are erased to `Channel<unknown>` because the
// fixpoint engine is generic over the lattice and only ever feeds a channel the
// values it produced itself. Only the exceptions channel reads the `throwIndex`
// (its cross-module `.js` throw derivation); the others ignore it.
const FACTORIES: Readonly<Record<string, (throwIndex: ThrowIndex) => Channel<unknown>>> = {
    async: () => createAsyncChannel() as unknown as Channel<unknown>,
    exceptions: (throwIndex) => createExceptionsChannel(throwIndex) as unknown as Channel<unknown>,
    resources: () => createResourcesChannel() as unknown as Channel<unknown>,
};

function channelFor(name: string, throwIndex: ThrowIndex): Channel<unknown> | undefined {
    const factory = FACTORIES[name];
    return factory ? factory(throwIndex) : undefined;
}

export { channelFor };
