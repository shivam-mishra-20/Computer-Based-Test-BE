import type { VertexAI } from '@google-cloud/vertexai';
import { getVertexClient } from '../lib/googleClients';

/**
 * Answer Generation Service
 * Uses Vertex AI Gemini to solve MCQ questions and identify correct answers
 */

interface MCQOption {
  text: string;
  isCorrect?: boolean;
}

interface MCQQuestion {
  _id?: string;
  text: string;
  type: string;
  options?: MCQOption[];
  subject?: string;
  topic?: string;
  chapter?: string;
  explanation?: string;
}

interface SolveResult {
  correctOptionIndex: number;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
}

let vertexAI: VertexAI | null = null;

function getVertexAI(): VertexAI {
  if (!vertexAI) vertexAI = getVertexClient();
  return vertexAI;
}

/**
 * Use AI to solve an MCQ question and determine the correct answer
 */
export async function solveQuestionWithAI(question: MCQQuestion): Promise<SolveResult> {
  // Validate question
  if (!question.options || question.options.length < 2) {
    throw new Error('Question must have at least 2 options');
  }

  if (question.type !== 'mcq' && question.type !== 'mcq-single' && question.type !== 'Multiple Choice') {
    throw new Error('Only MCQ questions are supported for AI solving');
  }

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

  // Build options text
  const optionsText = question.options
    .map((opt, idx) => `${String.fromCharCode(65 + idx)}. ${opt.text}`)
    .join('\n');

  const contextInfo = [
    question.subject && `Subject: ${question.subject}`,
    question.topic && `Topic: ${question.topic}`,
    question.chapter && `Chapter: ${question.chapter}`,
  ].filter(Boolean).join(' | ');

  const prompt = `You are an expert educator and subject matter expert. Your task is to solve the following multiple-choice question (MCQ) and identify the correct answer.

${contextInfo ? `Context: ${contextInfo}\n` : ''}
QUESTION:
${question.text}

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

  console.log(`[AI Solve] Solving MCQ: "${question.text.substring(0, 80)}..."`);

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

  // Validate result
  const correctIndex = Number(parsed.correctOptionIndex);
  if (isNaN(correctIndex) || correctIndex < 0 || correctIndex >= question.options.length) {
    throw new Error(`Invalid correctOptionIndex: ${parsed.correctOptionIndex}`);
  }

  console.log(`[AI Solve] ✓ Answer: Option ${String.fromCharCode(65 + correctIndex)} (confidence: ${parsed.confidence})`);

  return {
    correctOptionIndex: correctIndex,
    explanation: String(parsed.explanation || '').slice(0, 2000),
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
  };
}

/**
 * Solve multiple questions in batch
 */
export async function solveQuestionsInBatch(
  questions: MCQQuestion[],
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
