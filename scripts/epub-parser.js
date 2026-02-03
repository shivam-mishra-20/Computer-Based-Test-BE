#!/usr/bin/env node

const JSZip = require('jszip');
const fs = require('fs').promises;
const xml2js = require('xml2js');
const cheerio = require('cheerio');
const path = require('path');
const DiagramExtractorEPUB = require('../src/services/diagramExtractorEPUB');

class EPUBParser {
  constructor() {
    this.zip = null; // Store zip for image extraction
    this.diagramExtractor = null; // Will be initialized after metadata is available
  }

  async parse(epubPath) {
    console.log('[EPUB Parser] Reading:', epubPath);
    const data = await fs.readFile(epubPath);
    const zip = await JSZip.loadAsync(data);
    this.zip = zip; // Store for later image access
    
    // Step 1: Get metadata
    const metadata = await this.extractMetadata(zip, epubPath);
    console.log('[EPUB Parser] Metadata:', metadata);
    
    // Step 2: Initialize diagram extractor with metadata
    this.diagramExtractor = new DiagramExtractorEPUB(zip, metadata);
    console.log('[EPUB Parser] Diagram extractor initialized');
    
    // Step 3: Get chapter structure
    const chapters = await this.extractChapters(zip);
    console.log(`[EPUB Parser] Found ${chapters.length} chapters`);
    
    // Step 4: Extract questions from each chapter
    const questions = [];
    for (const chapter of chapters) {
      const chapterQuestions = await this.extractQuestionsFromChapter(
        zip, 
        chapter, 
        metadata
      );
      questions.push(...chapterQuestions);
    }
    
    // Step 5: Analyze statistics
    const stats = this.analyzeQuestions(questions);
    
    console.log(`[EPUB Parser] Total questions: ${questions.length}`);
    console.log(`[EPUB Parser] With options: ${stats.withOptions}`);
    console.log(`[EPUB Parser] With correct answers: ${stats.withCorrectAnswers}`);
    console.log(`[EPUB Parser] With diagrams: ${stats.withDiagrams}`);
    
    return { metadata, chapters, questions, stats };
  }
  
  analyzeQuestions(questions) {
    return {
      total: questions.length,
      withOptions: questions.filter(q => q.options && q.options.length > 0).length,
      withCorrectAnswers: questions.filter(q => 
        q.correctAnswerText || 
        (q.options && q.options.some(opt => opt.isCorrect))
      ).length,
      withDiagrams: questions.filter(q => q.diagramUrl).length,
      byType: questions.reduce((acc, q) => {
        acc[q.type] = (acc[q.type] || 0) + 1;
        return acc;
      }, {})
    };
  }
  
  async extractMetadata(zip, epubPath) {
    try {
      // Read container.xml to find content.opf location
      const containerXML = await zip.file('META-INF/container.xml').async('text');
      const container = await xml2js.parseStringPromise(containerXML);
      const contentPath = container.container.rootfiles[0].rootfile[0].$['full-path'];
      
      // Read content.opf
      const contentOPF = await zip.file(contentPath).async('text');
      const content = await xml2js.parseStringPromise(contentOPF);
      
      const metadata = content.package.metadata[0];
      
      const title = metadata['dc:title']?.[0] || path.basename(epubPath, '.epub');
      const metadataSubject = metadata['dc:subject']?.[0];
      
      return {
        title: title,
        author: metadata['dc:creator']?.[0] || 'Unknown',
        subject: this.identifySubjectFromTitle(title, metadataSubject),
        language: metadata['dc:language']?.[0] || 'en'
      };
    } catch (error) {
      console.warn('[EPUB Parser] Failed to extract metadata:', error.message);
      const filename = path.basename(epubPath, '.epub');
      return {
        title: filename,
        author: 'Unknown',
        subject: this.identifySubjectFromTitle(filename, 'Unknown'),
        language: 'en'
      };
    }
  }

