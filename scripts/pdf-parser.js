#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const pdfParse = require('pdf-parse');
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
   * @param {Buffer} pdfBuffer - PDF buffer
   * @param {Object} metadata - Metadata
   * @returns {Promise<Array>} - Questions
   */
  async extractQuestionsFromPDF(pdfBuffer, metadata) {
    const questions = [];
    
    try {
      console.log('[PDF Parser] Extracting text from PDF...');
      const pdfData = await pdfParse(pdfBuffer);
      const fullText = pdfData.text;
      const totalPages = pdfData.numpages;
      
      console.log(`[PDF Parser] PDF has ${totalPages} pages, ${fullText.length} characters`);
      
      // Split text by pages (approximate - pdf-parse doesn't provide page breaks reliably)
      // We'll use line breaks and common patterns
      const lines = fullText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
      
      let currentChapter = 'General';
      let questionNumber = 1;
      let i = 0;
      
      while (i < lines.length) {
        const line = lines[i];
        
        // Detect chapter headers
        const chapterMatch = line.match(/^(?:Chapter|CHAPTER)\s+(\d+|[IVX]+)[:\s\-]?\s*(.+)/i);
        if (chapterMatch) {
          currentChapter = chapterMatch[2] || `Chapter ${chapterMatch[1]}`;
          console.log(`[PDF Parser] Found chapter: ${currentChapter}`);
          i++;
          continue;
        }
        
        // Detect exercise/question sections
        const exerciseMatch = line.match(/^(Exercise|EXERCISE|Questions|QUESTIONS|MCQ|Practice)\s+(\d+\.?\d*)/i);
        if (exerciseMatch) {
          console.log(`[PDF Parser] Found exercise section: ${line}`);
          i++;
          continue;
        }
        
        // Detect numbered questions: "1. Question text" or "Q1. Question text" or "Q.1 Question text"
        const questionMatch = line.match(/^(?:Q\.?\s*)?(\d+)[\.\)]\s+(.+)/);
        
        if (questionMatch && questionMatch[2] && questionMatch[2].length > 15) {
          let questionText = questionMatch[2].trim();
          const originalQuestionNumber = questionMatch[1];
          
          // Look ahead to collect multi-line questions
          let j = i + 1;
          while (j < lines.length && j < i + 5) {
            const nextLine = lines[j];
            // Stop if we hit another question number or option pattern
            if (/^(?:Q\.?\s*)?\d+[\.\)]/.test(nextLine) || /^[\(\[]?[a-dA-D][\)\]\.]\s+/.test(nextLine)) {
              break;
            }
            // Stop if line looks like a header
            if (/^(Exercise|EXERCISE|Chapter|CHAPTER)/i.test(nextLine)) {
              break;
            }
            // If line seems to be continuation (doesn't start with number/letter marker)
            if (nextLine.length > 10 && !/^[\(\[]?[a-dA-D][\)\]]/.test(nextLine)) {
              questionText += ' ' + nextLine;
              j++;
            } else {
              break;
            }
          }
          
          i = j; // Move to where we stopped collecting question text
          
          // Extract options (for MCQs)
          const { options, nextIndex } = this.extractOptionsFromLines(lines, i);
          i = nextIndex;
          
          // Determine question type
          const questionType = options.length > 0 ? 'mcq' : 'short';
          
          // Create question object
          const question = {
            text: questionText,
            type: questionType,
            options: options.length > 0 ? options : undefined,
            subject: metadata.subject || 'Unknown',
            topic: currentChapter || 'General',
            chapter: currentChapter || 'Unknown',
            board: metadata.board,
            class: metadata.class,
            difficulty: 'medium',
            marks: options.length > 0 ? 1 : 2,
            correctAnswerText: this.extractCorrectAnswer(options),
            source: 'PDF Import',
            isActive: true,
            questionNumber: questionNumber.toString()
          };
          
          questions.push(question);
          questionNumber++;
        } else {
          i++;
        }
      }
      
      console.log(`[PDF Parser] Extracted ${questions.length} questions`);
      
      // Attempt to extract diagrams for questions (sample first few pages)
      const maxPagesToScan = Math.min(5, totalPages);
      console.log(`[PDF Parser] Scanning first ${maxPagesToScan} pages for diagrams...`);
      
      for (let pageNum = 1; pageNum <= maxPagesToScan && pageNum <= questions.length; pageNum++) {
        const questionContext = {
          chapter: questions[pageNum - 1]?.chapter || 'General',
          questionNumber: pageNum.toString()
        };
        
        try {
          const diagramMetadata = await this.diagramExtractor.extractDiagramFromPage(
            pdfBuffer,
            pageNum,
            questionContext
          );
          
          if (diagramMetadata && questions[pageNum - 1]) {
            questions[pageNum - 1].diagram = diagramMetadata;
          }
        } catch (err) {
          console.warn(`[PDF Parser] Failed to extract diagram from page ${pageNum}:`, err.message);
        }
      }
      
      return questions;
      
    } catch (error) {
      console.error('[PDF Parser] Failed to extract questions:', error.message);
      throw error;
    }
  }
  
  /**
   * Extract MCQ options from lines
   * @param {Array<string>} lines - All lines
   * @param {number} startIndex - Index to start looking
   * @returns {Object} - { options: Array, nextIndex: number }
   */
  extractOptionsFromLines(lines, startIndex) {
    const options = [];
    const optionPattern = /^[\(\[]?([a-dA-D])[\)\]\.]\s+(.+)/;
    let i = startIndex;
    
    // Look at next 6 lines for options
    while (i < lines.length && i < startIndex + 6) {
      const line = lines[i];
      const match = line.match(optionPattern);
      
      if (match && match[2]) {
        let optionText = match[2].trim();
        
        // Look ahead for multi-line options
        let j = i + 1;
        while (j < lines.length && j < i + 3) {
          const nextLine = lines[j];
          // Stop if next option or question
          if (optionPattern.test(nextLine) || /^(?:Q\.?\s*)?\d+[\.\)]/.test(nextLine)) {
            break;
          }
          // Stop if looks like a header
          if (/^(Exercise|EXERCISE|Chapter|CHAPTER|Answer|ANSWER)/i.test(nextLine)) {
            break;
          }
          // Continue if seems like continuation
          if (nextLine.length > 5 && !optionPattern.test(nextLine)) {
            optionText += ' ' + nextLine;
            j++;
          } else {
            break;
          }
        }
        
        options.push({
          text: optionText,
          isCorrect: false // Will be determined from answer key if available
        });
        
        i = j;
      } else {
        // Not an option, stop looking
        break;
      }
    }
    
    return { options, nextIndex: i };
  }
  
  /**
   * Extract correct answer from options (if marked)
   * @param {Array} options - Question options
   * @returns {string|undefined} - Correct answer text
   */
  extractCorrectAnswer(options) {
    if (!options || options.length === 0) return undefined;
    const correct = options.find(opt => opt.isCorrect);
    return correct ? correct.text : undefined;
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
