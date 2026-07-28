export * from './types';
export * from './registry';
export * from './resolve';
export * from './json';
export * from './schema-walker';
export * from './generate-object';
export * from './fixtures';
export * from './doctor';

export * from './providers/mock';
export * from './providers/process';
export * from './providers/cli-prompt';
export * from './providers/image-data';
export * from './providers/claude-cli';
export * from './providers/codex-cli';
export * from './providers/anthropic-api';
export * from './providers/openai-api';

export * from './prompts/interview';
export * from './prompts/photo-analysis';
export * from './prompts/edl';

import { registerProvider } from './registry';
import { mockProvider } from './providers/mock';
import { claudeCliProvider } from './providers/claude-cli';
import { codexCliProvider } from './providers/codex-cli';
import { anthropicApiProvider } from './providers/anthropic-api';
import { openaiApiProvider } from './providers/openai-api';

// The mock is always available: CI depends on it, and a missing AI_PROVIDER
// should degrade to "deterministic and offline", never to a crash.
//
// The other four are registered but not touched. Registration costs nothing —
// no binary is probed and no key is read until something resolves them — and it
// means `ai:doctor` can name every adapter that exists rather than only the one
// currently configured.
registerProvider(mockProvider);
registerProvider(claudeCliProvider);
registerProvider(codexCliProvider);
registerProvider(anthropicApiProvider);
registerProvider(openaiApiProvider);
