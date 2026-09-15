/**
 * Does the ENCODED IMAGE SIZE decide whether this endpoint answers?
 *
 * The production failure and the passing fixture differ in almost nothing
 * except how many bytes are sent:
 *
 *   fails   2500x1328 PNG, 1,788,625 bytes -> 3,001 empty frames, 0 content,
 *                                             0 reasoning, no finish_reason, 75s
 *   works   2500x1300 PNG,   449,791 bytes -> 2,524 frames, 5,216 chars, stop, 53s
 *
 * Zero reasoning characters rules out a thinking runaway — the model is not
 * working and hiding it, it is producing nothing at all. Size is the remaining
 * difference, and it is directly testable: the SAME picture, re-encoded at
 * several payload sizes.
 *
 * Structural output only: bytes, chunk counts, field lengths, status codes.
 *
 *   npx ts-node --transpile-only scripts/safety/nvidia-payload-size-probe.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import OpenAI from 'openai';
import { aiConfig } from '../../src/ai/config';

const PROMPT =
  'Transcribe this timetable image to JSON with keys scheduleDate, sections, warnings. Output JSON only.';

interface Encoding {
  name: string;
  build: (src: Buffer) => Promise<{ buffer: Buffer; mimeType: string }>;
}

const ENCODINGS: Encoding[] = [
  // Large PNG first: this is the condition the production failure ran under
  // (1,788,625 bytes). Same picture, same readability — only the byte count
  // differs from the variants below, which is what isolates SIZE from CONTENT.
  {
    name: 'png 5000w  (~1.8MB)',
    build: async (src) => ({
      buffer: await sharp(src)
        .rotate()
        .resize({ width: 5000, withoutEnlargement: false })
        .png()
        .toBuffer(),
      mimeType: 'image/png',
    }),
  },
  {
    name: 'jpeg q90 5000w (control)',
    build: async (src) => ({
      buffer: await sharp(src)
        .rotate()
        .resize({ width: 5000, withoutEnlargement: false })
        .jpeg({ quality: 90 })
        .toBuffer(),
      mimeType: 'image/jpeg',
    }),
  },
  {
    name: 'png 4000w  (~1.1MB)',
    build: async (src) => ({
      buffer: await sharp(src)
        .rotate()
        .resize({ width: 4000, withoutEnlargement: false })
        .png()
        .toBuffer(),
      mimeType: 'image/png',
    }),
  },
  {
    name: 'png 2500w  (current prep)',
    build: async (src) => ({
      buffer: await sharp(src)
        .rotate()
        .resize({ width: 2500, withoutEnlargement: false })
        .png()
        .toBuffer(),
      mimeType: 'image/png',
    }),
  },
  {
    name: 'png 1600w',
    build: async (src) => ({
      buffer: await sharp(src)
        .rotate()
        .resize({ width: 1600, withoutEnlargement: false })
        .png()
        .toBuffer(),
      mimeType: 'image/png',
    }),
  },
  {
    name: 'jpeg q90 2500w',
    build: async (src) => ({
      buffer: await sharp(src)
        .rotate()
        .resize({ width: 2500, withoutEnlargement: false })
        .jpeg({ quality: 90 })
        .toBuffer(),
      mimeType: 'image/jpeg',
    }),
  },
  {
    name: 'jpeg q85 2000w',
    build: async (src) => ({
      buffer: await sharp(src)
        .rotate()
        .resize({ width: 2000, withoutEnlargement: false })
        .jpeg({ quality: 85 })
        .toBuffer(),
      mimeType: 'image/jpeg',
    }),
  },
];

async function ask(client: OpenAI, buffer: Buffer, mimeType: string) {
  const controller = new AbortController();
  const cap = setTimeout(
    () => controller.abort(),
    Number(process.env.PROBE_CAP_MS || 120000),
  );
  const started = Date.now();
  let chunks = 0;
  let contentChars = 0;
  let reasoningChars = 0;
  let silent = 0;
  let finish: string | null = null;
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
                  url: `data:${mimeType};base64,${buffer.toString('base64')}`,
                },
              },
            ],
          },
        ] as any,
        temperature: 0,
        max_tokens: 6000,
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
      let any = false;
      if (typeof d.content === 'string' && d.content) {
        contentChars += d.content.length;
        any = true;
      }
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
        reasoningChars += d.reasoning_content.length;
        any = true;
      }
      if (!any) silent++;
      if (chunk?.choices?.[0]?.finish_reason)
        finish = chunk.choices[0].finish_reason;
    }
  } catch (err: any) {
    error = `status=${err?.status ?? 'n/a'} code=${err?.code ?? 'n/a'}`;
  } finally {
    clearTimeout(cap);
  }

  return {
    ms: Date.now() - started,
    chunks,
    silent,
    contentChars,
    reasoningChars,
    finish,
    error,
  };
}

async function main() {
  const srcPath =
    process.argv.find((a) => /\.(png|jpe?g)$/i.test(a)) ||
    join(__dirname, 'fixtures', 'schedule-two-grid.png');
  const src = readFileSync(srcPath);
  const rounds = Number(process.env.PROBE_ROUNDS || 2);

  console.log('model :', aiConfig.nvidia.scheduleVisionModel);
  console.log('source:', srcPath);
  console.log('rounds per encoding:', rounds, '\n');

  const client = new OpenAI({
    apiKey: aiConfig.nvidia.apiKey,
    baseURL: aiConfig.nvidia.baseURL,
  });

  for (const enc of ENCODINGS) {
    const { buffer, mimeType } = await enc.build(src);
    const meta = await sharp(buffer).metadata();
    for (let round = 1; round <= rounds; round++) {
      const r = await ask(client, buffer, mimeType);
      console.log(
        `${enc.name.padEnd(26)} ${String(meta.width)}x${String(meta.height)} ` +
          `${String(Math.round(buffer.length / 1024)).padStart(5)}KB  run${round}  ` +
          `${String(r.ms).padStart(7)}ms  chunks=${String(r.chunks).padStart(5)} ` +
          `silent=${String(r.silent).padStart(5)}  content=${String(r.contentChars).padStart(6)}  ` +
          `reasoning=${String(r.reasoningChars).padStart(6)}  finish=${String(r.finish).padEnd(6)}  ${r.error ?? 'OK'}`,
      );
    }
  }
}

main().catch((e) => {
  console.error('probe failed:', e?.name, e?.status ?? '', e?.code ?? '');
  process.exit(1);
});
