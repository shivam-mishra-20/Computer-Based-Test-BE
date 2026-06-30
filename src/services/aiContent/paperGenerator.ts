/**
 * Question paper generation: prompts the generation model for a structured
 * PaperJSON whose shape mirrors models/Paper, so utils/paperExport.buildPaperHtml
 * renders it for both preview and PDF.
 */
import { ai, pickModel } from '../../ai';
import type { ChatMessage } from '../../ai';
import type { PaperJSON, PaperOptions, PaperSection } from './types';

const SYSTEM = `You are an experienced school exam-setter who writes well-structured, curriculum-compliant question papers.
You set questions STRICTLY within the syllabus of the given class, subject and chapter(s) — never above grade level and never out of syllabus.
You ALWAYS respond with a single valid JSON object and nothing else — no markdown, no prose, no code fences.`;

/**
 * Hard syllabus-compliance constraints. These are the most important rules in
 * the prompt, so they are stated first and in strong, imperative language.
 */
function syllabusBlock(opts: PaperOptions, hasSource: boolean): string[] {
  const cls = opts.className || 'the selected class';
  const lines: string[] = [];
  lines.push(`STRICT SYLLABUS COMPLIANCE (highest priority — follow exactly):`);
  lines.push(
    `- Every question MUST fall within the syllabus of ${cls}` +
      (opts.subject ? ` ${opts.subject}` : '') +
      (opts.chapter ? `, limited to the chapter(s)/topic(s): ${opts.chapter}` : '') +
      `.`,
  );
  lines.push(
    `- Do NOT include out-of-syllabus content, topics from higher classes, or competitive/advanced-exam level questions.`,
  );
  lines.push(
    `- Calibrate difficulty, depth, vocabulary and phrasing to a ${cls} student. Keep it age- and grade-appropriate.`,
  );
  if (hasSource) {
    lines.push(
      `- Base questions ONLY on the provided source material below (and the chapter scope above). Do not introduce concepts, facts, or terms that are not present in that material.`,
    );
  }
  lines.push('');
  return lines;
}

function buildPrompt(opts: PaperOptions, sourceText?: string): string {
  const lines: string[] = [];
  lines.push(`Create a question paper as JSON with EXACTLY this schema:`);
  lines.push(`{
  "examTitle": string,
  "subject": string,
  "totalMarks": number,
  "meta": { "durationMins": number },
  "generalInstructions": string[],
  "sections": [
    { "title": string,
      "instructions": string,
      "marksPerQuestion": number,
      "questions": [
        { "text": string,
          "options": [ { "text": string } ],   // include ONLY for MCQ-type questions
          "explanation": string                  // brief answer/solution
        }
      ]
    }
  ]
}`);
  lines.push('');
  lines.push(...syllabusBlock(opts, !!(sourceText && sourceText.trim())));
  lines.push(`Requirements:`);

  // An explicit section plan ("10 MCQs, 5 Short Answer…") takes precedence over
  // the looser questionTypes hint and pins down exact counts/marks per section.
  const spec = (opts.sectionSpec || []).filter(
    (s) => s && s.type && Number(s.count) > 0,
  );
  if (spec.length) {
    lines.push(
      `- Produce EXACTLY ${spec.length} section(s), one per line below, in this order. ` +
        `Each section must contain EXACTLY the stated number of questions of the stated type:`,
    );
    let computedTotal = 0;
    spec.forEach((s, i) => {
      const letter = String.fromCharCode(65 + i); // A, B, C…
      const count = Math.floor(Number(s.count));
      const marksEach = s.marksEach != null ? Number(s.marksEach) : undefined;
      if (marksEach != null) computedTotal += count * marksEach;
      lines.push(
        `  - Section ${letter}: exactly ${count} "${s.type}" question(s)` +
          (marksEach != null
            ? ` worth ${marksEach} mark(s) each (set this section's marksPerQuestion to ${marksEach}).`
            : `.`),
      );
    });
    if (computedTotal > 0)
      lines.push(`- Total marks must sum to ${computedTotal}.`);
    else if (opts.marks)
      lines.push(`- Total marks must sum to ${opts.marks}.`);
    lines.push(
      `- Do NOT add, merge, split, or reorder sections. Do NOT change the question counts.`,
    );
  } else {
    if (opts.marks) lines.push(`- Total marks must sum to ${opts.marks}.`);
    if (opts.questionTypes?.length)
      lines.push(`- Use these question types, grouped into sensible sections: ${opts.questionTypes.join(', ')}.`);
  }

  if (opts.difficulty) {
    const d = opts.difficulty;
    lines.push(
      `- Approximate difficulty mix — easy: ${d.easy ?? 0}%, medium: ${d.medium ?? 0}%, hard: ${d.hard ?? 0}%.`,
    );
  }
  if (opts.subject) lines.push(`- Subject: ${opts.subject}`);
  if (opts.className) lines.push(`- Class/Grade: ${opts.className}`);
  if (opts.board) lines.push(`- Board/Curriculum: ${opts.board}`);
  if (opts.chapter) lines.push(`- Chapter/Topic: ${opts.chapter}`);
  lines.push(`- Language: ${opts.language || 'English'}.`);
  lines.push(`- Provide a concise "explanation" (the answer / 1-2 line solution) for every question — do not pad it.`);
  lines.push(`- Use LaTeX delimited by $...$ for any mathematical notation.`);
  lines.push(`- Output ONLY the JSON object. No markdown, no commentary, no trailing text.`);
  lines.push('');
  if (sourceText && sourceText.trim()) {
    lines.push(`Base the questions on this source material:`);
    lines.push('"""');
    lines.push(sourceText.slice(0, 60_000));
    lines.push('"""');
  } else if (opts.prompt) {
    lines.push(`Topic / instructions from the teacher:`);
    lines.push(opts.prompt);
  }
  return lines.join('\n');
}

