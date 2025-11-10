import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import { Types } from 'mongoose';
import { ImportBatch, ImportedQuestion, IImportedQuestion } from '../models/ImportedQuestion';
import { saveBatchValidatedQuestions, EnhancedQuestionData } from './questionValidationService';
import { normalizeMathematicalExpressions } from './mathService';

dotenv.config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

// Initialize clients
let groqClient: Groq | null = null;
let genAI: GoogleGenerativeAI | null = null;

function getGroq() {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');
  if (!groqClient) groqClient = new Groq({ apiKey: GROQ_API_KEY });
  return groqClient;
}

function getGemini() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  if (!genAI) genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  return genAI;
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
      ocrProvider?: 'groq' | 'gemini' | 'tesseract';
      mode?: 'strict' | 'normal';
      class?: string;
      board?: string;
      chapter?: string;
      section?: string;
      marks?: number;
    } = {}
  ): Promise<ImportResult> {
    const startTime = Date.now();
    
    try {
      console.log(`[Import] Starting import for file: ${fileName}`);
      
      // Create import batch
      const fileStats = fs.statSync(filePath);
      const batch = new ImportBatch({
        fileName: path.basename(filePath),
        originalFileName: fileName,
        fileType,
        fileSize: fileStats.size,
        status: 'processing',
        processingStarted: new Date(),
        ocrProvider: options.ocrProvider || 'gemini', // Default to Gemini for better accuracy
        processingModel: options.ocrProvider === 'gemini' ? 'gemini-2.0-flash-exp' : options.ocrProvider === 'groq' ? 'llava-v1.5-7b-4096-preview' : 'tesseract.js',
        uploadedBy
      });
      
      await batch.save();
      console.log(`[Import] Batch created with ID: ${batch._id}`);

      let extractedText: string;
      let totalPages = 1;
      const extractionProvider = options.ocrProvider || 'gemini';

      // Step 1: Extract text using Gemini for best results
      console.log(`[Import] Step 1: Extracting text using ${extractionProvider}...`);
      
      if (fileType === 'pdf') {
        // For PDFs, use Gemini vision API with enhanced prompting
        const result = await this.extractTextFromPDFWithGemini(filePath);
        extractedText = result.text;
        totalPages = result.pages;
      } else {
        // For images, use Gemini vision API
        extractedText = await this.extractTextFromImageWithGemini(filePath);
      }

      console.log(`[Import] Extracted ${extractedText.length} characters from ${totalPages} page(s)`);

      // Update batch with page count
      batch.totalPages = totalPages;
      await batch.save();

      // Step 2: Structure questions using Gemini AI with enhanced LaTeX formatting
      console.log(`[Import] Step 2: Structuring questions with Gemini AI...`);
      const questions = await this.structureQuestionsWithGemini(
        extractedText,
        {
          subject: options.subject,
          topic: options.topic,
          batchId: batch._id as Types.ObjectId
        }
      );

      console.log(`[Import] Structured ${questions.length} questions`);

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
   * Extract text from PDF using pdf-parse
   */
  private static async extractTextFromPDF(filePath: string): Promise<{ text: string; pages: number }> {
    try {
      const dataBuffer = await fs.promises.readFile(filePath);
      const pdfData = await pdfParse(dataBuffer as any);
      
      return {
        text: pdfData.text,
        pages: pdfData.numpages
      };
    } catch (error) {
      throw new Error(`PDF extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Extract text from PDF using Gemini Vision API for maximum accuracy
   * Converts PDF pages to images and processes with Gemini
   */
  private static async extractTextFromPDFWithGemini(filePath: string): Promise<{ text: string; pages: number }> {
    try {
      console.log(`[Gemini PDF] Processing PDF: ${filePath}`);
      
      // First get page count
      const dataBuffer = await fs.promises.readFile(filePath);
      const pdfData = await pdfParse(dataBuffer as any);
      const numPages = pdfData.numpages || 1;
      
      console.log(`[Gemini PDF] PDF has ${numPages} pages`);

      const pageTexts: string[] = [];
      const genAI = getGemini();
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

      // Process each page
      for (let pageIndex = 0; pageIndex < Math.min(numPages, 50); pageIndex++) {
        try {
          console.log(`[Gemini PDF] Processing page ${pageIndex + 1}/${numPages}`);
          
          // Convert PDF page to image using sharp
          const tmpPngPath = path.join(path.dirname(filePath), `__pdf_page_${pageIndex}_${Date.now()}.png`);
          
          await sharp(filePath, { page: pageIndex, density: 300 })
            .png()
            .toFile(tmpPngPath);

          try {
            // Process with Gemini Vision
            const imageBuffer = await fs.promises.readFile(tmpPngPath);
            const imagePart = {
              inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: 'image/png'
              }
            };

            const prompt = `Extract ALL text from this page of a question paper with MAXIMUM ACCURACY. 

CRITICAL REQUIREMENTS:
1. Extract EVERY word, number, and symbol exactly as shown
2. Preserve question numbering (Q1, 1., etc.)
3. Maintain option labels (a), b), c), d) or A, B, C, D
4. Include instructions, marks allocation, and section headers
5. For mathematical expressions:
   - Extract them accurately
   - Use standard notation (x^2 for powers, / for fractions initially)
   - Include all Greek letters, symbols, equations
6. Preserve the document structure and layout
7. Mark unclear or difficult-to-read text with [?]

Return ONLY the extracted text with proper line breaks. No explanations or markdown formatting.`;

            const result = await model.generateContent([prompt, imagePart]);
            const pageText = result.response.text();
            pageTexts.push(pageText);
            
            console.log(`[Gemini PDF] Page ${pageIndex + 1} extracted: ${pageText.length} characters`);
          } finally {
            // Clean up temp file
            try {
              await fs.promises.unlink(tmpPngPath);
            } catch {}
          }
        } catch (pageError) {
          console.error(`[Gemini PDF] Error processing page ${pageIndex + 1}:`, pageError);
          pageTexts.push(`[Error processing page ${pageIndex + 1}]`);
        }
      }

      const combinedText = pageTexts.map((text, idx) => 
        `\n\n=== PAGE ${idx + 1} ===\n${text}`
      ).join('\n');

      console.log(`[Gemini PDF] Total extracted text: ${combinedText.length} characters`);

      return {
        text: combinedText,
        pages: numPages
      };
    } catch (error) {
      console.error('[Gemini PDF] Fatal error:', error);
      throw new Error(`Gemini PDF extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Extract text from image using Gemini Vision API with enhanced accuracy
   */
  private static async extractTextFromImageWithGemini(filePath: string): Promise<string> {
    try {
      console.log(`[Gemini Image] Processing image: ${filePath}`);
      
      const genAI = getGemini();
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

      // Read and prepare image
      const imageBuffer = await fs.promises.readFile(filePath);
      const imagePart = {
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType: this.getMimeType(filePath)
        }
      };

      const prompt = `Extract ALL text from this image of a question paper with MAXIMUM ACCURACY.

CRITICAL REQUIREMENTS:
1. Extract EVERY word, number, and symbol exactly as shown
2. Preserve question numbering (Q1, Q2, 1., 2., etc.)
3. Maintain multiple choice option labels: (a), (b), (c), (d) or A, B, C, D
4. Include all instructions, marks allocation [2M], section headers
5. For mathematical expressions and equations:
   - Extract them with high precision
   - Preserve operators: +, -, ×, ÷, =, <, >, ≤, ≥
   - Include powers: x^2, x^n, e^x
   - Include fractions, roots, integrals, summations
   - Greek letters: α, β, γ, π, θ, Σ, Δ, etc.
   - Special symbols: ∫, √, ∑, ∏, ∞, ±, ≈, ≠
6. For diagrams or figures:
   - Note their presence: [DIAGRAM: description]
   - Extract any labels, axes, values shown
7. Preserve document structure:
   - Section divisions
   - Question grouping
   - Instructions vs questions
8. For unclear text, mark as [UNCLEAR: approximate_text]

OUTPUT FORMAT:
Return ONLY the extracted text with proper line breaks and spacing. 
Do NOT add markdown, do NOT add explanations.
Just the pure extracted content.`;

      const result = await model.generateContent([prompt, imagePart]);
      const extractedText = result.response.text();

      console.log(`[Gemini Image] Extracted ${extractedText.length} characters`);
      
      return extractedText;
    } catch (error) {
      console.error('[Gemini Image] Error:', error);
      throw new Error(`Gemini image extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get MIME type from file extension
   */
  private static getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp'
    };
    return mimeTypes[ext] || 'image/jpeg';
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
   * Extract text from image using OCR
   */
  private static async extractTextFromImage(filePath: string, provider: 'groq' | 'gemini' = 'groq'): Promise<string> {
    if (provider === 'groq') {
      return this.extractTextWithGroq(filePath);
    } else {
      return this.extractTextWithGemini(filePath);
    }
  }

  /**
   * OCR using Groq (Vision model)
   */
  private static async extractTextWithGroq(filePath: string): Promise<string> {
    try {
      const groq = getGroq();
      
      // Convert image to base64
      const imageBuffer = await fs.promises.readFile(filePath);
      const base64Image = imageBuffer.toString('base64');
      
      const response = await groq.chat.completions.create({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract all text from this image. Focus on questions, options, and answers. Preserve the original structure and numbering. If this is a question paper, maintain the question format exactly as shown.'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ]
          }
        ],
        model: 'llava-v1.5-7b-4096-preview', // Groq's vision model
        max_tokens: 4096,
        temperature: 0.1
      });

      return response.choices[0]?.message?.content || '';
    } catch (error) {
      throw new Error(`Groq OCR failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * OCR using Gemini Vision
   */
  private static async extractTextWithGemini(filePath: string): Promise<string> {
    try {
      const genAI = getGemini();
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });

      // Read and prepare image
      const imageBuffer = await fs.promises.readFile(filePath);
      const imagePart = {
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType: 'image/jpeg'
        }
      };

      const prompt = `Extract all text from this image with high accuracy. This appears to be a question paper. Please:
1. Preserve exact question numbering and structure
2. Maintain the format of multiple choice options (a, b, c, d)
3. Include any instructions or headers
4. Preserve mathematical expressions and symbols
5. Return the text exactly as it appears in the image

Focus on accuracy and completeness.`;

      const result = await model.generateContent([prompt, imagePart]);
      const text = result.response.text();
      
      return text;
    } catch (error) {
      throw new Error(`Gemini OCR failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * OCR using Tesseract.js for images (exact text extraction)
   */
  private static async extractTextFromImageWithTesseract(filePath: string): Promise<string> {
    try {
      const { data } = await Tesseract.recognize(filePath, 'eng', {
        // preserve interword spaces for better layout fidelity
        preserve_interword_spaces: 1,
        // logger: m => console.log(m)
      } as any);
      // Return raw text as-is to preserve exact content
      return (data.text || '').trim();
    } catch (error) {
      throw new Error(`Tesseract OCR (image) failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * OCR PDFs using Tesseract.js by rasterizing each page to image
   */
  private static async extractTextFromPDFWithTesseract(filePath: string): Promise<{ text: string; pages: number }> {
    try {
      // First, try to get number of pages via pdf-parse without relying on its text
      const dataBuffer = await fs.promises.readFile(filePath);
      const pdfData = await pdfParse(dataBuffer as any);
      const numpages = pdfData.numpages || 1;

      // Use sharp to rasterize each page; sharp supports page option for PDFs
      const pageTexts: string[] = [];
      for (let pageIndex = 0; pageIndex < numpages; pageIndex++) {
        try {
          const pageImage = sharp(filePath, { page: pageIndex, density: 300 })
            .ensureAlpha()
            .png();
          const tmpPngPath = path.join(path.dirname(filePath), `__ocr_${path.basename(filePath)}_${pageIndex}.png`);
          await pageImage.toFile(tmpPngPath);
          try {
            const text = await this.extractTextFromImageWithTesseract(tmpPngPath);
            pageTexts.push(text);
          } finally {
            try { await fs.promises.unlink(tmpPngPath); } catch {}
          }
        } catch (e) {
          // Skip page if rasterization fails, we'll fallback after loop
          pageTexts.push('');
        }
      }

      if (pageTexts.every(t => !t || !t.trim())) {
        // As a last resort, fallback to pdf-parse text
        const fallback = await this.extractTextFromPDF(filePath);
        return { text: fallback.text, pages: fallback.pages };
      }

      const combined = pageTexts.map((t, i) => `\n\n=== Page ${i + 1} ===\n${t}`).join('\n');
      return { text: combined, pages: numpages };
    } catch (error) {
      throw new Error(`Tesseract OCR (pdf) failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Structure extracted text into questions using Gemini with enhanced LaTeX formatting
   */
  private static async structureQuestionsWithGemini(
    extractedText: string,
    options: {
      subject?: string;
      topic?: string;
      batchId: Types.ObjectId;
    }
  ): Promise<ExtractedQuestion[]> {
    try {
      console.log(`[Gemini Structure] Starting question structuring...`);
      
      const genAI = getGemini();
      const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.0-flash-exp',
        generationConfig: {
          temperature: 0.1, // Low temperature for accuracy
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 8192,
        }
      });

      const prompt = `You are an expert question paper analyzer specializing in mathematical and scientific content. Parse the following extracted text and structure it into a JSON array of questions.

CRITICAL LATEX FORMATTING RULES - FOLLOW EXACTLY:
1. ALL mathematical expressions MUST use LaTeX formatting
2. Inline math: $x^2 + 5x + 6 = 0$ (single dollar signs)
3. Display equations: $$\\int_0^{\\pi} \\sin(x)\\, dx$$ (double dollar signs)

COMPREHENSIVE LATEX REFERENCE:
Basic Operations:
- Addition: $a + b$
- Subtraction: $a - b$  
- Multiplication: $a \\times b$ or $a \\cdot b$
- Division: $a \\div b$ or $\\frac{a}{b}$
- Equals: $=$, Not equals: $\\neq$

Powers and Roots:
- Superscript: $x^2$, $x^{2n}$, $e^{-x}$
- Subscript: $x_1$, $x_{n+1}$
- Square root: $\\sqrt{x}$, $\\sqrt{x^2 + y^2}$
- Nth root: $\\sqrt[3]{x}$, $\\sqrt[n]{x}$

Fractions:
- Simple: $\\frac{a}{b}$
- Complex: $\\frac{x^2 + 1}{x - 1}$
- Mixed: $2\\frac{1}{3}$

Greek Letters:
- Lowercase: $\\alpha$, $\\beta$, $\\gamma$, $\\delta$, $\\epsilon$, $\\theta$, $\\lambda$, $\\mu$, $\\pi$, $\\sigma$, $\\omega$
- Uppercase: $\\Gamma$, $\\Delta$, $\\Sigma$, $\\Omega$, $\\Phi$

Trigonometry:
- $\\sin(x)$, $\\cos(x)$, $\\tan(x)$
- $\\sin^2(x)$, $\\cos^{-1}(x)$
- $\\sec(x)$, $\\csc(x)$, $\\cot(x)$

Calculus:
- Derivative: $\\frac{dy}{dx}$, $\\frac{d^2y}{dx^2}$
- Partial: $\\frac{\\partial f}{\\partial x}$
- Integral: $\\int f(x)\\, dx$
- Definite: $\\int_a^b f(x)\\, dx$
- Double: $\\iint$, Triple: $\\iiint$
- Limit: $\\lim_{x \\to a} f(x)$
- Summation: $\\sum_{i=1}^{n} a_i$
- Product: $\\prod_{i=1}^{n} a_i$

Relations:
- $<$, $>$, $\\leq$, $\\geq$, $\\neq$
- $\\approx$, $\\equiv$, $\\propto$
- $\\in$ (element of), $\\notin$
- $\\subset$, $\\subseteq$, $\\supset$

Sets and Logic:
- Union: $\\cup$, Intersection: $\\cap$
- Empty set: $\\emptyset$ or $\\varnothing$
- $\\forall$ (for all), $\\exists$ (exists)
- $\\implies$ (implies), $\\iff$ (if and only if)
- $\\land$ (and), $\\lor$ (or), $\\neg$ (not)

Special Symbols:
- Infinity: $\\infty$
- Plus-minus: $\\pm$, Minus-plus: $\\mp$
- Dot product: $\\cdot$, Cross: $\\times$
- Angle: $\\angle$, Degree: $^{\\circ}$
- Perpendicular: $\\perp$, Parallel: $\\parallel$

Matrices and Vectors:
- Vector: $\\vec{v}$ or $\\mathbf{v}$
- Matrix: $\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$
- Determinant: $\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}$

Chemistry (if present):
- Use subscripts: $H_2O$, $CO_2$, $NaCl$
- Reactions: $2H_2 + O_2 \\rightarrow 2H_2O$

Physics:
- Units in text mode: $5 \\text{ m/s}^2$
- Vectors: $\\vec{F} = m\\vec{a}$

PRESERVE SOURCE TEXT EXACTLY (CRITICAL):
• Use the EXACT words from the extracted text
• Do NOT paraphrase, correct spelling, or rephrase
• Only wrap mathematical expressions in $ or $$
• Preserve original numbering: Q1, Q.1, 1., (1), etc.
• Keep option labels as-is: (a), a), A., etc.

QUESTION TYPE DETECTION:
- mcq: Has 4-5 options with (a)/(b)/(c)/(d) or A/B/C/D labels
- truefalse: Explicitly asks "True or False" or has only 2 options
- fill: Has blanks like "_____" or "fill in the blank"
- short: Asks for brief answer, typically 2-3 marks
- long: Asks for detailed explanation, typically 5+ marks
- integer: Asks for numeric answer only
- assertionreason: Has "Assertion:" and "Reason:" statements

JSON SCHEMA (STRICT):
[
  {
    "text": "Complete question text with LaTeX",
    "type": "mcq|truefalse|fill|short|long|integer|assertionreason",
    "options": [
      {"text": "Option text with LaTeX", "isCorrect": true|false}
    ],
    "correctAnswerText": "Answer for non-MCQ",
    "integerAnswer": 42,
    "assertion": "Assertion statement",
    "reason": "Reason statement",
    "assertionIsTrue": true|false,
    "reasonIsTrue": true|false,
    "reasonExplainsAssertion": true|false,
    "questionNumber": "1",
    "subject": "${options.subject || 'Unknown'}",
    "topic": "${options.topic || 'General'}",
    "difficulty": "easy|medium|hard",
    "confidence": 0.0-1.0,
    "needsReview": true|false
  }
]

QUALITY CHECKLIST:
✓ Extract ALL questions (don't skip any)
✓ Identify correct answers from answer keys if present
✓ ALL math in LaTeX with $ or $$
✓ High confidence (>0.8) for clear text
✓ Flag needsReview=true if unclear or confidence<0.7
✓ Appropriate difficulty based on complexity
✓ Return ONLY valid JSON (no markdown, no explanations)

EXTRACTED TEXT TO PARSE:
${extractedText}`;

      const result = await model.generateContent(prompt);
      const response = result.response.text();
      
      // Clean response from code fences and whitespace
      const cleanedResponse = response.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();

      // Robust JSON parsing: try direct parse, then extract array, then attempt to sanitize
      let questions: ExtractedQuestion[] | null = null;
      const attemptParse = (text: string) => {
        try {
          return JSON.parse(text) as ExtractedQuestion[];
        } catch (err) {
          return null;
        }
      };

      // 1) Direct parse
      questions = attemptParse(cleanedResponse);

      // 2) Extract first JSON array-looking substring and try parse
      if (!questions) {
        const jsonMatch = cleanedResponse.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          questions = attemptParse(jsonMatch[0]);

          // 3) If still failing, sanitize common bad escapes (stray backslashes) and retry
          if (!questions) {
            // Replace backslashes that are not part of valid JSON escape sequences with double-backslash
            // Valid escapes are: \" \\ \/ \b \f \n \r \t \uXXXX
            const sanitized = jsonMatch[0].replace(/\\(?!["\\\/bfnrtu])/g, "\\\\");
            try {
              questions = JSON.parse(sanitized) as ExtractedQuestion[];
            } catch (finalErr) {
              // As a last attempt, remove control characters that may break JSON
              const ctrlClean = sanitized.replace(/[\x00-\x1F]/g, '');
              try {
                questions = JSON.parse(ctrlClean) as ExtractedQuestion[];
              } catch (finalErr2) {
                throw new Error(
                  `Failed to parse JSON from Gemini response. Last parse error: ${finalErr2 instanceof Error ? finalErr2.message : String(finalErr2)}. Response snippet: ${ctrlClean.slice(0,1200)}`
                );
              }
            }
          }
        }
      }

      if (!questions) {
        throw new Error('Failed to parse JSON response from Gemini');
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
    const docs = questions.map((q) => ({
      text: q.text,
      type: q.type,
      subject: q.subject || undefined,
      topic: q.topic || undefined,
      difficulty: q.difficulty || 'medium',
      options: q.options,
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
    }));

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
   * Update question review status
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

    return await question.save();
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
        // Normalize question text
        const normalizedText = await normalizeMathematicalExpressions(question.text);
        
        // Normalize options if present
        let normalizedOptions = question.options;
        if (question.options && question.options.length > 0) {
          normalizedOptions = await Promise.all(
            question.options.map(async (opt) => ({
              text: await normalizeMathematicalExpressions(opt.text),
              isCorrect: opt.isCorrect
            }))
          );
        }
        
        // Normalize answer text if present
        let normalizedAnswer = question.correctAnswerText;
        if (normalizedAnswer) {
          normalizedAnswer = await normalizeMathematicalExpressions(normalizedAnswer);
        }
        
        // Normalize assertion-reason if present
        let normalizedAssertion = question.assertion;
        let normalizedReason = question.reason;
        if (normalizedAssertion) {
          normalizedAssertion = await normalizeMathematicalExpressions(normalizedAssertion);
        }
        if (normalizedReason) {
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