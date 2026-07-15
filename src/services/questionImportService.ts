import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import { Types } from 'mongoose';
import { ImportBatch, ImportedQuestion, IImportedQuestion } from '../models/ImportedQuestion';
import { EnhancedQuestionData, saveValidatedQuestion } from './questionValidationService';
import { normalizeMathematicalExpressions } from './mathService';
import { EnhancedPdfQuestionExtractor } from './enhancedPdfQuestionExtractor';
import { extractQuestionsFromChunk, mapOllamaToExtracted } from './ollamaService';
import { extractTextFromImage } from './aiService';
import { runPdfEnhancerPipeline, runTextEnhancerPipeline } from './scriptsBridge';
import { runBatch } from '../ai';
import * as progress from './importProgress';
import { sha256, getFileCache, setFileCache } from './importCache';

dotenv.config();

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
   * ASYNC entry point: create the batch, return it immediately, and run the full
   * import in the BACKGROUND. The HTTP route returns the batchId so the client
   * can poll GET /import-paper/batch/:id for live progress (see importProgress).
   */
  static async startImport(
    filePath: string,
    fileName: string,
    fileType: 'pdf' | 'image',
    uploadedBy: Types.ObjectId,
    options: {
      subject?: string; topic?: string; class?: string; board?: string;
      chapter?: string; section?: string; marks?: number; provider?: 'nvidia' | 'ollama';
    } = {}
  ): Promise<any> {
    const fileStats = fs.statSync(filePath);
    const batch = new ImportBatch({
      fileName: path.basename(filePath),
      originalFileName: fileName,
      fileType,
      fileSize: fileStats.size,
      status: 'processing',
      processingStarted: new Date(),
      ocrProvider: 'pdf-parse',
      processingModel: options.provider === 'nvidia'
        ? `nvidia-${process.env.NVIDIA_MODEL_PRIMARY || 'nemotron-super-49b'}`
        : 'ollama-qwen3:8b-enhanced',
      uploadedBy,
    });
    await batch.save();
    progress.initProgress(batch._id);

    // Fire-and-forget: progress + status live on the batch; never block the request.
    this.importQuestionPaper(filePath, fileName, fileType, uploadedBy, { ...options, existingBatch: batch })
      .catch((err) => {
        console.error('[Import] Background import failed:', err instanceof Error ? err.message : err);
        progress.failProgress(batch._id, err instanceof Error ? err.message : String(err));
      });

    return batch;
  }

  /**
   * Main entry point for importing question papers - ENHANCED VERSION
   * Uses new robust extractor with deduplication and proper chapter detection
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
      useEnhancedExtractor?: boolean;
      provider?: 'nvidia' | 'ollama';
      existingBatch?: any;
    } = {}
  ): Promise<ImportResult> {
    const startTime = Date.now();
    
    // Use enhanced extractor by default for PDFs
    const useEnhanced = options.useEnhancedExtractor !== false && fileType === 'pdf';

    if (useEnhanced) {
      console.log(`[Import] Using ENHANCED PDF extractor (${options.provider === 'nvidia' ? 'NVIDIA cloud' : 'Ollama qwen3:8b'} + chunking + deduplication)`);
      return await this.importWithEnhancedExtractor(filePath, fileName, uploadedBy, options);
    }

    const aiLabel = options.provider === 'nvidia' ? 'NVIDIA cloud' : 'Ollama qwen3:8b';
    console.log(`[Import] Using LEGACY extractor (${aiLabel})`);

    try {
      console.log(`[Import] Starting import for file: ${fileName}`);
      console.log(`[Import] Pipeline: OCR → ${aiLabel}`);
      
      // Use the pre-created batch (async flow) or create one (back-compat).
      const fileStats = fs.statSync(filePath);
      const batch = options.existingBatch || new ImportBatch({
        fileName: path.basename(filePath),
        originalFileName: fileName,
        fileType,
        fileSize: fileStats.size,
        status: 'processing',
        processingStarted: new Date(),
        ocrProvider: 'pdf-parse',
        processingModel: options.provider === 'nvidia'
          ? `nvidia-${process.env.NVIDIA_MODEL_PRIMARY || 'nemotron-super-49b'}`
          : 'ollama-qwen3:8b',
        uploadedBy
      });
      if (!options.existingBatch) await batch.save();
      const batchId = batch._id as Types.ObjectId;
      console.log(`[Import] Batch ${batchId}`);
      progress.setStage(batchId, 'extracting');

      let extractedText: string;
      let totalPages = 1;

      // Step 1: Extract text (OCR for images, pdf-parse for PDFs)
      console.log(`[Import] Step 1: Extracting text...`);

      if (fileType === 'pdf') {
        const result = await this.extractTextFromPDF(filePath);
        extractedText = result.text;
        totalPages = result.pages;
      } else {
        // Image: OCR via NVIDIA vision (cloud) or Tesseract (local).
        const useVision = options.provider === 'nvidia';
        console.log(`[Import] OCR image via ${useVision ? 'NVIDIA vision (cloud)' : 'Tesseract (local)'}...`);
        const imgBuffer = await fs.promises.readFile(filePath);
        const ocrText = await extractTextFromImage(imgBuffer, useVision);
        extractedText = ocrText && ocrText.trim() ? `\n\n=== PAGE 1 ===\n${ocrText}` : '';
        totalPages = 1;
        batch.ocrProvider = useVision ? 'nvidia-vision' : 'tesseract';
      }

      console.log(`[Import] Extracted ${extractedText.length} characters from ${totalPages} page(s)`);
      const textPreview = extractedText.slice(0, 200).replace(/\n/g, ' ');
      console.log(`[Import] Text preview: ${textPreview}...`);

      // Update batch with page count
      batch.totalPages = totalPages;
      await batch.save();

      // Step 2: Per-question enhancement (split + LLM cleanup/classify).
      console.log(`[Import] Step 2: Enhancing questions with ${aiLabel}...`);
      progress.setStage(batchId, 'parsing');
      let questions: any[];
      try {
        const result = await runTextEnhancerPipeline(
          extractedText,
          { subject: options.subject, topic: options.topic, chapter: options.chapter, class: options.class, board: options.board },
          options.provider,
          {
            onProgress: (done, total) => {
              progress.setStage(batchId, 'enhancing');
              progress.setTotal(batchId, total);
              progress.setProcessed(batchId, done);
            },
          }
        );
        questions = result.questions;
      } catch (enhErr) {
        console.warn('[Import] Enhancer pipeline failed, falling back to chunk structuring:', enhErr instanceof Error ? enhErr.message : enhErr);
        questions = await this.structureQuestionsWithOllama(
          extractedText,
          { subject: options.subject, topic: options.topic, provider: options.provider }
        );
      }

      console.log(`[Import] Extracted ${questions.length} questions`);
      batch.totalQuestions = questions.length;

      // Step 3: Normalize mathematical expressions in all questions
      progress.setStage(batchId, 'validating');
      console.log(`[Import] Step 3: Normalizing mathematical expressions...`);
      const normalizedQuestions = await this.normalizeQuestionsWithLaTeX(questions);

      // Step 4: Save questions to database with metadata
      progress.setStage(batchId, 'saving');
      console.log(`[Import] Step 4: Saving questions to database...`);
      const savedQuestions = await this.saveQuestions(
        normalizedQuestions,
        batchId,
        uploadedBy,
        {
          subject: options.subject,
          topic: options.topic,
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
      progress.completeProgress(batchId);

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
        const batch = options.existingBatch || await ImportBatch.findOne({ fileName: path.basename(filePath), uploadedBy }).sort({ createdAt: -1 });
        if (batch) {
          batch.status = 'failed';
          batch.processingErrors = batch.processingErrors || [];
          batch.processingErrors.push({ error: errorMessage, timestamp: new Date() });
          batch.totalProcessingTime = processingTime;
          await batch.save();
          progress.failProgress(batch._id, errorMessage);
        }
      } catch (updateError) {
        console.error('Failed to update batch status:', updateError);
      }

      throw error;
    }
  }

  /**
   * Import questions using ENHANCED extractor (new robust implementation)
   * Handles ALL questions, deduplication, proper chapter/topic naming, and figures
   */
  private static async importWithEnhancedExtractor(
    filePath: string,
    fileName: string,
    uploadedBy: Types.ObjectId,
    options: {
      subject?: string;
      topic?: string;
      class?: string;
      board?: string;
      chapter?: string;
      section?: string;
      marks?: number;
      model?: string; // optional model override (provider-agnostic)
      provider?: 'nvidia' | 'ollama';
      existingBatch?: any;
    }
  ): Promise<ImportResult> {
    const startTime = Date.now();
    
    try {
      console.log(`[Enhanced Import] Starting import for file: ${fileName}`);
      
      // Use the pre-created batch (async flow) or create one (back-compat).
      const fileStats = fs.statSync(filePath);
      const batch = options.existingBatch || new ImportBatch({
        fileName: path.basename(filePath),
        originalFileName: fileName,
        fileType: 'pdf',
        fileSize: fileStats.size,
        status: 'processing',
        processingStarted: new Date(),
        ocrProvider: 'pdf-parse',
        processingModel: options.provider === 'nvidia'
          ? `nvidia-${process.env.NVIDIA_MODEL_PRIMARY || 'nemotron-super-49b'}`
          : 'ollama-qwen3:8b-enhanced',
        uploadedBy
      });
      if (!options.existingBatch) await batch.save();
      const batchId = batch._id as Types.ObjectId;
      console.log(`[Enhanced Import] Batch ${batchId}`);

      progress.setStage(batchId, 'extracting');
      const pdfBuffer = await fs.promises.readFile(filePath);
      const cacheKey = `${sha256(pdfBuffer)}:${options.provider || 'ollama'}`;

      let questions: any[];
      let structure: any;
      let stats: any;

      // Req #5: skip parse + AI entirely if this exact PDF was processed before.
      const cached: any = await getFileCache(cacheKey);
      if (cached && Array.isArray(cached.questions) && cached.questions.length) {
        console.log(`[Enhanced Import] ✓ Cache HIT (${cached.questions.length} questions) — skipping parse + AI`);
        questions = cached.questions;
        structure = cached.structure || { totalPages: 1, chapters: [] };
        stats = cached.stats || { total: questions.length, duplicatesRemoved: 0, withDiagrams: 0, byType: {}, byChapter: {} };
        progress.setStage(batchId, 'enhancing');
        progress.setTotal(batchId, questions.length);
        progress.setProcessed(batchId, questions.length);
      } else {
        progress.setStage(batchId, 'parsing');
        console.log(`[Enhanced Import] Deterministic split + parallel/batched per-question enhancement (${options.provider === 'nvidia' ? 'NVIDIA cloud' : 'Ollama local'})...`);
        try {
          const result = await runPdfEnhancerPipeline(
            filePath,
            { subject: options.subject, board: options.board, class: options.class, chapter: options.chapter, topic: options.topic },
            options.provider,
            {
              onProgress: (done, total) => {
                progress.setStage(batchId, 'enhancing');
                progress.setTotal(batchId, total);
                progress.setProcessed(batchId, done);
              },
            }
          );
          questions = result.questions;
          structure = result.structure;
          stats = result.stats;
          // Cache for instant re-uploads of the same PDF.
          setFileCache(cacheKey, { questions, structure, stats }).catch(() => {});
          console.log(`[Enhanced Import] Pipeline produced ${questions.length} questions`);
        } catch (pipelineErr) {
          console.warn('[Enhanced Import] Pipeline failed, falling back to chunk extractor:', pipelineErr instanceof Error ? pipelineErr.message : pipelineErr);
          const extractor = new EnhancedPdfQuestionExtractor(pdfBuffer, fileName, uploadedBy, {
            subject: options.subject,
            topic: options.topic,
            class: options.class,
            board: options.board,
            chapter: options.chapter,
            provider: options.provider,
          });
          const r = await extractor.extract();
          questions = r.questions;
          structure = r.structure;
          stats = r.stats;
        }
      }

      console.log(`[Enhanced Import] ✓ Extraction complete: ${stats.total} questions, by type: ${JSON.stringify(stats.byType)}`);

      // Update batch with metadata
      batch.totalPages = structure.totalPages || 0;
      batch.totalQuestions = questions.length;
      await batch.save();

      // Normalize mathematical expressions
      progress.setStage(batchId, 'validating');
      console.log('[Enhanced Import] Normalizing mathematical expressions...');
      const normalizedQuestions = await this.normalizeQuestionsWithLaTeX(questions);

      // Save questions to database
      progress.setStage(batchId, 'saving');
      console.log('[Enhanced Import] Saving questions to database...');
      const savedQuestions = await this.saveQuestions(
        normalizedQuestions,
        batchId,
        uploadedBy,
        {
          subject: options.subject,
          topic: options.topic,
          class: options.class || structure.className,
          board: options.board || structure.board,
          chapter: options.chapter,
          section: options.section,
          marks: options.marks
        }
      );

      console.log(`[Enhanced Import] Saved ${savedQuestions.length} questions`);

      // Update imports collection (aggregate)
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
        console.warn('[Enhanced Import] Failed to upsert Imports aggregate:', e);
      }

      // Update batch status with enhanced stats
      const processingTime = Date.now() - startTime;
      batch.status = 'completed';
      batch.processingCompleted = new Date();
      batch.totalQuestions = questions.length;
      batch.processedQuestions = savedQuestions.length;
      batch.totalProcessingTime = processingTime;
      
      // Add extraction stats to batch
      (batch as any).extractionStats = {
        duplicatesRemoved: stats.duplicatesRemoved,
        chaptersDetected: structure.chapters.length,
        withDiagrams: stats.withDiagrams,
        byType: stats.byType,
        byChapter: stats.byChapter
      };
      
      await batch.save();
      progress.completeProgress(batchId);

      console.log(`[Enhanced Import] ✓ Import completed in ${processingTime}ms`);
      console.log(`[Enhanced Import] Success rate: ${Math.round((savedQuestions.length / Math.max(1, questions.length)) * 100)}%`);

      return {
        success: true,
        batchId: batch._id as Types.ObjectId,
        totalQuestions: questions.length,
        processedQuestions: savedQuestions.length,
        errors: [],
        processingTime
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('[Enhanced Import] Import failed:', errorMessage);

      // Try to update batch if it exists
      try {
        const batch = options.existingBatch || await ImportBatch.findOne({
          fileName: path.basename(filePath),
          uploadedBy
        }).sort({ createdAt: -1 });

        if (batch) {
          batch.status = 'failed';
          batch.processingErrors = batch.processingErrors || [];
          batch.processingErrors.push({ error: errorMessage, timestamp: new Date() });
          batch.totalProcessingTime = processingTime;
          await batch.save();
          progress.failProgress(batch._id, errorMessage);
        }
      } catch (updateError) {
        console.error('[Enhanced Import] Failed to update batch status:', updateError);
      }

      throw error;
    }
  }

  /**
   * Extract text from PDF using pdf-parse (local, no cloud).
   */
  private static async extractTextFromPDF(filePath: string): Promise<{ text: string; pages: number }> {
    try {
      console.log(`[pdf-parse] Processing PDF: ${filePath}`);
      const dataBuffer = await fs.promises.readFile(filePath);
      const pdfData = await pdfParse(dataBuffer as any);
      const numPages = pdfData.numpages || 1;

      const rawText = pdfData.text || '';
      const pageBlocks = rawText.split(/\f/).filter((p: string) => p.trim());

      let combinedText: string;
      if (pageBlocks.length > 1) {
        combinedText = pageBlocks
          .map((pg: string, idx: number) => `\n\n=== PAGE ${idx + 1} ===\n${pg}`)
          .join('\n');
      } else {
        combinedText = `\n\n=== PAGE 1 ===\n${rawText}`;
      }

      console.log(`[pdf-parse] Extracted ${combinedText.length} chars from ${numPages} pages`);
      return { text: combinedText, pages: numPages };
    } catch (error) {
      throw new Error(`PDF extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Structure extracted text into questions using local Ollama qwen3:8b.
   * Processes text in ~1200-char chunks sequentially (concurrency=1).
   */
  private static async structureQuestionsWithOllama(
    extractedText: string,
    options: { subject?: string; topic?: string; provider?: 'nvidia' | 'ollama' }
  ): Promise<ExtractedQuestion[]> {
    const CHUNK_CHARS = 1200;
    const allQuestions: ExtractedQuestion[] = [];

    // Split into page blocks then chunk
    const pageBlocks = extractedText.split(/=== PAGE \d+ ===/).filter(b => b.trim());
    const chunks: string[] = [];
    let buffer = '';

    for (const page of pageBlocks) {
      if (buffer.length + page.length > CHUNK_CHARS && buffer.length > 0) {
        chunks.push(buffer);
        buffer = page.trim();
      } else {
        buffer += (buffer ? '\n' : '') + page.trim();
      }
    }
    if (buffer.trim()) chunks.push(buffer);

    console.log(`[Ollama] Processing ${chunks.length} text chunks...`);

    let questionIndex = 0;
    for (let i = 0; i < chunks.length; i++) {
      console.log(`[Ollama] Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
      const ollamaQuestions = await extractQuestionsFromChunk(chunks[i], {
        subject: options.subject,
        startPage: i + 1,
        provider: options.provider,
      });

      const mapped = ollamaQuestions.map((q, idx) => {
        const m = mapOllamaToExtracted(q, questionIndex + idx, i + 1);
        return {
          text: m.text,
          type: m.type,
          options: m.options,
          correctAnswerText: m.correctAnswerText,
          questionNumber: m.questionNumber,
          subject: m.subject,
          topic: options.topic || m.topic,
          difficulty: m.difficulty,
          confidence: m.confidence,
          needsReview: m.needsReview,
        } as ExtractedQuestion;
      });
      questionIndex += ollamaQuestions.length;
      allQuestions.push(...mapped);
    }

    console.log(`[Ollama] Total questions extracted: ${allQuestions.length}`);
    return allQuestions;
  }

  /**
   * Strict, order-preserving question parser (fallback, no AI)
   */
  private static structureQuestionsStrict(
    extractedText: string,
    opts: { subject?: string; topic?: string }
  ): ExtractedQuestion[] {
    const text = extractedText.replace(/\r\n/g, '\n');
    
    // Enhanced question header patterns to capture sub-questions
    // Matches: Q1., 1., 1), 3a., 3b), 4(a), 4(b), 5i., 5ii), etc.
    const qHeader = /(^|\n)\s*(?:Q\s*)?(\d{1,3}(?:[a-z]|[ivxl]{1,4}|\([a-z]\)|\s[a-z])?)\s*(?:[\.:\)]|\s*-\s*|\s+)/gi;
    const indices: Array<{ num: string; start: number; end?: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = qHeader.exec(text)) !== null) {
      const idxStart = m.index + (m[1] ? m[1].length : 0);
      const questionNum = m[2].trim();
      indices.push({ num: questionNum, start: idxStart });
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





  // structureQuestionsWithVertexAI removed — use structureQuestionsWithOllama

  // parseTextBlockResponse removed — Ollama uses JSON mode


  /**
   * Save structured questions to database with validation
   */
  private static async saveQuestions(
    questions: ExtractedQuestion[],
    batchId: Types.ObjectId,
    extractedBy: Types.ObjectId,
    metadata?: {
      subject?: string;
      topic?: string;
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
        // Req #1: user-selected metadata wins; only fall back to AI when absent.
        subject: metadata?.subject || q.subject || undefined,
        topic: metadata?.topic || q.topic || undefined,
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

    // PARALLEL across questions (bounded), not one-question-at-a-time: the old
    // sequential loop made a 5-question image wait minutes here. Each
    // normalizeMathematicalExpressions call also now skips the LLM entirely
    // when the text has no math, so most questions cost 0 calls.
    const { results } = await runBatch(
      questions,
      (question) => this.normalizeOneQuestion(question),
      { concurrency: Math.max(1, Number(process.env.AI_ENHANCER_CONCURRENCY || 6)) },
    );
    // runBatch preserves order; a failed item degrades to its original.
    const normalized = results.map((r, i) => r ?? questions[i]);

    console.log(`[LaTeX Normalize] Completed normalizing ${normalized.length} questions`);
    return normalized;
  }

  private static async normalizeOneQuestion(question: ExtractedQuestion): Promise<ExtractedQuestion> {
    {
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
        
        return {
          ...question,
          text: normalizedText,
          options: normalizedOptions,
          correctAnswerText: normalizedAnswer,
          assertion: normalizedAssertion,
          reason: normalizedReason
        };
      } catch (error) {
        console.error(`[LaTeX Normalize] Error normalizing question ${question.questionNumber}:`, error);
        // Keep original if normalization fails
        return question;
      }
    }
  }
}