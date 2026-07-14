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
