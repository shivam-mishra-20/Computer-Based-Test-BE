import type { VertexAI } from '@google-cloud/vertexai';
import { getVertexClient } from '../lib/googleClients';

/**
 * Answer Generation Service
 * Uses Vertex AI Gemini to solve questions of all types
 */

interface QuestionOption {
  text: string;
  isCorrect?: boolean;
}

interface Question {
  _id?: string;
  text: string;
  type: string;
  options?: QuestionOption[];
  subject?: string;
  topic?: string;
  chapter?: string;
  explanation?: string;
  assertion?: string;
  reason?: string;
}

interface SolveResult {
  // For MCQ questions
  correctOptionIndex?: number;
  // For text-based answers (short answer, fill-in-blank, etc.)
  correctAnswerText?: string;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  questionType: string;
}

let vertexAI: VertexAI | null = null;

function getVertexAI(): VertexAI {
  if (!vertexAI) vertexAI = getVertexClient();
  return vertexAI;
}

/**
 * Determine if a question type is MCQ-based
 */
function isMCQType(type: string): boolean {
  return ['mcq', 'mcq-single', 'mcq-multi', 'Multiple Choice', 'true-false', 'truefalse', 'assertionreason'].includes(type);
}

/**
 * Use AI to solve any type of question
 */
export async function solveQuestionWithAI(question: Question): Promise<SolveResult> {
  const vertex = getVertexAI();
  const model = vertex.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.2, // Low for accuracy
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 2048,
    },
  });

  const contextInfo = [
    question.subject && `Subject: ${question.subject}`,
    question.topic && `Topic: ${question.topic}`,
    question.chapter && `Chapter: ${question.chapter}`,
  ].filter(Boolean).join(' | ');

  let prompt: string;
  let isMCQ = isMCQType(question.type);

  if (isMCQ && question.options && question.options.length >= 2) {
    // MCQ-style question
    const optionsText = question.options
      .map((opt, idx) => `${String.fromCharCode(65 + idx)}. ${opt.text}`)
      .join('\n');

    prompt = `You are an expert educator and subject matter expert. Your task is to solve the following multiple-choice question and identify the correct answer.

${contextInfo ? `Context: ${contextInfo}\n` : ''}
QUESTION TYPE: ${question.type}
QUESTION:
${question.text}
${question.assertion ? `\nAssertion (A): ${question.assertion}` : ''}
${question.reason ? `Reason (R): ${question.reason}` : ''}

OPTIONS:
${optionsText}

INSTRUCTIONS:
1. Carefully analyze the question
2. Consider each option thoroughly
3. Apply relevant concepts and knowledge
4. Identify the CORRECT answer

Return your response in STRICT JSON format:
{
  "correctOptionIndex": <number 0-${question.options.length - 1}>,
  "explanation": "<brief explanation of why this answer is correct>",
  "confidence": "<high|medium|low>"
}

IMPORTANT:
- correctOptionIndex is 0-based (A=0, B=1, C=2, D=3)
- Be thorough and accurate
- Provide a clear explanation
- Return ONLY the JSON object, no additional text`;

  } else {
    // Text-based question (short answer, long answer, fill-in-blank, etc.)
    prompt = `You are an expert educator and subject matter expert. Your task is to provide the correct answer to the following question.

${contextInfo ? `Context: ${contextInfo}\n` : ''}
QUESTION TYPE: ${question.type}
QUESTION:
${question.text}

INSTRUCTIONS:
1. Carefully analyze the question
2. Provide a clear, accurate, and complete answer
3. For fill-in-the-blank, provide the missing word(s)
4. For short answer, keep response concise but complete
5. For long answer, provide a comprehensive response

Return your response in STRICT JSON format:
{
  "correctAnswerText": "<the correct answer>",
  "explanation": "<brief explanation of why this is correct>",
  "confidence": "<high|medium|low>"
}

IMPORTANT:
- correctAnswerText should be the direct answer
- For numerical answers, include units if applicable
- Be thorough and accurate
- Return ONLY the JSON object, no additional text`;
  }

  console.log(`[AI Solve] Solving ${question.type}: "${question.text.substring(0, 80)}..."`);

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  const raw = result.response.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  // Parse response
  let parsed: any;
  try {
    // Clean up response
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    
    // Try direct parse
    try {
      parsed = JSON.parse(cleaned.trim());
    } catch {
      // Extract JSON object
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in response');
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (parseError) {
    console.error('[AI Solve] Failed to parse response:', raw);
    throw new Error(`Failed to parse AI response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
  }

  // Build result based on question type
  if (isMCQ && question.options && question.options.length >= 2) {
    const correctIndex = Number(parsed.correctOptionIndex);
    if (isNaN(correctIndex) || correctIndex < 0 || correctIndex >= question.options.length) {
      throw new Error(`Invalid correctOptionIndex: ${parsed.correctOptionIndex}`);
    }

    console.log(`[AI Solve] ✓ Answer: Option ${String.fromCharCode(65 + correctIndex)} (confidence: ${parsed.confidence})`);

    return {
      correctOptionIndex: correctIndex,
      explanation: String(parsed.explanation || '').slice(0, 2000),
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      questionType: question.type,
    };
  } else {
    console.log(`[AI Solve] ✓ Answer: "${String(parsed.correctAnswerText || '').substring(0, 50)}..." (confidence: ${parsed.confidence})`);

    return {
      correctAnswerText: String(parsed.correctAnswerText || '').slice(0, 5000),
      explanation: String(parsed.explanation || '').slice(0, 2000),
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      questionType: question.type,
    };
  }
}

/**
 * Solve multiple questions in batch
 */
export async function solveQuestionsInBatch(
  questions: Question[],
  onProgress?: (completed: number, total: number) => void
): Promise<{ solved: number; failed: number; results: Map<string, SolveResult | Error> }> {
  const results = new Map<string, SolveResult | Error>();
  let solved = 0;
  let failed = 0;

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const id = question._id || `q_${i}`;

    try {
      const result = await solveQuestionWithAI(question);
      results.set(id, result);
      solved++;
    } catch (error) {
      results.set(id, error instanceof Error ? error : new Error(String(error)));
      failed++;
    }

    onProgress?.(i + 1, questions.length);
    
    // Small delay to avoid rate limiting
    if (i < questions.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  console.log(`[AI Solve Batch] Completed: ${solved} solved, ${failed} failed`);
  return { solved, failed, results };
}
