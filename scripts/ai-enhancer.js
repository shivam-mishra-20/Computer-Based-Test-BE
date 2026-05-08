/**
 * AI Enhancer — Ollama Qwen3:8b (local) + Google Gemini (cloud)
 *
 * Two prompt strategies:
 *   1. STRUCTURED (preferred): when input chunks have blockType set by the
 *      structure analyzer. One API call per semantic block. AI receives the
 *      pre-parsed table as a markdown table, the block label, and strict rules
 *      to extract exactly one question per Example/numbered item.
 *
 *   2. FALLBACK: original character-chunked approach when no structure is
 *      detected. AI receives raw text and must find all questions itself.
 */

const { Ollama } = require('ollama');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL       = process.env.AI_ENHANCER_MODEL || 'qwen3:8b';
const CHUNK_SIZE  = parseInt(process.env.AI_ENHANCER_CHUNK_SIZE || '1200', 10);

const ollama = new Ollama({ host: OLLAMA_HOST });

// Block types that represent a single extractable question/example
const QUESTION_BLOCK_TYPES = new Set(['example', 'question', 'sub_question', 'theorem']);
// Block types that are section containers — pass through to children via context
const HEADER_BLOCK_TYPES   = new Set(['exercise_header', 'section_header', 'chapter_header']);

// ── Markdown table formatter ──────────────────────────────────────────────────

function tableToMarkdown(tableData) {
  if (!tableData || !tableData.headers || !tableData.rows) return '';
  const sep  = tableData.headers.map(() => '---').join(' | ');
  const head = tableData.headers.join(' | ');
  const rows = tableData.rows.map(r => r.join(' | ')).join('\n');
  return `${head}\n${sep}\n${rows}`;
}

// ── Shared JSON schema string ─────────────────────────────────────────────────

function jsonSchema(subject, chapter, cls, board) {
  return `{"questions":[{"question":"string","options":["a","b","c","d"],"answer":"string","question_type":"mcq|truefalse|fill|short|long|assertionreason|integer","subject":"${subject}","topic_name":"string","chapter_name":"${chapter}","class":"${cls}","board":"${board}","difficulty":"easy|medium|hard","marks":1}]}`;
}

// ── Math formatting rules (shared) ───────────────────────────────────────────

const MATH_RULES = `MATH FORMATTING (CRITICAL):
- Wrap ALL math in $ delimiters: inline $expr$, display $$expr$$
- Matrices: $\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}$
- Never output bare LaTeX outside $ delimiters
- Unicode: × → $\\times$, ² → $^{2}$, √ → $\\sqrt{}$, ÷ → $\\div$, ≠ → $\\neq$, ≤ → $\\leq$, ≥ → $\\geq$, α → $\\alpha$, β → $\\beta$, π → $\\pi$
- Fractions: $\\frac{a}{b}$, integrals: $\\int_a^b f(x)dx$`;

// ─────────────────────────────────────────────────────────────────────────────

class AIEnhancer {
  constructor() {
    this.model = MODEL;
    this.concurrentBatches = 1;
  }

  // ── Prompt builders ─────────────────────────────────────────────────────────

  /**
   * Structured prompt: used when the structure analyzer has already identified
   * the block type and extracted tables. AI's job is normalization, not discovery.
   */
  buildStructuredPrompt(chunk, bookMetadata) {
    const subject = bookMetadata.subject || 'Unknown';
    const chapter = bookMetadata.chapter || bookMetadata.title || 'General';
    const cls     = bookMetadata.class   || 'Unknown';
    const board   = bookMetadata.board   || 'CBSE';

    const blockType  = chunk.blockType  || 'question';
    const blockLabel = chunk.blockLabel || '';
    const parent     = chunk.parentLabel ? `\nPARENT SECTION: ${chunk.parentLabel}` : '';

    const tableMd = tableToMarkdown(chunk.tableData);
    const tableSection = tableMd
      ? `\nEXACT TABLE DATA (pre-extracted — use this verbatim, do NOT re-read from text):\n${tableMd}\n`
      : '';

    const isMultiQ = blockType === 'exercise_header' || blockType === 'section_header';

    const extractionRule = isMultiQ
      ? '- Extract ALL numbered questions/sub-questions found in the text'
      : '- Extract EXACTLY ONE question from this block. Do not split it.';

    return `You are extracting exam questions from an Indian NCERT/CBSE textbook. Return ONLY valid JSON.

BLOCK TYPE: ${blockType}
BLOCK LABEL: ${blockLabel}${parent}

JSON schema:
${jsonSchema(subject, chapter, cls, board)}

Rules:
${extractionRule}
- question text must be self-contained and include all necessary context
- SKIP: Solution:, Proof:, Given:, Note:, Remark:, Therefore, Hence, Step N:
- SKIP explanatory paragraphs that do not contain a task/imperative verb
- options: string array for mcq/truefalse, else []
- answer: correct option text for mcq, or brief answer for others
- question_type: mcq (4 opts), truefalse (2 opts), fill (blanks), short (≤2 lines answer), long (>2 lines), integer
- marks: mcq/truefalse/fill=1, short=2, long=5, integer=2
- difficulty: judge from complexity (easy/medium/hard)
- topic_name: infer from block label or text heading
${tableSection ? '- If question refers to a table, the question_text must mention it clearly' : ''}
${MATH_RULES}

BLOCK TEXT:
${chunk.text}
${tableSection}
JSON:`;
  }

