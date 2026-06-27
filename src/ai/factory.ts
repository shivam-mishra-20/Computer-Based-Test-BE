/**
 * Provider factory — selects the AIProvider from config. Switching providers is
 * a one-line `.env` change (AI_PROVIDER=ollama|nvidia). Providers are singletons.
 *
 * To add a future provider (e.g. Azure, Anthropic): implement AIProvider and
 * wire it into `build()` below. No feature code changes.
 */
import { aiConfig, type ProviderName } from './config';
import { NvidiaProvider } from './providers/nvidiaProvider';
import { OllamaProvider } from './providers/ollamaProvider';
import type { AIProvider } from './types';

const instances: Partial<Record<ProviderName, AIProvider>> = {};

function build(name: ProviderName): AIProvider {
  switch (name) {
    case 'ollama':
      return new OllamaProvider();
    case 'nvidia':
    default:
      return new NvidiaProvider();
  }
}

export function getProvider(name?: ProviderName): AIProvider {
  const key = (name || aiConfig.provider) as ProviderName;
  if (!instances[key]) instances[key] = build(key);
  return instances[key]!;
}

/** The active primary provider (from AI_PROVIDER). */
export function getPrimaryProvider(): AIProvider {
  return getProvider(aiConfig.provider);
}

/** The fallback provider (Ollama) when the primary is NVIDIA; else null. */
export function getFallbackProvider(): AIProvider | null {
  return aiConfig.provider === 'nvidia' ? getProvider('ollama') : null;
}
