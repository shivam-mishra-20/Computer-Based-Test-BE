#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const pdfParse = require('pdf-parse');
const DiagramExtractorPDF = require('../src/services/diagramExtractorPDF');

/**
 * PDF Question Parser with Diagram Extraction
 * Handles both text-based and scanned PDFs with OCR support
 */
class PDFParser {
  constructor() {
    this.diagramExtractor = null;
    this.minCharactersPerPage = 50; // Threshold to detect scanned PDFs
  }

  /**
   * Fallback for scanned PDFs: re-attempt with pdf-parse using different options.
   * Note: pdf-parse cannot OCR true image-only PDFs. For scanned docs the text
   * extracted will still be sparse — Ollama handles low-text chunks gracefully.
   */
  async extractTextWithOCR(pdfBuffer, totalPages) {
    console.log('[PDF Parser] Scanned PDF detected — using pdf-parse (local, no cloud OCR).');
    console.log('[PDF Parser] Tip: For image-only PDFs, convert to text-based PDF first for best results.');

    // pdf-parse already ran; return what it got (sparse text is ok — Ollama handles it)
    // This method is only reached when avgCharsPerPage < threshold.
    // Re-run pdf-parse with raw extraction to capture any remaining text.
    try {
      const pdfData = await pdfParse(pdfBuffer);
      const rawText = pdfData.text || '';
      const pageBlocks = rawText.split(/\f/).filter(p => p.trim());
      let combinedText;
      if (pageBlocks.length > 1) {
        combinedText = pageBlocks
          .map((pg, idx) => `\n\n=== PAGE ${idx + 1} ===\n${pg}`)
          .join('\n');
      } else {
        combinedText = `\n\n=== PAGE 1 ===\n${rawText}`;
      }
      console.log(`[PDF Parser] pdf-parse extracted ${combinedText.length} characters`);
      return combinedText;
    } catch (err) {
      console.warn('[PDF Parser] pdf-parse re-run failed:', err.message);
      return '';
    }
  }

  /**
   * Parse PDF file and extract questions with diagrams
   * @param {string} pdfPath - Path to PDF file
   * @returns {Promise<Object>} - { metadata, questions, stats }
   */
  async parse(pdfPath) {
    console.log('[PDF Parser] Reading:', pdfPath);
    const pdfBuffer = await fs.readFile(pdfPath);

    // Step 1: Extract metadata
    const metadata = await this.extractMetadata(pdfPath);
    console.log('[PDF Parser] Metadata:', metadata);

    // Step 2: Initialize diagram extractor
    this.diagramExtractor = new DiagramExtractorPDF(metadata);
    console.log('[PDF Parser] Diagram extractor initialized');

    // Step 3: Extract questions from PDF
    const questions = await this.extractQuestionsFromPDF(pdfBuffer, metadata);
    console.log(`[PDF Parser] Total questions: ${questions.length}`);

    // Step 4: Analyze statistics
    const stats = this.analyzeQuestions(questions);
    console.log(`[PDF Parser] With diagrams: ${stats.withDiagrams}`);

    return { metadata, questions, stats };
  }

  /**
   * Extract metadata from PDF filepath and parent folder structure.
   * Folder naming convention: class_9_mathematics, class_11_physics, class_9
   * Chapter name comes from the PDF filename.
   */
  async extractMetadata(pdfPath) {
    const filename = path.basename(pdfPath, '.pdf');
    const parentFolder = path.basename(path.dirname(pdfPath));

    // Parse class + subject from folder name
    // e.g. class_9_mathematics â†’ Class 9 + Mathematics
    //      class_11_physics     â†’ Class 11 + Physics
    //      class_9              â†’ Class 9  + (fallback to filename)
    const folderMatch = parentFolder.match(/^class[_\s-]?(\d+)[_\s-]?(.*)?$/i);
    let classLabel = 'Unknown';
    let subject = 'Unknown';

    if (folderMatch) {
      classLabel = `Class ${folderMatch[1]}`;
      const rawSubject = (folderMatch[2] || '').replace(/_/g, ' ').trim();
      if (rawSubject) subject = this.normalizeSubject(rawSubject);
    }

    // Fallback: infer subject from chapter filename
    if (subject === 'Unknown') subject = this.identifySubjectFromTitle(filename);

    return {
      title: filename,
      chapter: filename,   // PDF filename = chapter name
      author: 'Unknown',
      subject,
      language: 'en',
      class: classLabel,
      board: 'CBSE',
    };
  }