  /**
   * Fallback prompt: no structure info, AI must discover questions itself.
   */
  buildPrompt(inputText, bookMetadata) {
    const subject = bookMetadata.subject || 'Unknown';
    const chapter = bookMetadata.chapter || bookMetadata.title || 'General';
    const cls     = bookMetadata.class   || 'Unknown';
    const board   = bookMetadata.board   || 'CBSE';

    const tableMd = tableToMarkdown(bookMetadata.tableData);
    const tableSection = tableMd
      ? `\nEXACT TABLE DATA:\n${tableMd}\n`
      : '';

    return `Extract ALL exam questions from the text below. Return ONLY valid JSON.

JSON schema:
${jsonSchema(subject, chapter, cls, board)}

Rules:
- options: array of strings for MCQ/TrueFalse, else []
- answer: correct option text for MCQ, or answer text
- question_type: mcq if 4 options, truefalse if 2, fill if blanks, short/long otherwise
- marks: mcq/truefalse/fill=1, short=2, long=5, integer=2
- Extract subject/topic/chapter from headings in text when visible
- Keep question wording exact
- Deduplicate: skip repeated questions
- SKIP: Solution:, Proof:, Given:, Note:, Remark:, explanatory paragraphs
${MATH_RULES}

TEXT:
${inputText}
${tableSection}
JSON:`;
  }

  // ── Ollama call ─────────────────────────────────────────────────────────────

  async callOllama(promptText) {
    try {
      const response = await ollama.generate({
        model:   this.model,
        prompt:  promptText,
        format:  'json',
        stream:  false,
        options: {
          temperature:    0,
          num_ctx:        4096,
          num_predict:    2048,
          top_p:          0.9,
          repeat_penalty: 1.1,
        },
      });

      return this._parseJsonResponse(response.response.trim(), '[AIEnhancer]');
    } catch (error) {
      console.error('[AIEnhancer] Ollama error:', error.message);
      return [];
    }
  }

