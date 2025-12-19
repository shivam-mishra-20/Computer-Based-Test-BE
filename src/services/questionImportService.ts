import dotenv from 'dotenv';
import type { VertexAI } from '@google-cloud/vertexai';
import { getVertexClient, getVisionClient as createVisionClient } from '../lib/googleClients';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import sharp from 'sharp';
import { Types } from 'mongoose';
import { ImportBatch, ImportedQuestion, IImportedQuestion } from '../models/ImportedQuestion';
import { saveBatchValidatedQuestions, EnhancedQuestionData, saveValidatedQuestion } from './questionValidationService';
import { normalizeMathematicalExpressions } from './mathService';

dotenv.config();

// Google Cloud configuration
const GOOGLE_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'cbt-vision-api';
const GOOGLE_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

// Initialize clients (lazy loading)
let vertexAI: VertexAI | null = null;
let visionClient: ReturnType<typeof createVisionClient> | null = null;

/**
 * Get or initialize Vertex AI client for Gemini LLM
 * Uses the same service account credentials as Vision API
 */
function getVertexAI(): VertexAI {
  if (!vertexAI) vertexAI = getVertexClient();
  return vertexAI;
}

/**
 * Get or initialize Vision API client for OCR
 * Uses the same service account credentials as Vertex AI
 */
function getVisionClient(): ReturnType<typeof createVisionClient> {
  if (!visionClient) visionClient = createVisionClient();
  return visionClient;
}

export interface ExtractedQuestion {
  text: string;
  type: 'mcq' | 'truefalse' | 'fill' | 'short' | 'long' | 'assertionreason' | 'integer';
  options?: Array<{ text: string; isCorrect: boolean }>;
  correctAnswerText?: string;
  integerAnswer?: number;
  assertion?: string;
  reason?: string;
  assertionIsTrue?: boolean;
  reasonIsTrue?: boolean;
  reasonExplainsAssertion?: boolean;
  questionNumber?: string;
  subject?: string;
  topic?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  confidence: number;
  needsReview: boolean;
}

export interface ImportResult {
  success: boolean;
  batchId: Types.ObjectId;
  totalQuestions: number;
  processedQuestions: number;
  errors: Array<{ page?: number; error: string }>;
  processingTime: number;
}

export class QuestionImportService {
  
