import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import type { Types } from 'mongoose';
import type { Difficulty, IQuestion, QuestionType } from '../models/Question';
import Guidance from '../models/Guidance';

dotenv.config();

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Lazy singletons
let genAI: GoogleGenerativeAI | null = null;
let groqClient: Groq | null = null;

function getGemini() {
  if (!GOOGLE_API_KEY) return null;
  if (!genAI) genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
  return genAI;
}

function getGroq() {
  if (!GROQ_API_KEY) return null;
  if (!groqClient) groqClient = new Groq({ apiKey: GROQ_API_KEY });
  return groqClient;
}

export type GenerateOptions = {
  subject?: string;
  topic?: string;
  difficulty?: Difficulty;
  count?: number; // number of questions to generate
  types?: QuestionType[]; // preferred types
  createdBy?: Types.ObjectId;
};

export interface PaperBlueprintSection {
  title: string; // e.g., 'Section A'
  instructions?: string;
  marksPerQuestion?: number;
  questionCounts: Partial<Record<QuestionType, number>>; // counts per type
  difficultyDistribution?: { easy?: number; medium?: number; hard?: number }; // percentages summing ~100
}

export interface PaperBlueprint {
  subject?: string;
  examTitle: string;
  totalMarks?: number; // optional; can be computed
  generalInstructions?: string[];
  sections: PaperBlueprintSection[];
}

export interface GeneratedPaperSection extends PaperBlueprintSection {
  questions: Partial<IQuestion>[];
}

export interface GeneratedPaperResult {
  examTitle: string;
  subject?: string;
  totalMarks: number;
  generalInstructions: string[];
  sections: GeneratedPaperSection[];
}

export async function generateSolutionsForPaper(paper: GeneratedPaperResult): Promise<{
  sections: { title: string; solutions: { solutionText: string }[] }[];
}> {
  const g = getGemini();
  if (!g) throw new Error('Gemini API key not configured');
  const model = g.getGenerativeModel({ model: 'gemini-2.5-pro' });
  const sections: { title: string; solutions: { solutionText: string }[] }[] = [];
  for (const sec of paper.sections) {
    const questionsText = sec.questions
      .map((q, i) => {
        const base = `${i + 1}. ${q.text}`;
        if (q.type === 'mcq' && Array.isArray(q.options)) {
          const opts = q.options
            .map((o, idx) => `${String.fromCharCode(65 + idx)}. ${o.text}`)
            .join('\n');
          return `${base}\n${opts}`;
        }
        if (q.type === 'assertionreason') {
          return `${base}\nAssertion: ${q.assertion}\nReason: ${q.reason}`;
        }
        return base;
      })
      .join('\n\n');
    const prompt = `Provide concise, step-by-step model solutions for the following exam questions. Keep each solution focused, accurate, and avoid unnecessary verbosity. Where relevant, show key formulas or reasoning. Return STRICT JSON ONLY with schema: { "solutions": [{ "solutionText": string }] } and ensure the number of solutions equals the number of questions in order.
Exam: ${paper.examTitle} ${paper.subject ? `\nSubject: ${paper.subject}` : ''}
Section: ${sec.title}${sec.instructions ? `\nInstructions: ${sec.instructions}` : ''}

QUESTIONS:\n${questionsText}`;
    const result = await model.generateContent(prompt);
    const raw = result.response.text();
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('Failed to parse solutions JSON');
      parsed = JSON.parse(m[0]);
    }
    const sols = Array.isArray(parsed?.solutions)
      ? parsed.solutions.map((s: any) => ({ solutionText: String(s.solutionText || '').slice(0, 4000) }))
      : [];
    // if model returned wrong count, pad or trim
    const count = sec.questions.length;
    let adjusted = sols.slice(0, count);
    if (adjusted.length < count) {
      adjusted = adjusted.concat(Array.from({ length: count - adjusted.length }, () => ({ solutionText: 'Solution forthcoming.' })));
    }
    sections.push({ title: sec.title, solutions: adjusted });
  }
  return { sections };
}

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  // Prefer light-weight local parsing to avoid file upload API setup.
  // If pdf-parse is not available at runtime, fail gracefully.
  try {
    // dynamic import to keep types happy without needing @types
    const pdfParse = (await import('pdf-parse')).default as any;
    const data = await pdfParse(buffer);
    return String(data.text || '').slice(0, 200_000); // cap to 200k chars
  } catch (err) {
    console.warn('pdf-parse not available or failed:', err);
    throw new Error('PDF parsing failed. Ensure pdf-parse is installed.');
  }
}

