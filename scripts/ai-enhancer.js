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

// LLMs emit LaTeX with single backslashes inside JSON ("\frac"); JSON.parse then
// mangles them (\f/\t/\b/\n are valid escapes). Double lone command backslashes
// so \frac/\times/\beta survive parsing. Keeps \\, \uXXXX, \" and \/ intact.
function fixLatexBackslashes(s) {
  return String(s == null ? '' : s).replace(
    /(?<!\\)\\(u[0-9a-fA-F]{4}|[a-zA-Z])/g,
    (m, g) => (/^u[0-9a-fA-F]{4}$/.test(g) ? m : '\\\\' + g)
  );
}

// Block types that represent ONE extractable question/example (one API call → one question).
const QUESTION_BLOCK_TYPES = new Set(['example', 'question', 'sub_question']);
// Block types that contain MANY questions (one API call → extract all).
const MULTI_QUESTION_BLOCK_TYPES = new Set(['question_group', 'exercise_header', 'section_header']);
// Block types that are section containers — pass through to children via context.
const HEADER_BLOCK_TYPES   = new Set(['exercise_header', 'section_header', 'chapter_header']);

// ── Shared JSON schema string ─────────────────────────────────────────────────

function jsonSchema(subject, chapter, cls, board) {
  // NOTE: "options" holds the FULL VALUE of each choice (e.g. "23.3 g",
  // "C_{2}H_{4}"), NEVER the label letters a/b/c/d. "uncertain":true when any
  // symbol/value could not be read confidently → routed to human review.
  return `{"questions":[{"question":"string","instructions":"string (the lead-in like 'Simplify the following', else empty)","sub_questions":["(i) ...","(ii) ..."],"options":["<full text of choice 1>","<full text of choice 2>","<full text of choice 3>","<full text of choice 4>"],"answer":"string","question_type":"mcq|truefalse|fill|short|long|assertionreason|integer","subject":"${subject}","topic_name":"string","sub_topic":"string","chapter_name":"${chapter}","class":"${cls}","board":"${board}","difficulty":"easy|medium|hard","marks":1,"uncertain":false}]}`;
}

// Strip a leading MCQ option marker: "(a) ", "a) ", "A. ", "(A)", "b: " → "".
// Only single letters a-d/A-D followed by a delimiter — won't touch a value
// that merely starts with a letter ("C_{2}H_{4}" has no delimiter after C).
function stripOptionMarker(s) {
  return String(s || '').replace(/^\s*[([]?\s*[a-dA-D]\s*[).\].:]\s+/, '').trim();
}

// A bare option label with NO value ("a", "(b)", "C.", "d)") — signals the
// option VALUES were lost during OCR/parsing.
function isBareOptionLabel(s) {
  return /^\s*[([]?\s*[a-dA-D1-4]\s*[).\].:]?\s*$/.test(String(s || ''));
}

// FIDELITY: for the image/OCR path the SOURCE text is already verbatim, so the
// question STEM is taken from it directly (never the LLM's re-emission, which
// can drop/alter content). This trims a leading "N." and the trailing MCQ
// options block "(a) ... (b) ..." so only the stem (with any "(Given:...)"
// data) remains. Non-MCQ text is returned intact.
function stemFromSource(sourceText) {
  let t = String(sourceText || '').trim().replace(/^\s*\d{1,2}\s*[.)]\s*/, '');
  const aMatch = t.match(/\(\s*a\s*\)/i);
  if (aMatch && aMatch.index != null && /\(\s*b\s*\)/i.test(t.slice(aMatch.index))) {
    t = t.slice(0, aMatch.index).trim();
  }
  // One logical question → collapse internal line breaks to spaces (content
  // preserved; avoids literal "\n" and keeps the stem on one flowing line).
  return t.replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

// ── Math formatting rules (shared) ───────────────────────────────────────────