  _parseJsonResponse(raw, tag) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const mdMatch = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
      if (mdMatch) {
        try { parsed = JSON.parse(mdMatch[1]); } catch { /* fall through */ }
      }
      if (!parsed) {
        const start = raw.indexOf('{');
        const end   = raw.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
          try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through */ }
        }
      }
      if (!parsed) {
        console.warn(`${tag} Could not parse JSON:`, raw.slice(0, 200));
        return [];
      }
    }
    if (!Array.isArray(parsed.questions)) return [];
    return parsed.questions.filter(q => q && typeof q.question === 'string' && q.question.trim());
  }

  // ── Question mapper ─────────────────────────────────────────────────────────

  mapQuestion(q, chunkMeta) {
    const questionType = q.question_type || 'short';
    const allowedTypes = new Set(['mcq', 'short', 'long', 'truefalse', 'fill', 'integer', 'assertionreason']);
    const type = allowedTypes.has(questionType) ? questionType : 'short';

    let options = [];
    if ((type === 'mcq' || type === 'truefalse') && Array.isArray(q.options) && q.options.length > 0) {
      options = q.options.map(opt => ({
        text:      this.normalizeMath(String(opt)),
        isCorrect: String(opt).trim() === String(q.answer || '').trim(),
      }));
      if (options.length > 0 && options.every(o => !o.isCorrect)) {
        options[0] = { ...options[0], isCorrect: true };
      }
    }

    const marks = parseInt(q.marks) ||
      (type === 'mcq' || type === 'truefalse' || type === 'fill' ? 1 :
        type === 'long' ? 5 : 2);

    return {
      text:              this.normalizeMath(String(q.question).trim()),
      type,
      subject:           q.subject           || chunkMeta.subject  || 'Unknown',
      topic:             q.topic_name        || chunkMeta.topic    || 'General',
      chapter:           q.chapter_name      || chunkMeta.chapter  || 'Unknown',
      board:             chunkMeta.board     || 'CBSE',
      class:             q.class             || chunkMeta.class    || 'Unknown',
      difficulty:        ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
      marks,
      source:            'Smart Import',
      isActive:          true,
      options:           options.length > 0 ? options : undefined,
      correctAnswerText: (type !== 'mcq' && type !== 'truefalse' && q.answer)
        ? this.normalizeMath(String(q.answer)) : undefined,
      diagram:           chunkMeta.diagram   || null,
      tableData:         chunkMeta.tableData || null,
    };
  }

  // ── Chunk strategies ────────────────────────────────────────────────────────

  /**
   * When input has blockType set (structure-aware path):
   * Each block becomes one API call. Question blocks pass through directly.
   * Body/header blocks that exceed CHUNK_SIZE are split by paragraph.
   */
  splitStructuredBlocks(rawBlocks) {
    const out = [];
    for (const block of rawBlocks) {
      if (QUESTION_BLOCK_TYPES.has(block.blockType)) {
        // One block = one API call — never merge with others
        out.push({ ...block, _structured: true });
      } else if (HEADER_BLOCK_TYPES.has(block.blockType)) {
        // Headers become body-type fallback if they contain substantial text
        if (block.text.length > 200) {
          out.push({ ...block, _structured: false });
        }
      } else {
        // body/unknown — character-chunk as before
        if (block.text.length <= CHUNK_SIZE) {
          out.push({ ...block, _structured: false });
        } else {
          const paras = block.text.split(/\n{2,}/);
          let buf = '';
          for (const para of paras) {
            if (buf.length + para.length > CHUNK_SIZE && buf.length > 0) {
              out.push({ ...block, text: buf.trim(), _structured: false });
              buf = para;
            } else {
              buf += (buf ? '\n\n' : '') + para;
            }
          }
          if (buf.trim()) out.push({ ...block, text: buf.trim(), _structured: false });
        }
      }
    }
    return out;
  }

  /**
   * Fallback: character-based chunking, preserving first diagram/table per chunk.
   */
  splitIntoChunks(rawQuestions) {
    const chunks = [];
    let buffer        = '';
    let bufferDiagram = null;
    let bufferTable   = null;

    for (const q of rawQuestions) {
      const block = q.text || '';
      if (buffer.length + block.length > CHUNK_SIZE && buffer.length > 0) {
        chunks.push({ text: buffer.trim(), diagram: bufferDiagram, tableData: bufferTable, _structured: false });
        buffer        = block;
        bufferDiagram = q.diagram   || null;
        bufferTable   = q.tableData || null;
      } else {
        buffer += (buffer ? '\n\n' : '') + block;
        if (!bufferDiagram && q.diagram)   bufferDiagram = q.diagram;
        if (!bufferTable   && q.tableData) bufferTable   = q.tableData;
      }
    }
    if (buffer.trim()) {
      chunks.push({ text: buffer.trim(), diagram: bufferDiagram, tableData: bufferTable, _structured: false });
    }
    return chunks;
  }

  // ── Main enhancer ───────────────────────────────────────────────────────────

  async enhanceQuestions(rawQuestions, bookMetadata) {
    const hasStructure = rawQuestions.some(q => q.blockType);
    console.log(`\n[AIEnhancer] Ollama ${this.model} — ${rawQuestions.length} raw items (${hasStructure ? 'structured' : 'unstructured'})`);

    const chunks = hasStructure
      ? this.splitStructuredBlocks(rawQuestions)
      : this.splitIntoChunks(rawQuestions);

    console.log(`[AIEnhancer] ${chunks.length} chunk(s) to process`);

    const allQuestions = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const label = chunk.blockLabel || `chunk ${i + 1}`;
      console.log(`[AIEnhancer] ${i + 1}/${chunks.length} [${chunk.blockType || 'text'}] "${label.slice(0, 50)}" (${chunk.text.length} chars)`);

      const chunkMeta = {
        ...bookMetadata,
        diagram:   chunk.diagram   || null,
        tableData: chunk.tableData || null,
        blockType: chunk.blockType || null,
      };

      const prompt = chunk._structured
        ? this.buildStructuredPrompt(chunk, chunkMeta)
        : this.buildPrompt(chunk.text, chunkMeta);

      const raw    = await this.callOllama(prompt);
      const mapped = raw.map(q => this.mapQuestion(q, chunkMeta));
      console.log(`[AIEnhancer]   → ${mapped.length} question(s)`);
      allQuestions.push(...mapped);
    }

    const unique  = this.deduplicateQuestions(allQuestions);
    const removed = allQuestions.length - unique.length;
    console.log(`[AIEnhancer] Total: ${unique.length} unique (${removed} duplicates removed)`);
    return unique;
  }

  // ── Math normalization ──────────────────────────────────────────────────────

  normalizeMath(text) {
    if (!text) return text;
    text = text.replace(/(?<!\$)(\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\})(?!\$)/g, '$$$1$$');
    text = text.replace(/(?<!\$)(\\(?:frac|sqrt|int|sum|prod|lim|alpha|beta|gamma|delta|pi|theta|lambda|mu|sigma|omega|times|div|pm|mp|leq|geq|neq|approx|infty|partial|nabla|cdot|ldots|forall|exists|in|notin|subset|cup|cap|mathbf|mathrm|text|overline|hat|vec|bar)\b[^$\n]*?)(?!\$)/g, '$$$1$$');
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
    const seen   = new Set();
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