// OCR: extract text from images (PNG/JPG) using tesseract.js
export async function extractTextFromImage(buffer: Buffer): Promise<string> {
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng');
    try {
      const { data } = await worker.recognize(buffer as any);
      await worker.terminate();
      return String(data?.text || '').slice(0, 200_000);
    } catch (e) {
      try { await worker.terminate(); } catch {}
      throw e;
    }
  } catch (err) {
    console.warn('tesseract.js OCR failed or not installed:', err);
    throw new Error('OCR failed. Ensure tesseract.js is installed.');
  }
}

export async function getGuidanceText(subject?: string, topic?: string): Promise<string | null> {
  const queries: any[] = [];
  if (subject && topic) queries.push({ subject, topic, isActive: true });
  if (subject) queries.push({ subject, isActive: true });
  queries.push({ isActive: true });
  for (const q of queries) {
    const g = await Guidance.findOne(q).sort({ updatedAt: -1 }).lean();
    if (g?.instructions) return String(g.instructions);
  }
  return null;
}

function buildQuestionGenPrompt(text: string, opts: GenerateOptions) {
  const count = Math.min(Math.max(opts.count ?? 10, 1), 50);
  const types = opts.types?.join(', ') || 'mcq, truefalse, fill, short, long, assertionreason, integer';
  const difficulty = opts.difficulty ?? 'medium';
  const subject = opts.subject ? `Subject: ${opts.subject}\n` : '';
  const topic = opts.topic ? `Topic: ${opts.topic}\n` : '';
  return `You are an expert exam setter. Read the following study material and generate ${count} high-quality exam questions.
${subject}${topic}Difficulty: ${difficulty}
Allowed types: ${types}

Return STRICT JSON with this schema:
{
  "questions": [
    {
      "text": string,
      "type": "mcq"|"truefalse"|"fill"|"short"|"long"|"assertionreason"|"integer",
      "options": [{ "text": string, "isCorrect": boolean }] | null,
      "correctAnswerText": string | null,
      "integerAnswer": number | null,
      "assertion": string | null,
      "reason": string | null,
      "assertionIsTrue": boolean | null,
      "reasonIsTrue": boolean | null,
      "reasonExplainsAssertion": boolean | null,
      "tags": { "subject"?: string, "topic"?: string, "difficulty"?: "easy"|"medium"|"hard" },
      "explanation": string | null
    }
  ]
}

Ensure MCQs include 4 options with exactly one correct. For true/false, options can be omitted and correctAnswerText should be "true" or "false". For fill/short/long, provide correctAnswerText with keywords or a reference answer. For integer include integerAnswer & correctAnswerText (string). For assertionreason provide assertion, reason and boolean flags. Do not include markdown, only raw JSON.

ADMIN GUIDANCE (if any) to follow strictly:
${(opts as any).__guidance || 'N/A'}

Study material:
"""
${text}
"""`;
}

