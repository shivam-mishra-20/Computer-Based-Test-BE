/**
 * AI Enhancer — Ollama Qwen3:8b (local) + Google Gemini (cloud)
 *
 * Two prompt strategies:
 *   1. STRUCTURED (preferred): when input chunks have blockType set by the
 *      structure analyzer. One API call per semantic block. AI receives the
 *      block label and strict rules to extract exactly one question per
 *      Example/numbered item.
 *
 *   2. FALLBACK: original character-chunked approach when no structure is
 *      detected. AI receives raw text and must find all questions itself.
 *
 * NOTE: Table and image/diagram extraction is intentionally excluded from this
 * pipeline. Questions are text-only. Graphical content will be added manually.
 */

const { Ollama } = require('ollama');
const { normalizeLatex } = require('./latex-normalizer');
const { stripSolutionContent, shouldImport } = require('./content-classifier');
const { buildEmbeddedText } = require('./sub-question-grouper');
const { passesQualityGate } = require('./quality-score');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL       = process.env.AI_ENHANCER_MODEL || 'qwen3:8b';
const CHUNK_SIZE  = parseInt(process.env.AI_ENHANCER_CHUNK_SIZE || '1200', 10);

const ollama = new Ollama({ host: OLLAMA_HOST });

// Block types that represent ONE extractable question/example (one API call → one question).
const QUESTION_BLOCK_TYPES = new Set(['example', 'question', 'sub_question']);
// Block types that contain MANY questions (one API call → extract all).
const MULTI_QUESTION_BLOCK_TYPES = new Set(['question_group', 'exercise_header', 'section_header']);
// Block types that are section containers — pass through to children via context.
const HEADER_BLOCK_TYPES   = new Set(['exercise_header', 'section_header', 'chapter_header']);

// ── Shared JSON schema string ─────────────────────────────────────────────────

function jsonSchema(subject, chapter, cls, board) {
  return `{"questions":[{"question":"string","instructions":"string (the lead-in like 'Simplify the following', else empty)","sub_questions":["(i) ...","(ii) ..."],"options":["a","b","c","d"],"answer":"string","question_type":"mcq|truefalse|fill|short|long|assertionreason|integer","subject":"${subject}","topic_name":"string","sub_topic":"string","chapter_name":"${chapter}","class":"${cls}","board":"${board}","difficulty":"easy|medium|hard","marks":1}]}`;
}

// ── Math formatting rules (shared) ───────────────────────────────────────────

const MATH_RULES = `MATH FORMATTING (CRITICAL):
- Wrap ALL math in $ delimiters: inline $expr$, display $$expr$$
- Use braces on every script: x^{2} not x^2, H_{2}O not H_2O
- Matrices: $\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}$
- Never output bare LaTeX outside $ delimiters; never emit empty \\frac{}{} or \\sqrt{}
- Unicode: × → $\\times$, ² → $^{2}$, √2 → $\\sqrt{2}$, ÷ → $\\div$, ≠ → $\\neq$, ≤ → $\\leq$, ≥ → $\\geq$, α → $\\alpha$, β → $\\beta$, π → $\\pi$
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

    const isMultiQ = MULTI_QUESTION_BLOCK_TYPES.has(blockType);

    const extractionRule = isMultiQ
      ? '- Extract EVERY distinct numbered question in the text as a separate JSON item. Do NOT merge two questions into one.'
      : '- Extract EXACTLY ONE question from this block. Do not split it into multiple.';

    return `You are extracting exam questions from an Indian NCERT/CBSE/JEE/NEET textbook. Return ONLY valid JSON.

BLOCK TYPE: ${blockType}
BLOCK LABEL: ${blockLabel}${parent}

JSON schema:
${jsonSchema(subject, chapter, cls, board)}

Extraction rules:
${extractionRule}
- Each question must be self-contained and include all context needed to answer it.
- A valid question has a clear task: Find, Calculate, Prove, Show, Explain, State, Define, Describe, Choose, Match, What, Which, How, Why, or ends with "?".

SUB-QUESTIONS (IMPORTANT):
- If a stem like "Simplify the following:" is followed by parts (i)(ii)(iii) or (a)(b)(c), keep them as ONE question: put the lead-in in "instructions" and the parts in "sub_questions". Do NOT emit each part as a separate question.
- Do NOT confuse MCQ OPTIONS with sub-questions: (a)(b)(c)(d) right after a single question are OPTIONS → put them in "options", leave "sub_questions" empty.

SKIP entirely (do not output):
- chapter titles, section/exercise headings, page numbers, headers, footers
- Solution:, Answer:, Proof:, Given:, Note:, Remark:, Hint:, Therefore, Hence, Step N:
- definitions, theorems, activities, projects, summaries, learning outcomes, explanatory prose
- any fragment with no clear task

CLASSIFICATION:
- question_type: mcq (has options), truefalse, fill (blanks/____), short (≤2 line answer), long, integer/numerical, assertionreason
- options: string array for mcq/truefalse; else []
- answer: the correct option text for mcq; a brief answer otherwise (omit if unknown)
- topic_name + sub_topic: infer from the block label / nearby heading
- difficulty: easy | medium | hard, judged from complexity
- marks: mcq/truefalse/fill=1, short=2, long=5, integer=2
${MATH_RULES}

