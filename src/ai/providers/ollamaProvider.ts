/**
 * Ollama provider — local, zero-cost, offline. Used directly when
 * AI_PROVIDER=ollama and as the automatic fallback when NVIDIA fails.
 * Wraps the same `ollama` client/patterns already used in ollamaService.ts.
 */
import { Ollama } from 'ollama';
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

let ollama: Ollama | null = null;

function getOllama(): Ollama {
  if (!ollama) ollama = new Ollama({ host: aiConfig.ollama.host });
  return ollama;
}

function toUsage(res: any) {
  return {
    promptTokens: Number(res?.prompt_eval_count || 0),
    completionTokens: Number(res?.eval_count || 0),
    totalTokens: Number((res?.prompt_eval_count || 0) + (res?.eval_count || 0)),
  };
}

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama' as const;

  async chat(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<ChatResult> {
    const started = Date.now();
    const model = opts.model || aiConfig.ollama.model;

    const res = await getOllama().chat({
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })) as any,
      format: opts.json ? 'json' : undefined,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0,
        top_p: opts.topP ?? 0.9,
        num_predict: opts.maxTokens ?? 2048,
        num_ctx: 4096,
        repeat_penalty: 1.1,
      },
    } as any);

    const raw = (res as any)?.message?.content || '';
    return {
      text: stripReasoning(raw),
      usage: toUsage(res),
      provider: this.name,
      model,
      latencyMs: Date.now() - started,
    };
  }

  async chatJSON<T = any>(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<T> {
    const res = await this.chat(messages, { ...opts, json: true });
    const parsed = safeParse<T>(res.text);
    if (parsed === undefined) {
      throw new Error(
        `Ollama returned unparseable JSON: ${res.text.slice(0, 200)}`,
      );
    }
    return parsed;
  }

  async vision(
    prompt: string,
    images: VisionImage[],
    opts: ChatOptions = {},
  ): Promise<ChatResult> {
    const model = opts.model || aiConfig.ollama.visionModel;
    if (!model) {
      throw new Error(
        'OLLAMA_VISION_MODEL not configured — local vision fallback unavailable',
      );
    }
    const started = Date.now();
    const b64Images = images.map((img) =>
      Buffer.isBuffer(img.data)
        ? img.data.toString('base64')
        : String(img.data),
    );

    const res = await getOllama().chat({
      model,
      messages: [{ role: 'user', content: prompt, images: b64Images }] as any,
      stream: false,
      options: { temperature: opts.temperature ?? 0.1 },
    } as any);

    const raw = (res as any)?.message?.content || '';
    return {
      text: stripReasoning(raw),
      usage: toUsage(res),
      provider: this.name,
      model,
      latencyMs: Date.now() - started,
    };
  }

  async health(): Promise<HealthResult> {
    try {
      const list = await getOllama().list();
      const names = list.models.map((m) => m.name);
      const has = names.some((n) =>
        n.startsWith(aiConfig.ollama.model.split(':')[0]),
      );
      if (!has) {
        return {
          ok: false,
          message: `Model ${aiConfig.ollama.model} not found. Run: ollama pull ${aiConfig.ollama.model}. Available: ${names.join(', ')}`,
        };
      }
      return {
        ok: true,
        message: `Ollama running with ${aiConfig.ollama.model}`,
      };
    } catch {
      return {
        ok: false,
        message: `Ollama not reachable at ${aiConfig.ollama.host}. Start with: ollama serve`,
      };
    }
  }
}
