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
  const types = opts.types?.join(', ') || 'mcq, truefalse, short';
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
      "type": "mcq"|"truefalse"|"fill"|"short"|"long",
      "options": [{ "text": string, "isCorrect": boolean }] | null,
      "correctAnswerText": string | null,
      "tags": { "subject"?: string, "topic"?: string, "difficulty"?: "easy"|"medium"|"hard" },
      "explanation": string | null
    }
  ]
}

Ensure MCQs include 4 options with exactly one correct. For true/false, options can be omitted and correctAnswerText should be "true" or "false". For fill/short/long, provide correctAnswerText with keywords or a reference answer. Do not include markdown, only raw JSON.

Study material:
"""
${text}
"""`;
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
    type: ['mcq', 'truefalse', 'fill', 'short', 'long'].includes(q.type) ? q.type : 'mcq',
    options: Array.isArray(q.options)
      ? q.options.map((o: any) => ({ text: String(o.text || ''), isCorrect: !!o.isCorrect }))
      : undefined,
    correctAnswerText: q.correctAnswerText ? String(q.correctAnswerText) : undefined,
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