function buildPaperGenPrompt(source: string, blueprint: PaperBlueprint) {
  const subject = blueprint.subject ? `Subject: ${blueprint.subject}` : '';
  const instructionsList = (blueprint.generalInstructions || [
    'All questions are compulsory unless specified.',
    'Read each question carefully and allocate time wisely.',
  ]).slice(0, 12);
  const sections = blueprint.sections
    .map((s, idx) => {
      const diff = s.difficultyDistribution || {};
      const diffLine = diff ? `Difficulty% (approx): easy:${diff.easy ?? 0}, medium:${diff.medium ?? 0}, hard:${diff.hard ?? 0}` : '';
      return `Section ${idx + 1}: ${s.title}
Instructions: ${s.instructions || 'N/A'}
MarksPerQuestion: ${s.marksPerQuestion || 'variable'}
QuestionCounts: ${JSON.stringify(s.questionCounts)}
${diffLine}`;
    })
    .join('\n\n');
  return `You are an expert exam paper setter tasked with generating a professional, well-structured question paper similar in style to national competitive exams (e.g., JEE / NEET) based ONLY on the provided study material.

${subject}
Exam Title: ${blueprint.examTitle}

GLOBAL INSTRUCTIONS (include & refine, keep concise):
${instructionsList.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

SECTIONS BLUEPRINT:
${sections}

QUESTION TYPE DEFINITIONS:
mcq: Multiple Choice with 4 options exactly and one correct.
truefalse: Statement with answer true or false.
fill: Fill in the blank (provide answer keywords in correctAnswerText).
short: Short answer (2-4 lines reference answer in correctAnswerText).
long: Long/Descriptive (concise model answer in correctAnswerText; may include key points only).
assertionreason: Provide 'assertion' and 'reason'. Also boolean flags assertionIsTrue, reasonIsTrue, reasonExplainsAssertion. Provide combined explanation.
integer: Single correct integer value answer (store in integerAnswer AND also string in correctAnswerText for redundancy).

Return STRICT JSON ONLY with this schema (no extra commentary):
{
  "examTitle": string,
  "subject": string | null,
  "generalInstructions": string[],
  "sections": [
    {
      "title": string,
      "instructions": string | null,
      "marksPerQuestion": number | null,
      "questions": [
        {
          "text": string,
          "type": "mcq"|"truefalse"|"fill"|"short"|"long"|"assertionreason"|"integer",
          "options": [{"text": string, "isCorrect": boolean}] | null,
          "correctAnswerText": string | null,
          "integerAnswer": number | null,
          "assertion": string | null,
          "reason": string | null,
          "assertionIsTrue": boolean | null,
          "reasonIsTrue": boolean | null,
          "reasonExplainsAssertion": boolean | null,
          "tags": {"difficulty": "easy"|"medium"|"hard"},
          "explanation": string | null
        }
      ]
    }
  ]
}

ADMIN GUIDANCE (if any) to follow strictly:
${(blueprint as any).__guidance || 'N/A'}

Rules:
- Respect requested counts per type; if insufficient material, approximate & note in explanation.
- Maintain difficulty distribution per section within reasonable bounds.
- Keep each question concise and unambiguous.
- Do NOT fabricate figures or overly niche trivia absent from source.
- MCQ distractors must be plausible.
- Output valid JSON only (no backticks, no markdown).

SOURCE MATERIAL (truncate if huge):\n"""\n${source.slice(0, 120_000)}\n"""`;
}