  /**
   * Main entry point for importing question papers
   * Enhanced with Gemini AI for accurate text extraction and LaTeX formatting
   */
  static async importQuestionPaper(
    filePath: string,
    fileName: string,
    fileType: 'pdf' | 'image',
    uploadedBy: Types.ObjectId,
    options: {
      subject?: string;
      topic?: string;
      class?: string;
      board?: string;
      chapter?: string;
      section?: string;
      marks?: number;
      model?: 'gemini-2.5-flash' | 'gemini-2.5-pro';
    } = {}
  ): Promise<ImportResult> {
    const startTime = Date.now();
    // Default to Gemini 2.5 Pro for best performance
    let selectedModel = options.model || 'gemini-2.5-pro';
    
    console.log(`[Import] DEBUG: Received model = "${selectedModel}"`);
    
    // Strip "publishers/google/models/" prefix if present (frontend may send full path)
    if (selectedModel.includes('/')) {
      const originalModel = selectedModel;
      selectedModel = (selectedModel.split('/').pop() || 'gemini-2.5-pro') as typeof selectedModel;
      console.log(`[Import] DEBUG: Stripped "${originalModel}" → "${selectedModel}"`);
    }
    
    try {
      console.log(`[Import] Starting import for file: ${fileName}`);
      console.log(`[Import] Pipeline: Google Cloud Vision API → Vertex AI ${selectedModel}`);
      
      // Create import batch
      const fileStats = fs.statSync(filePath);
      const batch = new ImportBatch({
        fileName: path.basename(filePath),
        originalFileName: fileName,
        fileType,
        fileSize: fileStats.size,
        status: 'processing',
        processingStarted: new Date(),
        ocrProvider: 'google-vision',
        processingModel: `vertex-ai-${selectedModel}`,
        uploadedBy
      });
      
      await batch.save();
      console.log(`[Import] Batch created with ID: ${batch._id}`);

      let extractedText: string;
      let totalPages = 1;

      // Step 1: Extract text using Google Cloud Vision API (highest accuracy OCR)
      console.log(`[Import] Step 1: Extracting text using Google Cloud Vision API...`);
      
      if (fileType === 'pdf') {
        // For PDFs, convert pages to images and process with Vision API
        const result = await this.extractTextFromPDFWithVision(filePath);
        extractedText = result.text;
        totalPages = result.pages;
      } else {
        // For images, use Vision API directly
        extractedText = await this.extractTextFromImageWithVision(filePath);
      }

      console.log(`[Import] Vision API extracted ${extractedText.length} characters from ${totalPages} page(s)`);
      
      // Log a preview of extracted text for debugging
      const textPreview = extractedText.slice(0, 200).replace(/\n/g, ' ');
      console.log(`[Import] Text preview: ${textPreview}...`);

      // Update batch with page count
      batch.totalPages = totalPages;
      await batch.save();

      // Step 2: Structure questions using Vertex AI Gemini
      console.log(`[Import] Step 2: Structuring questions with Vertex AI ${selectedModel}...`);
      const questions = await this.structureQuestionsWithVertexAI(
        extractedText,
        {
          subject: options.subject,
          topic: options.topic,
          batchId: batch._id as Types.ObjectId,
          model: selectedModel
        }
      );

      console.log(`[Import] Vertex AI ${selectedModel} structured ${questions.length} questions`);

      // Step 3: Normalize mathematical expressions in all questions
      console.log(`[Import] Step 3: Normalizing mathematical expressions...`);
      const normalizedQuestions = await this.normalizeQuestionsWithLaTeX(questions);

      // Step 4: Save questions to database with metadata
      console.log(`[Import] Step 4: Saving questions to database...`);
      const savedQuestions = await this.saveQuestions(
        normalizedQuestions, 
        batch._id as Types.ObjectId, 
        uploadedBy,
        {
          class: options.class,
          board: options.board,
          chapter: options.chapter,
          section: options.section,
          marks: options.marks
        }
      );

      console.log(`[Import] Saved ${savedQuestions.length} questions`);

      // Step 5: Upsert subject/topic aggregate in Imports collection
      try {
        const { ImportModel } = await import('../models/Import');
        const byKey = new Map<string, Types.ObjectId[]>();
        for (const q of savedQuestions) {
          const key = `${q.subject || 'Unknown'}::${q.topic || 'General'}`;
          const arr = byKey.get(key) || [];
          arr.push(q._id as Types.ObjectId);
          byKey.set(key, arr);
        }
        for (const [key, ids] of byKey) {
          const [subject, topic] = key.split('::');
          await ImportModel.findOneAndUpdate(
            { uploadedBy, subject, topic },
            { 
              $setOnInsert: { uploadedBy, subject, topic },
              $inc: { questionCount: ids.length },
              $addToSet: { questionIds: { $each: ids } }
            },
            { upsert: true, new: true }
          );
        }
      } catch (e) {
        console.warn('[Import] Failed to upsert Imports aggregate:', e);
      }

      // Step 6: Update batch status
      const processingTime = Date.now() - startTime;
      batch.status = 'completed';
      batch.processingCompleted = new Date();
      batch.totalQuestions = normalizedQuestions.length;
      batch.processedQuestions = savedQuestions.length;
      batch.totalProcessingTime = processingTime;
      await batch.save();

      console.log(`[Import] Import completed in ${processingTime}ms`);

      return {
        success: true,
        batchId: batch._id as Types.ObjectId,
        totalQuestions: normalizedQuestions.length,
        processedQuestions: savedQuestions.length,
        errors: [],
        processingTime
      };

    } catch (error) {
      // Handle errors and update batch
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Try to update batch if it exists
      try {
        const batch = await ImportBatch.findOne({ fileName: path.basename(filePath), uploadedBy }).sort({ createdAt: -1 });
        if (batch) {
          batch.status = 'failed';
          batch.processingErrors = batch.processingErrors || [];
          batch.processingErrors.push({ error: errorMessage, timestamp: new Date() });
          batch.totalProcessingTime = processingTime;
          await batch.save();
        }
      } catch (updateError) {
        console.error('Failed to update batch status:', updateError);
      }

      throw error;
    }
  }

