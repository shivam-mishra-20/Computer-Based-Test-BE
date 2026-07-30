/**
 * Provider-agnostic AI types. Every feature talks to an `AIProvider` (or the
 * `ai` facade) — never to a vendor SDK directly. Adding a future provider only
 * means implementing this interface.
 */
import type { ProviderName } from './config';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface VisionImage {
  /** Raw image bytes or a base64 string (without the data: prefix). */
  data: Buffer | string;
  /** e.g. image/png, image/jpeg. */
  mimeType: string;
}

export interface ChatOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** nemotron reasoning toggle. Defaults to config (off) for JSON tasks. */
  reasoning?: 'on' | 'off';
  /** Hint the provider to return strict JSON where natively supported. */
  json?: boolean;
  /** Override the model id for this single call. */
  model?: string;
  /** Short feature label used in structured logs (e.g. 'generate', 'classify'). */
  label?: string;
  /**
   * Idle timeout (ms): abort the request if the provider sends NO token for
   * this long. A stalled/hung request fails fast so the pipeline can fall back
   * or retry, while a genuinely slow-but-progressing generation (tokens still
   * arriving) is never cut off. Defaults per task via config.idleTimeoutMs.
   */
  idleTimeoutMs?: number;
  /**
   * Absolute wall-clock cap (ms) for this single call, independent of the idle
   * timeout above. Some models can stream tokens continuously while never
   * converging on a useful answer (e.g. a reasoning model narrating instead of
   * emitting the requested output) — idleTimeoutMs never fires in that case
   * because tokens keep arriving. When set, the call is aborted once this much
   * time has elapsed, regardless of ongoing token flow. Unset by default (no
   * behavior change for existing callers); opt in per call via ChatOptions.
   */
  maxDurationMs?: number;
  /**
   * Client-side cap on generated characters. Needed because a provider may
   * IGNORE max_tokens (verified on NVIDIA's nemotron-3 endpoint: a 200-token
   * cap still produced 2,980 completion tokens), leaving a model that loops on
   * repeated output with no server-side bound. When exceeded the stream is cut
   * and finishReason is reported as 'length' — a truncated response. Unset by
   * default; opt in per call.
   */
  maxOutputChars?: number;
  /**
   * Cap on streamed chunks. The bound that actually works against a provider
   * which withholds text and flushes it in one final chunk — there, chunk count
   * is the only live measure of how much has been generated (NVIDIA's
   * nemotron-3 vision endpoint emits ~0.96 empty chunks per generated token).
   * Exceeding it ends the stream and reports finishReason 'length'. Unset by
   * default; opt in per call.
   */
  maxStreamChunks?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  text: string;
  usage: Usage;
  provider: ProviderName;
  model: string;
  latencyMs: number;
  /**
   * Provider's finish_reason when available ('stop', 'length', …). 'length'
   * means the response hit the token cap and is TRUNCATED — callers parsing
   * structured output should treat that as a hard failure rather than trying
   * to repair a half-written document. Optional: not every provider reports it.
   */
  finishReason?: string;
  /** Chunks consumed from the stream. Diagnostic: on a provider that buffers
   *  its text into one final chunk this is the only usable progress signal. */
  streamChunks?: number;
}

export interface HealthResult {
  ok: boolean;
  message: string;
}

export interface AIProvider {
  readonly name: ProviderName;
  /** Free-form chat completion → text. */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  /** Chat completion whose text is parsed into JSON of type T. */
  chatJSON<T = any>(messages: ChatMessage[], opts?: ChatOptions): Promise<T>;
  /** Multimodal completion (OCR / diagram analysis) → text. */
  vision(
    prompt: string,
    images: VisionImage[],
    opts?: ChatOptions,
  ): Promise<ChatResult>;
  health(): Promise<HealthResult>;
}
