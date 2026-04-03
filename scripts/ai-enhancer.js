const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');

// Initialize Gemini API
let genAI = null;

function getGenAI() {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set in environment variables');
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

// Initialize Groq API (fallback)
let groqClient = null;

function getGroq() {
  if (!groqClient) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not set — cannot use Groq fallback');
    }
    groqClient = new Groq({ apiKey });
  }
  return groqClient;
}

/**
 * Enhance extracted questions using Vertex AI Gemini
 * Splits multi-question blobs, adds LaTeX, identifies metadata
 */
class AIEnhancer {
  constructor() {
    this.model = process.env.AI_ENHANCER_MODEL || 'gemini-2.5-flash';
    this.concurrentBatches = Math.max(1, parseInt(process.env.AI_ENHANCER_CONCURRENCY || '4', 10));
    this.batchSize = Math.max(1, parseInt(process.env.AI_ENHANCER_BATCH_SIZE || '1', 10));
  }

  /**
   * Process questions in batches with AI enhancement (PARALLEL PROCESSING)
   * @param {Array} rawQuestions - Questions extracted from EPUB (may be multi-question blobs)
   * @param {Object} bookMetadata - Book metadata from EPUB
   * @returns {Promise<Array>} Enhanced, properly split questions
   */
  async enhanceQuestions(rawQuestions, bookMetadata) {
    console.log(`\n🤖 AI Enhancement Started (Parallel Processing)`);
    console.log(`   Model: ${this.model}`);
    console.log(`   Input: ${rawQuestions.length} extracted items`);
    console.log(`   Batch size: ${this.batchSize}`);
    console.log(`   Concurrency: ${this.concurrentBatches} parallel batches`);

    const enhancedQuestions = [];
    const totalBatches = Math.ceil(rawQuestions.length / this.batchSize);

    // Create all batches
    const batches = [];
    for (let i = 0; i < rawQuestions.length; i += this.batchSize) {
      batches.push({
        index: Math.floor(i / this.batchSize),
        questions: rawQuestions.slice(i, i + this.batchSize)
      });
    }

    // Process batches in parallel with concurrency limit
    let completed = 0;
    for (let i = 0; i < batches.length; i += this.concurrentBatches) {
      const chunk = batches.slice(i, i + this.concurrentBatches);
      
      // Process this chunk in parallel
      const promises = chunk.map(async ({ index, questions }) => {
        try {
          const structured = await this.structureQuestionBatch(questions, bookMetadata);
          return { success: true, index, questions: structured };
        } catch (error) {
          console.error(`   ❌ Batch ${index + 1} failed:`, error.message);
          return { success: false, index, questions: [] };
        }
      });

      const results = await Promise.all(promises);
      
      // Add results in order and update progress
      results.forEach(result => {
        if (result.success) {
          enhancedQuestions.push(...result.questions);
        }
        completed++;
        console.log(`   Progress: ${completed}/${totalBatches} batches (${Math.round(completed/totalBatches*100)}%)`);
      });
    }

    const uniqueQuestions = this.deduplicateQuestions(enhancedQuestions);
    const removedDuplicates = enhancedQuestions.length - uniqueQuestions.length;

    console.log(`   ✅ Enhanced: ${uniqueQuestions.length} questions`);
    if (removedDuplicates > 0) {
      console.log(`   ♻️  Removed ${removedDuplicates} duplicate question(s) after overlap parsing`);
    }

    return uniqueQuestions;
  }

