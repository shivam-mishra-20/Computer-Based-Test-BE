import { Types } from 'mongoose';
import sharp from 'sharp';
import { ai, fixLatexBackslashes } from '../ai';
import { extractPdfTextWithOcrFallback } from './pdfOcrFallback';

/** Verbatim OCR prompt shared by image/page extraction. */
const OCR_PROMPT = `Extract ALL text content from this image with MAXIMUM ACCURACY.

CRITICAL INSTRUCTIONS:
- Extract text EXACTLY as it appears (verbatim) — do NOT paraphrase or summarize.
- Preserve question numbers, options (A, B, C, D), and structure.
- Keep mathematical expressions, equations, and formulas precise.
- Include special characters, symbols, headers, and instructions.
- Note diagrams/figures with placeholders: [DIAGRAM: brief description].
- If the image contains NO readable text at all (a blank or empty page), reply with exactly: [NO_TEXT]

Return ONLY the extracted text, nothing else.`;

/**
 * Vision models asked to read a blank page often answer with a sentence about
 * the page ("The image is blank…") instead of nothing. That sentence must not
 * pass as source text — it would let generation invent questions from it.
 */
export function isNoTextReply(reply: string): boolean {
  const t = reply.trim();
  if (!t) return true;
  if (/^\[?\s*NO_TEXT\s*\]?\.?$/i.test(t)) return true;
  return (
    t.length < 300 &&
    /\b(?:image|page|picture|photo|document)\b[^.]{0,40}\b(?:is|appears(?: to be)?|seems(?: to be)?)\s+(?:completely\s+|entirely\s+|mostly\s+)?(?:blank|empty|white)\b|\bno\s+(?:readable|visible|legible|discernible|extractable)?\s*text\b|\b(?:does|did)\s+not\s+contain\s+any\s+(?:readable\s+|visible\s+)?text\b|\bthere\s+is\s+no\s+(?:readable\s+|visible\s+)?text\b/i.test(t)
  );
}

/** Detect an image MIME type from its bytes (defaults to image/png). */
async function detectImageMime(buffer: Buffer): Promise<string> {
  try {
    const format = (await sharp(buffer).metadata()).format || 'png';
    const map: Record<string, string> = {
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
    };
    return map[format] || 'image/png';
  } catch {
    return 'image/png';
  }
}

export interface GeneratedQuestion {
  text: string;
  type: 'mcq' | 'truefalse' | 'fill' | 'short' | 'long' | 'integer' | 'assertionreason';
  options?: Array<{ text: string; isCorrect: boolean }>;
  correctAnswerText?: string;
  integerAnswer?: number;
  assertion?: string;
  reason?: string;
  assertionIsTrue?: boolean;
  reasonIsTrue?: boolean;
  reasonExplainsAssertion?: boolean;
  questionNumber?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  confidence?: number;
  needsReview?: boolean;
}

export interface AIGenerationOptions {
  // Required metadata (same as Smart Import)
  subject: string;
  class: string;
  
  // Optional metadata
  topic?: string;
  board?: string;
  chapter?: string;
  section?: string;
  marks?: number;
  
  // Generation parameters
  count: number;
  difficulty?: 'easy' | 'medium' | 'hard' | 'mixed';
  questionTypes?: Array<'mcq' | 'truefalse' | 'fill' | 'short' | 'long' | 'integer' | 'assertionreason'>;
  /**
   * The institute's own instructions for generated questions (AI Guidance,
   * managed by an admin). Added to the prompt as written. The model itself is
   * NOT selectable per request — it comes from server configuration.
   */
  guidance?: string | null;
  /**
   * 'auto' (default): reproduce existing questions if the source IS a question
   * paper, else generate new ones. 'recreate': always reproduce verbatim.
   * 'generate': always create new questions.
   */
  mode?: 'auto' | 'recreate' | 'generate';

  // User context
  createdBy: Types.ObjectId;
}

/**
 * Heuristic: does the source text already contain exam questions (vs being
 * study material)? Used to auto-pick recreate vs generate without a slow LLM call.
 */
