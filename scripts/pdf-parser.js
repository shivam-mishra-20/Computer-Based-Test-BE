#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const DiagramExtractorPDF = require('../src/services/diagramExtractorPDF');

/**
 * PDF Question Parser with Diagram Extraction
 * Handles both text-based and scanned PDFs
 */
class PDFParser {
  constructor() {
    this.diagramExtractor = null;
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
   * Extract metadata from PDF filename
   * @param {string} pdfPath - Path to PDF
   * @returns {Promise<Object>} - Metadata
   */
  async extractMetadata(pdfPath) {
    const filename = path.basename(pdfPath, '.pdf');
    
    return {
      title: filename,
      author: 'Unknown',
      subject: this.identifySubjectFromTitle(filename),
      language: 'en',
      class: this.extractClassFromFilename(filename),
      board: this.extractBoardFromTitle(filename)
    };
  }

  /**
   * Identify subject from title
   */
  identifySubjectFromTitle(title) {
    const titleLower = title.toLowerCase();

    if (/(physics|mechanics|thermodynamics)/i.test(titleLower)) return 'Physics';
    if (/(chemistry|organic|inorganic)/i.test(titleLower)) return 'Chemistry';
    if (/(mathematics|math|algebra|calculus)/i.test(titleLower)) return 'Mathematics';
    if (/(biology|botany|zoology)/i.test(titleLower)) return 'Biology';
    if (/(english|literature)/i.test(titleLower)) return 'English';
    if (/(computer|programming)/i.test(titleLower)) return 'Computer Science';
    if (/(history|geography|civics)/i.test(titleLower)) return 'Social Science';

    return 'Unknown';
  }

  /**
   * Extract class from filename
   */
  extractClassFromFilename(filename) {
    const classMatch = filename.match(/(?:class|std)\s*(\d+|xi{1,3}|i{1,3}v?)/i);
    if (classMatch) {
      const classNum = classMatch[1].toUpperCase();
      if (classNum === 'XII' || classNum === '12') return 'Class 12';
      if (classNum === 'XI' || classNum === '11') return 'Class 11';
      if (classNum === 'X' || classNum === '10') return 'Class 10';
      return `Class ${classNum}`;
    }
    return 'Unknown';
  }

  /**
   * Extract board from title
   */
  extractBoardFromTitle(title) {
    const lower = title.toLowerCase();
    if (/ncert/i.test(lower)) return 'NCERT';
    if (/cbse/i.test(lower)) return 'CBSE';
    if (/jee/i.test(lower)) return 'JEE';
    if (/neet/i.test(lower)) return 'NEET';
    return 'CBSE';
  }

  /**
   * Extract questions from PDF
   * Simplified version - production would use pdf-parse or pdfjs-dist
   * @param {Buffer} pdfBuffer - PDF buffer
   * @param {Object} metadata - Metadata
   * @returns {Promise<Array>} - Questions
   */
  async extractQuestionsFromPDF(pdfBuffer, metadata) {
    const questions = [];
    
    // TODO: Implement full PDF text extraction using pdf-parse or pdfjs-dist
    // For now, returning mock structure
    console.warn('[PDF Parser] Full PDF text extraction not yet implemented');
    console.log('[PDF Parser] Use pdf-parse or pdfjs-dist for production');

    // Example: Extract from page 1 with diagram
    const questionContext = {
      chapter: 'Chapter 1',
      questionNumber: '1'
    };

    const diagramMetadata = await this.diagramExtractor.extractDiagramFromPage(
      pdfBuffer, 
      1, 
      questionContext
    );

    // Mock question for demonstration
    questions.push({
      text: 'Sample question from PDF (implement full extraction)',
      type: 'mcq',
      options: [
        { text: 'Option A', isCorrect: false },
        { text: 'Option B', isCorrect: true }
      ],
      subject: metadata.subject,
      topic: 'General',
      chapter: 'Chapter 1',
      board: metadata.board,
      class: metadata.class,
      difficulty: 'medium',
      marks: 1,
      diagram: diagramMetadata,  // Firebase metadata
      source: 'PDF Import',
      isActive: true,
      questionNumber: '1'
    });

    return questions;
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
    
    console.log('\n✅ PDF Extraction Complete!');
    console.log('═══════════════════════════════════════');
    console.log(`📚 Book: ${result.metadata.title}`);
    console.log(`📖 Subject: ${result.metadata.subject}`);
    console.log(`📝 Total Questions: ${result.stats.total}`);
    console.log(`🖼️  With Diagrams: ${result.stats.withDiagrams}`);
    console.log(`💾 Saved to: ${outputPath}`);
    console.log('═══════════════════════════════════════\n');
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = PDFParser;