  /**
   * Intelligently identify subject from book title or metadata
   * @param {string} title - Book title
   * @param {string} metadataSubject - Subject from metadata
   * @returns {string} Identified subject
   */
  identifySubjectFromTitle(title, metadataSubject) {
    // If metadata has subject and it's not 'Unknown', use it
    if (metadataSubject && metadataSubject !== 'Unknown' && metadataSubject.length > 2) {
      return metadataSubject;
    }

    const titleLower = title.toLowerCase();

    // Physics patterns
    if (/(physics|mechanics|thermodynamics|electromagnetism|optics|waves)/i.test(titleLower)) {
      return 'Physics';
    }

    // Chemistry patterns
    if (/(chemistry|organic|inorganic|physical chemistry|chemical)/i.test(titleLower)) {
      return 'Chemistry';
    }

    // Mathematics patterns
    if (/(mathematics|math|algebra|geometry|calculus|trigonometry|statistics)/i.test(titleLower)) {
      return 'Mathematics';
    }

    // Biology patterns
    if (/(biology|bio|botany|zoology|life science|ecology|genetics)/i.test(titleLower)) {
      return 'Biology';
    }

    // English patterns
    if (/(english|literature|grammar|composition)/i.test(titleLower)) {
      return 'English';
    }

    // Computer Science patterns
    if (/(computer|programming|informatics|coding)/i.test(titleLower)) {
      return 'Computer Science';
    }

    // Social Science patterns
    if (/(history|geography|civics|economics|social)/i.test(titleLower)) {
      return 'Social Science';
    }

    console.warn(`[EPUB Parser] Could not identify subject from title: "${title}"`);
    return 'Unknown';
  }
  
  async extractChapters(zip) {
    try {
      // Try toc.ncx first
      const tocFile = zip.file(/toc\.ncx$/i)[0];
      if (tocFile) {
        const tocXML = await tocFile.async('text');
        const toc = await xml2js.parseStringPromise(tocXML);
        
        const chapters = [];
        const navPoints = toc.ncx.navMap[0].navPoint || [];
        
        for (const point of navPoints) {
          chapters.push({
            title: point.navLabel[0].text[0],
            src: point.content[0].$.src,
            id: point.$.id
          });
        }
        
        if (chapters.length > 0) {
          return chapters;
        }
      }
      
      // Fallback: Scan all HTML/XHTML files
      console.log('[EPUB Parser] Using fallback: scanning all HTML files');
      const chapters = [];
      const htmlFiles = [];
      
      // Get all HTML files from the zip
      zip.forEach((relativePath, file) => {
        if (/\.(x?html?|xml)$/i.test(relativePath) && 
            !relativePath.includes('toc.') && 
            !relativePath.includes('nav.') &&
            !file.dir) {
          htmlFiles.push({
            path: relativePath,
            name: relativePath.split('/').pop().replace(/\.(x?html?|xml)$/i, '')
          });
        }
      });
      
      console.log(`[EPUB Parser] Found ${htmlFiles.length} HTML files to scan`);
      
      // Create chapters from HTML files
      for (let i = 0; i < htmlFiles.length; i++) {
        chapters.push({
          title: htmlFiles[i].name || `Chapter ${i + 1}`,
          src: htmlFiles[i].path,
          id: `chapter_${i + 1}`
        });
      }
      
      return chapters;
    } catch (error) {
      console.warn('[EPUB Parser] Failed to extract chapters:', error.message);
      return [];
    }
  }
  
  async extractQuestionsFromChapter(zip, chapter, metadata) {
    const questions = [];
    
    // Get the HTML file - chapter.src is already the full path from extractChapters
    const htmlFile = zip.file(chapter.src);
    
    if (!htmlFile) {
      console.warn(`[EPUB Parser] Could not find HTML for chapter: ${chapter.title} at ${chapter.src}`);
      return questions;
    }
    
    const html = await htmlFile.async('text');
    const $ = cheerio.load(html);
    
    console.log(`[EPUB Parser] Processing chapter: ${chapter.title}`);
    
    // Try multiple extraction strategies
    
    // Strategy 1: Look for exercise sections
    const exercises = this.detectExerciseSections($);
    if (exercises.length > 0) {
      console.log(`[EPUB Parser] Found ${exercises.length} exercise sections in "${chapter.title}"`);
      for (const exercise of exercises) {
        const exerciseQuestions = await this.extractQuestionsFromExercise($, exercise, chapter, metadata);
        questions.push(...exerciseQuestions);
      }
    }
    
    // Strategy 2: If no exercises found, look for numbered paragraphs/questions
    if (questions.length === 0) {
      console.log(`[EPUB Parser] No exercise sections found, trying direct question extraction`);
      const directQuestions = await this.extractDirectQuestions($, chapter, metadata);
      questions.push(...directQuestions);
    }
    
    // Strategy 3: If still no questions, extract all paragraphs as potential questions
    if (questions.length === 0) {
      console.log(`[EPUB Parser] Trying paragraph extraction for "${chapter.title}"`);
      const paragraphQuestions = await this.extractFromParagraphs($, chapter, metadata);
      questions.push(...paragraphQuestions);
    }
    
    console.log(`[EPUB Parser] Extracted ${questions.length} questions from "${chapter.title}"`);
    
    return questions;
  }
  
