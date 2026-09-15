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

// The automatic NVIDIA -> Ollama fallback was REMOVED.
//
// It was never configured on any deployment, so it could only ever fail — and
// because it failed LAST, its error ("OLLAMA_VISION_MODEL is not configured")
// replaced the real one. A NVIDIA 500 reached callers wearing an unrelated
// message about a local model nobody runs, which is why the schedule route had
// to throw the message away and show a generic string instead.
//
// Ollama is still selectable as the PRIMARY provider (AI_PROVIDER=ollama) —
// the EPUB automation runner uses exactly that. What is gone is the silent
// switch to it when NVIDIA fails.
