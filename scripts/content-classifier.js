'use strict';

/**
 * Content Classifier  (Phases 1 & 5)
 *
 * Identifies the educational role of a block of text and decides whether it is
 * importable question content or instructional material that must be discarded.
 *
 * Taxonomy (CONTENT_TYPE):
 *   chapter_header | exercise_header | section_header | example | question |
 *   sub_question | theorem | proof | solution | answer | explanation |
 *   activity | note | definition | summary | learning_outcome | body
 *
 * Used by epub-parser, pdf-structure-analyzer and ai-enhancer so EPUB and PDF
 * share one notion of "what is a question."
 */

// ── Imperative verbs that begin a genuine question/task ───────────────────────
const QUESTION_VERBS = [
  'solve', 'find', 'prove', 'show', 'calculate', 'determine', 'evaluate',
  'simplify', 'factorise', 'factorize', 'expand', 'rationalise', 'rationalize',
  'write', 'state', 'define', 'explain', 'describe', 'compare', 'list', 'give',
  'check', 'examine', 'express', 'convert', 'draw', 'construct', 'verify',
  'identify', 'name', 'choose', 'compute', 'derive', 'differentiate', 'integrate',
  'classify', 'arrange', 'match', 'fill', 'complete', 'answer', 'discuss',
];
const QUESTION_VERB_RE = new RegExp(`^(?:${QUESTION_VERBS.join('|')})\\b`, 'i');

// ── Ordered rules — MOST SPECIFIC FIRST ───────────────────────────────────────
// Each labelled-content rule (with a trailing ":") is checked before the generic
// imperative-question rule so "Explanation:" → explanation while "Explain why…"
// → question.
const RULES = [
  // Structural headers
  { type: 'chapter_header',   re: /^(?:chapter|unit)\s+\d+/i },
  { type: 'exercise_header',  re: /^(?:miscellaneous\s+)?exercise\s*[\d.]*/i },

  // Non-question instructional sections (Phase 5 — DROP these)
  { type: 'learning_outcome', re: /^(?:learning\s+outcomes?|learning\s+objectives?|what\s+you\s+(?:will\s+)?learn|objectives?\s*:)/i },
  { type: 'summary',          re: /^(?:summary|key\s+points?|points\s+to\s+remember|let\s+us\s+recall|recall\b|what\s+we\s+have\s+(?:learnt|learned|discussed)|in\s+this\s+chapter,?\s+we)/i },
  // NOTE: "try these / try this" is treated as a (kept) section_header below —
  // in NCERT these are practice questions, not activities.
  { type: 'activity',         re: /^(?:activit(?:y|ies)|project\b|experiment|lab(?:oratory)?\s*work|do\s+(?:this|it\s+yourself)|group\s+discussion|let'?s\s+do|let\s+us\s+do)/i },
  { type: 'note',             re: /^(?:note|remark|remember|did\s+you\s+know|caution|hint|tip)\s*[:.\)]/i },
  { type: 'definition',       re: /^(?:definition\b|defn\.?\b)/i },
  { type: 'theorem',          re: /^(?:theorem|lemma|corollary|axiom|postulate|property)\s*[\d.:]/i },
  { type: 'proof',            re: /^proof\s*[:.]?/i },

  // Worked-solution fragments (DROP — never a standalone question)
  { type: 'solution',         re: /^(?:solution|sol)\s*[:.]/i },
  { type: 'answer',           re: /^(?:answer|ans)\s*[:.]/i },
  { type: 'explanation',      re: /^(?:explanation|reason)\s*[:.]/i },

  // Worked examples (IMPORT — question statement only)
  { type: 'example',          re: /^(?:example|illustration|illustrative\s+example)\s+\d+/i },

  // Question-group / section headers
  { type: 'section_header',   re: /^(?:think\s+about\s+it|try\s+these|in[-\s]?text\s+questions?|check\s+your\s+progress|multiple\s+choice|objective(?:\s+type)?(?:\s+questions?)?|very\s+short\s+answer|short\s+answer|long\s+answer|fill\s+in\s+the\s+blanks?|true\s+(?:or|\/)\s+false|assertion\s*[-–]?\s*reason|case\s+study|passage|comprehension|match\s+the\s+(?:following|columns?))\b/i },

  // Sub-question markers: (i) (ii) (a) (b) (1) a) a.
  { type: 'sub_question',     re: /^\(\s*(?:x|ix|iv|v?i{0,3})\s*\)\s*/i },
  { type: 'sub_question',     re: /^\(\s*[a-h]\s*\)\s*/i },
  { type: 'sub_question',     re: /^\(\s*\d{1,2}\s*\)\s*/ },
  { type: 'sub_question',     re: /^[a-h][\).]\s+\S/ },

  // Numbered / verb-led / interrogative questions
  { type: 'question',         re: /^(?:Q(?:ues|uestion)?\.?\s*)\d+[.:\)]?\s/i },
  { type: 'question',         re: /^\d{1,3}[.:\)]\s+\S/ },
];