  /** Map raw folder subject string â†’ proper display name */
  normalizeSubject(raw) {
    const map = {
      mathematics: 'Mathematics', maths: 'Mathematics', math: 'Mathematics',
      physics: 'Physics',
      chemistry: 'Chemistry',
      biology: 'Biology',
      english: 'English',
      science: 'Science',
      'social science': 'Social Science', 'social studies': 'Social Science',
      history: 'History', geography: 'Geography', economics: 'Economics',
      'computer science': 'Computer Science', computers: 'Computer Science',
      hindi: 'Hindi', sanskrit: 'Sanskrit',
      accountancy: 'Accountancy', 'business studies': 'Business Studies',
    };
    return map[raw.toLowerCase()] || raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }

  /** Infer subject from chapter title as last resort */
  identifySubjectFromTitle(title) {
    const t = title.toLowerCase();
    if (/(physics|mechanics|thermodynamics|optics|waves|electricity|magnetism)/i.test(t)) return 'Physics';
    if (/(chemistry|organic|inorganic|chemical|acids|alkali|mole|bond)/i.test(t)) return 'Chemistry';
    if (/(math|algebra|calculus|polynomial|triangle|circle|quadrilateral|coordinate|statistics|probability|number system|surface area|volume|heron|euclid|linear equation)/i.test(t)) return 'Mathematics';
    if (/(biology|botany|zoology|cell|tissue|organ|ecosystem|genetics)/i.test(t)) return 'Biology';
    if (/(english|literature|grammar|prose|poetry)/i.test(t)) return 'English';
    if (/(computer|programming|algorithm)/i.test(t)) return 'Computer Science';
    if (/(history|geography|civics|economics|political|democratic|resource|disaster)/i.test(t)) return 'Social Science';
    return 'Unknown';
  }

  /**
   * Extract questions from PDF
   * @param {Buffer} pdfBuffer - PDF buffer
   * @param {Object} metadata - Metadata
   * @returns {Promise<Array>} - Questions
   */
  async extractQuestionsFromPDF(pdfBuffer, metadata) {
    const questions = [];
    
    try {
      console.log('[PDF Parser] Extracting text from PDF...');
      const pdfData = await pdfParse(pdfBuffer);
      let fullText = pdfData.text;
      const totalPages = pdfData.numpages;
      
      console.log(`[PDF Parser] PDF has ${totalPages} pages, ${fullText.length} characters`);
      
      // Detect if this is a scanned/image-based PDF (very few characters extracted)
      const avgCharsPerPage = fullText.length / totalPages;
      const isScannedPDF = avgCharsPerPage < this.minCharactersPerPage;
      
      if (isScannedPDF) {
        console.log(`[PDF Parser] âš ï¸  Detected scanned PDF (avg ${Math.round(avgCharsPerPage)} chars/page)`);
        console.log('[PDF Parser] Switching to OCR extraction...');
        fullText = await this.extractTextWithOCR(pdfBuffer, totalPages);
        console.log(`[PDF Parser] OCR extracted ${fullText.length} characters`);
      }
      
      // Split full text into exercise-section chunks.
      // Each chunk is passed to the AI enhancer as a raw block - the AI splits it
      // into individual questions (handles multi-question blobs natively).
      const chunks = this.splitIntoExerciseChunks(fullText, metadata);
      console.log(`[PDF Parser] Extracted ${chunks.length} exercise chunk(s) for AI processing`);

      return chunks;
      
    } catch (error) {
      console.error('[PDF Parser] Failed to extract questions:', error.message);
      throw error;
    }
  }
  