const MATH_RULES = `EXTRACTION FIDELITY (CRITICAL — a SINGLE wrong subscript, superscript, coefficient, charge, unit, symbol or digit is a FAILURE):
- Reproduce every chemical formula, equation, coefficient, subscript, superscript, charge, ion, reaction arrow, unit, symbol and numeric value EXACTLY as printed. Do NOT correct, balance, simplify, round, or infer anything.
- Keep the COMPLETE question: EVERY sentence of setup/context, ALL given data and constants (including any "(Given: ...)" clause and values like N_A, atomic masses, concentrations), and every numeric value. NEVER truncate, shorten, summarize, or drop any part of the question — the extracted question must be fully answerable on its own.
- A "(Given: ...)" line, a "(Take g = 10 ...)" note, or a bracketed data list on its OWN line immediately before/after a question BELONGS to that question — append it to that question's text verbatim; do NOT drop it or emit it as a separate item. Example: SOURCE "The value of x is ___. (Nearest Integer)\\n(Given: Atomic mass of Mg = 24 g mol^-1; N_A = 6.02 * 10^23 mol^-1)" → question text MUST end with "... (Given: Atomic mass of Mg = $24 \\text{ g mol}^{-1}$; $N_A = 6.02 \\times 10^{23} \\text{ mol}^{-1}$)".
- If ANY symbol, digit, formula, or option value is unclear/ambiguous/partially cut off in the source, do NOT guess — set "uncertain":true for that question so a human reviews it. Extract your best reading of the rest.

OPTIONS (CRITICAL):
- Each option is the FULL text/value of the choice, NOT the label. "(a) 23.3 g" → "23.3 g"; "(b) C_{2}H_{4}" → "C_{2}H_{4}". Strip only the leading (a)/(A)/A./A) marker; keep EVERYTHING after it including units.
- NEVER output bare label letters ("a","b","c","d") as options — that means the values were lost; re-read them, or set "uncertain":true.

MATH FORMATTING:
- Wrap ALL math in $ delimiters: inline $expr$, display $$expr$$
- Use braces on every script: x^{2} not x^2, H_{2}O not H_2O
- Matrices: $\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}$
- Never output bare LaTeX outside $ delimiters; never emit empty \\frac{}{} or \\sqrt{}
- Unicode: × → $\\times$, ² → $^{2}$, √2 → $\\sqrt{2}$, ÷ → $\\div$, ≠ → $\\neq$, ≤ → $\\leq$, ≥ → $\\geq$, α → $\\alpha$, β → $\\beta$, π → $\\pi$
- Fractions: $\\frac{a}{b}$, integrals: $\\int_a^b f(x)dx$

CHEMISTRY / PHYSICS (preserve notation EXACTLY):
- Atom-count subscripts: $H_{2}SO_{4}$, $CO_{2}$, $BaCl_{2}$, $H_{2}O$. Ionic charges as superscripts: $Na^{+}$, $Cl^{-}$, $SO_{4}^{2-}$.
- Physical states stay literal: (s), (l), (g), (aq). Reaction arrows: → as $\\rightarrow$, ⇌/⇋ as $\\rightleftharpoons$.
- Keep stoichiometric coefficients EXACTLY as written (e.g. $2H_{2} + O_{2} \\rightarrow 2H_{2}O$). NEVER rebalance or add/remove coefficients.
- Keep every unit attached to its value: "23.3 g", "100 mL", "9.8%", "48 ppm", "24 g mol^{-1}", "$6.02 \\times 10^{23}$". Preserve exponents on units: $mol^{-1}$, $m s^{-2}$.`;

// ─────────────────────────────────────────────────────────────────────────────

