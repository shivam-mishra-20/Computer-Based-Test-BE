import { Types } from 'mongoose';
import sharp from 'sharp';
import { ai, fixLatexBackslashes } from '../ai';

/** Verbatim OCR prompt shared by image/page extraction. */
const OCR_PROMPT = `Extract ALL text content from this image with MAXIMUM ACCURACY.

CRITICAL INSTRUCTIONS:
- Extract text EXACTLY as it appears (verbatim) — do NOT paraphrase or summarize.
- Preserve question numbers, options (A, B, C, D), and structure.
- Keep mathematical expressions, equations, and formulas precise.
- Include special characters, symbols, headers, and instructions.
- Note diagrams/figures with placeholders: [DIAGRAM: brief description].

Return ONLY the extracted text, nothing else.`;

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
  model?: string; // optional model override (provider-agnostic; default from env)
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
    return extractedText;
  } catch (error) {
    console.error('[AI Generation] Vision OCR error:', error);
    throw new Error(`Text extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Extract text from PDF by converting pages to images and using Vision API
 */
export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  try {
    console.log('[AI Generation] Extracting text from PDF...');
    
    // Use pdf-lib to convert PDF to images
    const { default: pdfParse } = await import('pdf-parse');
    const sharp = await import('sharp');
    
    // Try basic text extraction first
    const pdfData = await pdfParse(buffer);
    
    if (pdfData.text && pdfData.text.length > 100) {
      console.log(`[AI Generation] PDF text extraction successful: ${pdfData.text.length} chars`);
      return pdfData.text;
    }
    
    // If basic extraction fails, use OCR on rendered pages
    console.log('[AI Generation] Basic extraction insufficient, falling back to OCR...');
    
    // For now, return the basic extraction
    // TODO: Implement page-by-page OCR if needed
    return pdfData.text;
  } catch (error) {
    console.error('[AI Generation] PDF extraction error:', error);
    throw new Error(`PDF text extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
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

📄 SOURCE MATERIAL:
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
  options: AIGenerationOptions
): Promise<AIGenerationResult> {
  const extractedText = await extractTextFromPDF(buffer);
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
  options: AIGenerationOptions
): Promise<AIGenerationResult> {
  const extractedText = await extractTextFromImage(buffer);
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
  const result = await generateQuestionsFromText(text, options);
  return {
    ...result,
    metadata: {
      ...result.metadata,
      sourceType: 'text',
    },
  };
}
