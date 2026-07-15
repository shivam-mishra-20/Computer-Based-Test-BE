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
): Promise<{ raw: string; usage: any }> {
  let raw = '';
  let usage: any;
  let watchdog: NodeJS.Timeout | undefined;
  const arm = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(), idleMs);
  };
  try {
    arm();
    for await (const chunk of stream) {
      arm(); // a token arrived — reset the idle deadline
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) raw += delta;
      if (chunk?.usage) usage = chunk.usage;
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
  return { raw, usage };
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
  if (/nemotron-nano|nano-9b|nano-12b/i.test(model)) {
    return reasoning === 'on' ? '/think' : '/no_think';
  }
  return `detailed thinking ${reasoning}`;
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

    const controller = new AbortController();
    const idleMs = opts.idleTimeoutMs ?? aiConfig.nvidia.idleTimeoutMs;
    const stream = await getClient().chat.completions.create(
      {
        model,
        messages: [{ role: 'user', content }] as any,
        temperature: opts.temperature ?? 0.1,
        top_p: opts.topP ?? aiConfig.nvidia.topP,
        max_tokens: opts.maxTokens ?? aiConfig.nvidia.maxTokens,
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
