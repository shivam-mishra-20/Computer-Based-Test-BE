/**
 * Central AI configuration — single source of truth, fully env-driven.
 * No model names or endpoints are hardcoded in feature code; everything is read
 * here so switching providers/models is a `.env` change only.
 */
import dotenv from 'dotenv';

dotenv.config();

function str(v: string | undefined, fallback: string): string {
  const s = (v ?? '').trim();
  return s.length ? s : fallback;
}
function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function int(v: string | undefined, fallback: number): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export type ProviderName = 'nvidia' | 'ollama';

export const aiConfig = {
  /** Active cloud/primary provider. 'nvidia' (default) or 'ollama' (offline). */
  provider: str(
    process.env.AI_PROVIDER,
    'nvidia',
  ).toLowerCase() as ProviderName,

  nvidia: {
    apiKey: str(process.env.NVIDIA_API_KEY, ''),
    baseURL: str(
      process.env.NVIDIA_BASE_URL,
      'https://integrate.api.nvidia.com/v1',
    ),
    // Generation / writing model. Prefer NVIDIA_MODEL_GENERATION; fall back to
    // the legacy NVIDIA_MODEL_PRIMARY so existing deployments keep working.
    modelGeneration: str(
      process.env.NVIDIA_MODEL_GENERATION ?? process.env.NVIDIA_MODEL_PRIMARY,
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    ),
    // Back-compat alias — older code/providers read `modelPrimary`. Same value
    // as modelGeneration so nothing changes for existing callers.
    modelPrimary: str(
      process.env.NVIDIA_MODEL_GENERATION ?? process.env.NVIDIA_MODEL_PRIMARY,
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    ),
    modelVision: str(
      process.env.NVIDIA_MODEL_VISION,
      'meta/llama-3.2-90b-vision-instruct',
    ),
    // Small/fast model for metadata, JSON formatting, validation, small rewrites.
    // Falls back to the generation model when unset.
    modelFast: str(
      process.env.NVIDIA_MODEL_FAST ??
        process.env.NVIDIA_MODEL_GENERATION ??
        process.env.NVIDIA_MODEL_PRIMARY,
      'nvidia/llama-3.1-nemotron-nano-8b-v1',
    ),
    temperature: num(process.env.NVIDIA_TEMPERATURE, 0.2),
    topP: num(process.env.NVIDIA_TOP_P, 0.95),
    maxTokens: int(process.env.NVIDIA_MAX_TOKENS, 8192),
    // The 49B model decodes ~10 tok/s, so large batches can run for minutes.
    // Default 20 min so requests complete instead of aborting (override via env).
    timeoutMs: int(process.env.NVIDIA_TIMEOUT_MS, 1200000),
    maxRetries: int(process.env.NVIDIA_MAX_RETRIES, 1),
    concurrency: int(process.env.NVIDIA_CONCURRENCY, 3),
    /** nemotron "detailed thinking on|off" — keep 'off' for deterministic JSON. */
    reasoning:
      str(process.env.NVIDIA_REASONING, 'off').toLowerCase() === 'on'
        ? 'on'
        : 'off',
  },

  ollama: {
    host: str(process.env.OLLAMA_HOST, 'http://localhost:11434'),
    model: str(process.env.OLLAMA_MODEL, 'qwen3:8b'),
    /** Optional local VLM for vision fallback (e.g. llama3.2-vision). Blank = disabled. */
    visionModel: str(process.env.OLLAMA_VISION_MODEL, ''),
  },

  /** Rough cost estimation (USD per 1M tokens). 0 = unknown/free; set if you track spend. */
  cost: {
    inputPerM: num(process.env.NVIDIA_COST_INPUT_PER_M, 0),
    outputPerM: num(process.env.NVIDIA_COST_OUTPUT_PER_M, 0),
  },
};

/** Whether automatic NVIDIA→Ollama fallback should be attempted. */
export function fallbackEnabled(): boolean {
  return aiConfig.provider === 'nvidia';
}