export function looksLikeQuestionPaper(text: string): boolean {
  const t = (text || '').slice(0, 12000);
  let score = 0;
  if (/\bQ\.?\s*\d+/i.test(t)) score += 2;                              // Q1, Q.1
  if (/(^|\n)\s*\d+[.)]\s+\S/.test(t)) score += 2;                       // 1. / 1)
  if (/\(?[A-Da-d][).]\s.*\(?[A-Da-d][).]\s/s.test(t)) score += 1;       // option labels
  if (/\b(choose|select|tick|mark)\b.{0,25}\bcorrect\b/i.test(t)) score += 2;
  if (/\[\s*\d+\s*marks?\s*\]|\(\s*\d+\s*m(arks?)?\s*\)/i.test(t)) score += 1;
  if (/(answer the following|fill in the blank|true or false|assertion|reason)/i.test(t)) score += 1;
  if ((t.match(/\?/g) || []).length >= 5) score += 1;
  return score >= 3;
}

/**
 * Progress notifications for a caller that runs generation as a background
 * job (services/aiGenerationJobs). The synchronous endpoints pass nothing.
 */
export interface GenerationProgress {
  onStage?: (stage: 'reading' | 'ocr' | 'generating', detail?: { page: number; total: number }) => void;
}

export interface AIGenerationResult {
  questions: GeneratedQuestion[];
  metadata: {
    totalGenerated: number;
    sourceType: 'text' | 'pdf' | 'image';
    extractedTextLength?: number;
    ocrProvider?: 'nvidia-vision';
    processingTimeMs: number;
  };
}

/**
 * Extract text from image using Google Cloud Vision API
 */
