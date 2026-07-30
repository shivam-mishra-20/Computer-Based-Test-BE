/**
 * NVIDIA provider — talks to the NVIDIA API Catalog via its OpenAI-compatible
 * endpoint using the `openai` SDK. One client serves both the text model
 * (nemotron) and the vision model (VLM) for OCR / diagram analysis.
 */
import OpenAI from 'openai';
import { aiConfig } from '../config';
import { safeParse, stripReasoning } from '../json';
import type {
  AIProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  HealthResult,
  VisionImage,
} from '../types';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!aiConfig.nvidia.apiKey) {
    throw new Error('NVIDIA_API_KEY is not set');
  }
  if (!client) {
    client = new OpenAI({
      apiKey: aiConfig.nvidia.apiKey,
      baseURL: aiConfig.nvidia.baseURL,
      timeout: aiConfig.nvidia.timeoutMs,
      maxRetries: 0, // retries handled by withFallback / runBatch
    });
  }
  return client;
}

function toUsage(u: any) {
  return {
    promptTokens: Number(u?.prompt_tokens || 0),
    completionTokens: Number(u?.completion_tokens || 0),
    totalTokens: Number(u?.total_tokens || 0),
  };
}

/**
 * Consume a streamed chat completion into text + usage. We stream (not because
 * we surface tokens) but to keep the HTTP connection alive: with stream:false,
 * NVIDIA withholds response headers until the whole completion is ready, and
 * Node's undici fetch aborts at its 300s headersTimeout. Streaming sends headers
 * immediately and tokens continuously, so long generations (minutes) complete.
 *
 * The idle watchdog is what makes a HUNG request fail fast: it aborts the
 * stream if no token arrives for `idleMs`. Each token resets the timer, so a
 * slow-but-progressing generation is never cut off — only a genuinely stalled
 * connection (the cause of the multi-minute stages) is killed, letting
 * withFallback move on immediately.
 */
async function streamToText(
  stream: any,
  controller: AbortController,
  idleMs: number,
  maxDurationMs?: number,
  maxOutputChars?: number,
  maxStreamChunks?: number,
): Promise<{ raw: string; usage: any; finishReason?: string; streamChunks: number }> {
  let raw = '';
  let usage: any;
  let finishReason: string | undefined;
  let streamChunks = 0;
  let watchdog: NodeJS.Timeout | undefined;
  // One-shot hard cap, separate from the idle watchdog — never reset, so it
  // fires even while tokens keep flowing continuously (e.g. a model that
  // narrates instead of converging on an answer).
  const hardCap = maxDurationMs ? setTimeout(() => controller.abort(), maxDurationMs) : undefined;
  const arm = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(), idleMs);
  };
  try {
    arm();
    for await (const chunk of stream) {
      arm(); // a token arrived — reset the idle deadline
      // NOTE: only `delta.content` is collected. Reasoning models on this
      // endpoint stream their chain-of-thought in a SEPARATE
      // `delta.reasoning_content` field (verified live), which we
      // deliberately ignore — that keeps narration out of structured output.
      streamChunks++;
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) raw += delta;
      if (chunk?.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      if (chunk?.usage) usage = chunk.usage;

      // ---- Output bounds. Both exist because max_tokens is NOT honored by
      // this endpoint on every model (verified: a 200-token cap returned 2,980
      // completion tokens), so a model that degenerates into repeating itself
      // has no server-side bound at all. `break` is the documented way to stop
      // early: the SDK aborts the request. Reported as 'length' because that is
      // what it is — a truncated response the caller must not parse.

      // (a) Accumulated content. Works when the provider streams text
      //     incrementally. NOTE: it is inert on providers that withhold text
      //     and flush it in one final chunk — see (b).
      if (maxOutputChars && raw.length > maxOutputChars) {
        finishReason = 'length';
        break;
      }

      // (b) Chunk count as a live token proxy. NVIDIA's nemotron-3 vision
      //     endpoint streams one EMPTY delta per generated token and delivers
      //     the entire text in a single final chunk. Measured twice on a 20x9
      //     timetable: 6,847 chunks / 7,141 tokens and 31,324 chunks / 32,768
      //     tokens — a steady ~0.96 chunks per token. So counting chunks is the
      //     ONLY real-time view of how much the model has generated; content
      //     length and the idle watchdog are both blind until the very end
      //     (31,323 of those 31,324 chunks carried nothing at all, resetting
      //     the idle timer every ~8ms while producing no output).
      if (maxStreamChunks && streamChunks > maxStreamChunks) {
        finishReason = 'length';
        break;
      }
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (hardCap) clearTimeout(hardCap);
  }
  return { raw, usage, finishReason, streamChunks };
}

