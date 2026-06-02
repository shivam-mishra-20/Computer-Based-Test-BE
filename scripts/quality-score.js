'use strict';

/**
 * Quality Score & Gate  (Phase 8)
 *
 * Scores a MAPPED question (the output of ai-enhancer.mapQuestion) 0–100 across
 * five checks and rejects anything below a threshold so low-quality extractions
 * never reach the database.
 *
 *   boundary  — is this actually a self-contained question, not a fragment or
 *               instructional/solution text? Acts as a MULTIPLIER on the whole
 *               score: if it isn't a real question, nothing else can save it.
 *   latex     (35) — does all math render (balanced, no empty macros)?
 *   metadata  (28) — subject / chapter / class / type / difficulty present & valid
 *   hierarchy (17) — sub-parts intact (stem + ≥2 parts), no orphan markers
 *   answer    (20) — type-appropriate option/answer structure
 *
 *   final = round( (latex+metadata+hierarchy+answer) * boundaryFactor )
 *           with hard caps for structurally broken items (e.g. MCQ w/o options).
 *
 * The score is NOT stored (schema is fixed) — it gates + logs only.
 */

const { validateLatex } = require('./latex-normalizer');
const { classifyContentType, IMPORT_BLACKLIST, QUESTION_VERBS } = require('./content-classifier');

const VERB_RE = new RegExp(`^(?:${QUESTION_VERBS.join('|')})\\b`, 'i');
const MARKER_RE = /\(\s*(?:i{1,3}|iv|ix|vi{0,3}|v|x|[a-h]|\d{1,2})\s*\)/gi;
const VALID_TYPES = new Set(['mcq', 'truefalse', 'fill', 'short', 'long', 'assertionreason', 'integer']);

const CONTENT_WEIGHTS = { latex: 35, metadata: 28, hierarchy: 17, answer: 20 }; // sum = 100

function scoreQuestion(q) {
  const reasons = [];
  const checks = {};
  const text = q && q.text ? String(q.text) : '';
  const trimmed = text.trim();

  // ── boundary (multiplier) ───────────────────────────────────────────────────
  // Starts at 1.0 and is whittled down multiplicatively by junk signals, so a
  // fragment / instructional line can't be rescued by good latex+metadata.
  let boundary = 1;
  if (trimmed.length < 10) {
    boundary = 0;
    reasons.push('text-too-short');
  } else {
    const ct = classifyContentType(trimmed);
    if (IMPORT_BLACKLIST.has(ct)) { boundary = 0; reasons.push(`non-question:${ct}`); }
    if (/^(?:and|or|but|so|then|therefore|hence|thus|because|which|while)\b/i.test(trimmed)) {
      boundary *= 0.3; reasons.push('starts-mid-sentence');
    }
    if (/(?:solution|answer|proof|explanation)\s*:?\s*$/i.test(trimmed)) {
      boundary *= 0.3; reasons.push('ends-with-solution-marker');
    }
    const looksLikeQuestion =
      /\?\s*$/.test(trimmed) || VERB_RE.test(trimmed) || q.hasSubParts ||
      ['question', 'sub_question', 'example'].includes(ct);
    if (!looksLikeQuestion) { boundary *= 0.5; reasons.push('no-clear-task'); }
  }
  checks.boundary = boundary;

  // ── latex ─────────────────────────────────────────────────────────────────
  let latex = 1;
  const v = validateLatex(text);
  if (!v.valid) { latex = 0.3; reasons.push(`latex:${v.issues.join('/')}`); }
  if (Array.isArray(q.options)) {
    for (const o of q.options) {
      if (!validateLatex(o && o.text ? o.text : '').valid) {
        latex = Math.min(latex, 0.3); reasons.push('latex-option'); break;
      }
    }
  }
  checks.latex = latex;

  // ── metadata ────────────────────────────────────────────────────────────────
  const missing = [];
  if (!q.subject || /unknown/i.test(q.subject)) missing.push('subject');
  if (!q.chapter || /unknown/i.test(q.chapter)) missing.push('chapter');
  if (!q.class || /unknown/i.test(q.class)) missing.push('class');
  if (!['easy', 'medium', 'hard'].includes(q.difficulty)) missing.push('difficulty');
  if (!VALID_TYPES.has(q.type)) missing.push('type');
  const metadata = Math.max(0, 1 - missing.length * 0.25);
  if (missing.length) reasons.push(`metadata-missing:${missing.join(',')}`);
  checks.metadata = metadata;

  // ── hierarchy ─────────────────────────────────────────────────────────────
  let hierarchy = 1;
  if (q.hasSubParts) {
    if (!Array.isArray(q.subParts) || q.subParts.length < 2) { hierarchy = 0.5; reasons.push('subparts-missing'); }
  } else {
    const markerCount = (trimmed.match(MARKER_RE) || []).length;
    if (markerCount === 1 && /^\(/.test(trimmed)) { hierarchy = 0.6; reasons.push('orphan-subpart-marker'); }
  }
  checks.hierarchy = hierarchy;

  // ── answer / structure ────────────────────────────────────────────────────
  let answer = 1;
  let structurallyBroken = false;
  if (q.type === 'mcq') {
    if (!Array.isArray(q.options) || q.options.length < 2) { answer = 0; structurallyBroken = true; reasons.push('mcq-needs-options'); }
    else if (q.options.length < 3) { answer = 0.6; reasons.push('mcq-few-options'); }
  } else if (q.type === 'truefalse') {
    if (!Array.isArray(q.options) || q.options.length < 2) { answer = 0.5; reasons.push('tf-needs-2-options'); }
  } else if (q.type === 'assertionreason') {
    if (!q.assertion || !q.reason) { answer = 0.4; reasons.push('ar-missing-parts'); }
  }
  checks.answer = answer;

  // ── combine ─────────────────────────────────────────────────────────────────
  const content =
    CONTENT_WEIGHTS.latex * latex +
    CONTENT_WEIGHTS.metadata * metadata +
    CONTENT_WEIGHTS.hierarchy * hierarchy +
    CONTENT_WEIGHTS.answer * answer;

  let score = Math.round(content * boundary);

  // Hard cap: a question that can't function (e.g. MCQ with no options) must fail
  // regardless of how clean the rest looks.
  if (structurallyBroken) score = Math.min(score, 25);

  return { score, checks, reasons };
}

function defaultThreshold() {
  const n = parseInt(process.env.QUALITY_MIN_SCORE || '60', 10);
  return Number.isFinite(n) ? n : 60;
}

/**
 * @returns {{ pass:boolean, score:number, threshold:number, checks:object, reasons:string[] }}
 */
function passesQualityGate(q, min) {
  const threshold = Number.isFinite(min) ? min : defaultThreshold();
  const result = scoreQuestion(q);
  return { pass: result.score >= threshold, threshold, ...result };
}

module.exports = { scoreQuestion, passesQualityGate, defaultThreshold };
