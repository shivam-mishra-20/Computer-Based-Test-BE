/**
 * Question paper generation: prompts the generation model for a structured
 * PaperJSON whose shape mirrors models/Paper, so utils/paperExport.buildPaperHtml
 * renders it for both preview and PDF.
 */
import { ai, pickModel } from '../../ai';
import type { ChatMessage } from '../../ai';
import type { PaperJSON, PaperOptions, PaperSection } from './types';

const SYSTEM = `You are an experienced exam-setter who writes well-structured question papers.
You ALWAYS respond with a single valid JSON object and nothing else — no markdown, no prose, no code fences.`;

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
  lines.push(`Requirements:`);
  if (opts.marks) lines.push(`- Total marks must sum to ${opts.marks}.`);
  if (opts.questionTypes?.length)
    lines.push(`- Use these question types, grouped into sensible sections: ${opts.questionTypes.join(', ')}.`);
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
  lines.push(`- Provide a brief "explanation" (answer) for every question.`);
  lines.push(`- Use LaTeX delimited by $...$ for any mathematical notation.`);
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

function coercePaper(raw: any, opts: PaperOptions): PaperJSON {
  const sectionsIn: any[] = Array.isArray(raw?.sections) ? raw.sections : [];
  const sections: PaperSection[] = sectionsIn
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

  if (!sections.length) {
    throw new Error('The model did not return any questions. Try regenerating.');
  }

  return {
    examTitle:
      String(raw?.examTitle ?? '').trim() ||
      [opts.subject, opts.chapter].filter(Boolean).join(' — ') ||
      'Question Paper',
    subject: raw?.subject ? String(raw.subject) : opts.subject,
    totalMarks:
      raw?.totalMarks != null ? Number(raw.totalMarks) : opts.marks,
    meta: raw?.meta?.durationMins
      ? { durationMins: Number(raw.meta.durationMins) }
      : undefined,
    generalInstructions: Array.isArray(raw?.generalInstructions)
      ? raw.generalInstructions.map((i: any) => String(i)).filter(Boolean)
      : undefined,
    sections,
  };
}

export async function generatePaperJSON(
  opts: PaperOptions,
  sourceText?: string,
): Promise<PaperJSON> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: buildPrompt(opts, sourceText) },
  ];
  const raw = await ai.chatJSON<any>(messages, {
    model: pickModel('generation'),
    label: 'ai-content-paper',
    maxTokens: 8192,
  });
  return coercePaper(raw, opts);
}