function toDataUrl(img: VisionImage): string {
  const b64 = Buffer.isBuffer(img.data)
    ? img.data.toString('base64')
    : String(img.data);
  return `data:${img.mimeType};base64,${b64}`;
}

/**
 * Inject the model-appropriate reasoning directive into the system prompt.
 * Two conventions exist in the nemotron family:
 *   - super/ultra v1.x:  "detailed thinking on|off"
 *   - nemotron-nano v2+: "/think" | "/no_think"
 * Sending the WRONG convention silently leaves reasoning at the model default
 * — observed live: nano-9b-v2 burned thousands of hidden <think> tokens per
 * call (an 87s "parse" for 5 questions) because "detailed thinking off" is a
 * no-op for it.
 */
function reasoningDirectiveFor(model: string, reasoning: 'on' | 'off'): string {
  // Checked FIRST and deliberately: "nemotron-nano-3-*" would otherwise fall
  // into the nano-v2 branch below and get "/no_think", which this family
  // handles badly (verified: reasoning bleeds into content, JSON comes back
  // malformed). nemotron-3 is steered by templateKwargsFor() instead; this
  // directive is only along for the ride.
  if (isNemotron3(model)) return `detailed thinking ${reasoning}`;
  if (/nemotron-nano|nano-9b|nano-12b/i.test(model)) {
    return reasoning === 'on' ? '/think' : '/no_think';
  }
  return `detailed thinking ${reasoning}`;
}

/**
 * nemotron-3 chat models, in both naming orders NVIDIA ships
 * (nemotron-3-nano-*, nemotron-3-super-*, nemotron-3-ultra-*, nemotron-nano-3-*).
 * Deliberately NOT a bare /nemotron-3/ — that would also catch the embedding
 * and content-safety endpoints, which take neither of these knobs.
 */
function isNemotron3(model: string): boolean {
  return /nemotron-3-(?:nano|super|ultra)|nemotron-nano-3/i.test(model);
}

/**
 * How to ACTUALLY turn thinking off, per model family. Sending the wrong
 * convention is a SILENT no-op — the model keeps reasoning at its default and
 * nothing in the response says so.
 *
 * nemotron-3 accepts NO system directive at all; only the chat-template flag
 * works. Verified live on nemotron-3-nano-omni with a 20x9 timetable
 * (2026-07-30), identical prompt + image each run:
 *   "detailed thinking off"  -> 36,540 chars of reasoning_content, 22,016
 *                               completion tokens, 120s. On a real sheet the
 *                               same request ran to the model's 32,768-token
 *                               ceiling and came back TRUNCATED with 0 cells.
 *   "/no_think"              -> reasoning bleeds back into `content`, JSON
 *                               came out malformed (missing a bracket).
 *   chat_template_kwargs
 *     {thinking:false}       -> 0 reasoning chars, ~3k completion tokens, ~30s,
 *                               valid JSON, 72-74 of 75 cells.
 * The system directive is kept alongside the flag (verified harmless: still 0
 * reasoning chars) so behavior is unchanged for every other model family.
 *
 * ALSO VERIFIED: this endpoint IGNORES max_tokens for nemotron-3 — a request
 * capped at 200 still returned 2,980 completion tokens. Token caps cannot
 * bound a runaway here; only reasoning-off and the wall-clock cap can.
 */
function templateKwargsFor(
  model: string,
  reasoning: 'on' | 'off',
): Record<string, unknown> | undefined {
  if (!isNemotron3(model)) return undefined;
  return { chat_template_kwargs: { thinking: reasoning === 'on' } };
}

function withReasoningDirective(
  messages: ChatMessage[],
  reasoning: 'on' | 'off',
  model: string,
): ChatMessage[] {
  const directive = reasoningDirectiveFor(model, reasoning);
  const out = messages.map((m) => ({ ...m }));
  const sys = out.find((m) => m.role === 'system');
  if (sys) {
    sys.content = `${directive}\n\n${sys.content}`;
    return out;
  }
  return [{ role: 'system', content: directive }, ...out];
}

export class NvidiaProvider implements AIProvider {
  readonly name = 'nvidia' as const;