  /**
   * Send batch of questions to Gemini for structuring
   */
  async structureQuestionBatch(batch, bookMetadata) {
    const generativeModel = getGenAI().getGenerativeModel({
      model: this.model,
      generationConfig: {
        temperature: 0.0,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 32768,
      },
    });

    // Concatenate all chunks for batch processing
    const inputText = batch.map((q, idx) => {
      const label = q.exerciseLabel ? ` [${q.exerciseLabel}]` : '';
      return `[Chunk ${idx + 1}${label}]\n${q.text}\n`;
    }).join('\n---\n\n');

    const prompt = `You are an expert academic question extractor for ${bookMetadata.subject || 'Unknown'} (${bookMetadata.class || 'Class 12'}, ${bookMetadata.board || 'CBSE'}).

📚 Chapter Context:
- Chapter: ${bookMetadata.chapter || bookMetadata.title || 'Unknown'}
- Subject: ${bookMetadata.subject || 'Unknown'}
- Class: ${bookMetadata.class || 'Class 12'}
- Board: ${bookMetadata.board || 'CBSE'}

🎯 Your Task:
The input below is raw text from a PDF textbook chapter. Extract EVERY question and activity you can find. Your job is to:

1. **FIND** every question — numbered exercises, in-text questions, "Try These", "Think About It", examples with sub-parts, fill-in-the-blanks, true/false, match the following, assertion-reason
2. **SPLIT** any multi-question blobs into individual questions  
3. **IDENTIFY** type: mcq, short, long, truefalse, fill, integer, assertionreason
4. **EXTRACT** options if MCQ (with correct answer if present)
5. **ADD** LaTeX to all mathematical expressions
6. **CLEAN** text (remove page numbers, headers, footers)
7. **PRESERVE** exact wording — do not paraphrase

⚠️ QUESTION PATTERNS — look for ALL of these:
- Numbered: "1.", "1)", "Q1.", "Q.1", "(i)", "(ii)"
- MCQ with choices: "(a) ... (b) ... (c) ... (d) ..."
- Fill in the blank: "________" or "......"
- True / False statements to evaluate
- "Match the following" items
- "State whether ... True or False"
- "Give reason why ...", "Explain ...", "Define ...", "Describe ..."
- "Calculate / Find / Determine / Evaluate ..."
- "Prove that ...", "Show that ..."
- Any sentence ending with "?"
- Examples asking students to solve something

📝 Output Format — use EXACTLY this separator and field names for EACH question:
------------------------------------
QUESTION_NUMBER: <sequential number>
QUESTION_TEXT: <clean question text with LaTeX>
QUESTION_TYPE: mcq | short | long | truefalse | fill | integer | assertionreason

OPTION_A: <option text or EMPTY>
OPTION_B: <option text or EMPTY>
OPTION_C: <option text or EMPTY>
OPTION_D: <option text or EMPTY>

CORRECT_OPTION: A | B | C | D | UNKNOWN
CORRECT_ANSWER_TEXT: <answer text or EMPTY>

SUBJECT: ${bookMetadata.subject || 'Unknown'}
TOPIC: <infer from question content>
CHAPTER: ${bookMetadata.chapter || bookMetadata.title || 'Unknown'}
DIFFICULTY: easy | medium | hard
MARKS: 1 | 2 | 4 | 5

CONFIDENCE: <0.0 – 1.0>
NEEDS_REVIEW: true | false
------------------------------------

🧮 LaTeX Rules:
- Inline math: $x^2 + 5x + 6 = 0$
- Display equations: $$E = mc^2$$
- Convert: ² → $^2$, × → $\\times$, ∞ → $\\infty$, √x → $\\sqrt{x}$, fractions → $\\frac{a}{b}$
- Do NOT double-escape backslashes

📊 Type & Marks:
- mcq → 1 mark | short → 2 marks | long → 5 marks | truefalse → 1 mark | fill → 1 mark | integer → 2 marks

🚨 CRITICAL:
- Extract EVERY question — if you find 20 questions, output 20 blocks
- NEVER combine multiple questions into one block
- NEVER skip a question
- NEVER invent information
- If a question is unclear, set NEEDS_REVIEW: true
- If a chunk has no questions at all, output nothing (no blocks)

---

INPUT TEXT:
${inputText}

---

Extract ALL questions now:`;

    let responseText;
    try {
      const result = await generativeModel.generateContent(prompt);
      responseText = result.response.text();
      console.log(`      → Gemini response received`);
    } catch (geminiError) {
      console.warn(`      ⚠️  Gemini failed: ${geminiError.message}`);
      console.log(`      🔄 Falling back to Groq...`);
      responseText = await this.callGroqFallback(prompt);
    }

    // Parse the structured response, passing original batch for diagram preservation
    const structuredQuestions = this.parseGeminiResponse(responseText, bookMetadata, batch);

    console.log(`      → Extracted ${structuredQuestions.length} questions from ${batch.length} inputs`);

    return structuredQuestions;
  }