export async function generatePaperFromTextGemini(source: string, blueprint: PaperBlueprint): Promise<GeneratedPaperResult> {
  const g = getGemini();
  if (!g) throw new Error('Gemini API key not configured');
  const model = g.getGenerativeModel({ model: 'gemini-2.5-pro' });
  const prompt = buildPaperGenPrompt(source, blueprint);
  const result = await model.generateContent(prompt);
  const raw = result.response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Failed to parse paper JSON');
    parsed = JSON.parse(match[0]);
  }
  if (!parsed.sections || !Array.isArray(parsed.sections)) throw new Error('Malformed paper JSON');
  const sections: GeneratedPaperSection[] = parsed.sections.map((s: any) => {
    const questions: Partial<IQuestion>[] = Array.isArray(s.questions)
      ? s.questions.map((q: any) => ({
          text: String(q.text || '').trim(),
          type: (['mcq','truefalse','fill','short','long','assertionreason','integer'].includes(q.type) ? q.type : 'mcq') as QuestionType,
          options: Array.isArray(q.options)
            ? q.options.slice(0, 6).map((o: any) => ({ text: String(o.text || ''), isCorrect: !!o.isCorrect }))
            : undefined,
          correctAnswerText: q.correctAnswerText ? String(q.correctAnswerText) : undefined,
          integerAnswer: q.integerAnswer !== undefined ? Number(q.integerAnswer) : undefined,
          assertion: q.assertion ? String(q.assertion) : undefined,
          reason: q.reason ? String(q.reason) : undefined,
            assertionIsTrue: typeof q.assertionIsTrue === 'boolean' ? q.assertionIsTrue : undefined,
            reasonIsTrue: typeof q.reasonIsTrue === 'boolean' ? q.reasonIsTrue : undefined,
            reasonExplainsAssertion: typeof q.reasonExplainsAssertion === 'boolean' ? q.reasonExplainsAssertion : undefined,
          tags: { difficulty: (q.tags?.difficulty as Difficulty) || 'medium' },
          explanation: q.explanation ? String(q.explanation) : undefined,
        }))
      : [];
    return {
      title: String(s.title || 'Section'),
      instructions: s.instructions ? String(s.instructions) : undefined,
      marksPerQuestion: s.marksPerQuestion ? Number(s.marksPerQuestion) : undefined,
      questionCounts: {},
      questions,
    } as GeneratedPaperSection;
  });
  const totalMarks = sections.reduce((sum, sec) => sum + sec.questions.length * (sec.marksPerQuestion || 1), 0);
  return {
    examTitle: parsed.examTitle || blueprint.examTitle,
    subject: parsed.subject || blueprint.subject,
    totalMarks,
    generalInstructions: Array.isArray(parsed.generalInstructions) ? parsed.generalInstructions.map((x: any) => String(x)).slice(0, 25) : [],
    sections,
  };
}