type CleanSpec = NonNullable<PaperOptions['sectionSpec']>;

const cleanSpec = (spec?: CleanSpec): CleanSpec =>
  (spec || []).filter((s) => s && s.type && Number(s.count) > 0);

/** Map raw model JSON → PaperSection[] (drops blank questions and empty sections). */
function parseSections(raw: any): PaperSection[] {
  const sectionsIn: any[] = Array.isArray(raw?.sections) ? raw.sections : [];
  return sectionsIn
    .map((sec) => ({
      title: String(sec?.title ?? 'Section').trim(),
      instructions: sec?.instructions ? String(sec.instructions) : undefined,
      marksPerQuestion:
        sec?.marksPerQuestion != null ? Number(sec.marksPerQuestion) : undefined,
      questions: (Array.isArray(sec?.questions) ? sec.questions : [])
        .map((q: any) => ({
          text: String(q?.text ?? '').trim(),
          options: Array.isArray(q?.options)
            ? q.options
                .map((o: any) => ({ text: String(o?.text ?? o ?? '') }))
                .filter((o: any) => o.text)
            : undefined,
          explanation: q?.explanation ? String(q.explanation) : undefined,
        }))
        .filter((q: any) => q.text),
    }))
    .filter((s) => s.questions.length);
}

/**
 * Align produced sections to the requested plan and clamp each to its count.
 * LLMs overshoot ("give 25" → 29), so we never trust the count. Empty sections
 * are KEPT here (so top-up rounds can target a deficit by index); callers drop
 * empties when finalising.
 *  - single spec: flatten all produced questions into one section.
 *  - multi spec: align by order.
 */
function alignToSpec(sections: PaperSection[], spec: CleanSpec): PaperSection[] {
  const clean = cleanSpec(spec);
  if (!clean.length) return sections;

  if (clean.length === 1) {
    const sp = clean[0];
    const all = sections.flatMap((s) => s.questions);
    return [
      {
        title: sections[0]?.title || `${sp.type} Questions`,
        instructions: sections[0]?.instructions,
        marksPerQuestion: sp.marksEach ?? sections[0]?.marksPerQuestion,
        questions: all.slice(0, Math.floor(Number(sp.count))),
      },
    ];
  }

  return clean.map((sp, i) => {
    const src = sections[i];
    return {
      title: src?.title || `${sp.type} Questions`,
      instructions: src?.instructions,
      marksPerQuestion: sp.marksEach ?? src?.marksPerQuestion,
      questions: (src?.questions || []).slice(0, Math.floor(Number(sp.count))),
    } as PaperSection;
  });
}

function sumMarks(sections: PaperSection[]): number {
  return sections.reduce(
    (acc, s) => acc + (Number(s.marksPerQuestion) || 0) * s.questions.length,
    0,
  );
}

const normText = (t: string) =>
  String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Build the final PaperJSON envelope from parsed/finalised sections. */
function finalizePaper(
  raw: any,
  opts: PaperOptions,
  sections: PaperSection[],
  hasSpec: boolean,
): PaperJSON {
  // Total marks: trust the (clamped/topped-up) sections when we have a spec so
  // the header matches the actual paper; otherwise use the model/requested value.
  const specTotal = hasSpec ? sumMarks(sections) : 0;
  const totalMarks =
    specTotal > 0
      ? specTotal
      : raw?.totalMarks != null
        ? Number(raw.totalMarks)
        : opts.marks;

  return {
    examTitle:
      String(raw?.examTitle ?? '').trim() ||
      [opts.subject, opts.chapter].filter(Boolean).join(' — ') ||
      'Question Paper',
    subject: raw?.subject ? String(raw.subject) : opts.subject,
    className: opts.className,
    totalMarks,
    meta: raw?.meta?.durationMins
      ? { durationMins: Number(raw.meta.durationMins) }
      : undefined,
    generalInstructions: Array.isArray(raw?.generalInstructions)
      ? raw.generalInstructions.map((i: any) => String(i)).filter(Boolean)
      : undefined,
    sections,
  };
}

