import type { Channel } from './kernel/types';
import type { ThrowIndex } from './exceptions/derive';
import { createAsyncChannel } from './async/channel';
import { createExceptionsChannel } from './exceptions/channel';
import { createResourcesChannel } from './resources/channel';

// Channel factories by name. Values are erased to `Channel<unknown>` because the
// fixpoint engine is generic over the lattice and only ever feeds a channel the
// values it produced itself. Only the exceptions channel reads the `throwIndex`
// (its cross-module `.js` throw derivation); the others ignore it.
const FACTORIES: Readonly<Record<string, (config: unknown, throwIndex: ThrowIndex) => Channel<unknown>>> = {
    async: (config) => createAsyncChannel(config) as unknown as Channel<unknown>,
    exceptions: (_config, throwIndex) => createExceptionsChannel(throwIndex) as unknown as Channel<unknown>,
    resources: (config) => createResourcesChannel(config) as unknown as Channel<unknown>,
};

function channelFor(name: string, config: unknown, throwIndex: ThrowIndex): Channel<unknown> | undefined {
    const factory = FACTORIES[name];
    return factory ? factory(config, throwIndex) : undefined;
}

function implementedChannels(): ReadonlyArray<string> {
    return Object.keys(FACTORIES);
}


export { channelFor, implementedChannels };