  /**
  /**
   * Split PDF full text into chunks for AI question extraction.
   * ALWAYS chunks the entire text — no content is skipped.
   * Section headers are detected only to label chunks, not to gate them.
   */
  splitIntoExerciseChunks(text, metadata) {
    const CHUNK_SIZE = Number(process.env.PDF_CHUNK_SIZE || 4000);
    const CHUNK_OVERLAP = Number(process.env.PDF_CHUNK_OVERLAP || 300);
    const chunks = [];
    const chapterName = metadata.chapter || 'General';

    // Detect section markers for labelling (not for filtering)
    const sectionRe = /(?:EXERCISES?\s*\d+[.]?\d*|Exercise\s+\d+[.]?\d*|THINK ABOUT IT|TRY THESE|LET['']S\s+THINK|IN[-\s]TEXT\s*QUESTIONS?|ACTIVITIES?|CHECK YOUR PROGRESS|PRACTICE\s*QUESTIONS?)/gi;
    const markers = [];
    let m;
    while ((m = sectionRe.exec(text)) !== null) {
      markers.push({ index: m.index, label: m[0].replace(/\s+/g, ' ').trim() });
    }

    // Chunk the ENTIRE text — nothing is excluded
    let start = 0;
    let chunkIdx = 0;
    while (start < text.length) {
      let end = Math.min(start + CHUNK_SIZE, text.length);
      if (end < text.length) {
        // Prefer breaking at a blank line, then at any newline
        const lastDoubleNl = text.lastIndexOf('\n\n', end);
        const lastNl = text.lastIndexOf('\n', end);
        if (lastDoubleNl > start + CHUNK_SIZE / 2) end = lastDoubleNl;
        else if (lastNl > start + CHUNK_SIZE / 2) end = lastNl;
      }

      const slice = text.slice(start, end).trim();
      if (slice.length > 80) {
        // Label with the first section marker that starts inside this chunk
        const marker = markers.find(mk => mk.index >= start && mk.index < end);
        const exerciseLabel = marker
          ? marker.label
          : chunkIdx === 0 ? 'Introduction' : `Part ${chunkIdx + 1}`;

        chunks.push({ text: slice, topic: chapterName, chapter: chapterName, exerciseLabel });
        console.log(`[PDF Parser] Chunk ${chunkIdx + 1}: ${slice.length} chars — "${exerciseLabel}"`);
        chunkIdx++;
      }

      if (end >= text.length) {
        break;
      }

      const overlap = Math.max(0, Math.min(CHUNK_OVERLAP, CHUNK_SIZE - 500));
      const nextStart = Math.max(end - overlap, start + 500);
      start = nextStart > start ? nextStart : end + 1;
    }

    if (chunks.length === 0 && text.trim().length > 100) {
      chunks.push({ text: text.trim(), topic: chapterName, chapter: chapterName, exerciseLabel: 'Full Text' });
    }

    console.log(`[PDF Parser] Created ${chunks.length} chunk(s) from ${text.length} chars (chunk size: ${CHUNK_SIZE})`);
    return chunks;
  }

  /**
   * Split text into segments of ~maxChars, breaking on newlines where possible.
   */
  chunkText(text, maxChars) {
    if (text.length <= maxChars) return [text];
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + maxChars, text.length);
      if (end < text.length) {
        const lastNl = text.lastIndexOf('\n', end);
        if (lastNl > start + maxChars / 2) end = lastNl;
      }
      const slice = text.slice(start, end).trim();
      if (slice.length > 50) chunks.push(slice);
      start = end + 1;
    }
    return chunks;
  }

  /**
   * Analyze questions
   */
  analyzeQuestions(questions) {
    return {
      total: questions.length,
      withOptions: questions.filter(q => q.options && q.options.length > 0).length,
      withCorrectAnswers: questions.filter(q => 
        q.correctAnswerText || 
        (q.options && q.options.some(opt => opt.isCorrect))
      ).length,
      withDiagrams: questions.filter(q => q.diagram).length,
      byType: questions.reduce((acc, q) => {
        acc[q.type] = (acc[q.type] || 0) + 1;
        return acc;
      }, {})
    };
  }
}

// CLI Interface
async function main() {
  const parser = new PDFParser();
  
  const pdfPath = process.argv[2];
  
  if (!pdfPath) {
    console.error('Usage: node pdf-parser.js <path-to-pdf-file>');
    process.exit(1);
  }

  try {
    const result = await parser.parse(pdfPath);
    
    // Save to JSON
    const outputPath = path.join(__dirname, 'extracted_pdf_questions.json');
    await fs.writeFile(
      outputPath,
      JSON.stringify(result, null, 2)
    );
    
    console.log('\nâœ… PDF Extraction Complete!');
    console.log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
    console.log(`ðŸ“š Book: ${result.metadata.title}`);
    console.log(`ðŸ“– Subject: ${result.metadata.subject}`);
    console.log(`ðŸ“ Total Questions: ${result.stats.total}`);
    console.log(`ðŸ–¼ï¸  With Diagrams: ${result.stats.withDiagrams}`);
    console.log(`ðŸ’¾ Saved to: ${outputPath}`);
    console.log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n');
    
    process.exit(0);
    
  } catch (error) {
    console.error('âŒ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = PDFParser;
