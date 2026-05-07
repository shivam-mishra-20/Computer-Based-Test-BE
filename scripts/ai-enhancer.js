/**
 * AI Enhancer — Ollama Qwen3:8b (local)
 * Replaces Google Gemini / Groq for question structuring.
 * Optimized: JSON mode, concurrency=1, ~1200-char chunks, low VRAM.
 */

const { Ollama } = require('ollama');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL = process.env.AI_ENHANCER_MODEL || 'qwen3:8b';
const CHUNK_SIZE = parseInt(process.env.AI_ENHANCER_CHUNK_SIZE || '1200', 10);

const ollama = new Ollama({ host: OLLAMA_HOST });

class AIEnhancer {
  constructor() {
    this.model = MODEL;
    // Always 1 — Ollama local inference, keep VRAM stable
    this.concurrentBatches = 1;
  }

  /**
   * Build compact JSON-mode prompt for Ollama.
   */
  buildPrompt(inputText, bookMetadata) {
    const subject = bookMetadata.subject || 'Unknown';
    const chapter = bookMetadata.chapter || bookMetadata.title || 'General';
    const cls = bookMetadata.class || 'Unknown';
    const board = bookMetadata.board || 'CBSE';

    return `Extract ALL exam questions from the text below. Return ONLY valid JSON.

JSON schema:
{"questions":[{"question":"string","options":["a","b","c","d"],"answer":"string","question_type":"mcq|truefalse|fill|short|long|assertionreason|integer","subject":"${subject}","topic_name":"string","chapter_name":"${chapter}","class":"${cls}","board":"${board}","difficulty":"easy|medium|hard","marks":1}]}

Rules:
- options: array of strings for MCQ/TrueFalse, else []
- answer: correct option text for MCQ, or answer text
- question_type: mcq if 4 options, truefalse if 2, fill if blanks, short/long otherwise
- marks: mcq/truefalse/fill=1, short=2, long=5, integer=2
- Extract subject/topic/chapter from headings in text when visible
- Keep question wording exact
- Deduplicate: skip repeated questions
- MATH FORMATTING (CRITICAL): ALL math expressions MUST be wrapped in $ delimiters
  - Inline math: $expression$ (e.g., $x^2 + y^2 = z^2$)
  - Display math: $$expression$$ for standalone equations
  - Matrices: $\begin{bmatrix} a & b \\ c & d \end{bmatrix}$
  - Never output bare LaTeX commands outside $ delimiters
  - Convert Unicode: × → $\times$, ² → $^{2}$, √ → $\sqrt{}$, ÷ → $\div$, ≠ → $\neq$, ≤ → $\leq$, ≥ → $\geq$, α → $\alpha$, β → $\beta$, π → $\pi$
  - Fractions: $\frac{a}{b}$, integrals: $\int_a^b f(x)dx$

TEXT:
${inputText}

JSON:`;
  }