  detectExerciseSections($) {
    const exercises = [];
    const exerciseHeaders = [
      /exercise\s+\d+\.?\d*/i,
      /practice\s+questions/i,
      /miscellaneous\s+exercise/i,
      /chapter.*test/i,
      /mcqs?/i,
      /objective/i,
      /very\s+short\s+answer/i,
      /short\s+answer/i,
      /long\s+answer/i,
      /solved\s+examples?/i
    ];
    
    $('h1, h2, h3, h4, h5, p.title, div.title').each((i, elem) => {
      const text = $(elem).text().trim();
      
      for (const pattern of exerciseHeaders) {
        if (pattern.test(text)) {
          exercises.push({
            title: text,
            element: elem,
            type: this.classifyExerciseType(text)
          });
          break;
        }
      }
    });
    
    return exercises;
  }
  
  classifyExerciseType(title) {
    const lower = title.toLowerCase();
    if (/mcq|objective|multiple\s+choice/i.test(lower)) return 'mcq';
    if (/true.*false/i.test(lower)) return 'truefalse';
    if (/fill.*blank/i.test(lower)) return 'fill';
    if (/very\s+short/i.test(lower)) return 'short';
    if (/long\s+answer/i.test(lower)) return 'long';
    return 'mixed';
  }
  
  async extractQuestionsFromExercise($, exercise, chapter, metadata) {
    const questions = [];
    
    // Get all content after exercise header until next exercise or end
    let currentElement = $(exercise.element).next();
    let questionNumber = 1;
    const maxIterations = 500; // Safety limit
    let iterations = 0;
    
    while (currentElement.length && !this.isExerciseHeader($, currentElement) && iterations < maxIterations) {
      iterations++;
      const text = currentElement.text().trim();
      
      // Check if this element starts with a question number
      const questionMatch = text.match(/^(?:Q\.?\s*)?(\d+)\.?\s+(.+)/);
      
      if (questionMatch && questionMatch[2]) {
        const questionText = questionMatch[2].trim();
        
        // Check for MCQ options in next elements
        const { options, nextElement } = this.extractOptions($, currentElement);
        currentElement = nextElement;
        
        // Check for images/diagrams with question context for Firebase Storage
        const questionContext = {
          chapter: chapter.title || 'general',
          questionNumber: questionNumber.toString()
        };
        const diagramMetadata = await this.extractDiagram($, currentElement, questionContext);
        
        // Create question object with diagram metadata (NOT base64)
        const question = {
          // Core fields
          text: questionText,
          type: options.length > 0 ? 'mcq' : (exercise.type && exercise.type !== 'mixed' ? exercise.type : 'short'),
          options: options.length > 0 ? options : undefined,
          
          // Metadata fields (FLAT - at root level, NOT nested)
          subject: metadata.subject || 'Unknown',           // REQUIRED
          topic: chapter.title || 'General',                // REQUIRED  
          chapter: chapter.title || 'Unknown',              // REQUIRED
          board: this.extractBoardFromTitle(metadata.title), // REQUIRED
          class: this.extractClassFromTitle(metadata.title),
          section: exercise.title,
          difficulty: 'medium',
          marks: this.estimateMarks(exercise.type, options.length > 0),
          
          // Additional fields
          correctAnswerText: this.extractCorrectAnswer(options),
          diagram: diagramMetadata || undefined,  // Firebase metadata, NOT base64
          source: 'Smart Import',                           // REQUIRED
          isActive: true,                                   // REQUIRED
          
          // For tracking during extraction
          questionNumber: questionNumber.toString()
        };
        
        questions.push(question);
        questionNumber++;
      }
      
      currentElement = currentElement.next();
    }
    
    return questions;
  }
  
