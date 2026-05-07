/**
 * Ollama Local AI Service - Qwen3:8b
 * Replaces Google Vertex AI / Gemini for question extraction.
 * Optimized for: low VRAM, stable JSON, long PDF processing.
 */

import { Ollama } from 'ollama';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL = 'qwen3:8b';

// Single shared client
const ollama = new Ollama({ host: OLLAMA_HOST });

export interface OllamaQuestion {
  question: string;
  options: string[];          // empty array if not MCQ
  answer: string;             // correct option text or answer text
  question_type: 'mcq' | 'truefalse' | 'fill' | 'short' | 'long' | 'assertionreason' | 'integer';
  subject: string;
  topic_name: string;
  chapter_name: string;
  class: string;
  board: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

interface OllamaResponse {
  questions: OllamaQuestion[];
}

/**
 * Build a compact, token-efficient extraction prompt.
 * Chunk should be ~1200 chars max to stay within context.
 */
function buildPrompt(
  chunk: string,
  context: { subject?: string; chapter?: string; class?: string; board?: string }
): string {
  const subject = context.subject || 'Unknown';
  const chapter = context.chapter || 'General';
  const cls = context.class || 'Unknown';
  const board = context.board || 'CBSE';

  return `Extract ALL exam questions from the text. Return ONLY valid JSON.

JSON schema:
{"questions":[{"question":"string","options":["a","b","c","d"],"answer":"string","question_type":"mcq|truefalse|fill|short|long|assertionreason|integer","subject":"${subject}","topic_name":"string","chapter_name":"${chapter}","class":"${cls}","board":"${board}","difficulty":"easy|medium|hard"}]}

Rules:
- options: array of strings (MCQ/TrueFalse), else []
- answer: correct option text for MCQ, or answer text
- question_type: mcq if 4 options, truefalse if 2, fill if blanks, short/long otherwise
- Extract subject/topic/chapter from headings in the text if visible
- difficulty: easy/medium/hard based on complexity
- MATH FORMATTING (CRITICAL): ALL math expressions MUST be wrapped in $ delimiters
  - Inline math: $expression$ (e.g., $x^2 + y^2 = z^2$)
  - Display math: $$expression$$ for standalone equations
  - Matrices: $\begin{bmatrix} a & b \\ c & d \end{bmatrix}$
  - Never output bare LaTeX commands outside $ delimiters
  - Convert Unicode: × → $\times$, ² → $^{2}$, √ → $\sqrt{}$, ÷ → $\div$, ≠ → $\neq$, ≤ → $\leq$, ≥ → $\geq$, α → $\alpha$, β → $\beta$, π → $\pi$
  - Fractions: $\frac{a}{b}$, integrals: $\int_a^b f(x)dx$

TEXT:
${chunk}

JSON:`;
}

/**
 * Extract questions from a single chunk using local Ollama qwen3:8b.
 * Concurrency = 1 (called sequentially by caller).
 * JSON mode enabled for stable output.
 */
export async function extractQuestionsFromChunk(
  chunk: string,
  context: {
    subject?: string;
    chapter?: string;
    class?: string;
    board?: string;
    startPage?: number;
  }
): Promise<OllamaQuestion[]> {
  const prompt = buildPrompt(chunk, context);

  try {
    const response = await ollama.generate({
      model: MODEL,
      prompt,
      format: 'json',           // JSON mode - forces valid JSON output
      stream: false,
      options: {
        temperature: 0,         // deterministic
        num_ctx: 4096,          // context window
        num_predict: 2048,      // max output tokens
        top_p: 0.9,
        repeat_penalty: 1.1,
      },
    });

    const raw = response.response.trim();

    let parsed: OllamaResponse;
    try {
      parsed = JSON.parse(raw) as OllamaResponse;
    } catch {
      // Attempt to extract JSON object if model prefixed text
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as OllamaResponse;
      } else {
        console.warn('[Ollama] Could not parse JSON response:', raw.slice(0, 200));
        return [];
      }
    }

    if (!Array.isArray(parsed.questions)) {
      console.warn('[Ollama] Response has no questions array');
      return [];
    }

    return parsed.questions.filter(q => q && typeof q.question === 'string' && q.question.trim());
  } catch (error) {
    console.error('[Ollama] Extraction error:', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Wrap bare LaTeX in $ delimiters and convert Unicode math symbols.
 * Catches cases where the model outputs valid LaTeX but forgets the delimiters.
 */
function normalizeMath(text: string): string {
  if (!text) return text;
  // Wrap \begin{...}...\end{...} blocks not already in $
  text = text.replace(/(?<!\$)(\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\})(?!\$)/g, '$$$1$$');
  // Wrap isolated LaTeX commands not already delimited
  text = text.replace(
    /(?<!\$)(\\(?:frac|sqrt|int|sum|prod|lim|alpha|beta|gamma|delta|pi|theta|lambda|mu|sigma|omega|times|div|pm|mp|leq|geq|neq|approx|infty|partial|nabla|cdot|ldots|forall|exists|in|notin|subset|cup|cap|mathbf|mathrm|text|overline|hat|vec|bar)\b[^$\n]*?)(?!\$)/g,
    '$$$1$$'
  );
  // Unicode math characters
  text = text.replace(/(?<!\$)×(?!\$)/g, ' $\\times$ ');
  text = text.replace(/(?<!\$)÷(?!\$)/g, ' $\\div$ ');
  text = text.replace(/(?<!\$)≠(?!\$)/g, ' $\\neq$ ');
  text = text.replace(/(?<!\$)≤(?!\$)/g, ' $\\leq$ ');
  text = text.replace(/(?<!\$)≥(?!\$)/g, ' $\\geq$ ');
  text = text.replace(/(?<!\$)²(?!\$)/g, '$^{2}$');
  text = text.replace(/(?<!\$)³(?!\$)/g, '$^{3}$');
  text = text.replace(/(?<!\$)½(?!\$)/g, '$\\frac{1}{2}$');
  text = text.replace(/(?<!\$)¼(?!\$)/g, '$\\frac{1}{4}$');
  text = text.replace(/(?<!\$)¾(?!\$)/g, '$\\frac{3}{4}$');
  // Clean up accidental triple-dollar signs
  text = text.replace(/\${3,}/g, '$$');
  return text;
}

/**
 * Map OllamaQuestion to the ExtractedQuestion interface used throughout the app.
 */
export function mapOllamaToExtracted(
  q: OllamaQuestion,
  index: number,
  startPage: number
): {
  text: string;
  type: 'mcq' | 'truefalse' | 'fill' | 'short' | 'long' | 'assertionreason' | 'integer';
  options?: Array<{ text: string; isCorrect: boolean }>;
  correctAnswerText?: string;
  questionNumber: string;
  subject: string;
  topic: string;
  chapter: string;
  difficulty: 'easy' | 'medium' | 'hard';
  confidence: number;
  needsReview: boolean;
  pageNumber: number;
} {
  let options: Array<{ text: string; isCorrect: boolean }> | undefined;
  let correctAnswerText: string | undefined;

  if ((q.question_type === 'mcq' || q.question_type === 'truefalse') && q.options?.length > 0) {
    options = q.options.map(opt => ({
      text: normalizeMath(opt),
      isCorrect: opt.trim() === (q.answer || '').trim(),
    }));
    // If no option matched, mark first as correct placeholder
    if (options.every(o => !o.isCorrect) && options.length > 0) {
      options[0] = { ...options[0], isCorrect: true };
    }
  } else {
    correctAnswerText = q.answer ? normalizeMath(q.answer) : undefined;
  }

  const difficulty: 'easy' | 'medium' | 'hard' =
    ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium';

  return {
    text: normalizeMath(q.question.trim()),
    type: q.question_type || 'short',
    options,
    correctAnswerText,
    questionNumber: `${index + 1}`,
    subject: q.subject || 'Unknown',
    topic: q.topic_name || q.chapter_name || 'General',
    chapter: q.chapter_name || 'General',
    difficulty,
    confidence: 0.85,
    needsReview: false,
    pageNumber: startPage,
  };
}

/**
 * Health check - verify Ollama is running and model is available.
 */
export async function checkOllamaHealth(): Promise<{ ok: boolean; message: string }> {
  try {
    const list = await ollama.list();
    const hasModel = list.models.some(m => m.name.startsWith('qwen3'));
    if (!hasModel) {
      return {
        ok: false,
        message: `Model qwen3:8b not found. Run: ollama pull qwen3:8b. Available: ${list.models.map(m => m.name).join(', ')}`,
      };
    }
    return { ok: true, message: `Ollama running with qwen3:8b` };
  } catch (error) {
    return {
      ok: false,
      message: `Ollama not reachable at ${OLLAMA_HOST}. Start with: ollama serve`,
    };
  }
}