// Enforce the blueprint by topping up missing questions per section and type.
async function enforceBlueprintOnSections(
  source: string,
  blueprint: PaperBlueprint,
  initial: GeneratedPaperSection[],
  guidance?: string | null,
): Promise<GeneratedPaperSection[]> {
  const sections: GeneratedPaperSection[] = [];
  // Support English-specific pseudo types
  const englishMap = (key: string): { baseType: QuestionType; formatHint?: string } => {
    switch (key) {
      case 'english:letter-formal':
        return { baseType: 'long', formatHint: 'Formal letter format: sender address, date, receiver address, subject, salutation, body (3-4 paragraphs), complimentary close, signature.' };
      case 'english:letter-informal':
        return { baseType: 'long', formatHint: 'Informal letter format: date, salutation, conversational body (2-3 paragraphs), closing and name.' };
      case 'english:story':
        return { baseType: 'long', formatHint: 'Story writing: clear plot with beginning, conflict, resolution; maintain tense consistency; include title.' };
      case 'english:essay':
        return { baseType: 'long', formatHint: 'Essay writing: introduction, 2-3 body paragraphs, conclusion; maintain coherence and word limit guidance if provided.' };
      case 'english:diary':
        return { baseType: 'short', formatHint: 'Diary entry: date/day, salutation (optional), body in first person reflecting feelings/events, closing/signature.' };
      case 'english:advertisement':
        return { baseType: 'short', formatHint: 'Advertisement: catchy headline, body with key details (what, where, when, contact), concise; use persuasive language.' };
      case 'english:notice':
        return { baseType: 'short', formatHint: 'Notice writing: heading NOTICE, date, subject, body with essential information (what, when, where), signature/name/designation.' };
      case 'english:unseen-passage':
        return { baseType: 'short', formatHint: 'Unseen passage comprehension: include a short passage (4-6 lines) within the question text and ask a question requiring a brief answer.' };
      case 'english:unseen-poem':
        return { baseType: 'short', formatHint: 'Unseen poem comprehension: include a short 3-5 line poem within the question text and ask a question on theme or literary device requiring a brief answer.' };
      default:
        return { baseType: 'long' } as any;
    }
  };

  for (let sIdx = 0; sIdx < blueprint.sections.length; sIdx++) {
    const bp = blueprint.sections[sIdx];
    const current = initial[sIdx] || ({ title: bp.title, instructions: bp.instructions, marksPerQuestion: bp.marksPerQuestion, questionCounts: {}, difficultyDistribution: bp.difficultyDistribution, questions: [] } as GeneratedPaperSection);

    const requestedKeys = Object.keys(bp.questionCounts || {});
    let kept = (current.questions || []).slice();
    const haveByKey: Record<string, number> = {};
    for (const key of requestedKeys) {
      if (key.startsWith('english:')) haveByKey[key] = 0; else haveByKey[key] = kept.filter((q) => String(q.type) === key).length;
    }

    const diff = bp.difficultyDistribution || { easy: 0, medium: 100, hard: 0 };
    const diffParts: Array<{ key: Difficulty; pct: number }> = [
      { key: 'easy', pct: Math.max(0, Number(diff.easy ?? 0)) },
      { key: 'medium', pct: Math.max(0, Number(diff.medium ?? 0)) },
      { key: 'hard', pct: Math.max(0, Number(diff.hard ?? 0)) },
    ];
    const pctSum = diffParts.reduce((a, b) => a + b.pct, 0) || 1;

    const groupedByKey: Record<string, Partial<IQuestion>[]> = {};
    for (const key of requestedKeys) groupedByKey[key] = [];
    // Seed with existing for standard types
    for (const key of requestedKeys) {
      if (!key.startsWith('english:')) groupedByKey[key] = kept.filter((q) => String(q.type) === key);
    }

    for (const key of requestedKeys) {
      const desired = Math.max(0, Number((bp.questionCounts as any)[key] || 0));
      const have = haveByKey[key] || 0;
      let missing = desired - have;
      if (missing <= 0) continue;
      const alloc: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0 };
      let acc = 0;
      for (let i = 0; i < diffParts.length; i++) {
        const p = diffParts[i];
        let count = Math.floor((p.pct / pctSum) * missing);
        if (i === diffParts.length - 1) count = missing - acc;
        alloc[p.key] = count as any;
        acc += count;
      }
      for (const d of ['easy', 'medium', 'hard'] as Difficulty[]) {
        const need = alloc[d];
        if (need <= 0) continue;
        const { baseType, formatHint } = key.startsWith('english:') ? englishMap(key) : ({ baseType: key } as any);
        const extraGuidance = formatHint ? `\nENGLISH FORMAT: ${formatHint}` : '';
        const gen = await generateQuestionsFromTextGemini(source || `${blueprint.subject || ''} ${bp.title || ''}`.trim(), {
          subject: blueprint.subject,
          topic: bp.title,
          difficulty: d,
          count: need,
          types: [baseType],
          createdBy: undefined as any,
          __guidance: ((guidance || '') + extraGuidance) as any,
        } as any);
        const normalized = gen.map((q) => {
          if (q.type === 'mcq' && Array.isArray(q.options)) {
            const firstCorrectIdx = q.options.findIndex((o) => o.isCorrect);
            let opts = q.options.map((o) => ({ text: String(o.text || ''), isCorrect: !!o.isCorrect })).slice(0, 4);
            const correctCount = opts.filter((o) => o.isCorrect).length;
            while (opts.length < 4) opts.push({ text: 'None of the above', isCorrect: false });
            if (correctCount !== 1) opts = opts.map((o, idx) => ({ ...o, isCorrect: idx === (firstCorrectIdx >= 0 ? Math.min(firstCorrectIdx, 3) : 0) }));
            return { ...q, type: baseType, options: opts as any };
          }
          return { ...q, type: baseType };
        });
        groupedByKey[key] = groupedByKey[key].concat(normalized as any);
      }
    }

    const balanced: Partial<IQuestion>[] = [];
    for (const key of requestedKeys) {
      const desired = Math.max(0, Number((bp.questionCounts as any)[key] || 0));
      balanced.push(...(groupedByKey[key] || []).slice(0, desired));
    }

    sections.push({
      title: bp.title,
      instructions: bp.instructions,
      marksPerQuestion: bp.marksPerQuestion,
      questionCounts: bp.questionCounts,
      difficultyDistribution: bp.difficultyDistribution,
      questions: balanced,
    });
  }
  return sections;
}