export async function extractTextFromImage(buffer: Buffer): Promise<string> {
  try {
    console.log('[AI Generation] Extracting text from image using NVIDIA vision OCR...');
    const mimeType = await detectImageMime(buffer);
    const extractedText = await ai.visionText(OCR_PROMPT, [{ data: buffer, mimeType }], {
      label: 'ocr-image',
      maxTokens: 8192,
    });

    console.log(`[AI Generation] NVIDIA vision extracted ${extractedText.length} characters`);
    // NO reply at all is the service failing (an idle-timeout ends the stream
    // with zero chunks and still returns ""), not a blank page — a blank page
    // gets the [NO_TEXT] answer the prompt asks for. Reporting it as "no
    // readable text" told teachers their scan was unreadable during an outage.
    if (!extractedText.trim()) {
      throw new Error('the vision service returned no output');
    }
    if (isNoTextReply(extractedText)) {
      console.log('[AI Generation] Vision reports no readable text on this image');
      return '';
    }
    return extractedText;
  } catch (error) {
    console.error('[AI Generation] Vision OCR error:', error);
    throw new Error(`Text extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Extract text from PDF by converting pages to images and using Vision API
 */
export async function extractTextFromPDF(buffer: Buffer, progress?: GenerationProgress): Promise<string> {
  let parsed = '';
  try {
    console.log('[AI Generation] Extracting text from PDF...');
    const { default: pdfParse } = await import('pdf-parse');
    parsed = (await pdfParse(buffer)).text || '';
  } catch (error) {
    // A PDF the text parser cannot read may still render — try OCR below.
    console.warn('[AI Generation] PDF text layer unreadable:', error instanceof Error ? error.message : error);
  }

  if (meaningfulLength(parsed) > 100) {
    console.log(`[AI Generation] PDF text extraction successful: ${parsed.length} chars`);
    return parsed;
  }

  // Scanned (image-only) PDF: render the sparse pages and read them with the
  // same NVIDIA vision OCR image uploads use — the pipeline Smart Import
  // already relies on (services/pdfOcrFallback). Capped, because only the
  // first 50,000 characters reach the prompt anyway.
  console.log('[AI Generation] Text layer is sparse — running OCR on the PDF pages...');
  const fallback = await extractPdfTextWithOcrFallback(buffer, {
    ocr: (png) => extractTextFromImage(png),
    maxOcrPages: Number(process.env.AI_GENERATE_OCR_MAX_PAGES || 15),
    onOcrPage: (page, total) => progress?.onStage?.('ocr', { page, total }),
  });
  const text = meaningfulLength(fallback.combinedText) > meaningfulLength(parsed) ? fallback.combinedText : parsed;
  if (fallback.usedOcr) {
    console.log(`[AI Generation] OCR read ${fallback.ocrPages.length}/${fallback.totalPages} page(s)`);
  }
  // Nothing readable AND the OCR service itself failed: that is an outage to
  // retry, not a blank document — say so instead of "no readable text".
  if (meaningfulLength(text) < MIN_SOURCE_CHARS() && fallback.ocrFailedPages.length > 0) {
    throw new OcrUnavailableError();
  }
  return text;
}

/** The vision OCR service failed (timeout, 5xx) on a scan with no text layer. */
export class OcrUnavailableError extends Error {
  readonly code = 'OCR_UNAVAILABLE';
  constructor() {
    super(
      "The text-recognition service didn't respond, so this scan couldn't be read. Nothing was generated — please try again in a few minutes.",
    );
    this.name = 'OcrUnavailableError';
  }
}

/** Characters of real content — page markers and whitespace do not count. */
export function meaningfulLength(text: string | null | undefined): number {
  return String(text || '')
    .replace(/=== PAGE \d+ ===/g, '')
    .replace(/\s+/g, '')
    .length;
}

/** The fewest content characters worth sending to the model. */
const MIN_SOURCE_CHARS = () => Number(process.env.AI_GENERATE_MIN_SOURCE_CHARS || 40);

/**
 * The upload had no text the model could work from. Generating anyway makes
 * the model invent questions from nothing, which then look real in the
 * preview — so this is refused before any generation call.
 */
export class EmptySourceError extends Error {
  readonly code = 'EMPTY_SOURCE';
  constructor(readonly sourceType: 'pdf' | 'image' | 'text') {
    super(
      sourceType === 'pdf'
        ? 'No readable text was found in this PDF, even after OCR. If it is a scan, upload clearer page images; if it is protected, export it again without protection.'
        : sourceType === 'image'
          ? 'No readable text was found in this image. Upload a sharper, well-lit photo of the page.'
          : 'There is no source text to generate questions from.',
    );
    this.name = 'EmptySourceError';
  }
}

function assertUsableSource(text: string, sourceType: 'pdf' | 'image' | 'text'): void {
  if (meaningfulLength(text) < MIN_SOURCE_CHARS()) throw new EmptySourceError(sourceType);
}

/**
 * Generate questions from text using Vertex AI Gemini 2.5 Pro
 */
export async function generateQuestionsFromText(
  text: string,
  options: AIGenerationOptions
): Promise<AIGenerationResult> {
  const startTime = Date.now();
  
  try {
    // Decide whether to REPRODUCE existing questions or GENERATE new ones.
    const mode = options.mode || 'auto';
    const recreate = mode === 'recreate' || (mode === 'auto' && looksLikeQuestionPaper(text));
    console.log(`[AI Generation] Mode: ${recreate ? 'RECREATE (reproduce source questions)' : 'GENERATE (new questions)'}`);
    console.log(`[AI Generation] ${recreate ? 'Reproducing' : 'Generating'} questions...`);
    console.log(`[AI Generation] Metadata: Class=${options.class}, Subject=${options.subject}, Topic=${options.topic || 'N/A'}`);

    // Build difficulty instruction
    let difficultyInstr = '';
    if (options.difficulty === 'mixed') {
      difficultyInstr = 'Mix difficulty levels: 30% easy, 50% medium, 20% hard.';
    } else if (options.difficulty) {
      difficultyInstr = `Set all questions to ${options.difficulty} difficulty.`;
    } else {
      difficultyInstr = 'Use appropriate difficulty for the grade level.';
    }
    
    // Build question type instruction
    let typeInstr = '';
    if (options.questionTypes && options.questionTypes.length > 0) {
      const typeCounts = Math.ceil(options.count / options.questionTypes.length);
      typeInstr = `Generate approximately ${typeCounts} of each type: ${options.questionTypes.join(', ')}.`;
    } else {
      typeInstr = 'Mix question types based on section: MCQ, Short Answer, Long Answer, True/False, Fill in the Blank.';
    }
    
    // Map section to appropriate question types
    if (options.section) {
      const sectionTypeMap: Record<string, string> = {
        'Objective': 'Focus on MCQ (multiple choice) and True/False questions.',
        'Very Short': 'Generate Fill in the Blank and very brief Short Answer questions (1-2 marks).',
        'Short': 'Generate Short Answer questions (2-3 marks) requiring brief explanations.',
        'Long': 'Generate Long Answer questions (5+ marks) requiring detailed explanations.',
        'Case Study': 'Generate MCQ and Short Answer questions based on a scenario or case study.',
      };
      if (sectionTypeMap[options.section]) {
        typeInstr = sectionTypeMap[options.section];
      }
    }
    
    const prompt = `You are an expert educator creating high-quality examination questions for ${options.class} students.

📚 CONTEXT:
- Subject: ${options.subject}
- Class: ${options.class}
${options.board ? `- Board: ${options.board}` : ''}
${options.chapter ? `- Chapter: ${options.chapter}` : ''}
${options.topic ? `- Topic: ${options.topic}` : ''}
${options.section ? `- Section Type: ${options.section}` : ''}
${options.marks ? `- Marks per Question: ${options.marks}` : ''}

🎯 TASK:
${recreate
  ? `The source material below ALREADY CONTAINS exam questions. EXTRACT and REPRODUCE EVERY question present — exactly as written. Do NOT invent, add, remove, reorder, or reword questions.`
  : `Generate EXACTLY ${options.count} original, pedagogically sound questions based on the source material below.`}

📋 REQUIREMENTS:
${recreate
  ? `1. Reproduce the questions EXACTLY as they appear — same wording, same numbering/order.
2. Keep each question's options and mark the SAME correct option shown in the source; if no answer is given, solve it correctly.
3. Preserve question type (MCQ / fill / short / long / etc.) as in the source.
4. Use proper LaTeX for ALL math (use DOUBLE backslashes in JSON: \\\\frac, \\\\sin, etc.).
5. ENHANCE ONLY (non-destructive): fix OCR artifacts, broken spacing, and garbled characters — never change meaning or values.
6. Extract ALL questions found; do not cap the count. Set needsReview=true for any question whose source text was garbled.`
  : `1. ${typeInstr}
2. ${difficultyInstr}
3. Each question must be curriculum-appropriate for ${options.class} level
4. Use proper LaTeX formatting for ALL mathematical expressions (use DOUBLE backslashes in JSON: \\\\frac, \\\\sin, etc.)
5. MCQ questions must have 4 options with exactly ONE correct answer
6. Ensure questions test understanding, not just rote memorization
7. Set confidence=0.95 for clear questions, 0.7-0.8 for questions needing review
8. Flag needsReview=true if confidence < 0.75`}

⚠️ JSON FORMATTING (CRITICAL):
- Return ONLY valid JSON array - no markdown, no explanations
- In JSON strings, use DOUBLE backslashes for LaTeX: \\\\frac{1}{2}, \\\\sin(x), \\\\alpha
- Example: "text": "Solve $\\\\frac{x+1}{x-1} = 2$"
- ALWAYS close all JSON objects and arrays properly
- Never truncate mid-object

📐 LATEX REFERENCE:
- Fractions: $\\\\frac{a}{b}$
- Square roots: $\\\\sqrt{x}$, $\\\\sqrt[n]{x}$
- Trigonometry: $\\\\sin(x)$, $\\\\cos(x)$, $\\\\tan(x)$
- Greek letters: $\\\\alpha$, $\\\\beta$, $\\\\theta$, $\\\\pi$
- Calculus: $\\\\frac{dy}{dx}$, $\\\\int_a^b f(x)\\\\, dx$, $\\\\lim_{x \\\\to a}$
- Superscript/Subscript: $x^2$, $x_1$
- Inequalities: $\\\\leq$, $\\\\geq$, $\\\\neq$
- Piecewise: $\\\\begin{cases} f(x), & x > 0 \\\\\\\\ g(x), & x \\\\leq 0 \\\\end{cases}$

📝 QUESTION TYPE VALUES (MUST USE EXACTLY):
- "mcq" - Multiple Choice Questions (4 options, one correct)
- "truefalse" - True/False questions (2 options: True and False)
- "fill" - Fill in the Blank (provide correctAnswerText)
- "short" - Short Answer (2-3 marks, provide correctAnswerText)
- "long" - Long Answer (5+ marks, provide correctAnswerText)
- "integer" - Numerical Answer (provide integerAnswer as number)
- "assertionreason" - Assertion-Reason (provide assertion and reason fields)

JSON SCHEMA:
[
  {
    "text": "Question text with proper LaTeX formatting",
    "type": "mcq",
    "options": [
      {"text": "Option A with LaTeX if needed", "isCorrect": false},
      {"text": "Option B", "isCorrect": true},
      {"text": "Option C", "isCorrect": false},
      {"text": "Option D", "isCorrect": false}
    ],
    "questionNumber": "1",
    "difficulty": "easy|medium|hard",
    "confidence": 0.95,
    "needsReview": false
  },
  {
    "text": "Is the statement 'Water boils at 100°C at sea level' correct?",
    "type": "truefalse",
    "options": [
      {"text": "True", "isCorrect": true},
      {"text": "False", "isCorrect": false}
    ],
    "questionNumber": "2",
    "difficulty": "easy",
    "confidence": 0.95,
    "needsReview": false
  },
  {
    "text": "The process by which plants make food is called _______.",
    "type": "fill",
    "correctAnswerText": "Photosynthesis",
    "questionNumber": "3",
    "difficulty": "easy",
    "confidence": 0.90,
    "needsReview": false
  },
  {
    "text": "Explain Newton's first law of motion.",
    "type": "short",
    "correctAnswerText": "An object at rest stays at rest and an object in motion stays in motion with the same speed and direction unless acted upon by an unbalanced force.",
    "questionNumber": "4",
    "difficulty": "medium",
    "confidence": 0.90,
    "needsReview": false
  },
  {
    "text": "Find the value of $\\\\sin(30°) + \\\\cos(60°)$",
    "type": "integer",
    "integerAnswer": 1,
    "correctAnswerText": "1",
    "questionNumber": "5",
    "difficulty": "medium",
    "confidence": 0.85,
    "needsReview": false
  }
]

${options.guidance && options.guidance.trim()
  ? `🏫 INSTITUTE GUIDANCE (follow it unless it conflicts with the JSON format above):
${options.guidance.trim().slice(0, 4000)}

`
  : ''}📄 SOURCE MATERIAL:
"""
${text.slice(0, 50000)}
"""

${recreate
  ? 'Extract and reproduce ALL questions from the source NOW.'
  : `Generate ${options.count} questions NOW.`} Return ONLY the JSON array.`;

    const result = await ai.chat([{ role: 'user', content: prompt }], {
      temperature: 0.7,
      maxTokens: 8192,
      label: 'generate-questions',
    });

    const responseText = result.text || '';

    console.log(`[AI Generation] Received ${responseText.length} chars response`);
    
    // Parse JSON with robust error handling
    const questions = await parseGeneratedQuestions(responseText);

    // `auto` guessed "this is a question paper" from its layout (numbered
    // lines read that way too) and the model found nothing to reproduce. The
    // teacher asked for questions, so generate them from the same source
    // instead of answering with an empty list. Once: 'generate' never retries.
    if (recreate && mode === 'auto' && questions.length === 0) {
      console.log('[AI Generation] Nothing to reproduce — generating new questions from the source instead');
      return generateQuestionsFromText(text, { ...options, mode: 'generate' });
    }

    const processingTime = Date.now() - startTime;
    console.log(`[AI Generation] Successfully generated ${questions.length} questions in ${processingTime}ms`);
    
    return {
      questions,
      metadata: {
        totalGenerated: questions.length,
        sourceType: 'text',
        extractedTextLength: text.length,
        processingTimeMs: processingTime,
      },
    };
  } catch (error) {
    console.error('[AI Generation] Error:', error);
    throw new Error(`Question generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Robust JSON parsing with multiple fallback strategies
 */
async function parseGeneratedQuestions(responseText: string): Promise<GeneratedQuestion[]> {
  // Clean response. Repair single-backslash LaTeX (\frac, \times, \beta, …) BEFORE
  // parsing — otherwise JSON.parse silently mangles those into \f/\t/\b escapes.
  let cleaned = fixLatexBackslashes(
    responseText.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim()
  );

  // Check for truncation
  const isTruncated = !cleaned.endsWith(']') && !cleaned.endsWith('}]');
  if (isTruncated) {
    console.warn('[AI Generation] Response appears truncated, attempting repair...');
    // Auto-close unclosed structures
    const openBraces = (cleaned.match(/\{/g) || []).length;
    const closeBraces = (cleaned.match(/\}/g) || []).length;
    const openBrackets = (cleaned.match(/\[/g) || []).length;
    const closeBrackets = (cleaned.match(/\]/g) || []).length;
    
    for (let i = 0; i < openBraces - closeBraces; i++) cleaned += '\n  }';
    for (let i = 0; i < openBrackets - closeBrackets; i++) cleaned += '\n]';
  }
  
  // Attempt 1: Direct parse
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {}
  
  // Attempt 2: Extract array
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      return Array.isArray(parsed) ? parsed : [];
    } catch {}
    
    // Attempt 3: Fix LaTeX escaping
    let sanitized = arrayMatch[0];
    sanitized = sanitized.replace(
      /"((?:[^"\\]|\\.)*)"/g,
      (match, content) => {
        let escaped = content
          .replace(/\\\\/g, '\\u0000')
          .replace(/\\/g, '\\\\')
          .replace(/\\u0000/g, '\\\\');
        return `"${escaped}"`;
      }
    );
    
    try {
      const parsed = JSON.parse(sanitized);
      console.log('[AI Generation] ✓ Parsed after LaTeX sanitization');
      return Array.isArray(parsed) ? parsed : [];
    } catch {}
    
    // Attempt 4: Remove control characters
    const ctrlClean = sanitized.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
    try {
      const parsed = JSON.parse(ctrlClean);
      return Array.isArray(parsed) ? parsed : [];
    } catch {}
  }
  
  throw new Error('Failed to parse JSON response from AI model');
}

