import { AiProviderNotFoundError, type AiProvider } from './types';

const registry = new Map<string, AiProvider>();

export function registerProvider(provider: AiProvider): AiProvider {
  registry.set(provider.id, provider);
  return provider;
}

export function hasProvider(id: string): boolean {
  return registry.has(id);
}

export function listProviderIds(): string[] {
  return [...registry.keys()].sort();
}

export function listProviders(): AiProvider[] {
  return listProviderIds().map((id) => registry.get(id) as AiProvider);
}

/** Throws a message that names what *is* available — nobody enjoys guessing. */
export function getProvider(id: string): AiProvider {
  const provider = registry.get(id);
  if (!provider) throw new AiProviderNotFoundError(id, listProviderIds());
  return provider;
}

/** Test hook: drop everything except the providers registered at import time. */
export function clearProviders(): void {
  registry.clear();
}