export async function generatePaperFromTextEnforced(source: string, blueprint: PaperBlueprint): Promise<GeneratedPaperResult> {
  // Initial attempt using structured paper generation
  const g = getGemini();
  if (!g) throw new Error('Gemini API key not configured');
  const guidance = await getGuidanceText(blueprint.subject, undefined);
  let initial: GeneratedPaperResult;
  try {
    initial = await generatePaperFromTextGemini(source, { ...(blueprint as any), __guidance: guidance } as any);
  } catch {
    // If the structured generation fails, seed with empty sections and we will top up strictly
    initial = {
      examTitle: blueprint.examTitle,
      subject: blueprint.subject,
      totalMarks: 0,
      generalInstructions: blueprint.generalInstructions || [],
      sections: blueprint.sections.map((s) => ({
        title: s.title,
        instructions: s.instructions,
        marksPerQuestion: s.marksPerQuestion,
        questionCounts: s.questionCounts,
        difficultyDistribution: s.difficultyDistribution,
        questions: [],
      })),
    };
  }

  // Strictly enforce counts/types by topping up
  const enforcedSections = await enforceBlueprintOnSections(source, blueprint, initial.sections, guidance);
  const totalMarks = enforcedSections.reduce((sum, sec) => sum + (sec.marksPerQuestion || 0) * (sec.questions?.length || 0), 0);
  return {
    examTitle: initial.examTitle || blueprint.examTitle,
    subject: initial.subject || blueprint.subject,
    totalMarks,
    generalInstructions: initial.generalInstructions?.length ? initial.generalInstructions : (blueprint.generalInstructions || []),
    sections: enforcedSections,
  };
}

export async function refineQuestionGemini(original: Partial<IQuestion> & { notes?: string; desiredDifficulty?: Difficulty; constraints?: string }): Promise<Partial<IQuestion>> {
  const g = getGemini();
  if (!g) throw new Error('Gemini API key not configured');
  const model = g.getGenerativeModel({ model: 'gemini-2.5-pro' });
  const prompt = `Refine the following question maintaining its core concept. Apply improvements: clarity, difficulty targeting, remove ambiguity. If MCQ ensure exactly 4 options & one correct. If assertionreason, maintain structure & booleans. Return ONLY JSON with schema { "text": string, "type": string, "options": [{"text":string,"isCorrect":boolean}]|null, "correctAnswerText": string|null, "integerAnswer": number|null, "assertion": string|null, "reason": string|null, "assertionIsTrue": boolean|null, "reasonIsTrue": boolean|null, "reasonExplainsAssertion": boolean|null, "explanation": string|null }.
Original JSON:
${JSON.stringify(original)}
DesiredDifficulty: ${original.desiredDifficulty || 'unchanged'}
ExtraConstraints: ${original.constraints || 'none'}
Notes: ${original.notes || 'none'}
`; 
  const result = await model.generateContent(prompt);
  const raw = result.response.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); if (!m) throw new Error('Failed to parse refined question'); parsed = JSON.parse(m[0]); }
  return {
    text: String(parsed.text || original.text || '').trim(),
    type: (['mcq','truefalse','fill','short','long','assertionreason','integer'].includes(parsed.type) ? parsed.type : original.type) as QuestionType,
    options: Array.isArray(parsed.options) ? parsed.options.slice(0, 6).map((o: any) => ({ text: String(o.text||''), isCorrect: !!o.isCorrect })) : undefined,
    correctAnswerText: parsed.correctAnswerText ? String(parsed.correctAnswerText) : original.correctAnswerText,
    integerAnswer: parsed.integerAnswer !== undefined ? Number(parsed.integerAnswer) : original.integerAnswer,
    assertion: parsed.assertion ? String(parsed.assertion) : original.assertion,
    reason: parsed.reason ? String(parsed.reason) : original.reason,
    assertionIsTrue: typeof parsed.assertionIsTrue === 'boolean' ? parsed.assertionIsTrue : original.assertionIsTrue,
    reasonIsTrue: typeof parsed.reasonIsTrue === 'boolean' ? parsed.reasonIsTrue : original.reasonIsTrue,
    reasonExplainsAssertion: typeof parsed.reasonExplainsAssertion === 'boolean' ? parsed.reasonExplainsAssertion : original.reasonExplainsAssertion,
    explanation: parsed.explanation ? String(parsed.explanation) : original.explanation,
  };
}