// Block types that hold NO importable question and must be discarded.
const IMPORT_BLACKLIST = new Set([
  'solution', 'answer', 'explanation',
  'activity', 'note', 'definition', 'theorem', 'proof',
  'summary', 'learning_outcome',
]);

// Block types that ARE (or contain) importable questions.
const QUESTION_TYPES = new Set(['question', 'sub_question', 'example']);

// ── Public API ─────────────────────────────────────────────────────────────────

function firstLine(text) {
  if (!text) return '';
  const line = String(text).split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return (line || '').slice(0, 120);
}

/**
 * Classify a block of text into a CONTENT_TYPE based on its opening line.
 */
function classifyContentType(text) {
  const head = firstLine(text);
  if (!head) return 'body';

  for (const rule of RULES) {
    if (rule.re.test(head)) return rule.type;
  }

  // Verb-led imperative ("Find the value…", "Prove that…")
  if (QUESTION_VERB_RE.test(head)) return 'question';

  // Interrogative ending in ?
  if (/\?\s*$/.test(head) || /\?\s/.test(head)) return 'question';

  return 'body';
}

/** True when a block of this type should be extracted into questions. */
function shouldImport(blockType) {
  if (!blockType) return true;           // unknown/body → let the AI decide
  return !IMPORT_BLACKLIST.has(blockType);
}

function isQuestionType(blockType) {
  return QUESTION_TYPES.has(blockType);
}

// ── Solution / explanation stripping ──────────────────────────────────────────

// Labelled markers (always stripped): "Solution:", "Answer:", "Proof:", …
const LABELLED_MARKER_RE = /\b(?:solution|sol|answer|ans|explanation|proof|hint|discussion)\s*[:.]/i;
// Inferential markers (only stripped in aggressive mode — e.g. Example blocks):
const INFERENTIAL_MARKER_RE = /(?:^|[.\s])(?:therefore|hence|thus|so,?\s+the\s+answer)\b/i;

/**
 * Remove worked-solution / explanation tail from a question statement.
 *
 * @param {string} text
 * @param {{ aggressive?: boolean }} [opts]  aggressive also cuts at
 *        Therefore/Hence/Thus (used for Example blocks, per the import policy).
 * @returns {string} just the question statement.
 */
function stripSolutionContent(text, opts = {}) {
  if (!text || typeof text !== 'string') return text;
  const { aggressive = false } = opts;

  let cut = text.length;

  const labelled = text.match(LABELLED_MARKER_RE);
  if (labelled && labelled.index < cut) cut = labelled.index;

  if (aggressive) {
    const inf = text.match(INFERENTIAL_MARKER_RE);
    if (inf) {
      // start of the actual keyword (skip the leading boundary char captured)
      const idx = inf.index + (/^[.\s]/.test(inf[0]) ? 1 : 0);
      if (idx < cut) cut = idx;
    }
  }

  return text.slice(0, cut).trim();
}

module.exports = {
  classifyContentType,
  shouldImport,
  isQuestionType,
  stripSolutionContent,
  IMPORT_BLACKLIST,
  QUESTION_TYPES,
  QUESTION_VERBS,
};
