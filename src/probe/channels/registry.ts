import type { Channel } from "../kernel/types";
import { createExceptionsChannel } from "../exceptions/channel";

// Channel factories by name. Only channels with a landed implementation appear
// here; config may enable others (resources/async/context) and analyze skips the
// ones with no factory yet. Values are erased to `Channel<unknown>` because the
// fixpoint engine is generic over the lattice and only ever feeds a channel the
// values it produced itself.
const FACTORIES: Readonly<Record<string, () => Channel<unknown>>> = {
  exceptions: () => createExceptionsChannel() as unknown as Channel<unknown>,
};

export function channelFor(name: string): Channel<unknown> | undefined {
  const factory = FACTORIES[name];
  return factory ? factory() : undefined;
}

export function implementedChannels(): ReadonlyArray<string> {
  return Object.keys(FACTORIES);
}