  extractOptions($, questionElement) {
    const options = [];
    let nextElement = questionElement.next();
    const optionPattern = /^\s*[\(\[]?([a-dA-D])[\)\]\.]\s*(.+)/;
    
    // Check next 6 elements for options
    for (let i = 0; i < 6 && nextElement.length; i++) {
      const text = nextElement.text().trim();
      
      if (optionPattern.test(text)) {
        const match = text.match(optionPattern);
        const optionText = match ? match[2].trim() : text.replace(optionPattern, '').trim();
        
        options.push({
          text: optionText,
          isCorrect: false // Will be determined from answer key if available
        });
        
        nextElement = nextElement.next();
      } else if (text && !this.isQuestionHeader(text)) {
        // Might be a continuation of previous option
        break;
      } else {
        break;
      }
    }
    
    return { options, nextElement };
  }
  
  extractCorrectAnswer(options) {
    if (!options || options.length === 0) return undefined;
    
    const correctOption = options.find(opt => opt.isCorrect);
    return correctOption ? correctOption.text : undefined;
  }
  
  /**
   * Extract diagram using Firebase Storage (NOT base64)
   * Delegates to DiagramExtractorEPUB service
   * @param {CheerioStatic} $ - Cheerio instance
   * @param {CheerioElement} element - Current element
   * @param {Object} questionContext - Question context (chapter, number)
   * @returns {Promise<Object|null>} Diagram metadata or null
   */
  async extractDiagram($, element, questionContext) {
    if (!this.diagramExtractor) {
      console.warn('[EPUB Parser] Diagram extractor not initialized');
      return null;
    }

    try {
      const diagramMetadata = await this.diagramExtractor.extractDiagram($, element, questionContext);
      return diagramMetadata;
    } catch (error) {
      console.warn('[EPUB Parser] Diagram extraction failed:', error.message);
      return null;
    }
  }
  
  isExerciseHeader($, element) {
    const text = $(element).text().toLowerCase();
    return /^(exercise|practice|mcq|objective|chapter|test|solved)/i.test(text);
  }
  
  isQuestionHeader(text) {
    return /^(?:Q\.?\s*)?\d+\.?\s+/.test(text);
  }
  
  extractClassFromTitle(title) {
    const match = title.match(/class\s+(\d+|xi|xii|11|12)/i);
    if (!match) return 'Unknown';
    
    const classNum = match[1].toLowerCase();
    if (classNum === 'xi' || classNum === '11') return 'Class 11';
    if (classNum === 'xii' || classNum === '12') return 'Class 12';
    return `Class ${classNum}`;
  }
  
  extractBoardFromTitle(title) {
    const lower = title.toLowerCase();
    if (/ncert/i.test(lower)) return 'NCERT';
    if (/cbse/i.test(lower)) return 'CBSE';
    if (/jee/i.test(lower)) return 'JEE';
    if (/neet/i.test(lower)) return 'NEET';
    return 'CBSE'; // Default
  }
  
  estimateMarks(exerciseType, isMCQ) {
    if (isMCQ) return 1;
    if (exerciseType === 'short') return 2;
    if (exerciseType === 'long') return 5;
    return 1;
  }
  
  // New extraction strategies
  async extractDirectQuestions($, chapter, metadata) {
    const questions = [];
    let questionNumber = 1;
    
    // Look for any paragraph or div that starts with a number followed by dot or period
    const elements = $('p, div, li').get();
    for (const elem of elements) {
      const $elem = $(elem);
      const text = $elem.text().trim();
      const questionMatch = text.match(/^(?:Q\.?\s*)?(\d+)[\.\)]\s+(.+)/);
      
      if (questionMatch && questionMatch[2] && questionMatch[2].length > 10) {
        const questionText = questionMatch[2].trim();
        
        // Look for options
        const { options } = this.extractOptions($, $elem);
        
        // Extract diagram with question context
        const questionContext = {
          chapter: chapter.title || 'general',
          questionNumber: questionNumber.toString()
        };
        const diagramMetadata = await this.extractDiagram($, $elem, questionContext);
        
        const question = {
          text: questionText,
          type: options.length > 0 ? 'mcq' : 'short',
          options: options.length > 0 ? options : undefined,
          subject: metadata.subject || 'Unknown',
          topic: chapter.title || 'General',
          chapter: chapter.title || 'Unknown',
          board: this.extractBoardFromTitle(metadata.title),
          class: this.extractClassFromTitle(metadata.title),
          difficulty: 'medium',
          marks: options.length > 0 ? 1 : 2,
          correctAnswerText: this.extractCorrectAnswer(options),
          diagram: diagramMetadata || undefined,  // Firebase metadata
          source: 'Smart Import',
          isActive: true,
          questionNumber: questionNumber.toString()
        };
        
        questions.push(question);
        questionNumber++;
      }
    }
    
