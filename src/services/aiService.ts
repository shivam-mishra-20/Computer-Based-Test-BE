import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import type { Types } from 'mongoose';
import type { Difficulty, IQuestion, QuestionType } from '../models/Question';

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
  const model = g.getGenerativeModel({ model: 'gemini-1.5-flash' });
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

export async function refineQuestionGemini(original: Partial<IQuestion> & { notes?: string; desiredDifficulty?: Difficulty; constraints?: string }): Promise<Partial<IQuestion>> {
  const g = getGemini();
  if (!g) throw new Error('Gemini API key not configured');
  const model = g.getGenerativeModel({ model: 'gemini-1.5-flash' });
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
  const model = g.getGenerativeModel({ model: 'gemini-1.5-flash' });
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