function coercePaper(raw: any, opts: PaperOptions): PaperJSON {
  const parsed = parseSections(raw);
  if (!parsed.length) {
    throw new Error('The model did not return any questions. Try regenerating.');
  }

  const clean = cleanSpec(opts.sectionSpec);
  let sections = parsed;
  if (clean.length) {
    sections = alignToSpec(parsed, clean).filter((s) => s.questions.length);
    if (!sections.length) {
      throw new Error('The model did not return any questions. Try regenerating.');
    }
  }
  return finalizePaper(raw, opts, sections, clean.length > 0);
}

/** One generation call → raw JSON. maxTokens is a ceiling, not a target. */
function callModel(userContent: string, maxTokens: number): Promise<any> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userContent },
  ];
  return ai.chatJSON<any>(messages, {
    model: pickModel('generation'),
    label: 'ai-content-paper',
    maxTokens,
  });
}

/** Prompt for a focused top-up that fills only the missing questions. */
function buildTopUpPrompt(
  opts: PaperOptions,
  sourceText: string | undefined,
  deficits: { sp: CleanSpec[number]; need: number }[],
  current: PaperSection[],
): string {
  const lines: string[] = [];
  lines.push(
    `Generate ADDITIONAL questions to complete a question paper. Respond with a single valid JSON object only:`,
  );
  lines.push(
    `{ "sections": [ { "title": string, "marksPerQuestion": number, "questions": [ { "text": string, "options": [ {"text": string} ], "explanation": string } ] } ] }`,
  );
  lines.push('');
  lines.push(...syllabusBlock(opts, !!(sourceText && sourceText.trim())));
  lines.push(`Produce EXACTLY these additional questions — one section per line, in this order:`);
  deficits.forEach((d, i) => {
    const letter = String.fromCharCode(65 + i);
    lines.push(
      `  - Section ${letter}: ${d.need} more "${d.sp.type}" question(s)` +
        (d.sp.marksEach != null ? ` worth ${d.sp.marksEach} mark(s) each.` : `.`),
    );
  });
  lines.push(
    `- They MUST be DIFFERENT from the existing questions listed below — do not repeat or merely rephrase them.`,
  );
  lines.push(`- Provide a concise "explanation" (answer) for each. Use LaTeX delimited by $...$ for math.`);
  lines.push(`- Output ONLY the JSON object.`);

  const existing = current.flatMap((s) => s.questions.map((q) => q.text)).slice(0, 150);
  if (existing.length) {
    lines.push('');
    lines.push(`Existing questions (do NOT repeat these):`);
    existing.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  if (sourceText && sourceText.trim()) {
    lines.push('');
    lines.push(`Source material:`);
    lines.push('"""');
    lines.push(sourceText.slice(0, 40_000));
    lines.push('"""');
  } else if (opts.prompt) {
    lines.push('');
    lines.push(`Topic / instructions: ${opts.prompt}`);
  }
  return lines.join('\n');
}

// Bounded so a stubborn model can't loop/cost forever; 2 extra rounds is plenty.
const MAX_TOPUP_ROUNDS = 2;

export async function generatePaperJSON(
  opts: PaperOptions,
  sourceText?: string,
): Promise<PaperJSON> {
  const raw = await callModel(buildPrompt(opts, sourceText), 16384);

  const clean = cleanSpec(opts.sectionSpec);
  // No explicit counts requested → nothing to enforce/top-up.
  if (!clean.length) return coercePaper(raw, opts);

  const parsed = parseSections(raw);
  if (!parsed.length) {
    throw new Error('The model did not return any questions. Try regenerating.');
  }

  // Aligned + clamped to the plan (never exceeds counts); empties kept so we can
  // top them up by index.
  const aligned = alignToSpec(parsed, clean);

  for (let round = 0; round < MAX_TOPUP_ROUNDS; round++) {
    const deficits = clean
      .map((sp, i) => ({
        i,
        sp,
        need: Math.floor(Number(sp.count)) - (aligned[i]?.questions.length || 0),
      }))
      .filter((d) => d.need > 0);
    if (!deficits.length) break; // every section is exactly full

    let topRaw: any;
    try {
      topRaw = await callModel(
        buildTopUpPrompt(opts, sourceText, deficits, aligned),
        8192,
      );
    } catch {
      break; // top-up is best-effort — never fail the whole paper over it
    }
    const topSections = parseSections(topRaw);
    if (!topSections.length) break;

    deficits.forEach((d, di) => {
      // Single-section plans flatten everything; multi-section align by order.
      const candidates =
        clean.length === 1
          ? topSections.flatMap((s) => s.questions)
          : topSections[di]?.questions || topSections.flatMap((s) => s.questions);
      const target = aligned[d.i];
      const cap = Math.floor(Number(d.sp.count));
      const seen = new Set(target.questions.map((q) => normText(q.text)));
      for (const q of candidates) {
        if (target.questions.length >= cap) break;
        const key = normText(q.text);
        if (q.text && !seen.has(key)) {
          target.questions.push(q);
          seen.add(key);
        }
      }
    });
  }

  const sections = aligned.filter((s) => s.questions.length > 0);
  if (!sections.length) {
    throw new Error('The model did not return any questions. Try regenerating.');
  }
  return finalizePaper(raw, opts, sections, true);
}