export async function generateQuestionsFromTextGemini(text: string, opts: GenerateOptions): Promise<Partial<IQuestion>[]> {
  const g = getGemini();
  if (!g) throw new Error('Gemini API key not configured');
  const model = g.getGenerativeModel({ model: 'gemini-2.5-pro' });
  const prompt = buildQuestionGenPrompt(text, opts);
  const result = await model.generateContent(prompt);
  const raw = result.response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to salvage JSON from code fences if present
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Failed to parse model output as JSON');
    parsed = JSON.parse(match[0]);
  }
  const items = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const normalized: Partial<IQuestion>[] = items.map((q: any) => ({
    text: String(q.text || '').trim(),
    type: ['mcq', 'truefalse', 'fill', 'short', 'long', 'assertionreason', 'integer'].includes(q.type) ? q.type : 'mcq',
    options: Array.isArray(q.options)
      ? q.options.map((o: any) => ({ text: String(o.text || ''), isCorrect: !!o.isCorrect }))
      : undefined,
    correctAnswerText: q.correctAnswerText ? String(q.correctAnswerText) : undefined,
    integerAnswer: q.integerAnswer !== undefined ? Number(q.integerAnswer) : undefined,
    assertion: q.assertion ? String(q.assertion) : undefined,
    reason: q.reason ? String(q.reason) : undefined,
    assertionIsTrue: typeof q.assertionIsTrue === 'boolean' ? q.assertionIsTrue : undefined,
    reasonIsTrue: typeof q.reasonIsTrue === 'boolean' ? q.reasonIsTrue : undefined,
    reasonExplainsAssertion: typeof q.reasonExplainsAssertion === 'boolean' ? q.reasonExplainsAssertion : undefined,
    tags: {
      subject: opts.subject || q.tags?.subject,
      topic: opts.topic || q.tags?.topic,
      difficulty: (q.tags?.difficulty as Difficulty) || opts.difficulty || 'medium',
    },
    explanation: q.explanation ? String(q.explanation) : undefined,
  }));
  // Basic sanity filter
  return normalized.filter((q) => q.text && q.type);
}

export async function gradeSubjectiveAnswerGroq(params: {
  questionText: string;
  studentAnswer: string;
  rubric?: string; // optional teacher rubric
}): Promise<{ rubricScore: number; feedback: string }> {
  const client = getGroq();
  if (!client) throw new Error('Groq API key not configured');
  const system = `You are a strict but fair grader. Score the student's answer between 0 and 1 with up to two decimals. Provide brief, actionable feedback. Return STRICT JSON: { "rubricScore": number, "feedback": string }`;
  const user = `Question: ${params.questionText}\n\nStudent Answer: ${params.studentAnswer}\n\nRubric (optional): ${params.rubric || 'N/A'}\n\nRespond with JSON only.`;
  const resp = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' } as any,
  });
  const raw = resp.choices?.[0]?.message?.content || '';
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Failed to parse Groq grading response'); }
  const score = Math.max(0, Math.min(1, Number(parsed.rubricScore)));
  const feedback = String(parsed.feedback || '').slice(0, 2000);
  return { rubricScore: isNaN(score) ? 0 : score, feedback };
}

export async function summarizeWithGroq(text: string): Promise<string | null> {
  const client = getGroq();
  if (!client) return null;
  const resp = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    temperature: 0.3,
    messages: [
      { role: 'system', content: 'Summarize the key insights in 3-5 bullets. Keep it concise.' },
      { role: 'user', content: text.slice(0, 12000) },
    ],
  });
  return resp.choices?.[0]?.message?.content || null;
}