  /**
   * Call Ollama with JSON mode. Returns parsed question array.
   */
  async callOllama(inputText, bookMetadata) {
    const prompt = this.buildPrompt(inputText, bookMetadata);

    try {
      const response = await ollama.generate({
        model: this.model,
        prompt,
        format: 'json',       // JSON mode — forces valid JSON
        stream: false,
        options: {
          temperature: 0,     // deterministic
          num_ctx: 4096,
          num_predict: 2048,
          top_p: 0.9,
          repeat_penalty: 1.1,
        },
      });

      const raw = response.response.trim();
      let parsed;

      try {
        parsed = JSON.parse(raw);
      } catch {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
          parsed = JSON.parse(raw.slice(start, end + 1));
        } else {
          console.warn('[AIEnhancer] Could not parse JSON:', raw.slice(0, 200));
          return [];
        }
      }

      if (!Array.isArray(parsed.questions)) return [];
      return parsed.questions.filter(q => q && typeof q.question === 'string' && q.question.trim());
    } catch (error) {
      console.error('[AIEnhancer] Ollama error:', error.message);
      return [];
    }
  }

  /**
   * Map Ollama JSON question → internal DB shape.
   */
  mapQuestion(q, bookMetadata) {
    const questionType = q.question_type || 'short';
    const allowedTypes = new Set(['mcq', 'short', 'long', 'truefalse', 'fill', 'integer', 'assertionreason']);
    const type = allowedTypes.has(questionType) ? questionType : 'short';

    let options = [];
    if ((type === 'mcq' || type === 'truefalse') && Array.isArray(q.options) && q.options.length > 0) {
      options = q.options.map(opt => ({
        text: this.normalizeMath(String(opt)),
        isCorrect: String(opt).trim() === String(q.answer || '').trim(),
      }));
      // If no option matched as correct, flag first
      if (options.length > 0 && options.every(o => !o.isCorrect)) {
        options[0] = { ...options[0], isCorrect: true };
      }
    }

    const marks = parseInt(q.marks) ||
      (type === 'mcq' || type === 'truefalse' || type === 'fill' ? 1 :
        type === 'long' ? 5 : 2);

    return {
      text: this.normalizeMath(String(q.question).trim()),
      type,
      subject: q.subject || bookMetadata.subject || 'Unknown',
      topic: q.topic_name || bookMetadata.topic || 'General',
      chapter: q.chapter_name || bookMetadata.chapter || 'Unknown',
      board: bookMetadata.board || 'CBSE',
      class: q.class || bookMetadata.class || 'Unknown',
      difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
      marks,
      source: 'Smart Import',
      isActive: true,
      options: options.length > 0 ? options : undefined,
      correctAnswerText: (type !== 'mcq' && type !== 'truefalse' && q.answer) ? this.normalizeMath(String(q.answer)) : undefined,
      diagram: bookMetadata.diagram || null,
    };
  }

  /**
   * Split raw text into ~CHUNK_SIZE character chunks for Ollama.
   */
  splitIntoChunks(rawQuestions) {
    // rawQuestions is array of { text, topic, chapter, exerciseLabel, diagram? }
    // Combine all text and chunk by CHUNK_SIZE chars
    const chunks = [];
    let buffer = '';
    let bufferDiagram = null;

    for (const q of rawQuestions) {
      const block = q.text || '';
      if (buffer.length + block.length > CHUNK_SIZE && buffer.length > 0) {
        chunks.push({ text: buffer.trim(), diagram: bufferDiagram });
        buffer = block;
        bufferDiagram = q.diagram || null;
      } else {
        buffer += (buffer ? '\n\n' : '') + block;
        if (!bufferDiagram && q.diagram) bufferDiagram = q.diagram;
      }
    }
    if (buffer.trim()) {
      chunks.push({ text: buffer.trim(), diagram: bufferDiagram });
    }

    return chunks;
  }

  /**
   * Enhance questions: chunk → Ollama → map → deduplicate.
   * Concurrency = 1 for VRAM stability.
   */
  async enhanceQuestions(rawQuestions, bookMetadata) {
    console.log(`\n[AIEnhancer] Ollama ${this.model} — ${rawQuestions.length} raw items`);

    const chunks = this.splitIntoChunks(rawQuestions);
    console.log(`[AIEnhancer] Split into ${chunks.length} chunk(s) (~${CHUNK_SIZE} chars each)`);

    const allQuestions = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`[AIEnhancer] Chunk ${i + 1}/${chunks.length} (${chunk.text.length} chars)...`);

      const metaWithDiagram = { ...bookMetadata, diagram: chunk.diagram || null };
      const ollamaQuestions = await this.callOllama(chunk.text, metaWithDiagram);
      const mapped = ollamaQuestions.map(q => this.mapQuestion(q, metaWithDiagram));

      console.log(`[AIEnhancer] Chunk ${i + 1}: ${mapped.length} questions extracted`);
      allQuestions.push(...mapped);
    }

    const unique = this.deduplicateQuestions(allQuestions);
    const removed = allQuestions.length - unique.length;
    console.log(`[AIEnhancer] Total: ${unique.length} unique questions (${removed} duplicates removed)`);
    return unique;
  }

  /**
   * Wrap bare LaTeX commands in $ delimiters if the model forgot.
   * Only wraps sequences that look like LaTeX and aren't already inside $...$.
   */
  normalizeMath(text) {
    if (!text) return text;
    // Wrap \begin{...}...\end{...} blocks not already in $
    text = text.replace(/(?<!\$)(\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\})(?!\$)/g, '$$$1$$');
    // Wrap isolated LaTeX commands like \frac, \sqrt, \int, \sum, \lim, \alpha etc.
    text = text.replace(/(?<!\$)(\\(?:frac|sqrt|int|sum|prod|lim|alpha|beta|gamma|delta|pi|theta|lambda|mu|sigma|omega|times|div|pm|mp|leq|geq|neq|approx|infty|partial|nabla|cdot|ldots|forall|exists|in|notin|subset|cup|cap|mathbf|mathrm|text|overline|hat|vec|bar)\b[^$\n]*?)(?!\$)/g, '$$$1$$');
    // Convert common Unicode math chars not inside $ delimiters
    text = text.replace(/(?<!\$)×(?!\$)/g, ' $\\times$ ');
    text = text.replace(/(?<!\$)÷(?!\$)/g, ' $\\div$ ');
    text = text.replace(/(?<!\$)≠(?!\$)/g, ' $\\neq$ ');
    text = text.replace(/(?<!\$)≤(?!\$)/g, ' $\\leq$ ');
    text = text.replace(/(?<!\$)≥(?!\$)/g, ' $\\geq$ ');
    text = text.replace(/(?<!\$)²(?!\$)/g, '$^{2}$');
    text = text.replace(/(?<!\$)³(?!\$)/g, '$^{3}$');
    text = text.replace(/(?<!\$)½(?!\$)/g, '$\\frac{1}{2}$');
    text = text.replace(/(?<!\$)¼(?!\$)/g, '$\\frac{1}{4}$');
    text = text.replace(/(?<!\$)¾(?!\$)/g, '$\\frac{3}{4}$');
    // Clean up accidental double-wrapping $$$ → $$
    text = text.replace(/\${3,}/g, '$$');
    return text;
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
    for (const q of questions) {
      const normalized = this.normalizeQuestionText(q?.text);
      if (!normalized) continue;
      const key = `${(q?.subject || '').toLowerCase()}::${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(q);
    }
    return unique;
  }
}

/**
 * Gemini Enhancer — Google Gemini API (cloud)
 * Same interface as AIEnhancer; override enhanceQuestions to use Gemini.
 */
class GeminiEnhancer extends AIEnhancer {
  constructor() {
    super();
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('[GeminiEnhancer] GEMINI_API_KEY env var is required');
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    this.concurrentBatches = 1;
  }

  async callGemini(inputText, bookMetadata) {
    const prompt = this.buildPrompt(inputText, bookMetadata);
    try {
      const model = this.genAI.getGenerativeModel({ model: this.geminiModel });
      const result = await model.generateContent(prompt);
      const raw = result.response.text().trim();

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Try extracting from a markdown code block first
        const mdMatch = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
        if (mdMatch) {
          try { parsed = JSON.parse(mdMatch[1]); } catch { /* fall through */ }
        }
        if (!parsed) {
          const start = raw.indexOf('{');
          const end = raw.lastIndexOf('}');
          if (start !== -1 && end !== -1) {
            try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through */ }
          }
        }
        if (!parsed) {
          console.warn('[GeminiEnhancer] Could not parse JSON:', raw.slice(0, 200));
          return [];
        }
      }

      if (!Array.isArray(parsed.questions)) return [];
      return parsed.questions.filter(q => q && typeof q.question === 'string' && q.question.trim());
    } catch (error) {
      console.error('[GeminiEnhancer] Gemini error:', error.message);
      return [];
    }
  }

  async enhanceQuestions(rawQuestions, bookMetadata) {
    console.log(`\n[GeminiEnhancer] ${this.geminiModel} — ${rawQuestions.length} raw items`);
    const chunks = this.splitIntoChunks(rawQuestions);
    console.log(`[GeminiEnhancer] Split into ${chunks.length} chunk(s) (~${CHUNK_SIZE} chars each)`);

    const allQuestions = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`[GeminiEnhancer] Chunk ${i + 1}/${chunks.length} (${chunk.text.length} chars)...`);
      const meta = { ...bookMetadata, diagram: chunk.diagram || null };
      const geminiQuestions = await this.callGemini(chunk.text, meta);
      const mapped = geminiQuestions.map(q => this.mapQuestion(q, meta));
      console.log(`[GeminiEnhancer] Chunk ${i + 1}: ${mapped.length} questions extracted`);
      allQuestions.push(...mapped);
    }

    const unique = this.deduplicateQuestions(allQuestions);
    const removed = allQuestions.length - unique.length;
    console.log(`[GeminiEnhancer] Total: ${unique.length} unique questions (${removed} duplicates removed)`);
    return unique;
  }
}

/**
 * Factory — pick enhancer based on AI_PROVIDER env var or argument.
 * @param {'ollama'|'gemini'} provider
 */
function createEnhancer(provider) {
  if (provider === 'gemini') return new GeminiEnhancer();
  return new AIEnhancer();
}

module.exports = { AIEnhancer, GeminiEnhancer, createEnhancer };
