/**
 * Which part of the request shape does this model actually accept?
 *
 * The schedule vision call sends four things at once: a system directive, a
 * `response_format`, `chat_template_kwargs`, and a streamed image. When the
 * provider answers 500 there is nothing in the response that says which one it
 * objected to, so this varies them one at a time.
 *
 * Structural output only — status, code, chunk counts, field lengths. No keys,
 * no prompt text, no image, no model output.
 *
 *   npx ts-node --transpile-only scripts/safety/nvidia-shape-bisect.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import OpenAI from 'openai';
import { aiConfig } from '../../src/ai/config';
import { prepareScheduleImageForVision } from '../../src/services/schedule/scheduleImagePrep';

const PROMPT =
  'Transcribe this timetable image to JSON with keys scheduleDate, sections, warnings. Output JSON only.';

interface Variant {
  name: string;
  systemDirective?: string;
  responseFormat?: boolean;
  templateKwargs?: boolean;
  stream: boolean;
  maxTokens?: number;
}

const VARIANTS: Variant[] = [
  {
    name: 'current app shape',
    systemDirective: 'detailed thinking off',
    responseFormat: true,
    templateKwargs: true,
    stream: true,
  },
  {
    name: 'no response_format',
    systemDirective: 'detailed thinking off',
    responseFormat: false,
    templateKwargs: true,
    stream: true,
  },
  {
    name: 'no chat_template_kwargs',
    systemDirective: 'detailed thinking off',
    responseFormat: true,
    templateKwargs: false,
    stream: true,
  },
  {
    name: 'no system directive',
    responseFormat: true,
    templateKwargs: true,
    stream: true,
  },
  { name: 'bare streamed vision', stream: true },
  { name: 'bare NON-streamed vision', stream: false },
  {
    name: 'kwargs only, no format, no system',
    templateKwargs: true,
    stream: true,
  },
];

async function run(
  client: OpenAI,
  v: Variant,
  image: { mimeType: string; b64: string },
) {
  const messages: any[] = [];
  if (v.systemDirective)
    messages.push({ role: 'system', content: v.systemDirective });
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: PROMPT },
      {
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.b64}` },
      },
    ],
  });

  const body: any = {
    model: aiConfig.nvidia.scheduleVisionModel,
    messages,
    temperature: 0,
    max_tokens: v.maxTokens ?? 2000,
    stream: v.stream,
  };
  if (v.responseFormat) body.response_format = { type: 'json_object' };
  if (v.templateKwargs) body.chat_template_kwargs = { thinking: false };
  if (v.stream) body.stream_options = { include_usage: true };

  const controller = new AbortController();
  const cap = setTimeout(
    () => controller.abort(),
    Number(process.env.BISECT_CAP_MS || 90000),
  );
  const started = Date.now();

  let chunks = 0;
  let contentChars = 0;
  let reasoningChars = 0;
  let finish: string | null = null;
  let usage: any = null;
  let error: string | null = null;

  try {
    const res: any = await client.chat.completions.create(body, {
      signal: controller.signal,
    });
    if (v.stream) {
      for await (const chunk of res) {
        chunks++;
        const d = chunk?.choices?.[0]?.delta ?? {};
        if (typeof d.content === 'string') contentChars += d.content.length;
        if (typeof d.reasoning_content === 'string')
          reasoningChars += d.reasoning_content.length;
        if (chunk?.choices?.[0]?.finish_reason)
          finish = chunk.choices[0].finish_reason;
        if (chunk?.usage) usage = chunk.usage;
      }
    } else {
      const msg = res?.choices?.[0]?.message ?? {};
      contentChars = typeof msg.content === 'string' ? msg.content.length : 0;
      reasoningChars =
        typeof msg.reasoning_content === 'string'
          ? msg.reasoning_content.length
          : 0;
      finish = res?.choices?.[0]?.finish_reason ?? null;
      usage = res?.usage ?? null;
    }
  } catch (err: any) {
    // Shape only — a provider error body can echo a masked credential.
    error = `${err?.name} status=${err?.status ?? 'n/a'} code=${err?.code ?? 'n/a'} type=${err?.type ?? 'n/a'}`;
  } finally {
    clearTimeout(cap);
  }

  return {
    variant: v.name,
    ms: Date.now() - started,
    chunks,
    contentChars,
    reasoningChars,
    finish,
    completionTokens: usage?.completion_tokens ?? null,
    error,
  };
}

async function main() {
  const prepared = await prepareScheduleImageForVision(
    readFileSync(join(__dirname, 'fixtures', 'schedule-two-grid.png')),
  );
  const image = {
    mimeType: prepared.mimeType,
    b64: prepared.buffer.toString('base64'),
  };

  console.log('model:', aiConfig.nvidia.scheduleVisionModel);
  console.log(
    'image:',
    `${prepared.sent.width}x${prepared.sent.height}`,
    prepared.sent.bytes,
    'bytes\n',
  );

  const client = new OpenAI({
    apiKey: aiConfig.nvidia.apiKey,
    baseURL: aiConfig.nvidia.baseURL,
  });

  for (const v of VARIANTS) {
    const r = await run(client, v, image);
    console.log(
      `${r.variant.padEnd(34)} ${String(r.ms).padStart(7)}ms  chunks=${String(r.chunks).padStart(5)}  ` +
        `content=${String(r.contentChars).padStart(6)}  reasoning=${String(r.reasoningChars).padStart(6)}  ` +
        `finish=${String(r.finish).padEnd(6)}  tokens=${String(r.completionTokens).padEnd(6)}  ${r.error ?? ''}`,
    );
  }
}

main().catch((e) => {
  console.error('bisect failed:', e?.name, e?.status ?? '', e?.code ?? '');
  process.exit(1);
});