  /**
   * Extract text from image using Google Cloud Vision API (highest accuracy)
   */
  private static async extractTextFromImageWithVision(filePath: string): Promise<string> {
    try {
      console.log(`[Vision API] Processing image: ${filePath}`);
      
      const client = getVisionClient();
      
      // Read image file
      const imageBuffer = await fs.promises.readFile(filePath);
      
      // Perform document text detection (best for dense text like question papers)
      const [result] = await client.documentTextDetection({
        image: { content: imageBuffer }
      });
      
      const fullText = result.fullTextAnnotation;
      if (!fullText || !fullText.text) {
        throw new Error('No text detected in image');
      }
      
      console.log(`[Vision API] Extracted ${fullText.text.length} characters`);
      return fullText.text;
      
    } catch (error) {
      console.error('[Vision API] Error:', error);
      throw new Error(`Vision API extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Extract text from PDF using Google Cloud Vision API
   * Uses Vision API's native PDF support via asyncBatchAnnotateFiles
   */
  private static async extractTextFromPDFWithVision(filePath: string): Promise<{ text: string; pages: number }> {
    try {
      console.log(`[Vision API PDF] Processing PDF: ${filePath}`);
      
      // Get page count
      const dataBuffer = await fs.promises.readFile(filePath);
      const pdfData = await pdfParse(dataBuffer as any);
      const numPages = pdfData.numpages || 1;
      
      console.log(`[Vision API PDF] PDF has ${numPages} pages`);

      const client = getVisionClient();
      
      // Read the PDF file
      const pdfBuffer = await fs.promises.readFile(filePath);

      console.log(`[Vision API PDF] Processing PDF with Vision API...`);

      // Use batchAnnotateFiles for synchronous PDF processing
      // Note: This processes all pages in one request
      const request = {
        requests: [
          {
            inputConfig: {
              content: pdfBuffer,
              mimeType: 'application/pdf',
            },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' as const }],
            pages: Array.from({ length: numPages }, (_, i) => i + 1), // Process all pages
          },
        ],
      };

      const [response] = await client.batchAnnotateFiles(request);
      
      if (!response.responses || response.responses.length === 0) {
        console.warn(`[Vision API PDF] No responses from Vision API`);
        return { text: '', pages: numPages };
      }

      const pageTexts: string[] = [];
      
      // Extract text from each page response
      for (const fileResponse of response.responses) {
        if (fileResponse.responses) {
          for (const pageResponse of fileResponse.responses) {
            const fullText = pageResponse.fullTextAnnotation;
            if (fullText && fullText.text) {
              pageTexts.push(fullText.text);
              console.log(`[Vision API PDF] Extracted ${fullText.text.length} chars from page`);
            } else {
              pageTexts.push('');
            }
          }
        }
      }

      const combinedText = pageTexts
        .map((text, idx) => `\n\n=== PAGE ${idx + 1} ===\n${text}`)
        .join('\n');

      console.log(`[Vision API PDF] Total extracted: ${combinedText.length} characters from ${pageTexts.length} pages`);

      return {
        text: combinedText,
        pages: numPages
      };
      
    } catch (error) {
      console.error('[Vision API PDF] Fatal error:', error);
      
      // Fallback to text extraction with pdf-parse
      console.log(`[Vision API PDF] Falling back to text extraction with pdf-parse...`);
      try {
        const dataBuffer = await fs.promises.readFile(filePath);
        const pdfData = await pdfParse(dataBuffer as any);
        
        return {
          text: pdfData.text || '',
          pages: pdfData.numpages || 1
        };
      } catch (fallbackError) {
        throw new Error(`Vision API PDF extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

  /**
   * Strict, order-preserving question parser (no paraphrasing)
   * - Detects questions by numbering patterns (Q1., 1., 1), etc.)
   * - Captures options (a)/(b)/(c)/(d) formats when present
   * - Uses exact substrings from the OCR text to ensure 1:1 fidelity
   */
  private static structureQuestionsStrict(
    extractedText: string,
    opts: { subject?: string; topic?: string }
  ): ExtractedQuestion[] {
    const text = extractedText.replace(/\r\n/g, '\n');
    // Common question header patterns: Q1., Q1), Q 1., 1., 1), 1 -, 1:
    const qHeader = /(^|\n)\s*(?:Q\s*)?(\d{1,3})\s*(?:[\.:\)]|\s*-\s*|\s+)/g;
    const indices: Array<{ num: string; start: number; end?: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = qHeader.exec(text)) !== null) {
      const idxStart = m.index + (m[1] ? m[1].length : 0);
      indices.push({ num: m[2], start: idxStart });
    }
    if (!indices.length) return [];
    // Determine segment ranges
    for (let i = 0; i < indices.length; i++) {
      indices[i].end = i < indices.length - 1 ? indices[i + 1].start : text.length;
    }
    const questions: ExtractedQuestion[] = [];
    const optionLine = /^(?:\s*[\(\[]?[a-dA-D][\)\].]|\s*[a-dA-D][\.)]\s)/; // (a), a), a.
    const normalize = (s: string) => s.replace(/[\t\f\v\r]+/g, ' ').replace(/\s+$/g, '').replace(/^\s+/g, '');
    for (const seg of indices) {
      const raw = text.slice(seg.start!, seg.end!);
      // Split into lines but keep exact content overall
      const lines = raw.split(/\n/);
      // First line likely contains question number already consumed; use entire segment as text baseline
      // Extract options as consecutive lines starting from where option pattern begins
      const optsStart = lines.findIndex(l => optionLine.test(l));
      let qText = raw;
      let options: ExtractedQuestion['options'] | undefined = undefined;
      if (optsStart >= 0) {
        const before = lines.slice(0, optsStart).join('\n');
        const optsLines: string[] = [];
        for (let i = optsStart; i < lines.length; i++) {
          const ln = lines[i];
          if (!ln.trim()) continue;
          if (optionLine.test(ln)) optsLines.push(ln);
          else break;
        }
        // Build options preserving text; strip only leading label like (a) or a.)
        const optTexts = optsLines.map((ln) => ln.replace(/^\s*[\(\[]?([a-dA-D])[\)\].]?\s*/,'').trim());
        if (optTexts.length >= 3 && optTexts.length <= 6) {
          options = optTexts.map(t => ({ text: t, isCorrect: false }));
          // Question text is segment up to options
          qText = before.trimEnd();
        }
      }

      const question: ExtractedQuestion = {
        text: normalize(qText),
        type: options ? 'mcq' : 'short',
        options,
        questionNumber: seg.num,
        subject: opts.subject || 'Unknown',
        topic: opts.topic || 'General',
        difficulty: 'medium',
        confidence: 0.85,
        needsReview: false,
      };
      questions.push(question);
    }
    return questions;
  }