  /**
   * Groq fallback — uses llama-3.3-70b-versatile for same structured output
   */
  async callGroqFallback(prompt) {
    const completion = await getGroq().chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.0,
      max_tokens: 16384,
    });
    return completion.choices[0].message.content;
  }

  /**
   * Parse Gemini's structured response into question objects
   * PRESERVES diagram metadata from original questions (Firebase Storage)
   */
  parseGeminiResponse(responseText, bookMetadata, originalBatch) {
    const questions = [];
    const blocks = this.extractQuestionBlocks(responseText);

    for (let i = 0; i < blocks.length; i++) {
      try {
        // Preserve diagram metadata from original chunk (NOT base64, Firebase metadata)
        const chunkIndex = originalBatch.length <= 1 ? 0 : Math.min(i, originalBatch.length - 1);
        const originalQuestion = originalBatch[chunkIndex] || {};
        const metadataWithDiagram = {
          ...bookMetadata,
          diagram: originalQuestion.diagram || null  // Firebase metadata object
        };
        
        const question = this.parseQuestionBlock(blocks[i], metadataWithDiagram);
        if (question) {
          questions.push(question);
        }
      } catch (error) {
        console.error('      ⚠️  Failed to parse question block:', error.message);
      }
    }

    return questions;
  }

  extractQuestionBlocks(responseText) {
    if (!responseText || typeof responseText !== 'string') return [];

    const normalized = responseText.replace(/\r/g, '').trim();
    if (!normalized) return [];

    const separatorBlocks = normalized
      .split('------------------------------------')
      .map(block => block.trim())
      .filter(block => /QUESTION_TEXT\s*:/i.test(block));

    if (separatorBlocks.length > 0) {
      return separatorBlocks;
    }

    const numberedBlocks = normalized.match(/QUESTION_NUMBER\s*:[\s\S]*?(?=\nQUESTION_NUMBER\s*:|$)/gi);
    if (numberedBlocks && numberedBlocks.length > 0) {
      return numberedBlocks.map(block => block.trim());
    }

    const questionTextBlocks = normalized.match(/QUESTION_TEXT\s*:[\s\S]*?(?=\nQUESTION_TEXT\s*:|$)/gi);
    if (questionTextBlocks && questionTextBlocks.length > 0) {
      return questionTextBlocks.map(block => block.trim());
    }

    return [];
  }

  /**
   * Parse a single question block
   */
  parseQuestionBlock(block, bookMetadata) {
    const lines = block.split('\n').map(l => l.trim()).filter(l => l);
    const fields = {};
    const knownFields = new Set([
      'QUESTION_NUMBER',
      'QUESTION_TEXT',
      'QUESTION_TYPE',
      'OPTION_A',
      'OPTION_B',
      'OPTION_C',
      'OPTION_D',
      'OPTION_E',
      'OPTION_F',
      'CORRECT_OPTION',
      'CORRECT_ANSWER_TEXT',
      'INTEGER_ANSWER',
      'SUBJECT',
      'TOPIC',
      'CHAPTER',
      'DIFFICULTY',
      'MARKS',
      'CONFIDENCE',
      'NEEDS_REVIEW'
    ]);
    let currentKey = null;

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex !== -1) {
        const key = line.substring(0, colonIndex).trim().toUpperCase().replace(/ /g, '_');
        const value = line.substring(colonIndex + 1).trim();

        if (knownFields.has(key)) {
          fields[key] = value;
          currentKey = key;
          continue;
        }
      }

      if (currentKey) {
        const existing = fields[currentKey] ? `${fields[currentKey]} ` : '';
        fields[currentKey] = `${existing}${line}`.trim();
      }
    }

    // Validate required fields
    if (!fields.QUESTION_TEXT || fields.QUESTION_TEXT === 'EMPTY') {
      return null;
    }

    const normalizedType = String(fields.QUESTION_TYPE || 'short').toLowerCase().trim();
    const allowedTypes = new Set(['mcq', 'short', 'long', 'truefalse', 'fill', 'integer', 'assertionreason']);
    const questionType = allowedTypes.has(normalizedType) ? normalizedType : 'short';

    // Build options array for MCQ
    const options = [];
    if (questionType === 'mcq') {
      ['A', 'B', 'C', 'D', 'E', 'F'].forEach(letter => {
        const optionText = fields[`OPTION_${letter}`];
        if (optionText && optionText !== 'EMPTY') {
          options.push({
            text: optionText,
            isCorrect: fields.CORRECT_OPTION === letter
          });
        }
      });
    }

    // Build question object matching your DB schema
    const question = {
      text: fields.QUESTION_TEXT,
      type: questionType,
      subject: fields.SUBJECT || bookMetadata.subject || 'Unknown',
      topic: fields.TOPIC || bookMetadata.topic || 'General',
      chapter: fields.CHAPTER || bookMetadata.chapter || 'Unknown',
      board: bookMetadata.board || 'CBSE',
      class: bookMetadata.class || 'Unknown',
      difficulty: fields.DIFFICULTY || 'medium',
      marks: parseInt(fields.MARKS) || (questionType === 'mcq' ? 1 : 2),
      source: 'Smart Import',
      isActive: true,
      questionNumber: fields.QUESTION_NUMBER,
    };

    // Add type-specific fields
    if (options.length > 0) {
      question.options = options;
    }

    if (fields.CORRECT_ANSWER_TEXT && fields.CORRECT_ANSWER_TEXT !== 'EMPTY') {
      question.correctAnswerText = fields.CORRECT_ANSWER_TEXT;
    }

    if (questionType === 'integer' && fields.INTEGER_ANSWER) {
      question.integerAnswer = parseInt(fields.INTEGER_ANSWER);
    }

    // CRITICAL: Preserve diagram metadata from Firebase Storage (NOT base64 URL)
    if (bookMetadata.diagram) {
      question.diagram = bookMetadata.diagram;  // Contains { storage, path, url, width, height, hash }
    }

    return question;
  }

  normalizeQuestionText(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/^\s*(?:q\.?\s*)?\d+[\).:\-]\s*/, '')
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9\s$]/g, '')
      .trim();
  }

  deduplicateQuestions(questions) {
    const seen = new Set();
    const unique = [];

    for (const question of questions) {
      const normalized = this.normalizeQuestionText(question?.text);
      if (!normalized) continue;

      const key = `${(question?.subject || '').toLowerCase()}::${normalized}`;
      if (seen.has(key)) continue;

      seen.add(key);
      unique.push(question);
    }

    return unique;
  }
}

module.exports = AIEnhancer;
