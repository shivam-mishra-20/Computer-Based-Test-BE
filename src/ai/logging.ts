/**
 * Structured per-call AI telemetry: provider, model, latency, tokens, retries,
 * failures, and a rough cost estimate. One line per call, easy to grep/ship.
 */
import { aiConfig, type ProviderName } from './config';
import type { Usage } from './types';

export interface AICallLog {
  provider: ProviderName;
  model: string;
  label?: string;
  latencyMs: number;
  usage?: Usage;
  retries?: number;
  ok: boolean;
  fellBack?: boolean;
  error?: string;
}

/** USD cost estimate from configured per-1M-token rates (0 if unknown). */
export function estimateCostUSD(provider: ProviderName, usage?: Usage): number {
  if (!usage || provider !== 'nvidia') return 0;
  const { inputPerM, outputPerM } = aiConfig.cost;
  const cost =
    (usage.promptTokens / 1_000_000) * inputPerM +
    (usage.completionTokens / 1_000_000) * outputPerM;
  return Math.round(cost * 1e6) / 1e6;
}

export function logAICall(entry: AICallLog): void {
  const cost = estimateCostUSD(entry.provider, entry.usage);
  const parts = [
    `[AI]`,
    entry.ok ? 'ok' : 'ERR',
    `provider=${entry.provider}`,
    `model=${entry.model}`,
    entry.label ? `label=${entry.label}` : '',
    `latency=${entry.latencyMs}ms`,
    entry.usage
      ? `tokens=${entry.usage.promptTokens}+${entry.usage.completionTokens}=${entry.usage.totalTokens}`
      : '',
    entry.retries ? `retries=${entry.retries}` : '',
    entry.fellBack ? `fellBack=1` : '',
    cost > 0 ? `cost=$${cost.toFixed(6)}` : '',
    entry.error ? `error=${entry.error.slice(0, 180)}` : '',
  ].filter(Boolean);

  const line = parts.join(' ');
  if (entry.ok) console.log(line);
  else console.warn(line);
}
