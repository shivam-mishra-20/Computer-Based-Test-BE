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
    // Feature-specific override for the Schedule Image Auto-Extraction table
    // reader (Admin → App Management → Custom Schedule → Upload Schedule).
    // Kept separate from modelVision so this doesn't change behavior for the
    // other, already-working vision callers (Smart Import OCR, PPT vision
    // analysis) — same pattern as the ppt.* per-feature model overrides below.
    scheduleVisionModel: str(
      process.env.NVIDIA_MODEL_SCHEDULE_VISION,
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    ),
    // Small/fast model for metadata, JSON formatting, validation, small rewrites.
    // Falls back to the generation model when unset.
    // NOTE: nvidia/llama-3.1-nemotron-nano-8b-v1 (the old default) went dead on
    // the NVIDIA API 2026-07 — requests hang forever with no response. Probe a
    // replacement with scripts before changing this again.
    modelFast: str(
      process.env.NVIDIA_MODEL_FAST ??
        process.env.NVIDIA_MODEL_GENERATION ??
        process.env.NVIDIA_MODEL_PRIMARY,
      'nvidia/nvidia-nemotron-nano-9b-v2',
    ),
    temperature: num(process.env.NVIDIA_TEMPERATURE, 0.2),
    topP: num(process.env.NVIDIA_TOP_P, 0.95),
    maxTokens: int(process.env.NVIDIA_MAX_TOKENS, 8192),
    // Absolute per-request wall-clock cap (backstop). The idle timeout below is
    // the fast path; this only bounds a request that keeps trickling tokens
    // forever. Lowered from the old 20-min default so nothing can hang for 20
    // minutes; still generous for a long slide generation (override via env).
    timeoutMs: int(process.env.NVIDIA_TIMEOUT_MS, 360000), // 6 min
    // Idle timeout: abort if the model sends NO token for this long. A hung/
    // stalled connection fails within seconds so the pipeline falls back or
    // retries immediately, instead of blocking on the 20-min client timeout
    // (the observed cause of multi-minute "Understanding Request" stages).
    // Streaming generations send tokens continuously, so this never fires on a
    // healthy-but-slow request. Per-task override via ChatOptions.idleTimeoutMs.
    idleTimeoutMs: int(process.env.NVIDIA_IDLE_TIMEOUT_MS, 45000),
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

  /** PPT fast-path tuning (v7). Internal planning stages default to the fast
   * model (big speed win, output is teacher-reviewed anyway); the slides the
   * teacher actually reads default to the quality model. All env-overridable. */
  ppt: {
    /** Model for knowledge extraction + the lecture outline: 'fast' | 'generation'. */
    planningModel: (str(process.env.PPT_PLANNING_MODEL, 'fast') === 'generation'
      ? 'generation'
      : 'fast') as 'fast' | 'generation',
    /** Model for slide content generation: 'fast' | 'generation'. */
    slideModel: (str(process.env.PPT_SLIDE_MODEL, 'generation') === 'fast'
      ? 'fast'
      : 'generation') as 'fast' | 'generation',
    /** Model for REDESIGN (preserve-wording) slides. Redesign is mechanical —
     * reformat the page's own verbatim text into a layout, invent nothing —
     * so the fast model handles it well, and on a 92-slide deck it's the
     * difference between ~40 minutes and ~4. 'generation' restores max polish. */
    redesignSlideModel: (str(process.env.PPT_REDESIGN_SLIDE_MODEL, 'fast') === 'generation'
      ? 'generation'
      : 'fast') as 'fast' | 'generation',
    /** Parallel slide-generation calls (independent per-slide fan-out). */
    slideConcurrency: int(process.env.PPT_SLIDE_CONCURRENCY, 6),
    /** Per-slide hallucination reviewer adds a second LLM call per slide. Off
     * by default for speed (grounded slides rarely need it); on for max quality. */
    reviewSlides: str(process.env.PPT_REVIEW_SLIDES, 'off').toLowerCase() === 'on',
    /** Cap knowledge-extraction batches (each is one LLM call over ~5k chars).
     * Lowered from 12 — a lecture needs the chapter, not the whole book. */
    extractMaxBatches: int(process.env.PPT_EXTRACT_MAX_BATCHES, 6),
  },
};

/** Whether automatic NVIDIA→Ollama fallback should be attempted. */
export function fallbackEnabled(): boolean {
  return aiConfig.provider === 'nvidia';
}
