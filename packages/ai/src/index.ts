export * from './types';
export * from './registry';
export * from './resolve';
export * from './providers/mock';

import { registerProvider } from './registry';
import { mockProvider } from './providers/mock';

// The mock is always available: CI depends on it, and a missing AI_PROVIDER
// should degrade to "deterministic and offline", never to a crash.
registerProvider(mockProvider);