  async chat(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<ChatResult> {
    const started = Date.now();
    const model = opts.model || aiConfig.nvidia.modelPrimary;
    const reasoning =
      opts.reasoning || (aiConfig.nvidia.reasoning as 'on' | 'off');
    const finalMessages = withReasoningDirective(messages, reasoning, model);

    const controller = new AbortController();
    const idleMs = opts.idleTimeoutMs ?? aiConfig.nvidia.idleTimeoutMs;
    const stream = await getClient().chat.completions.create(
      {
        model,
        messages: finalMessages as any,
        temperature: opts.temperature ?? aiConfig.nvidia.temperature,
        top_p: opts.topP ?? aiConfig.nvidia.topP,
        max_tokens: opts.maxTokens ?? aiConfig.nvidia.maxTokens,
        // No-op for every model family except nemotron-3, where it is the only
        // thing that turns thinking off — see templateKwargsFor().
        ...(templateKwargsFor(model, reasoning) || {}),
        stream: true,
        stream_options: { include_usage: true },
      } as any,
      { signal: controller.signal },
    );

    const { raw, usage } = await streamToText(stream, controller, idleMs);
    return {
      text: stripReasoning(raw),
      usage: toUsage(usage),
      provider: this.name,
      model,
      latencyMs: Date.now() - started,
    };
  }

  async chatJSON<T = any>(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<T> {
    const res = await this.chat(messages, opts);
    const parsed = safeParse<T>(res.text);
    if (parsed === undefined) {
      throw new Error(
        `NVIDIA returned unparseable JSON: ${res.text.slice(0, 200)}`,
      );
    }
    return parsed;
  }

  async vision(
    prompt: string,
    images: VisionImage[],
    opts: ChatOptions = {},
  ): Promise<ChatResult> {
    const started = Date.now();
    const model = opts.model || aiConfig.nvidia.modelVision;

    const content: any[] = [{ type: 'text', text: prompt }];
    for (const img of images) {
      content.push({ type: 'image_url', image_url: { url: toDataUrl(img) } });
    }

    // Reasoning directive is applied ONLY when the caller explicitly asks for
    // one. `chat()` always injects it, but doing the same here would silently
    // change the request for every existing vision caller (Smart Import OCR,
    // PPT vision analysis) that works today — so this stays opt-in.
    // Why it matters: on a reasoning VLM the default is thinking-ON, which for
    // a dense table means minutes of reasoning tokens and often a truncated,
    // unusable response. The directive alone is NOT enough on nemotron-3 (it is
    // silently ignored there) — templateKwargsFor() carries the real switch.
    const messages: any[] = [];
    if (opts.reasoning) {
      messages.push({ role: 'system', content: reasoningDirectiveFor(model, opts.reasoning) });
    }
    messages.push({ role: 'user', content });

    const controller = new AbortController();
    const idleMs = opts.idleTimeoutMs ?? aiConfig.nvidia.idleTimeoutMs;
    const stream = await getClient().chat.completions.create(
      {
        model,
        messages: messages as any,
        temperature: opts.temperature ?? 0.1,
        top_p: opts.topP ?? aiConfig.nvidia.topP,
        max_tokens: opts.maxTokens ?? aiConfig.nvidia.maxTokens,
        // Native JSON mode when the caller asks for it. Verified on this
        // endpoint: it also moves a reasoning model's chain-of-thought into
        // `reasoning_content`, so `content` stays pure JSON.
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        // The actual reasoning switch on nemotron-3 — see templateKwargsFor().
        // Applied only when the caller opted into reasoning control, so other
        // vision callers (Smart Import OCR, PPT analysis) are untouched.
        ...(opts.reasoning ? templateKwargsFor(model, opts.reasoning) || {} : {}),
        stream: true,
        stream_options: { include_usage: true },
      } as any,
      { signal: controller.signal },
    );

    const { raw, usage, finishReason, streamChunks } = await streamToText(
      stream,
      controller,
      idleMs,
      opts.maxDurationMs,
      opts.maxOutputChars,
      opts.maxStreamChunks,
    );
    return {
      text: stripReasoning(raw),
      usage: toUsage(usage),
      provider: this.name,
      model,
      latencyMs: Date.now() - started,
      finishReason,
      streamChunks,
    };
  }

  async health(): Promise<HealthResult> {
    if (!aiConfig.nvidia.apiKey) {
      return { ok: false, message: 'NVIDIA_API_KEY is not set' };
    }
    try {
      const res = await this.chat(
        [{ role: 'user', content: 'Reply with the single word: ok' }],
        {
          maxTokens: 16,
          label: 'health',
        },
      );
      return {
        ok: true,
        message: `NVIDIA reachable (${aiConfig.nvidia.modelPrimary}): "${res.text.slice(0, 40)}"`,
      };
    } catch (err) {
      return {
        ok: false,
        message: `NVIDIA error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
