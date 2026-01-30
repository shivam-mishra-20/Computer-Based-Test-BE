const { VertexAI } = require('@google-cloud/vertexai');
const path = require('path');

// Initialize Vertex AI
const GOOGLE_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'cbt-vision-api';
const GOOGLE_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const KEY_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, '..', 'vision-key.json');

let vertexAI = null;

function getVertexAI() {
  if (!vertexAI) {
    vertexAI = new VertexAI({
      project: GOOGLE_PROJECT,
      location: GOOGLE_LOCATION,
      googleAuthOptions: {
        keyFilename: KEY_FILE
      }
    });
  }
  return vertexAI;
}

/**
 * Enhance extracted questions using Vertex AI Gemini
 * Splits multi-question blobs, adds LaTeX, identifies metadata
 */
class AIEnhancer {
  constructor() {
    this.model = 'gemini-2.5-pro';
  }

  /**
   * Process questions in batches with AI enhancement
   * @param {Array} rawQuestions - Questions extracted from EPUB (may be multi-question blobs)
   * @param {Object} bookMetadata - Book metadata from EPUB
   * @returns {Promise<Array>} Enhanced, properly split questions
   */
  async enhanceQuestions(rawQuestions, bookMetadata) {
    console.log(`\n🤖 AI Enhancement Started`);
    console.log(`   Model: ${this.model}`);
    console.log(`   Input: ${rawQuestions.length} extracted items`);

    const enhancedQuestions = [];
    const batchSize = 5; // Process 5 questions at a time to avoid token limits

    for (let i = 0; i < rawQuestions.length; i += batchSize) {
      const batch = rawQuestions.slice(i, i + batchSize);
      console.log(`   Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(rawQuestions.length / batchSize)}`);

      try {
        const structured = await this.structureQuestionBatch(batch, bookMetadata);
        enhancedQuestions.push(...structured);
      } catch (error) {
        console.error(`   ❌ Batch ${Math.floor(i / batchSize) + 1} failed:`, error.message);
        // Continue with next batch
      }
    }

    console.log(`   ✅ Enhanced: ${enhancedQuestions.length} questions`);
    return enhancedQuestions;
  }