BLOCK TEXT:
${chunk.text}
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

    return `Extract EVERY distinct exam question from the text below. Return ONLY valid JSON.

JSON schema:
${jsonSchema(subject, chapter, cls, board)}

Rules:
- A valid question has a clear task: Find, Calculate, Prove, Show, Explain, State, Define, Describe, Choose, Match, What, Which, How, Why, or ends with "?".
- Each question must be self-contained. Keep wording exact — do NOT paraphrase. Deduplicate repeats.
- SUB-QUESTIONS: a stem ("Simplify the following:") with parts (i)(ii)(iii) is ONE question — put the lead-in in "instructions" and the parts in "sub_questions". Do NOT split the parts into separate questions.
- OPTIONS vs sub-questions: (a)(b)(c)(d) after a single stem are OPTIONS → "options"; leave "sub_questions" empty.
- options: array of strings for MCQ/TrueFalse, else []
- answer: correct option text for MCQ, or brief answer (omit if unknown)
- question_type: mcq, truefalse, fill, short, long, integer, assertionreason
- marks: mcq/truefalse/fill=1, short=2, long=5, integer=2
- topic_name + sub_topic + chapter: infer from headings in the text when visible
- SKIP: chapter titles, section/exercise headings, page numbers, headers, footers
- SKIP: Solution:, Answer:, Proof:, Given:, Note:, Remark:, Hint:, Therefore, Hence, Step N:
- SKIP: definitions, theorems, activities, projects, summaries, learning outcomes, explanatory prose
- SKIP: any fragment with no clear task
${MATH_RULES}

TEXT:
${inputText}
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

  // Map the AI's extended type vocabulary onto the fixed schema enum.
  normalizeType(t) {
    const k = String(t || '').toLowerCase().replace(/[_\s-]/g, '');
    const map = {
      mcq: 'mcq', multiplechoice: 'mcq', objective: 'mcq', singlecorrect: 'mcq',
      truefalse: 'truefalse', tf: 'truefalse',
      fill: 'fill', fillintheblank: 'fill', fillintheblanks: 'fill', blank: 'fill',
      short: 'short', shortanswer: 'short', long: 'long', longanswer: 'long', essay: 'long', descriptive: 'long',
      integer: 'integer', integertype: 'integer', numerical: 'integer', numeric: 'integer',
      assertionreason: 'assertionreason', assertion: 'assertionreason',
      // Extended types map onto the closest schema enum (fine-grained label lives in logs)
      match: 'short', matchthefollowing: 'short', matchfollowing: 'short',
      casestudy: 'short', passage: 'short', passagebased: 'short', comprehension: 'short',
    };
    return map[k] || 'short';
  }

  mapQuestion(q, chunkMeta) {
    const type = this.normalizeType(q.question_type);
    const isExample = chunkMeta.blockType === 'example';

    // Compose the question text: embed sub-parts (Phase 2), strip worked
    // solutions for Examples (per import policy), then normalize LaTeX.
    const stem = String(q.question || '').trim();
    const instr = String(q.instructions || '').trim();
    const subs = Array.isArray(q.sub_questions)
      ? q.sub_questions.map(s => String(s || '').trim()).filter(Boolean)
      : [];

    let rawText = subs.length >= 1
      ? buildEmbeddedText(instr || stem, subs.map(s => ({ label: '', text: s })))
      : stem;
    if (isExample) rawText = stripSolutionContent(rawText, { aggressive: true });
    const text = this.normalizeMath(rawText).trim();

    let options = [];
    if ((type === 'mcq' || type === 'truefalse') && Array.isArray(q.options) && q.options.length > 0) {
      options = q.options
        .map(opt => String(opt || '').trim())
        .filter(Boolean)
        .map(opt => ({ text: this.normalizeMath(opt), isCorrect: opt === String(q.answer || '').trim() }));
      if (options.length > 0 && options.every(o => !o.isCorrect)) {
        options[0] = { ...options[0], isCorrect: true };
      }
    }

    const marks = parseInt(q.marks) ||
      (type === 'mcq' || type === 'truefalse' || type === 'fill' ? 1 :
        type === 'long' ? 5 : 2);

    return {
      text,
      type,
      subject:           q.subject      || chunkMeta.subject || 'Unknown',
      topic:             q.topic_name   || chunkMeta.topic   || 'General',
      chapter:           q.chapter_name || chunkMeta.chapter || 'Unknown',
      board:             chunkMeta.board || 'CBSE',
      class:             q.class        || chunkMeta.class   || 'Unknown',
      section:           isExample ? 'Example' : undefined,
      difficulty:        ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
      marks,
      source:            'Smart Import',
      isActive:          true,
      options:           options.length > 0 ? options : undefined,
      correctAnswerText: (type !== 'mcq' && type !== 'truefalse' && q.answer)
        ? this.normalizeMath(String(q.answer)) : undefined,
      // In-memory only (not persisted) — used by the quality scorer / logs.
      hasSubParts:       subs.length >= 1,
      subParts:          subs.length >= 1 ? subs.map(s => ({ label: '', text: s })) : undefined,
      _subTopic:         q.sub_topic || undefined,
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
      // Defense-in-depth: drop instructional/solution blocks the parser missed.
      if (!shouldImport(block.blockType)) continue;

      if (block.blockType === 'question_group') {
        // Multi-question page → one structured call that extracts ALL questions
        out.push({ ...block, _structured: true });
      } else if (QUESTION_BLOCK_TYPES.has(block.blockType)) {
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
   * Fallback: character-based chunking for text-only question extraction.
   */
  splitIntoChunks(rawQuestions) {
    const chunks = [];
    let buffer = '';

    for (const q of rawQuestions) {
      const block = q.text || '';
      if (buffer.length + block.length > CHUNK_SIZE && buffer.length > 0) {
        chunks.push({ text: buffer.trim(), _structured: false });
        buffer = block;
      } else {
        buffer += (buffer ? '\n\n' : '') + block;
      }
    }
    if (buffer.trim()) {
      chunks.push({ text: buffer.trim(), _structured: false });
    }
    return chunks;
  }

  // ── Main enhancer ───────────────────────────────────────────────────────────

  async enhanceQuestions(rawQuestions, bookMetadata) {
    return this._enhance(rawQuestions, bookMetadata, (p) => this.callOllama(p), `[AIEnhancer] Ollama ${this.model}`);
  }

  /**
   * Shared extraction loop for both Ollama and Gemini: chunk → AI → map →
   * quality-gate → dedup. Emits Phase-9 structured logs.
   * @param {(prompt:string)=>Promise<object[]>} callFn  provider call
   */
  async _enhance(rawQuestions, bookMetadata, callFn, tag) {
    const hasStructure = rawQuestions.some(q => q.blockType);
    console.log(`\n${tag} — ${rawQuestions.length} raw block(s) (${hasStructure ? 'structured' : 'unstructured'})`);

    const chunks = hasStructure
      ? this.splitStructuredBlocks(rawQuestions)
      : this.splitIntoChunks(rawQuestions);
    console.log(`${tag} ${chunks.length} chunk(s) to process`);

    const all = [];
    const stats = { extracted: 0, kept: 0, rejected: 0, examples: 0, subpart: 0 };

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const label = chunk.blockLabel || `chunk ${i + 1}`;
      console.log(`${tag} ${i + 1}/${chunks.length} [${chunk.blockType || 'text'}] "${String(label).slice(0, 50)}" (${chunk.text.length} chars)`);

      const chunkMeta = {
        ...bookMetadata,
        chapter:     chunk.chapter || bookMetadata.chapter,
        topic:       chunk.topic   || bookMetadata.topic,
        parentLabel: chunk.parentLabel || null,
        blockType:   chunk.blockType || null,
      };

      const prompt = chunk._structured
        ? this.buildStructuredPrompt(chunk, chunkMeta)
        : this.buildPrompt(chunk.text, chunkMeta);

      const raw = await callFn(prompt);
      stats.extracted += raw.length;

      let kept = 0;
      for (const rq of raw) {
        const mapped = this.mapQuestion(rq, chunkMeta);
        const gate = passesQualityGate(mapped);
        if (!gate.pass) {
          stats.rejected++;
          if (stats.rejected <= 25) {
            console.log(`${tag}   [Quality] ✗ score=${gate.score} (${gate.reasons.slice(0, 3).join('; ')}) :: "${mapped.text.slice(0, 45)}"`);
          }
          continue;
        }
        if (mapped.section === 'Example') stats.examples++;
        if (mapped.hasSubParts) { stats.subpart++; console.log(`${tag}   [SubQ] parent + ${mapped.subParts.length} parts :: "${mapped.text.split('\n')[0].slice(0, 45)}"`); }
        all.push(mapped);
        kept++;
      }
      stats.kept += kept;
      console.log(`${tag}   → ${kept} kept / ${raw.length} extracted`);
    }

    const unique  = this.deduplicateQuestions(all);
    const dupes   = all.length - unique.length;
    console.log(`${tag} ✅ ${unique.length} questions | gate-rejected ${stats.rejected}, dupes ${dupes}, examples ${stats.examples}, multi-part ${stats.subpart}`);

    // Strip in-memory-only helper fields before import.
    return unique.map(({ hasSubParts, subParts, _subTopic, ...q }) => q);
  }

  // ── Math normalization ──────────────────────────────────────────────────────
  // Delegates to the dedicated latex-normalizer (Phase 4) — the single source of
  // truth for clean, balanced, KaTeX-renderable math.

  normalizeMath(text) {
    return normalizeLatex(text);
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
    return this._enhance(rawQuestions, bookMetadata, (p) => this.callGeminiWithPrompt(p), `[GeminiEnhancer] ${this.geminiModel}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function createEnhancer(provider) {
  if (provider === 'gemini') return new GeminiEnhancer();
  return new AIEnhancer();
}

module.exports = { AIEnhancer, GeminiEnhancer, createEnhancer };
