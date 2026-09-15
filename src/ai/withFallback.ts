/**
 * The `ai` facade — the single seam every feature calls. Wraps the active
 * provider with bounded retries (NVIDIA_MAX_RETRIES), structured logging, and
 * JSON parsing. Features never import a vendor SDK directly.
 *
 * ── The automatic Ollama fallback was removed ───────────────────────────────
 * It was never configured on any deployment, so it could only fail — and
 * because it failed LAST, its error replaced the primary's. A NVIDIA 500
 * reached callers as "OLLAMA_VISION_MODEL is not configured", which told an
 * admin nothing about what had actually gone wrong and cost an extra attempt on
 * every failure. The primary's error is now what callers see, which is the
 * whole point of having one.
 */
import { aiConfig } from './config';
import { getPrimaryProvider } from './factory';
import { logAICall } from './logging';
import { safeParse } from './json';
import type {
  AIProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  HealthResult,
  VisionImage,
} from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A timeout/abort is not transient — the model is just slow. Retrying only
 * multiplies the wait, so we stop retrying and surface it immediately.
 */
function isTimeout(err: any): boolean {
  const name = String(err?.name || '');
  const msg = String(err?.message || '').toLowerCase();
  const causeCode = String(err?.cause?.code || err?.code || '');
  return (
    /timeout/i.test(name) ||
    msg.includes('timed out') ||
    msg.includes('aborted') ||
    causeCode === 'ETIMEDOUT' ||
    causeCode === 'UND_ERR_HEADERS_TIMEOUT' ||
    causeCode === 'UND_ERR_BODY_TIMEOUT'
  );
}

/** Execute `op` against the primary provider with bounded retries. */
async function run(
  op: (p: AIProvider) => Promise<ChatResult>,
  label?: string,
): Promise<ChatResult> {
  const primary = getPrimaryProvider();
  const primaryAttempts =
    primary.name === 'nvidia' ? aiConfig.nvidia.maxRetries + 1 : 1;

  let lastErr: unknown;
  /** The provider's failure, surfaced as-is once the retries are spent. */
  let primaryErr: unknown;
  let retries = 0;

  for (let i = 0; i < primaryAttempts; i++) {
    try {
      const res = await op(primary);
      logAICall({
        provider: res.provider,
        model: res.model,
        label,
        latencyMs: res.latencyMs,
        usage: res.usage,
        retries: i,
        ok: true,
      });
      return res;
    } catch (err) {
      lastErr = err;
      primaryErr = err;
      retries = i + 1;
      if (isTimeout(err)) break; // slow model — don't multiply the wait by retrying
      if (i < primaryAttempts - 1) await sleep(400 * Math.pow(2, i));
    }
  }

  const surfaced = primaryErr ?? lastErr;
  logAICall({
    provider: primary.name,
    model: '-',
    label,
    retries,
    latencyMs: 0,
    ok: false,
    error: surfaced instanceof Error ? surfaced.message : String(surfaced),
  });
  throw surfaced instanceof Error ? surfaced : new Error(String(surfaced));
}

export const ai = {
  /** Free-form chat → ChatResult (text + usage). */
  chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    return run((p) => p.chat(messages, opts), opts.label);
  },

  /** Convenience: single-prompt chat → plain text. */
  async text(prompt: string, opts: ChatOptions = {}): Promise<string> {
    const res = await run(
      (p) => p.chat([{ role: 'user', content: prompt }], opts),
      opts.label,
    );
    return res.text;
  },

  /** Chat whose text is parsed into JSON of type T (with retries + repair).
   * If every repair pass in safeParse fails (e.g. an unescaped quote inside a
   * string — unfixable mechanically), ONE corrective retry shows the model its
   * own broken output and asks for strictly valid JSON. Without this, a single
   * bad sample kills an entire multi-minute generation. */
  async chatJSON<T = any>(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<T> {
    const res = await run(
      (p) => p.chat(messages, { ...opts, json: true }),
      opts.label,
    );
    let parsed = safeParse<T>(res.text);
    if (parsed !== undefined) return parsed;

    console.warn(
      `[ai] chatJSON parse failed (label=${opts.label || '-'}, provider=${res.provider}) — running one corrective retry`,
    );
    const fixMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: res.text.slice(0, 12000) },
      {
        role: 'user',
        content:
          'Your previous reply was NOT valid JSON and could not be parsed. ' +
          'Re-send the SAME content as one complete, strictly valid JSON document. ' +
          'Rules: no markdown fences, no commentary before or after the JSON; ' +
          'escape every backslash inside strings as \\\\ (e.g. "\\\\frac"); ' +
          'escape double quotes inside strings as \\"; no trailing commas.',
      },
    ];
    const retry = await run(
      (p) => p.chat(fixMessages, { ...opts, json: true }),
      `${opts.label || 'chatJSON'}:jsonfix`,
    );
    parsed = safeParse<T>(retry.text);
    if (parsed === undefined) {
      throw new Error(
        `AI returned unparseable JSON (${retry.provider}): ${retry.text.slice(0, 200)}`,
      );
    }
    return parsed;
  },

  /** Multimodal (OCR / diagram analysis) → ChatResult. */
  vision(
    prompt: string,
    images: VisionImage[],
    opts: ChatOptions = {},
  ): Promise<ChatResult> {
    return run((p) => p.vision(prompt, images, opts), opts.label || 'vision');
  },

  /** OCR helper: vision → plain extracted text. */
  async visionText(
    prompt: string,
    images: VisionImage[],
    opts: ChatOptions = {},
  ): Promise<string> {
    const res = await this.vision(prompt, images, opts);
    return res.text;
  },

  /** Health of the active primary provider. */
  health(): Promise<HealthResult> {
    return getPrimaryProvider().health();
  },
};