  /**
   * Structure extracted text into questions using Vertex AI Gemini
   * Production-grade implementation with single Google Cloud credentials
   */
  private static async structureQuestionsWithVertexAI(
    extractedText: string,
    options: {
      subject?: string;
      topic?: string;
      batchId: Types.ObjectId;
      model?: 'gemini-2.5-flash' | 'gemini-2.5-pro' | 'gemini-2.0-flash' | 'gemini-3.0' | 'gemini-3.0-pro';
    }
  ): Promise<ExtractedQuestion[]> {
    try {
      const modelName = options.model || 'gemini-2.5-pro';
      console.log(`[Vertex AI] Using model: ${modelName}`);
      
      const vertexAI = getVertexAI();
      const generativeModel = vertexAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.0, // Maximum consistency
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 16384, // Increased to handle more questions (up to ~20-30 questions)
        },
      });

      const prompt = `You are a production-grade academic question extraction engine.

Your task:
Extract ALL questions from the OCR text below and return clean, structured content
that can be safely stored, displayed, and reused for exams, PDFs, and question banks.

🎯 CRITICAL REQUIREMENTS:
- Extract EVERY SINGLE question from the source - DO NOT SKIP ANY
- If the source has 10 questions, you MUST output exactly 10 question blocks
- Preserve the original wording EXACTLY - no paraphrasing, no rewriting
- Do NOT correct grammar or spelling errors
- Do NOT output JSON, markdown, or any other format
- ONLY add LaTeX markup around mathematical expressions using $...$
- COMPLETE THE ENTIRE OUTPUT - do not stop until all questions are extracted

Return output in the EXACT format below.
Repeat the block for EACH AND EVERY question.

------------------------------------
QUESTION_NUMBER: <as in source or sequential>
QUESTION_TEXT: <exact question text with LaTeX>
QUESTION_TYPE: mcq | truefalse | fill | short | long | integer | assertionreason

OPTION_A: <text or EMPTY>
OPTION_B: <text or EMPTY>
OPTION_C: <text or EMPTY>
OPTION_D: <text or EMPTY>

CORRECT_OPTION: A | B | C | D | UNKNOWN
CORRECT_ANSWER_TEXT: <text or EMPTY>

SUBJECT: ${options.subject || 'Unknown'}
TOPIC: ${options.topic || 'General'}
DIFFICULTY: easy | medium | hard

CONFIDENCE: <0.0 – 1.0>
NEEDS_REVIEW: true | false
------------------------------------

RULES (STRICT):
- Each field must be on a SINGLE LINE
- Preserve LaTeX exactly as-is using $...$
- Do NOT escape LaTeX for JSON
- Do NOT invent answers or options
- If answer is unclear, set CORRECT_OPTION to UNKNOWN
- If OCR text is unclear, set NEEDS_REVIEW to true
- Every question must be in its own block
- If an option doesn't exist, write EMPTY
- EXTRACT ALL QUESTIONS - Count them in the source and match that count exactly
- Do NOT stop generating until you've processed every question

LATEX FORMATTING:
- Use $...$ for inline math (e.g., $x^2 + 5x + 6 = 0$)
- Use $$...$$ for display equations
- Common: $\frac{a}{b}$, $\sqrt{x}$, $x^2$, $x_1$, $\sum$, $\int$, $\lim$
- Greek: $\alpha$, $\beta$, $\gamma$, $\theta$, $\pi$
- Relations: $\leq$, $\geq$, $\neq$, $\approx$
- Convert Unicode: ∞→$\infty$, ²→$^2$, ×→$\times$

LATEX FORMATTING (STRICT · PRODUCTION · ENFORCED):

GENERAL RULES:

Use $...$ only for inline mathematical expressions
Example: $x^2 + 5x + 6 = 0$

Use 
.
.
.
... only for standalone, multi-line, or long equations
(integrals, summations, limits, derivations)

Do NOT wrap full sentences in LaTeX
Wrap only the smallest valid mathematical expression

Use inline math by default.
Display math is an exception, not the default.

STANDARD LATEX SYNTAX:

Fractions: $\frac{a}{b}$

Roots: $\sqrt{x}$

Powers: $x^2$

Subscripts: $x_1$

Summation: $\sum$

Integration: $\int$

Limits: $\lim$

GREEK LETTERS:

Use lowercase unless explicitly required:
$\alpha$, $\beta$, $\gamma$, $\theta$, $\pi$

RELATIONS & OPERATORS:

$\leq$, $\geq$, $\neq$, $\approx$

$=$, $+$, $-$, $\times$, $\div$

UNICODE → LATEX CONVERSION (MANDATORY):

∞ → $\infty$

² → $^2$, ³ → $^3$

× → $\times$, ÷ → $\div$

√ → $\sqrt{}$

≤ → $\leq$, ≥ → $\geq$, ≠ → $\neq$

π → $\pi$

Unicode minus (−) → -

DO NOT RULES (STRICT):

Do NOT wrap entire sentences in $...$

Do NOT mix $...$ and 
.
.
.
... for the same expression

Do NOT invent, simplify, or rewrite expressions

Do NOT escape LaTeX (no \, no JSON escaping)

Do NOT output malformed LaTeX (unbalanced $, {}, or )

Do NOT normalize text that already contains valid LaTeX

BACKEND ENFORCEMENT RULES:

$ count must be even

Curly braces {} must be balanced

Replace 
.
.
.
... with $...$ unless expression contains \int, \sum, or \lim, or is longer than 20 characters

Reject any remaining Unicode math symbols

Each LaTeX expression must remain on a single line

If $ already exists in text, skip further normalization

RENDERING & STORAGE GUARANTEES:

Fully compatible with MathJax and KaTeX

Safe for database storage and retrieval

Safe for screen rendering and PDF generation

Safe for question papers, exams, and downloads

Safe for review workflows and exports (PDF / DOCX / HTML)

PRESERVATION GUARANTEE:

Preserve LaTeX exactly as written

Do not modify, expand, or auto-correct expressions

QUESTION TYPE DETECTION:
- mcq: Has 4-5 options with (a)/(b)/(c)/(d) or A/B/C/D labels
- truefalse: Explicitly asks "True or False" or has only 2 options
- fill: Has blanks like "_____" or "fill in the blank"
- short: Asks for brief answer, typically 2-3 marks
- long: Asks for detailed explanation, typically 5+ marks
- integer: Asks for numeric answer only
- assertionreason: Has "Assertion:" and "Reason:" statements

EXAMPLE OUTPUT:
------------------------------------
QUESTION_NUMBER: 1
QUESTION_TEXT: If $f(x) = x^2 + 3x + 5$, find $\frac{dy}{dx}$.
QUESTION_TYPE: mcq

OPTION_A: $2x + 3$
OPTION_B: $x^2 + 3$
OPTION_C: $2x$
OPTION_D: $3x + 5$

CORRECT_OPTION: A
CORRECT_ANSWER_TEXT: EMPTY

SUBJECT: Mathematics
TOPIC: Calculus
DIFFICULTY: easy

CONFIDENCE: 0.95
NEEDS_REVIEW: false
------------------------------------

OCR TEXT TO PROCESS:
<<<BEGIN>>>
${extractedText}
<<<END>>>`;

      console.log(`[Vertex AI] Sending ${extractedText.length} chars for structuring...`);
      
      const request = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      };
      
      const result = await generativeModel.generateContent(request);
      const response = result.response;
      const responseText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      console.log(`[Vertex AI] Received ${responseText.length} chars response`);
      
      // Log finish reason for debugging
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason) {
        console.log(`[Vertex AI] Finish reason: ${finishReason}`);
        if (finishReason === 'MAX_TOKENS' || finishReason === 'OTHER') {
          console.warn('[Vertex AI] ⚠ Response may be truncated due to token limit');
        }
      }
      
      // Parse the text-based format instead of JSON
      const questions = this.parseTextBlockResponse(responseText, options);
      
      if (!questions || questions.length === 0) {
        throw new Error('Failed to parse any questions from Gemini response');
      }
      
      console.log(`[Vertex AI] ✓ Successfully parsed ${questions.length} questions from text format`);
      
      // Warn if question count seems suspiciously low
      if (questions.length < 5) {
        console.warn(`[Vertex AI] ⚠️ Only ${questions.length} questions extracted - this may be incomplete!`);
        console.warn(`[Vertex AI] Consider checking if the OCR text contains more questions.`);
      }

      // Validate and clean questions
      return questions.map((q, index) => ({
        text: q.text || `Question ${index + 1}`,
        type: q.type || 'short',
        options: q.options || undefined,
        correctAnswerText: q.correctAnswerText || undefined,
        integerAnswer: q.integerAnswer || undefined,
        assertion: q.assertion || undefined,
        reason: q.reason || undefined,
        assertionIsTrue: q.assertionIsTrue || undefined,
        reasonIsTrue: q.reasonIsTrue || undefined,
        reasonExplainsAssertion: q.reasonExplainsAssertion || undefined,
        questionNumber: q.questionNumber || `${index + 1}`,
        subject: q.subject || options.subject || 'Unknown',
        topic: q.topic || options.topic || 'General',
        difficulty: q.difficulty || 'medium',
        confidence: Math.min(Math.max(q.confidence || 0.5, 0), 1),
        needsReview: q.needsReview || q.confidence < 0.7
      }));

    } catch (error) {
      throw new Error(`Question structuring failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Parse the text-block format response from Gemini
   * Format: Blocks separated by dashes, each field on its own line
   */
  private static parseTextBlockResponse(
    responseText: string,
    options: { subject?: string; topic?: string }
  ): ExtractedQuestion[] {
    const questions: ExtractedQuestion[] = [];
    
    // Log the raw response for debugging
    console.log(`[TextParser] Raw response length: ${responseText.length} chars`);
    console.log(`[TextParser] First 500 chars: ${responseText.slice(0, 500)}`);
    
    // Split by the separator line - be flexible with the pattern
    // Match: newline, 4+ dashes, optional spaces, newline
    let blocks = responseText.split(/\n\s*-{4,}\s*\n/).filter(block => block.trim());
    
    // If no blocks found with standard separator, try alternative patterns
    if (blocks.length <= 1) {
      console.log(`[TextParser] Standard separator not found, trying alternative patterns...`);
      // Try without newline requirement
      blocks = responseText.split(/-{10,}/).filter(block => block.trim() && block.includes('QUESTION_'));
    }
    
    // Additional fallback: try to split by QUESTION_NUMBER: pattern if still no blocks
    if (blocks.length <= 1 && responseText.includes('QUESTION_NUMBER:')) {
      console.log(`[TextParser] Trying to split by QUESTION_NUMBER pattern...`);
      const questionSplits = responseText.split(/(?=QUESTION_NUMBER:)/);
      blocks = questionSplits.filter(block => block.trim() && block.includes('QUESTION_TEXT'));
    }
    
    console.log(`[TextParser] Found ${blocks.length} potential question blocks`);
    
    if (blocks.length === 0) {
      console.error(`[TextParser] No question blocks found! Response preview:\n${responseText.slice(0, 1000)}`);
      return [];
    }
    
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      console.log(`[TextParser] Processing block ${i + 1}/${blocks.length}...`);
      
      try {
        const lines = block.split('\n').map(l => l.trim()).filter(l => l);
        
        // Extract fields using regex - case insensitive for robustness
        const getValue = (key: string): string => {
          const line = lines.find(l => l.toUpperCase().startsWith(`${key.toUpperCase()}:`));
          if (!line) return '';
          const colonIndex = line.indexOf(':');
          return line.substring(colonIndex + 1).trim();
        };
        
        const questionNumber = getValue('QUESTION_NUMBER');
        const questionText = getValue('QUESTION_TEXT');
        const questionType = getValue('QUESTION_TYPE').toLowerCase() as ExtractedQuestion['type'];
        
        // Skip if no question text found
        if (!questionText) {
          console.warn(`[TextParser] Block ${i + 1} skipped - no question text found`);
          console.log(`[TextParser] Block preview: ${block.slice(0, 200)}`);
          continue;
        }
        
        const optionA = getValue('OPTION_A');
        const optionB = getValue('OPTION_B');
        const optionC = getValue('OPTION_C');
        const optionD = getValue('OPTION_D');
        
        const correctOption = getValue('CORRECT_OPTION').toUpperCase();
        const correctAnswerText = getValue('CORRECT_ANSWER_TEXT');
        
        const subject = getValue('SUBJECT') || options.subject || 'Unknown';
        const topic = getValue('TOPIC') || options.topic || 'General';
        const difficultyStr = (getValue('DIFFICULTY') || 'medium').toLowerCase();
        const difficulty = (['easy', 'medium', 'hard'].includes(difficultyStr) ? difficultyStr : 'medium') as ExtractedQuestion['difficulty'];
        
        const confidenceStr = getValue('CONFIDENCE');
        const confidence = confidenceStr ? parseFloat(confidenceStr) : 0.85;
        
        const needsReviewStr = getValue('NEEDS_REVIEW').toLowerCase();
        const needsReview = needsReviewStr === 'true';
        
        // Build options array for MCQ
        let questionOptions: ExtractedQuestion['options'] = undefined;
        if (questionType === 'mcq' || questionType === 'truefalse') {
          const opts: Array<{ text: string; isCorrect: boolean }> = [];
          
          if (optionA && optionA !== 'EMPTY') {
            opts.push({ text: optionA, isCorrect: correctOption === 'A' });
          }
          if (optionB && optionB !== 'EMPTY') {
            opts.push({ text: optionB, isCorrect: correctOption === 'B' });
          }
          if (optionC && optionC !== 'EMPTY') {
            opts.push({ text: optionC, isCorrect: correctOption === 'C' });
          }
          if (optionD && optionD !== 'EMPTY') {
            opts.push({ text: optionD, isCorrect: correctOption === 'D' });
          }
          
          if (opts.length > 0) {
            questionOptions = opts;
          }
        }
        
        const question: ExtractedQuestion = {
          text: questionText,
          type: questionType || 'short',
          options: questionOptions,
          correctAnswerText: (correctAnswerText && correctAnswerText !== 'EMPTY') ? correctAnswerText : undefined,
          questionNumber: questionNumber || `${questions.length + 1}`,
          subject,
          topic,
          difficulty,
          confidence: Math.min(Math.max(confidence, 0), 1),
          needsReview
        };
        
        questions.push(question);
        console.log(`[TextParser] ✓ Parsed question ${question.questionNumber}: ${question.type}`);
        
      } catch (parseError) {
        console.warn(`[TextParser] Failed to parse block ${i + 1}:`, parseError);
        console.log(`[TextParser] Failed block preview: ${block.slice(0, 300)}`);
        // Continue to next block
      }
    }
    
    console.log(`[TextParser] ===== PARSING SUMMARY =====`);
    console.log(`[TextParser] Total blocks found: ${blocks.length}`);
    console.log(`[TextParser] Successfully parsed: ${questions.length}`);
    console.log(`[TextParser] Failed to parse: ${blocks.length - questions.length}`);
    
    if (questions.length < 5 && blocks.length <= 3) {
      console.warn(`[TextParser] ⚠️ WARNING: Only ${questions.length} questions extracted!`);
      console.warn(`[TextParser] This may indicate the LLM response was incomplete or incorrectly formatted.`);
      console.warn(`[TextParser] Full response for debugging:\n${responseText}`);
    }
    
    return questions;
  }

  /**
   * Save structured questions to database with validation
   */
  private static async saveQuestions(
    questions: ExtractedQuestion[],
    batchId: Types.ObjectId,
    extractedBy: Types.ObjectId,
    metadata?: {
      class?: string;
      board?: string;
      chapter?: string;
      section?: string;
      marks?: number;
    }
  ): Promise<IImportedQuestion[]> {
    // Review-first flow: persist extracted questions into ImportedQuestion (temporary store)
    // Do NOT push directly to the Question Bank here.
    const docs = questions.map((q) => {
      // Filter out empty options to prevent validation errors
      let cleanedOptions = q.options;
      if (cleanedOptions && Array.isArray(cleanedOptions)) {
        cleanedOptions = cleanedOptions.filter(opt => opt && opt.text && opt.text.trim() !== '');
        // If after filtering we have no options, set to undefined
        if (cleanedOptions.length === 0) {
          cleanedOptions = undefined;
        }
      }

      return {
        text: q.text,
        type: q.type,
        subject: q.subject || undefined,
        topic: q.topic || undefined,
        difficulty: q.difficulty || 'medium',
        options: cleanedOptions,
        correctAnswerText: q.correctAnswerText,
        integerAnswer: q.integerAnswer,
        assertion: q.assertion,
        reason: q.reason,
        assertionIsTrue: q.assertionIsTrue,
        reasonIsTrue: q.reasonIsTrue,
        reasonExplainsAssertion: q.reasonExplainsAssertion,
        diagramUrl: undefined,
        importBatch: batchId,
        originalText: q.text || '',
        confidence: typeof q.confidence === 'number' ? q.confidence : 0.5,
        needsReview: q.needsReview ?? false,
        status: 'extracted' as const,
        pageNumber: undefined,
        questionNumber: q.questionNumber,
        extractedBy,
        reviewedBy: undefined,
        // Include metadata for later use when moving to class-wise collections
        class: metadata?.class,
        board: metadata?.board,
        chapter: metadata?.chapter,
        section: metadata?.section,
        marks: metadata?.marks,
      };
    });

    const saved = await ImportedQuestion.insertMany(docs);
    return saved;
  }

  /**
   * Get import batch with questions
   */
  static async getImportBatch(batchId: Types.ObjectId): Promise<any> {
    const batch = await ImportBatch.findById(batchId);
    if (!batch) throw new Error('Import batch not found');

    const questions = await ImportedQuestion.find({ importBatch: batchId })
      .sort({ questionNumber: 1 });

    return {
      ...batch.toObject(),
      questions
    };
  }

  /**
   * Update question review status and move to class-wise collection if approved
   */
  static async reviewQuestion(
    questionId: Types.ObjectId,
    reviewedBy: Types.ObjectId,
    action: 'approve' | 'reject',
    updatedData?: Partial<IImportedQuestion>
  ): Promise<IImportedQuestion> {
    const question = await ImportedQuestion.findById(questionId);
    if (!question) throw new Error('Question not found');

    if (updatedData) {
      Object.assign(question, updatedData);
    }

    question.status = action === 'approve' ? 'approved' : 'rejected';
    question.reviewedBy = reviewedBy;
    question.needsReview = false;

    await question.save();

    // If approved, move to class-wise Question collection with validation
    if (action === 'approve') {
      try {
        // Metadata is now stored directly in the question document
        const className = question.class;

        if (!className) {
          console.warn(`[Review] Question ${questionId} approved but no class found, skipping move to Question collection`);
          return question;
        }

        // Prepare enhanced question data
        const enhancedData: Partial<EnhancedQuestionData> = {
          text: question.text,
          type: question.type as any,
          options: question.options,
          correctAnswerText: question.correctAnswerText,
          integerAnswer: question.integerAnswer,
          assertion: question.assertion,
          reason: question.reason,
          assertionIsTrue: question.assertionIsTrue,
          reasonIsTrue: question.reasonIsTrue,
          reasonExplainsAssertion: question.reasonExplainsAssertion,
          diagramUrl: question.diagramUrl,
          subject: question.subject || 'Unknown',
          topic: question.topic,
          difficulty: (question.difficulty || 'medium') as any,
          createdBy: question.extractedBy,
          class: className,
          board: question.board,
          chapter: question.chapter,
          section: question.section,
          marks: question.marks,
          source: 'Smart Import',
        };

        // Save with validation (will skip duplicates within same class+chapter and empty answers)
        const saved = await saveValidatedQuestion(enhancedData);
        if (saved) {
          console.log(`✓ Question ${questionId} moved to ${className} collection`);
        } else {
          console.log(`⊘ Question ${questionId} skipped (duplicate or invalid)`);
        }
      } catch (error) {
        console.error(`[Review] Failed to move question ${questionId} to Question collection:`, error);
        // Don't fail the approval, just log the error
      }
    }

    return question;
  }

  /**
   * Bulk approve questions
   */
  static async bulkApproveQuestions(
    questionIds: Types.ObjectId[],
    reviewedBy: Types.ObjectId
  ): Promise<{ approved: number; failed: number }> {
    let approved = 0;
    let failed = 0;

    for (const questionId of questionIds) {
      try {
        await this.reviewQuestion(questionId, reviewedBy, 'approve');
        approved++;
      } catch (error) {
        failed++;
        console.error(`Failed to approve question ${questionId}:`, error);
      }
    }

    return { approved, failed };
  }

  /**
   * Normalize all mathematical expressions in questions using LaTeX
   */
  private static async normalizeQuestionsWithLaTeX(questions: ExtractedQuestion[]): Promise<ExtractedQuestion[]> {
    console.log(`[LaTeX Normalize] Processing ${questions.length} questions...`);
    
    const normalized: ExtractedQuestion[] = [];
    
    for (const question of questions) {
      try {
        // Check if text already has LaTeX formatting (has $ signs)
        const hasLatex = (text: string) =>
  /\$(.+?)\$/.test(text) || /\$\$(.+?)\$\$/.test(text);

        
        // Only normalize if NO LaTeX is present yet
        // If Vertex AI already added LaTeX, skip normalization to avoid corruption
        const shouldNormalize = !hasLatex(question.text);
        
        if (shouldNormalize) {
          console.log(`[LaTeX Normalize] Question ${question.questionNumber} needs normalization`);
        } else {
          console.log(`[LaTeX Normalize] Question ${question.questionNumber} already has LaTeX, skipping`);
        }
        
        // Normalize question text only if needed
        const normalizedText = shouldNormalize 
          ? await normalizeMathematicalExpressions(question.text)
          : question.text;
        
        // Normalize options if present and needed
        let normalizedOptions = question.options;
        if (question.options && question.options.length > 0) {
          normalizedOptions = await Promise.all(
            question.options.map(async (opt) => {
              const needsNorm = !hasLatex(opt.text);
              return {
                text: needsNorm ? await normalizeMathematicalExpressions(opt.text) : opt.text,
                isCorrect: opt.isCorrect
              };
            })
          );
        }
        
        // Normalize answer text if present and needed
        let normalizedAnswer = question.correctAnswerText;
        if (normalizedAnswer && !hasLatex(normalizedAnswer)) {
          normalizedAnswer = await normalizeMathematicalExpressions(normalizedAnswer);
        }
        
        // Normalize assertion-reason if present and needed
        let normalizedAssertion = question.assertion;
        let normalizedReason = question.reason;
        if (normalizedAssertion && !hasLatex(normalizedAssertion)) {
          normalizedAssertion = await normalizeMathematicalExpressions(normalizedAssertion);
        }
        if (normalizedReason && !hasLatex(normalizedReason)) {
          normalizedReason = await normalizeMathematicalExpressions(normalizedReason);
        }
        
        normalized.push({
          ...question,
          text: normalizedText,
          options: normalizedOptions,
          correctAnswerText: normalizedAnswer,
          assertion: normalizedAssertion,
          reason: normalizedReason
        });
      } catch (error) {
        console.error(`[LaTeX Normalize] Error normalizing question ${question.questionNumber}:`, error);
        // Keep original if normalization fails
        normalized.push(question);
      }
    }
    
    console.log(`[LaTeX Normalize] Completed normalizing ${normalized.length} questions`);
    return normalized;
  }
}