    return questions;
  }
  
  async extractFromParagraphs($, chapter, metadata) {
    const questions = [];
    let questionNumber = 1;
    
    // Extract all paragraphs that look like questions
    const elements = $('p').get();
    for (const elem of elements) {
      const $elem = $(elem);
      const text = $elem.text().trim();
      
      // Skip very short paragraphs
      if (text.length < 20) continue;
      
      // Check if it looks like a question (ends with ?, has certain keywords, etc.)
      const looksLikeQuestion = 
        text.endsWith('?') ||
        /\b(what|which|how|why|when|where|calculate|find|determine|explain|describe)\b/i.test(text) ||
        /^\d+[\.\)]\s+/.test(text);
      
      if (looksLikeQuestion) {
        // Look for options in next elements
        const { options } = this.extractOptions($, $elem);
        
        // Extract diagram with question context
        const questionContext = {
          chapter: chapter.title || 'general',
          questionNumber: questionNumber.toString()
        };
        const diagramMetadata = await this.extractDiagram($, $elem, questionContext);
        
        const question = {
          text: text.replace(/^\d+[\.\)]\s+/, ''), // Remove leading number if any
          type: options.length > 0 ? 'mcq' : 'short',
          options: options.length > 0 ? options : undefined,
          subject: metadata.subject || 'Unknown',
          topic: chapter.title || 'General',
          chapter: chapter.title || 'Unknown',
          board: this.extractBoardFromTitle(metadata.title),
          class: this.extractClassFromTitle(metadata.title),
          difficulty: 'medium',
          marks: options.length > 0 ? 1 : 2,
          correctAnswerText: this.extractCorrectAnswer(options),
          diagram: diagramMetadata || undefined,  // Firebase metadata
          source: 'Smart Import',
          isActive: true,
          questionNumber: questionNumber.toString()
        };
        
        questions.push(question);
        questionNumber++;
      }
    }
    
    return questions;
  }
}

// CLI Interface
async function main() {
  const parser = new EPUBParser();
  
  const epubPath = process.argv[2] || '../class_12/NEET JEE Chemistry Practice Bank Part 1 (5000+ Questions).epub';
  
  if (!epubPath) {
    console.error('Usage: node epub-parser.js <path-to-epub-file>');
    process.exit(1);
  }
  
  try {
    const result = await parser.parse(epubPath);
    
    // Save to JSON for inspection
    const outputPath = path.join(__dirname, 'extracted_questions.json');
    await fs.writeFile(
      outputPath,
      JSON.stringify(result, null, 2)
    );
    
    console.log('\n✅ Extraction Complete!');
    console.log('═══════════════════════════════════════');
    console.log(`📚 Book: ${result.metadata.title}`);
    console.log(`✍️  Author: ${result.metadata.author}`);
    console.log(`📖 Subject: ${result.metadata.subject}`);
    console.log(`📝 Chapters: ${result.chapters.length}`);
    console.log(`\n❓ Questions:`);
    console.log(`   Total: ${result.stats.total}`);
    console.log(`   With Options: ${result.stats.withOptions}`);
    console.log(`   With Correct Answers: ${result.stats.withCorrectAnswers}`);
    console.log(`   With Diagrams: ${result.stats.withDiagrams}`);
    console.log(`\n📊 By Type:`);
    Object.entries(result.stats.byType).forEach(([type, count]) => {
      console.log(`   ${type}: ${count}`);
    });
    console.log(`\n💾 Saved to: ${outputPath}`);
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

module.exports = EPUBParser;