/**
 * Main entry point: Generate questions from PDF
 */
export async function generateQuestionsFromPDF(
  buffer: Buffer,
  options: AIGenerationOptions,
  progress?: GenerationProgress,
): Promise<AIGenerationResult> {
  progress?.onStage?.('reading');
  const extractedText = await extractTextFromPDF(buffer, progress);
  assertUsableSource(extractedText, 'pdf');
  progress?.onStage?.('generating');
  const result = await generateQuestionsFromText(extractedText, options);
  return {
    ...result,
    metadata: {
      ...result.metadata,
      sourceType: 'pdf',
      ocrProvider: 'nvidia-vision',
    },
  };
}

/**
 * Main entry point: Generate questions from image
 */
export async function generateQuestionsFromImage(
  buffer: Buffer,
  options: AIGenerationOptions,
  progress?: GenerationProgress,
): Promise<AIGenerationResult> {
  let extractedText: string;
  try {
    progress?.onStage?.('ocr', { page: 1, total: 1 });
    extractedText = await extractTextFromImage(buffer);
  } catch {
    throw new OcrUnavailableError();
  }
  assertUsableSource(extractedText, 'image');
  progress?.onStage?.('generating');
  const result = await generateQuestionsFromText(extractedText, options);
  return {
    ...result,
    metadata: {
      ...result.metadata,
      sourceType: 'image',
      ocrProvider: 'nvidia-vision',
    },
  };
}

/**
 * Generate questions from direct text input (no OCR)
 */
export async function generateQuestionsFromDirectText(
  text: string,
  options: AIGenerationOptions
): Promise<AIGenerationResult> {
  assertUsableSource(text, 'text');
  const result = await generateQuestionsFromText(text, options);
  return {
    ...result,
    metadata: {
      ...result.metadata,
      sourceType: 'text',
    },
  };
}