  /**
   * Send batch of questions to Gemini for structuring
   */
  async structureQuestionBatch(batch, bookMetadata) {
    const vertexAI = getVertexAI();
    const generativeModel = vertexAI.getGenerativeModel({
      model: this.model,
      generationConfig: {
        temperature: 0.0,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 16384,
      },
    });

    // Concatenate all question texts for batch processing
    const inputText = batch.map((q, idx) => {
      return `[Question ${idx + 1}]\n${q.text}\n`;
    }).join('\n---\n\n');

    const prompt = `You are an academic question extraction and structuring engine for ${bookMetadata.subject || 'Unknown'} subject.

📚 Book Context:
- Title: ${bookMetadata.title}
- Subject: ${bookMetadata.subject}
- Board: ${bookMetadata.board || 'CBSE'}
- Class: ${bookMetadata.class || 'Class 12'}

🎯 Your Task:
The input below contains raw text extracted from an EPUB book. Some entries may contain MULTIPLE questions concatenated together. Your job is to:

1. **SPLIT** any multi-question text into individual questions
2. **IDENTIFY** each question's type (mcq, short, long, etc.)
3. **EXTRACT** options if MCQ (with correct answer if present)
4. **ADD** proper LaTeX formatting to mathematical expressions
5. **CLEAN** the text (remove page numbers, headers, etc.)
6. **PRESERVE** the original wording exactly - do not paraphrase

⚠️ CRITICAL: If you see text like "11. Question text (a) option1 (b) option2... 12. Another question...", you MUST split this into TWO separate question blocks.

📝 Output Format (repeat for EACH question):
------------------------------------
QUESTION_NUMBER: <number or sequential>
QUESTION_TEXT: <clean question text with LaTeX>
QUESTION_TYPE: mcq | short | long | truefalse | fill | integer | assertionreason

OPTION_A: <text or EMPTY>
OPTION_B: <text or EMPTY>
OPTION_C: <text or EMPTY>
OPTION_D: <text or EMPTY>

CORRECT_OPTION: A | B | C | D | UNKNOWN
CORRECT_ANSWER_TEXT: <text or EMPTY>

SUBJECT: ${bookMetadata.subject || 'Unknown'}
TOPIC: <infer from question or use "${bookMetadata.topic || 'General'}">
CHAPTER: <infer from question or use "${bookMetadata.chapter || 'Unknown'}">
DIFFICULTY: easy | medium | hard
MARKS: 1 | 2 | 4 | 5

CONFIDENCE: <0.0 – 1.0>
NEEDS_REVIEW: true | false
------------------------------------

🧮 LaTeX Rules:
- Use $...$ for inline math (e.g., $x^2 + 5x + 6 = 0$)
- Use $$...$$ for display equations
- Convert Unicode: ² → $^2$, × → $\\times$, ∞ → $\\infty$
- Do NOT escape backslashes (write $\\frac{a}{b}$ not $\\\\frac{a}{b}$)

📊 Type Detection:
- **mcq**: Has (a), (b), (c), (d) options
- **short**: Requires brief answer (1-2 lines)
- **long**: Requires detailed explanation
- **truefalse**: True/False question
- **integer**: Answer is a number
- **assertionreason**: Has assertion and reason statements

🎯 Marks Assignment:
- MCQ: 1 mark
- Short answer: 2 marks
- Long answer: 5 marks
- True/False: 1 mark

🔍 Question Splitting Examples:

**Input:** "11. What is photosynthesis? (a) Process A (b) Process B 12. Define respiration?"

**Output:** 
Two separate blocks:
1. Question 11 about photosynthesis (MCQ)
2. Question 12 about respiration (short)

**Input:** "109. (CH3)3NH + CH3COOH (a) Option1 (b) Option2 110. Calculate pH"

**Output:**
Two separate blocks:
1. Question 109 with options (MCQ)
2. Question 110 about pH (short/long)

🚨 DO NOT:
- Combine multiple questions into one block
- Skip questions
- Invent information not in the source
- Change the question wording

✅ DO:
- Split every distinct question into its own block
- Preserve exact question text
- Add LaTeX to all mathematical expressions
- Set NEEDS_REVIEW to true if uncertain

---

INPUT TEXT:
${inputText}

---

Now extract and structure ALL questions found above:`;

    const result = await generativeModel.generateContent(prompt);
    const responseText = result.response.candidates[0].content.parts[0].text;

    // Parse the structured response
    const structuredQuestions = this.parseGeminiResponse(responseText, bookMetadata);

    console.log(`      → Extracted ${structuredQuestions.length} questions from ${batch.length} inputs`);

    return structuredQuestions;
  }

  /**
   * Parse Gemini's structured response into question objects
   */
  parseGeminiResponse(responseText, bookMetadata) {
    const questions = [];
    const blocks = responseText.split('------------------------------------').filter(b => b.trim());

    for (const block of blocks) {
      try {
        const question = this.parseQuestionBlock(block, bookMetadata);
        if (question) {
          questions.push(question);
        }
      } catch (error) {
        console.error('      ⚠️  Failed to parse question block:', error.message);
      }
    }

    return questions;
  }

  /**
   * Parse a single question block
   */
  parseQuestionBlock(block, bookMetadata) {
    const lines = block.split('\n').map(l => l.trim()).filter(l => l);
    const fields = {};

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.substring(0, colonIndex).trim().toUpperCase().replace(/ /g, '_');
      const value = line.substring(colonIndex + 1).trim();

      fields[key] = value;
    }

    // Validate required fields
    if (!fields.QUESTION_TEXT || fields.QUESTION_TEXT === 'EMPTY') {
      return null;
    }

    // Build options array for MCQ
    const options = [];
    if (fields.QUESTION_TYPE === 'mcq') {
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
      type: fields.QUESTION_TYPE || 'short',
      subject: fields.SUBJECT || bookMetadata.subject || 'Unknown',
      topic: fields.TOPIC || bookMetadata.topic || 'General',
      chapter: fields.CHAPTER || bookMetadata.chapter || 'Unknown',
      board: bookMetadata.board || 'CBSE',
      class: bookMetadata.class || 'Unknown',
      difficulty: fields.DIFFICULTY || 'medium',
      marks: parseInt(fields.MARKS) || (fields.QUESTION_TYPE === 'mcq' ? 1 : 2),
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

    if (fields.QUESTION_TYPE === 'integer' && fields.INTEGER_ANSWER) {
      question.integerAnswer = parseInt(fields.INTEGER_ANSWER);
    }

    return question;
  }
}

module.exports = AIEnhancer;