// ─────────────────────────────────────────────────────────────────────────────

class GeminiEnhancer extends AIEnhancer {
  constructor() {
    super();
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('[GeminiEnhancer] GEMINI_API_KEY env var is required');
    this.genAI       = new GoogleGenerativeAI(apiKey);
    this.geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  }

  async callGeminiWithPrompt(promptText) {
    try {
      const model  = this.genAI.getGenerativeModel({ model: this.geminiModel });
      const result = await model.generateContent(promptText);
      const raw    = result.response.text().trim();
      return this._parseJsonResponse(raw, '[GeminiEnhancer]');
    } catch (error) {
      console.error('[GeminiEnhancer] Gemini error:', error.message);
      return [];
    }
  }

  async enhanceQuestions(rawQuestions, bookMetadata) {
    const hasStructure = rawQuestions.some(q => q.blockType);
    console.log(`\n[GeminiEnhancer] ${this.geminiModel} — ${rawQuestions.length} raw items (${hasStructure ? 'structured' : 'unstructured'})`);

    const chunks = hasStructure
      ? this.splitStructuredBlocks(rawQuestions)
      : this.splitIntoChunks(rawQuestions);

    console.log(`[GeminiEnhancer] ${chunks.length} chunk(s) to process`);

    const allQuestions = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const label = chunk.blockLabel || `chunk ${i + 1}`;
      console.log(`[GeminiEnhancer] ${i + 1}/${chunks.length} [${chunk.blockType || 'text'}] "${label.slice(0, 50)}" (${chunk.text.length} chars)`);

      const chunkMeta = {
        ...bookMetadata,
        diagram:   chunk.diagram   || null,
        tableData: chunk.tableData || null,
        blockType: chunk.blockType || null,
      };

      const prompt = chunk._structured
        ? this.buildStructuredPrompt(chunk, chunkMeta)
        : this.buildPrompt(chunk.text, chunkMeta);

      const raw    = await this.callGeminiWithPrompt(prompt);
      const mapped = raw.map(q => this.mapQuestion(q, chunkMeta));
      console.log(`[GeminiEnhancer]   → ${mapped.length} question(s)`);
      allQuestions.push(...mapped);
    }

    const unique  = this.deduplicateQuestions(allQuestions);
    const removed = allQuestions.length - unique.length;
    console.log(`[GeminiEnhancer] Total: ${unique.length} unique (${removed} duplicates removed)`);
    return unique;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function createEnhancer(provider) {
  if (provider === 'gemini') return new GeminiEnhancer();
  return new AIEnhancer();
}

module.exports = { AIEnhancer, GeminiEnhancer, createEnhancer };