class AIEnhancer {
  constructor() {
    this.model = MODEL;
    // Local Ollama: sequential, single-question calls (GPU/VRAM-safe).
    this.maxConcurrency = 1;
    this.maxBatchSize = 1;
    this.maxRetries = parseInt(process.env.AI_ENHANCER_MAX_RETRIES || '2', 10);
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
- Solution:, Answer:, Proof:, Note:, Remark:, Hint:, Therefore, Hence, Step N: (worked-solution scaffolding ONLY)
- NOTE: a "(Given: ...)" clause that supplies DATA/CONSTANTS for the question (atomic masses, N_A, g, values) is PART OF THE QUESTION — KEEP it verbatim, never skip it.
- definitions, theorems, activities, projects, summaries, learning outcomes, explanatory prose
- any fragment with no clear task

CLASSIFICATION:
- question_type: mcq (has options), truefalse, fill (blanks/____), short (≤2 line answer), long, integer/numerical, assertionreason
- options: string array for mcq/truefalse; else []
- answer: the correct option text for mcq; a brief answer otherwise (omit if unknown)
- topic_name + sub_topic: infer from the block label / nearby heading
- difficulty: easy | medium | hard, judged from complexity
- marks: mcq/truefalse/fill=1, short=2, long=5, integer=2
${this._metadataDirective(bookMetadata)}
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
${this._metadataDirective(bookMetadata)}
${MATH_RULES}

TEXT:
${inputText}
JSON:`;
  }

  // ── Raw model call (Ollama) — returns the raw JSON string ───────────────────

  async _callRaw(promptText) {
    try {
      const response = await ollama.generate({
        model:   this.model,
        prompt:  promptText,
        format:  'json',
        stream:  false,
        options: {
          temperature:    0,
          num_ctx:        4096,
          num_predict:    parseInt(process.env.AI_ENHANCER_NUM_PREDICT || '3072', 10),
          top_p:          0.9,
          repeat_penalty: 1.1,
        },
      });
      return String(response.response || '').trim();
    } catch (error) {
      console.error('[AIEnhancer] Ollama error:', error.message);
      return '';
    }
  }

  _parseJsonResponse(raw, tag) {
    raw = fixLatexBackslashes(raw);
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

  // Parse a BATCHED response: {"items":[{id, ...}]}. Returns Map<index0, item|null>
  // where a present id maps to its item (or null when {skip:true}); a MISSING id
  // is simply absent from the map (caller treats absence as fail-soft).
  _parseBatchResponse(raw, count, tag) {
    const result = new Map();
    raw = fixLatexBackslashes(stripThink(raw || ''));
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start !== -1 && end !== -1) { try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through */ } }
    }
    const items = parsed && (Array.isArray(parsed.items) ? parsed.items
      : (Array.isArray(parsed.questions) ? parsed.questions : null));
    if (!items) { console.warn(`${tag} batch parse failed:`, String(raw).slice(0, 160)); return result; }

    let positional = 0;
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const idx = Number.isFinite(it.id) ? ((it.id | 0) - 1) : positional++;
      if (idx < 0 || idx >= count) continue;
      if (it.skip === true) { result.set(idx, null); continue; }
      if (typeof it.question === 'string' && it.question.trim()) result.set(idx, it);
    }
    return result;
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

    // FIDELITY: image/OCR path uses the VERBATIM source block as the stem —
    // the LLM's re-emitted "question" text is NOT trusted for wording (it
    // silently dropped "(Given:)" data and setup sentences). The LLM is used
    // only for structure (options/type/difficulty) below.
    let rawText;
    if (chunkMeta._verbatim && chunkMeta._sourceText) {
      rawText = subs.length >= 1
        ? buildEmbeddedText(stemFromSource(chunkMeta._sourceText), subs.map(s => ({ label: '', text: s })))
        : stemFromSource(chunkMeta._sourceText);
    } else {
      rawText = subs.length >= 1
        ? buildEmbeddedText(instr || stem, subs.map(s => ({ label: '', text: s })))
        : stem;
    }
    if (isExample) rawText = stripSolutionContent(rawText, { aggressive: true });
    const text = this.normalizeMath(rawText).trim();

    let options = [];
    let optionsLost = false;
    if ((type === 'mcq' || type === 'truefalse') && Array.isArray(q.options) && q.options.length > 0) {
      const raw = q.options.map(opt => String(opt || '').trim()).filter(Boolean);
      // If EVERY option is a bare label ("a","b","c","d"), the values were lost
      // in extraction — flag for teacher review instead of saving garbage.
      optionsLost = raw.length > 0 && raw.every(isBareOptionLabel);
      const ans = stripOptionMarker(String(q.answer || '').trim());
      options = raw.map(opt => {
        const val = stripOptionMarker(opt) || opt; // strip "(a) " marker, keep the value
        return {
          text: this.normalizeMath(val),
          isCorrect: stripOptionMarker(opt) === ans || opt === String(q.answer || '').trim(),
        };
      });
      if (!optionsLost && options.length > 0 && options.every(o => !o.isCorrect)) {
        options[0] = { ...options[0], isCorrect: true };
      }
    }
    // FIDELITY: model flagged uncertainty, or option values were lost → the
    // teacher must review before this question is trusted.
    const needsReview = !!q.uncertain || optionsLost;

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
      needsReview,
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
    const flush = () => { if (buffer.trim()) { chunks.push({ text: buffer.trim(), _structured: false }); buffer = ''; } };

    for (const q of rawQuestions) {
      const block = q.text || '';
      // Pre-split VERBATIM blocks (image/OCR path) stay 1:1 — one question per
      // chunk, carrying _verbatim so mapQuestion uses the source stem, and so
      // they fan out in parallel instead of being merged into one slow call.
      if (q._verbatim) {
        flush();
        if (block.trim()) chunks.push({ text: block.trim(), _structured: false, _verbatim: true });
        continue;
      }
      if (buffer.length + block.length > CHUNK_SIZE && buffer.length > 0) {
        chunks.push({ text: buffer.trim(), _structured: false });
        buffer = block;
      } else {
        buffer += (buffer ? '\n\n' : '') + block;
      }
    }
    flush();
    return chunks;
  }

  // Req #1: honor user-provided metadata; tell the model NOT to reclassify it.
  _metadataDirective(meta) {
    const fixed = [];
    if (meta.subject && meta.subject !== 'Unknown') fixed.push(`subject="${meta.subject}"`);
    if (meta.chapter && meta.chapter !== 'General') fixed.push(`chapter="${meta.chapter}"`);
    if (meta.topic) fixed.push(`topic="${meta.topic}"`);
    if (meta.board && meta.board !== 'CBSE') fixed.push(`board="${meta.board}"`);
    if (!fixed.length) return '';
    return `USER-PROVIDED METADATA (use verbatim; do NOT reclassify these fields): ${fixed.join(', ')}.`;
  }

  // Batched prompt: enhance N single-question blocks in one request. One object
  // per input id, ids preserved, {skip:true} for non-questions.
  buildBatchPrompt(chunks, bookMetadata) {
    const subject = bookMetadata.subject || 'Unknown';
    const chapter = bookMetadata.chapter || bookMetadata.title || 'General';
    const cls     = bookMetadata.class   || 'Unknown';
    const board   = bookMetadata.board   || 'CBSE';
    const blocks = chunks.map((c, i) => `[${i + 1}]\n${c.text}`).join('\n\n');
    return `You are normalizing exam questions from an Indian NCERT/CBSE/JEE/NEET textbook (Subject: ${subject}, Chapter: ${chapter}, Class: ${cls}, Board: ${board}). Return ONLY valid JSON.

There are ${chunks.length} input blocks below, each marked [n]. Each block contains ONE question. For EACH block, extract and clean that single question.

Return JSON: {"items":[{"id":1,"question":"...","instructions":"","sub_questions":[],"options":["<full text of choice 1>","<full text of choice 2>"],"answer":"","question_type":"mcq|truefalse|fill|short|long|assertionreason|integer","topic_name":"","sub_topic":"","difficulty":"easy|medium|hard","marks":1,"uncertain":false}]}

Rules:
- EXACTLY one object per input id (1..${chunks.length}); keep ids in order.
- If a block has no valid question (heading/solution/prose), return {"id":n,"skip":true}.
- options: string array for mcq/truefalse, else []. answer: correct option text for mcq, else a brief answer (omit if unknown).
- SUB-QUESTIONS: a stem with (i)(ii)(iii) parts is ONE question → put parts in "sub_questions"; (a)(b)(c)(d) right after a single stem are OPTIONS → "options".
- SKIP solutions, proofs, definitions, theorems, activities, summaries, page headers/footers.
${this._metadataDirective(bookMetadata)}
${MATH_RULES}

BLOCKS:
${blocks}
JSON:`;
  }

  _chunkMeta(chunk, bookMetadata) {
    return {
      ...bookMetadata,
      chapter:     chunk.chapter || bookMetadata.chapter,
      topic:       chunk.topic   || bookMetadata.topic,
      parentLabel: chunk.parentLabel || null,
      blockType:   chunk.blockType || null,
      // Fidelity path (image/OCR): the source block is one verbatim question.
      _sourceText: chunk.text || '',
      _verbatim:   !!chunk._verbatim,
    };
  }

  // A "batchable" chunk yields exactly ONE question (structured single-q block).
  _isBatchable(chunk) {
    return chunk._structured && QUESTION_BLOCK_TYPES.has(chunk.blockType);
  }

  // Group chunks into work units: batches of single-question blocks (size N),
  // plus standalone units for multi-question / fallback chunks.
  _buildUnits(chunks, batchSize) {
    const units = [];
    let batch = [];
    const flush = () => { if (batch.length) { units.push({ batch: true, chunks: batch }); batch = []; } };
    for (const chunk of chunks) {
      if (batchSize > 1 && this._isBatchable(chunk)) {
        batch.push(chunk);
        if (batch.length >= batchSize) flush();
      } else {
        flush();
        units.push({ batch: false, chunks: [chunk] });
      }
    }
    flush();
    return units;
  }

  // Bounded-concurrency worker pool.
  async _pool(items, concurrency, worker) {
    let next = 0;
    const run = async () => { while (next < items.length) { const i = next++; await worker(items[i], i); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, run));
  }

  // Retry a raw call until non-empty or retries exhausted.
  async _callRawRetry(callRaw, prompt) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const raw = await callRaw(prompt);
      if (raw && raw.trim()) return raw;
      if (attempt < this.maxRetries) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
    return '';
  }

  // Process one unit → [{ chunk, raws }]. raws=[] → nothing extractable (drop);
  // raws=null → AI failed for this block (fail-soft: keep raw text, needsReview).
  async _runUnit(unit, bookMetadata, callRaw, cache, stats, tag) {
    const out = [];
    const toProcess = [];

    for (const chunk of unit.chunks) {
      if (cache) {
        try {
          const hit = await cache.get(chunk.text);
          if (hit) { out.push({ chunk, raws: Array.isArray(hit) ? hit : [] }); stats.cached++; continue; }
        } catch { /* ignore cache errors */ }
      }
      toProcess.push(chunk);
    }
    if (toProcess.length === 0) return out;

    if (unit.batch && toProcess.length > 1) {
      const meta = this._chunkMeta(toProcess[0], bookMetadata);
      const raw = await this._callRawRetry(callRaw, this.buildBatchPrompt(toProcess, meta));
      const byIdx = this._parseBatchResponse(raw, toProcess.length, tag);
      for (let j = 0; j < toProcess.length; j++) {
        let raws;
        if (byIdx.has(j)) { const item = byIdx.get(j); raws = item ? [item] : []; }
        else raws = null; // missing from response → fail-soft
        out.push({ chunk: toProcess[j], raws });
        if (cache && raws && raws.length) { try { await cache.set(toProcess[j].text, raws); } catch { /* ignore */ } }
      }
    } else {
      for (const chunk of toProcess) {
        const meta = this._chunkMeta(chunk, bookMetadata);
        const prompt = chunk._structured ? this.buildStructuredPrompt(chunk, meta) : this.buildPrompt(chunk.text, meta);
        const raw = await this._callRawRetry(callRaw, prompt);
        const raws = raw ? this._parseJsonResponse(raw, tag) : null;
        out.push({ chunk, raws });
        if (cache && raws && raws.length) { try { await cache.set(chunk.text, raws); } catch { /* ignore */ } }
      }
    }
    return out;
  }

  // Req #6 fail-soft: keep the raw block as a question flagged for manual review.
  _fallbackQuestion(chunk, chunkMeta) {
    const text = this.normalizeMath(String(chunk.text || '').trim()).trim();
    if (!text || text.length < 8) return null;
    return {
      text,
      type: 'short',
      subject: chunkMeta.subject || 'Unknown',
      topic: chunkMeta.topic || chunkMeta.chapter || 'General',
      chapter: chunkMeta.chapter || 'Unknown',
      board: chunkMeta.board || 'CBSE',
      class: chunkMeta.class || 'Unknown',
      difficulty: 'medium',
      marks: 1,
      source: 'Smart Import',
      isActive: true,
      needsReview: true,
    };
  }

  // ── Main enhancer ───────────────────────────────────────────────────────────

  async enhanceQuestions(rawQuestions, bookMetadata, opts = {}) {
    return this._enhance(rawQuestions, bookMetadata, (p) => this._callRaw(p), `[AIEnhancer] Ollama ${this.model}`, opts);
  }

  /**
   * Parallel, batched extraction: chunk → (cache | batched/individual AI) → map →
   * quality-gate → fail-soft → dedup.
   * @param {(prompt:string)=>Promise<string>} callRaw  raw provider call
   * @param {{concurrency?:number,batchSize?:number,onProgress?:Function,cache?:object}} opts
   */
  async _enhance(rawQuestions, bookMetadata, callRaw, tag, opts = {}) {
    const hasStructure = rawQuestions.some(q => q.blockType);
    const chunks = hasStructure ? this.splitStructuredBlocks(rawQuestions) : this.splitIntoChunks(rawQuestions);
    // Tag each chunk with its SOURCE position — parallel processing completes
    // out of order, so results are re-sorted by this before returning.
    chunks.forEach((c, i) => { if (c._order == null) c._order = i; });

    const concurrency = Math.max(1, opts.concurrency ?? this.maxConcurrency ?? 1);
    const batchSize   = Math.max(1, opts.batchSize   ?? this.maxBatchSize   ?? 1);
    const onProgress  = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const cache       = opts.cache || null;

    console.log(`\n${tag} — ${rawQuestions.length} block(s) (${hasStructure ? 'structured' : 'unstructured'}) → ${chunks.length} chunk(s) | concurrency=${concurrency} batch=${batchSize}${cache ? ' cache=on' : ''}`);
    if (onProgress) onProgress(0, chunks.length);

    const units = this._buildUnits(chunks, batchSize);
    const all = [];
    const stats = { extracted: 0, kept: 0, rejected: 0, fallback: 0, cached: 0 };
    let done = 0;

    await this._pool(units, concurrency, async (unit) => {
      let results;
      try {
        results = await this._runUnit(unit, bookMetadata, callRaw, cache, stats, tag);
      } catch (e) {
        console.warn(`${tag} unit failed → fail-soft: ${e && e.message}`);
        results = unit.chunks.map(chunk => ({ chunk, raws: null }));
      }
      for (const { chunk, raws } of results) {
        const meta = this._chunkMeta(chunk, bookMetadata);
        if (raws && raws.length) {
          stats.extracted += raws.length;
          for (let ri = 0; ri < raws.length; ri++) {
            const rq = raws[ri];
            const mapped = this.mapQuestion(rq, meta);
            // Preserve source order: chunk position first, then within-chunk.
            mapped._order = (chunk._order ?? 0) * 1000 + ri;
            // Score with the metadata that IS known (user-provided subject/
            // class/chapter arrive via meta and are applied downstream) — the
            // gate must not punish a question for fields it will get anyway.
            const gate = passesQualityGate({
              ...mapped,
              subject: mapped.subject || (meta && meta.subject),
              chapter: mapped.chapter || (meta && (meta.chapter || meta.topic)),
              class: mapped.class || (meta && meta.class),
              difficulty: mapped.difficulty || 'medium',
            });
            if (!gate.pass) {
              if (opts.gateMode === 'flag') {
                // Teacher-reviewed imports: NEVER silently drop a question the
                // teacher photographed — keep it, flag it for review. (Observed
                // live: 4 of 5 real JEE questions were being dropped here.)
                mapped.needsReview = true;
                stats.rejected++; // counted as "flagged" in the log below
                all.push(mapped);
                stats.kept++;
                continue;
              }
              stats.rejected++;
              continue;
            }
            all.push(mapped);
            stats.kept++;
          }
        } else if (raws === null) {
          const fb = this._fallbackQuestion(chunk, meta);
          if (fb) { fb._order = (chunk._order ?? 0) * 1000; all.push(fb); stats.fallback++; }
        }
        // raws === [] → explicit skip / nothing extractable → drop silently.
      }
      done += unit.chunks.length;
      if (onProgress) onProgress(done, chunks.length);
    });

    // Restore SOURCE order (parallel units finish out of order), then dedup
    // (which keeps first occurrence, so order is preserved).
    all.sort((a, b) => (a._order ?? 0) - (b._order ?? 0));
    const unique = this.deduplicateQuestions(all);
    console.log(`${tag} ✅ ${unique.length} questions | extracted ${stats.extracted}, kept ${stats.kept}, gate-${opts.gateMode === 'flag' ? 'flagged' : 'rejected'} ${stats.rejected}, fail-soft ${stats.fallback}, cached ${stats.cached}, dupes ${all.length - unique.length}`);

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

// Strip nemotron/qwen <think>…</think> reasoning traces before JSON parsing.
function stripThink(s) {
  return String(s || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

class NvidiaEnhancer extends AIEnhancer {
  constructor() {
    super();
    const OpenAI = require('openai');
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) throw new Error('[NvidiaEnhancer] NVIDIA_API_KEY env var is required');
    this.client = new OpenAI({
      apiKey,
      baseURL: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    });
    // FAST model by default. Stem fidelity is NOT at risk from the model on
    // the image/OCR path: the question text is taken verbatim from the source
    // block (see stemFromSource / _verbatim), so the LLM only classifies +
    // extracts options — fast work the small model does well. The quality
    // model is far more faithful but the shared NVIDIA tier serializes
    // requests (~45s/question), which is too slow. Override with
    // AI_ENHANCER_MODEL_NVIDIA for the quality model if you accept the latency.
    this.nvModel   = process.env.AI_ENHANCER_MODEL_NVIDIA
      || process.env.NVIDIA_MODEL_FAST
      || process.env.NVIDIA_MODEL_PRIMARY
      || 'nvidia/nvidia-nemotron-nano-9b-v2';
    this.reasoning = (process.env.NVIDIA_REASONING || 'off').toLowerCase() === 'on' ? 'on' : 'off';
    this.maxTokens = parseInt(process.env.NVIDIA_MAX_TOKENS || '4096', 10);
    // Cloud: safe to fan out concurrent requests and batch questions per call.
    this.maxConcurrency = Math.max(1, parseInt(process.env.AI_ENHANCER_CONCURRENCY || '6', 10));
    this.maxBatchSize   = Math.max(1, parseInt(process.env.AI_ENHANCER_BATCH_SIZE || '4', 10));
  }

  // Raw streamed call — returns the raw text (streaming avoids undici's 300s
  // headersTimeout on slow generations).
  async _callRaw(promptText) {
    try {
      // Model-appropriate reasoning toggle: nemotron-nano v2 uses /no_think;
      // "detailed thinking off" is a NO-OP for it (observed live: thousands of
      // hidden <think> tokens → an 87s call for 5 questions).
      const reasoningDirective = /nemotron-nano|nano-9b|nano-12b/i.test(this.nvModel)
        ? (this.reasoning === 'on' ? '/think' : '/no_think')
        : `detailed thinking ${this.reasoning}`;
      const stream = await this.client.chat.completions.create({
        model: this.nvModel,
        messages: [
          { role: 'system', content: reasoningDirective },
          { role: 'user', content: promptText },
        ],
        temperature: 0,
        top_p: 0.95,
        max_tokens: this.maxTokens,
        stream: true,
      });
      let content = '';
      for await (const chunk of stream) {
        const d = chunk?.choices?.[0]?.delta?.content;
        if (d) content += d;
      }
      return stripThink(content);
    } catch (error) {
      console.error('[NvidiaEnhancer] NVIDIA error:', error.message);
      return '';
    }
  }

  async enhanceQuestions(rawQuestions, bookMetadata, opts = {}) {
    return this._enhance(rawQuestions, bookMetadata, (p) => this._callRaw(p), `[NvidiaEnhancer] ${this.nvModel}`, opts);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function createEnhancer(provider) {
  const p = String(provider || '').toLowerCase();
  // 'gemini' kept as a legacy alias so old configs route to NVIDIA, not crash.
  if (p === 'nvidia' || p === 'gemini') return new NvidiaEnhancer();
  return new AIEnhancer(); // 'ollama' / local (default)
}

module.exports = { AIEnhancer, NvidiaEnhancer, createEnhancer };
