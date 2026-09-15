/**
 * What is actually in the chunks?
 *
 * The schedule extraction fails with a signature that says nothing on its own:
 * 7,500 stream chunks, 0 characters, 0 completion tokens, no finish_reason.
 * The provider's own comments assert those chunks are "one EMPTY delta per
 * generated token", but that was measured on a different model revision and is
 * exactly the kind of claim that goes stale. This measures it.
 *
 * Diagnostics are STRUCTURAL only — chunk index, which fields exist, how long
 * each field's value is, finish_reason, usage. Never the prompt, never the
 * image, never a key, and never the text itself.
 *
 *   npx ts-node --transpile-only scripts/safety/nvidia-stream-probe.ts [image.png]
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import OpenAI from 'openai';
import { aiConfig } from '../../src/ai/config';
import { prepareScheduleImageForVision } from '../../src/services/schedule/scheduleImagePrep';
import { SCHEDULE_SCHEMA_EXAMPLE } from '../../src/services/schedule/scheduleExtractionContract';

const PROMPT = `You are a STRICT TRANSCRIBER of a photographed DAILY CLASS SCHEDULE (timetable). Transcribe exactly what is printed. Never invent, guess, compute, or normalize anything.

Columns are TIME-SLOT headers. Rows are CLASS/BATCH labels. A cell is the intersection of one row and one column. Transcribe a cell ONLY if it has visible text.

Return ONLY this raw JSON object. The angle-bracketed values are SLOTS — replace every one with text you actually read in the image:
${SCHEDULE_SCHEMA_EXAMPLE}`;

interface ChunkFacts {
  i: number;
  keys: string[];
  choiceKeys: string[];
  deltaKeys: string[];
  contentLen: number;
  reasoningLen: number;
  otherTextFields: Record<string, number>;
  finish: string | null;
  hasUsage: boolean;
  hasToolCalls: boolean;
  hasRefusal: boolean;
  errorField: string | null;
}

const TEXTUAL = new Set([
  'content',
  'reasoning_content',
  'reasoning',
  'text',
  'refusal',
]);

function describeChunk(chunk: any, i: number): ChunkFacts {
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta ?? choice?.message ?? {};
  const otherTextFields: Record<string, number> = {};
  for (const [k, v] of Object.entries(delta)) {
    if (typeof v === 'string' && !TEXTUAL.has(k)) otherTextFields[k] = v.length;
    if (
      typeof v === 'string' &&
      TEXTUAL.has(k) &&
      k !== 'content' &&
      k !== 'reasoning_content'
    ) {
      otherTextFields[k] = v.length;
    }
  }
  return {
    i,
    keys: Object.keys(chunk ?? {}),
    choiceKeys: choice ? Object.keys(choice) : [],
    deltaKeys: Object.keys(delta),
    contentLen: typeof delta?.content === 'string' ? delta.content.length : -1,
    reasoningLen:
      typeof delta?.reasoning_content === 'string'
        ? delta.reasoning_content.length
        : typeof delta?.reasoning === 'string'
          ? delta.reasoning.length
          : -1,
    otherTextFields,
    finish: choice?.finish_reason ?? null,
    hasUsage: Boolean(chunk?.usage),
    hasToolCalls: Boolean(delta?.tool_calls),
    hasRefusal: Boolean(delta?.refusal),
    errorField: chunk?.error ? JSON.stringify(Object.keys(chunk.error)) : null,
  };
}

async function main() {
  const imagePath =
    process.argv.find((a) => /\.(png|jpe?g)$/i.test(a)) ||
    join(__dirname, 'fixtures', 'schedule-two-grid.png');
  const prepared = await prepareScheduleImageForVision(readFileSync(imagePath));

  const model = aiConfig.nvidia.scheduleVisionModel;
  const capMs = Number(process.env.PROBE_CAP_MS || 200000);
  console.log(
    'image :',
    `${prepared.sent.width}x${prepared.sent.height}`,
    prepared.sent.bytes,
    'bytes',
  );
  console.log('model :', model);
  console.log('cap   :', capMs, 'ms\n');

  const client = new OpenAI({
    apiKey: aiConfig.nvidia.apiKey,
    baseURL: aiConfig.nvidia.baseURL,
  });

  const controller = new AbortController();
  const hardCap = setTimeout(() => controller.abort(), capMs);
  const started = Date.now();

  const facts: ChunkFacts[] = [];
  let content = '';
  let reasoning = '';
  let finish: string | null = null;
  let usage: any = null;
  let streamError: string | null = null;

  try {
    const stream = (await client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: 'detailed thinking off' },
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${prepared.mimeType};base64,${prepared.buffer.toString('base64')}`,
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
    )) as any;

    for await (const chunk of stream) {
      const f = describeChunk(chunk, facts.length);
      facts.push(f);
      const d = chunk?.choices?.[0]?.delta ?? {};
      if (typeof d.content === 'string') content += d.content;
      if (typeof d.reasoning_content === 'string')
        reasoning += d.reasoning_content;
      if (typeof d.reasoning === 'string') reasoning += d.reasoning;
      if (chunk?.choices?.[0]?.finish_reason)
        finish = chunk.choices[0].finish_reason;
      if (chunk?.usage) usage = chunk.usage;
    }
  } catch (err: any) {
    // Redacted: provider errors can echo a (partially masked) credential back.
    // Only the shape of the failure is diagnostic, never its text.
    streamError = `${err?.name} status=${err?.status ?? 'n/a'} code=${err?.code ?? 'n/a'} type=${err?.type ?? 'n/a'}`;
  } finally {
    clearTimeout(hardCap);
  }

  const elapsed = Date.now() - started;

  // ── Aggregate, structurally ───────────────────────────────────────────────
  const withContent = facts.filter((f) => f.contentLen > 0).length;
  const withReasoning = facts.filter((f) => f.reasoningLen > 0).length;
  const emptyDelta = facts.filter(
    (f) => f.contentLen <= 0 && f.reasoningLen <= 0,
  ).length;
  const deltaKeyShapes = new Map<string, number>();
  for (const f of facts) {
    const k = f.deltaKeys.sort().join(',') || '(none)';
    deltaKeyShapes.set(k, (deltaKeyShapes.get(k) || 0) + 1);
  }

  console.log('── result ────────────────────────────────────────────');
  console.log(
    JSON.stringify(
      {
        elapsedMs: elapsed,
        chunks: facts.length,
        contentChars: content.length,
        reasoningChars: reasoning.length,
        finishReason: finish,
        usage,
        streamError,
        chunksWithContent: withContent,
        chunksWithReasoning: withReasoning,
        chunksWithNeither: emptyDelta,
        toolCallChunks: facts.filter((f) => f.hasToolCalls).length,
        refusalChunks: facts.filter((f) => f.hasRefusal).length,
        providerErrorChunks: facts.filter((f) => f.errorField).length,
      },
      null,
      2,
    ),
  );

  console.log('\n── delta shapes (field-name sets, by frequency) ──────');
  [...deltaKeyShapes.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([shape, n]) =>
      console.log(`  ${String(n).padStart(6)}  {${shape}}`),
    );

  console.log('\n── first 3 / last 3 chunks ───────────────────────────');
  [...facts.slice(0, 3), ...facts.slice(-3)].forEach((f) =>
    console.log(`  #${f.i}`, JSON.stringify({ ...f, keys: undefined })),
  );

  const out = join(
    process.env.PROBE_OUT_DIR || process.cwd(),
    'nvidia-stream-facts.json',
  );
  writeFileSync(
    out,
    JSON.stringify(
      { facts: facts.slice(0, 50), tail: facts.slice(-20) },
      null,
      2,
    ),
  );
  console.log(`\nstructural facts written to ${out}`);
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
