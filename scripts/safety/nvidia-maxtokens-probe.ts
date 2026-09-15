/**
 * Does `max_tokens` decide whether this endpoint answers at all?
 *
 * Observed while bisecting the request shape: the SAME shape succeeded at
 * max_tokens 2000 and returned an immediate 500 at 6000 — which is the value
 * the schedule extractor uses. That is a testable claim, and it is cheap to
 * test because the failure comes back in about a second.
 *
 * Each value is tried more than once, because an intermittent provider can
 * manufacture either answer from a single sample.
 *
 * Structural output only: status/code and field lengths. No keys, no prompt,
 * no image, no model output.
 *
 *   npx ts-node --transpile-only scripts/safety/nvidia-maxtokens-probe.ts
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

const VALUES = [2000, 3000, 4000, 6000, 8000];
const ROUNDS = Number(process.env.PROBE_ROUNDS || 2);

async function once(
  client: OpenAI,
  maxTokens: number,
  image: { mimeType: string; b64: string },
) {
  const controller = new AbortController();
  const cap = setTimeout(
    () => controller.abort(),
    Number(process.env.PROBE_CAP_MS || 120000),
  );
  const started = Date.now();
  let chunks = 0;
  let contentChars = 0;
  let reasoningChars = 0;
  let finish: string | null = null;
  let tokens: number | null = null;
  let error: string | null = null;

  try {
    const stream: any = await client.chat.completions.create(
      {
        model: aiConfig.nvidia.scheduleVisionModel,
        messages: [
          { role: 'system', content: 'detailed thinking off' },
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${image.mimeType};base64,${image.b64}`,
                },
              },
            ],
          },
        ] as any,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        chat_template_kwargs: { thinking: false },
        stream: true,
        stream_options: { include_usage: true },
      } as any,
      { signal: controller.signal },
    );
    for await (const chunk of stream) {
      chunks++;
      const d = chunk?.choices?.[0]?.delta ?? {};
      if (typeof d.content === 'string') contentChars += d.content.length;
      if (typeof d.reasoning_content === 'string')
        reasoningChars += d.reasoning_content.length;
      if (chunk?.choices?.[0]?.finish_reason)
        finish = chunk.choices[0].finish_reason;
      if (chunk?.usage) tokens = chunk.usage.completion_tokens ?? null;
    }
  } catch (err: any) {
    // Shape only — an error body can echo a masked credential.
    error = `status=${err?.status ?? 'n/a'} code=${err?.code ?? 'n/a'}`;
  } finally {
    clearTimeout(cap);
  }

  return {
    ms: Date.now() - started,
    chunks,
    contentChars,
    reasoningChars,
    finish,
    tokens,
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
    'bytes',
  );
  console.log(`rounds per value: ${ROUNDS}\n`);

  for (const v of VALUES) {
    for (let round = 1; round <= ROUNDS; round++) {
      const r = await once(client, v, image);
      console.log(
        `max_tokens=${String(v).padStart(5)} run${round}  ${String(r.ms).padStart(7)}ms  ` +
          `chunks=${String(r.chunks).padStart(5)}  content=${String(r.contentChars).padStart(6)}  ` +
          `reasoning=${String(r.reasoningChars).padStart(6)}  finish=${String(r.finish).padEnd(6)}  ` +
          `tokens=${String(r.tokens).padEnd(6)}  ${r.error ?? 'OK'}`,
      );
    }
  }
}

const client = new OpenAI({
  apiKey: aiConfig.nvidia.apiKey,
  baseURL: aiConfig.nvidia.baseURL,
});

main().catch((e) => {
  console.error('probe failed:', e?.name, e?.status ?? '', e?.code ?? '');
  process.exit(1);
});
