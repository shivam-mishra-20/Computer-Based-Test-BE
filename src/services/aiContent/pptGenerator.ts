/**
 * PPT generation: builds a strict-JSON prompt for the generation model and
 * returns a structured SlideDeck. The deck is then rendered to a real .pptx by
 * pptxRenderer — the AI never produces binary PPT.
 */
import { ai, pickModel } from '../../ai';
import type { ChatMessage } from '../../ai';
import type { PptOptions, Slide, SlideDeck } from './types';

const SYSTEM = `You are an expert instructional designer who builds clear, classroom-ready lecture slide decks.
You ALWAYS respond with a single valid JSON object and nothing else — no markdown, no prose, no code fences.`;

function buildPrompt(opts: PptOptions, sourceText?: string): string {
  const n = Math.min(Math.max(Number(opts.numSlides) || 8, 3), 30);
  const lines: string[] = [];
  lines.push(
    `Create a lecture presentation as JSON with EXACTLY this schema:`,
  );
  lines.push(`{
  "title": string,
  "subtitle": string,
  "slides": [
    { "layout": "title"|"content"|"objectives"|"quiz"|"summary",
      "title": string,
      "bullets": string[],            // 3-6 concise points for content/summary/objectives
      "notes": string,                // short speaker notes (optional)
      "quiz": [ { "question": string, "options": string[], "answer": string } ] // only for layout "quiz"
    }
  ]
}`);
  lines.push('');
  lines.push(`Requirements:`);
  lines.push(`- Produce about ${n} slides total.`);
  lines.push(`- The FIRST slide must be layout "title".`);
  if (opts.includeObjectives)
    lines.push(`- Include one "objectives" slide near the start (Learning Objectives).`);
  if (opts.includeQuiz)
    lines.push(`- Include 1-2 "quiz" slides with 3-4 MCQ options each and the correct answer.`);
  if (opts.includeSummary)
    lines.push(`- The LAST slide must be layout "summary".`);
  lines.push(`- Keep bullets short (max ~14 words). Avoid full paragraphs.`);
  if (opts.subject) lines.push(`- Subject: ${opts.subject}`);
  if (opts.className) lines.push(`- Class/Grade: ${opts.className}`);
  if (opts.board) lines.push(`- Board/Curriculum: ${opts.board}`);
  if (opts.chapter) lines.push(`- Chapter/Topic: ${opts.chapter}`);
  if (opts.audience) lines.push(`- Audience: ${opts.audience}`);
  if (opts.style) lines.push(`- Presentation style/tone: ${opts.style}`);
  lines.push(`- Language: ${opts.language || 'English'}.`);
  lines.push(
    `- Use LaTeX delimited by $...$ for any mathematical or scientific notation.`,
  );
  lines.push('');
  if (sourceText && sourceText.trim()) {
    lines.push(`Base the content on this source material:`);
    lines.push('"""');
    lines.push(sourceText.slice(0, 60_000));
    lines.push('"""');
  } else if (opts.prompt) {
    lines.push(`Topic / instructions from the teacher:`);
    lines.push(opts.prompt);
  }
  return lines.join('\n');
}

function coerceDeck(raw: any, opts: PptOptions): SlideDeck {
  const slidesIn: any[] = Array.isArray(raw?.slides) ? raw.slides : [];
  const slides: Slide[] = slidesIn
    .map((s) => {
      const layout = ['title', 'content', 'objectives', 'quiz', 'summary'].includes(
        s?.layout,
      )
        ? s.layout
        : 'content';
      const slide: Slide = {
        layout,
        title: String(s?.title ?? '').trim() || 'Slide',
      };
      if (Array.isArray(s?.bullets))
        slide.bullets = s.bullets.map((b: any) => String(b)).filter(Boolean);
      if (s?.notes) slide.notes = String(s.notes);
      if (Array.isArray(s?.quiz)) {
        slide.quiz = s.quiz
          .map((q: any) => ({
            question: String(q?.question ?? '').trim(),
            options: Array.isArray(q?.options)
              ? q.options.map((o: any) => String(o))
              : undefined,
            answer: q?.answer != null ? String(q.answer) : undefined,
          }))
          .filter((q: any) => q.question);
      }
      return slide;
    })
    .filter((s) => s.title);

  if (!slides.length) {
    throw new Error('The model did not return any slides. Try regenerating.');
  }

  return {
    title:
      String(raw?.title ?? '').trim() ||
      opts.chapter ||
      opts.subject ||
      'Lecture',
    subtitle: raw?.subtitle ? String(raw.subtitle) : undefined,
    theme: opts.theme,
    slides,
  };
}

export async function generateSlideDeck(
  opts: PptOptions,
  sourceText?: string,
): Promise<SlideDeck> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: buildPrompt(opts, sourceText) },
  ];
  const raw = await ai.chatJSON<any>(messages, {
    model: pickModel('generation'),
    label: 'ai-content-ppt',
    maxTokens: 8192,
  });
  return coerceDeck(raw, opts);
}
