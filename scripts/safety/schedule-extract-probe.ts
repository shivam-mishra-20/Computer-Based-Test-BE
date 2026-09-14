/**
 * Live probe: what does the REAL vision model return for the REAL fixture?
 *
 * Diagnosis-only. Calls NVIDIA exactly as the route does, prints the image
 * measurements and the RAW response, and writes the response to the scratchpad
 * for inspection. Touches no database and no storage.
 *
 *   npx ts-node --transpile-only scripts/safety/schedule-extract-probe.ts [path/to/image.png]
 */

// The model's response has no static shape — reading it is the whole point.
/* eslint-disable @typescript-eslint/no-explicit-any */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ai, aiConfig } from '../../src/ai';
import {
  prepareScheduleImageForVision,
  visionImageDiagnostics,
} from '../../src/services/schedule/scheduleImagePrep';
import {
  SCHEDULE_SCHEMA_EXAMPLE,
  detectTemplateEcho,
} from '../../src/services/schedule/scheduleExtractionContract';

// The prompt the route uses today, copied verbatim so the probe measures the
// shipped behaviour rather than a paraphrase of it.
const CURRENT_PROMPT = `You are a STRICT TRANSCRIBER of a photographed DAILY CLASS SCHEDULE (timetable). Transcribe exactly what is printed. Never invent, guess, compute, or normalize anything.

TABLE STRUCTURE:
- The image may contain MULTIPLE STACKED TIMETABLE SECTIONS, each with its OWN column headers. Never reuse one section's columns for another.
- Columns are TIME-SLOT headers (e.g. "3:30-4:30PM"). Rows are CLASS/BATCH labels (e.g. "8th adv", "9th JEE", "11th JEE B1", "7th").
- A cell is the intersection of one row and one column. Transcribe a cell ONLY if it has visible text. Blank cells produce NOTHING.

PER CELL: transcribe the literal visible text verbatim on a SINGLE LINE, joining multiple lines with one space.

DATE: find the date printed once. Source format DD-MM-YYYY; output ISO YYYY-MM-DD.

Return ONLY this raw JSON object, plain JSON (do NOT backslash-escape quotes), no markdown, no commentary:
{"scheduleDate":"YYYY-MM-DD","sections":[{"columns":["3:30-4:30PM"],"rows":["9th JEE"],"cells":[{"row":"9th JEE","column":"3:30-4:30PM","rawText":"Archit sir 4"}]}],"warnings":[]}

Rules:
- Each cell's "row"/"column" must copy EXACTLY a string from that section's own "rows"/"columns" arrays.
- List every populated cell once. Never list a blank cell or duplicate an intersection.`;

/** The same prompt with the placeholder example — what ships after the fix. */
const FIXED_PROMPT = CURRENT_PROMPT.replace(
  /\{"scheduleDate":"YYYY-MM-DD".*?"warnings":\[\]\}/s,
  SCHEDULE_SCHEMA_EXAMPLE,
).replace(
  'no markdown, no commentary:',
  'no markdown, no commentary. The angle-bracketed values are SLOTS — replace every one with text you actually read in the image, and never output a slot:',
);

async function main() {
  const useFixed = process.argv.includes('--fixed');
  const fixturePath =
    process.argv.find((a) => a.endsWith('.png') || a.endsWith('.jpg')) ||
    join(__dirname, 'fixtures', 'schedule-two-grid.png');

  const bytes = readFileSync(fixturePath);
  const prepared = await prepareScheduleImageForVision(bytes);

  console.log(
    '\n── image handed to the model ────────────────────────────────',
  );
  console.log(JSON.stringify(visionImageDiagnostics(prepared), null, 2));

  console.log(
    '\n── model ────────────────────────────────────────────────────',
  );
  console.log('  model:', aiConfig.nvidia.scheduleVisionModel);

  const started = Date.now();
  console.log(
    '  prompt:',
    useFixed ? 'FIXED (placeholder example)' : 'CURRENT (worked example)',
  );

  const res = await ai.vision(
    useFixed ? FIXED_PROMPT : CURRENT_PROMPT,
    [{ data: prepared.buffer, mimeType: prepared.mimeType }],
    {
      model: aiConfig.nvidia.scheduleVisionModel,
      maxTokens: 6000,
      temperature: 0,
      json: true,
      reasoning: 'off',
      maxDurationMs: 150000,
      maxOutputChars: 24000,
      maxStreamChunks: 14000,
      label: 'schedule-probe',
    },
  );
  const elapsed = Date.now() - started;

  const text = res.text || '';
  console.log(
    '\n── raw response ─────────────────────────────────────────────',
  );
  console.log(
    JSON.stringify(
      {
        elapsedMs: elapsed,
        length: text.length,
        finishReason: res.finishReason,
        completionTokens: res.usage?.completionTokens,
        streamChunks: res.streamChunks,
      },
      null,
      2,
    ),
  );

  const out = join(
    process.env.PROBE_OUT_DIR || process.cwd(),
    'schedule-probe-response.json',
  );
  writeFileSync(out, text);
  console.log(`  full response written to ${out}`);

  console.log(
    '\n── structure ────────────────────────────────────────────────',
  );
  try {
    const parsed = JSON.parse(text);
    const sections = Array.isArray(parsed?.sections) ? parsed.sections : [];
    console.log(`  scheduleDate: ${parsed?.scheduleDate}`);
    console.log(`  sections:     ${sections.length}`);
    sections.forEach((s: any, i: number) => {
      console.log(
        `    [${i}] rows=${(s?.rows || []).length} columns=${(s?.columns || []).length} cells=${(s?.cells || []).length}`,
      );
    });
    const allCells = sections.flatMap((s: any) => s?.cells || []);
    console.log(`  total cells:  ${allCells.length}`);
    console.log('  first 5 cells:');
    allCells
      .slice(0, 5)
      .forEach((c: any) => console.log(`    ${JSON.stringify(c)}`));

    // The specific question this whole investigation turns on.
    const echo = allCells.find(
      (c: any) =>
        String(c?.rawText || '')
          .trim()
          .toLowerCase() === 'archit sir 4',
    );
    console.log(
      `\n  >>> response contains the PROMPT EXAMPLE cell ("Archit sir 4"): ${Boolean(echo)}`,
    );
    const truth = allCells.find(
      (c: any) =>
        /9th\s*jee/i.test(String(c?.row || '')) &&
        /3[:.]30\s*-\s*4[:.]30/i.test(String(c?.column || '')),
    );
    console.log(
      `  >>> 9th JEE / 3:30-4:30 cell: ${truth ? JSON.stringify(truth) : 'ABSENT'}`,
    );
    console.log(
      `  >>> template-echo verdict: ${detectTemplateEcho(parsed) ?? 'none (accepted)'}`,
    );
  } catch (e) {
    console.log('  response is not parseable JSON:', (e as Error).message);
    console.log('  head:', text.slice(0, 400));
  }
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
