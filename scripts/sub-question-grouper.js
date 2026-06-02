'use strict';

/**
 * Sub-Question Grouper  (Phases 2 & 3)
 *
 * Preserves the parent → sub-part hierarchy of educational questions so that
 *
 *   Simplify each of the following:
 *   (i)  √2 + √8
 *   (ii) √45 − √20
 *
 * is stored as ONE question (stem + parts) rather than being split into
 * unrelated fragments or flattened into a blob.
 *
 * Storage format (per product decision): the parent stem and each labelled part
 * live in a single multi-line `text` string — see buildEmbeddedText().
 *
 * Key safety rule: MCQ options "(a) (b) (c) (d)" must NOT be mistaken for
 * sub-questions. We only group when there is an explicit multi-part instruction
 * ("…the following", a list verb) OR the parts use roman numerals (i)(ii)(iii),
 * which are sub-parts in textbooks, not options.
 */

// Roman-numeral sub-part label, e.g. (i) (ii) (iii) (iv) … (x)
const ROMAN_LABEL_RE = /^\(\s*(?:i{1,3}|iv|ix|vi{0,3}|v|x)\s*\)$/i;

// Any sub-part marker: (i) (ii) (a) (b) (1) (2)
const MARKER_RE = /\(\s*(i{1,3}|iv|ix|vi{0,3}|v|x|[a-h]|\d{1,2})\s*\)/gi;

// ── Educational pattern detection (Phase 3) ───────────────────────────────────

const LIST_VERB_RE = /^(?:simplify|solve|expand|evaluate|factori[sz]e|rationali[sz]e|find|prove|show|compute|differentiate|integrate|verify|examine|classify|arrange|name|identify|write|state|express|convert|draw|construct|answer)\b/i;
const FOLLOWING_RE = /\b(?:each\s+of\s+the\s+following|the\s+following|following)\b\s*[:.]?/i;

/**
 * Identify the educational pattern of a question stem.
 * @returns {{ pattern: string|null, isParent: boolean, instruction: string|null }}
 */
function detectEducationalPattern(text) {
  const t = (text || '').trim();
  if (!t) return { pattern: null, isParent: false, instruction: null };
  const head = t.slice(0, 160);

  if (/^match\s+the\s+(?:following|columns?)/i.test(head)) return { pattern: 'match', isParent: true, instruction: 'Match the following' };
  if (/^(?:read\s+the\s+following\s+)?(?:passage|case\s+study|comprehension)/i.test(head) || /\bcase\s+study\b/i.test(head))
    return { pattern: 'passage', isParent: true, instruction: 'Case Study / Passage' };
  if (/^fill\s+in\s+the\s+blanks?/i.test(head)) return { pattern: 'fill', isParent: false, instruction: 'Fill in the blanks' };
  if (/^choose\s+the\s+(?:correct|right)\b/i.test(head) || /^select\s+the\s+(?:correct|right)\b/i.test(head))
    return { pattern: 'mcq', isParent: false, instruction: 'Choose the correct answer' };
  if (/\bassertion\b/i.test(head) && /\breason\b/i.test(head)) return { pattern: 'assertionreason', isParent: false, instruction: null };
  if (/^state\s+(?:whether\s+)?true\s+(?:or|\/)\s+false/i.test(head) || /^true\s+(?:or|\/)\s+false/i.test(head))
    return { pattern: 'truefalse', isParent: false, instruction: 'True or False' };
  if (/^attempt\s+any\s+\w+/i.test(head) || /^answer\s+any\s+\w+/i.test(head))
    return { pattern: 'selection', isParent: false, instruction: head };

  // MCQ stems frequently say "…which of the following…"; their (a)(b)(c)(d) are
  // OPTIONS, not sub-parts. So a multi-part list requires either an explicit list
  // verb at the START ("Simplify the following: …") or ROMAN sub-markers (i)(ii).
  const hasFollowing = FOLLOWING_RE.test(head);
  const startsWithListVerb = LIST_VERB_RE.test(head);
  const romanMarkers = (t.match(/\(\s*(?:i{1,3}|iv|ix|vi{0,3}|v|x)\s*\)/gi) || []).length;
  if ((startsWithListVerb && hasFollowing) || (startsWithListVerb && romanMarkers >= 2) || (hasFollowing && romanMarkers >= 2)) {
    const instr = (head.match(LIST_VERB_RE) || [head.split(/\s+/)[0]])[0];
    return { pattern: 'list', isParent: true, instruction: instr };
  }

  return { pattern: null, isParent: false, instruction: null };
}

// ── Sub-part splitting (inline) ───────────────────────────────────────────────

/**
 * Split an inline multi-part question into { stem, subParts:[{label,text}] }.
 * Returns empty subParts when the text isn't a confident multi-part list.
 */
function splitSubParts(text) {
  if (!text || typeof text !== 'string') return { stem: text || '', subParts: [] };

  const matches = [];
  let m;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(text)) !== null) {
    matches.push({ index: m.index, end: MARKER_RE.lastIndex, label: m[1].toLowerCase() });
  }
  if (matches.length < 2) return { stem: text.trim(), subParts: [] };

  // The list must start at a sequence beginning to avoid mid-sentence "(a)" refs.
  if (!['i', 'a', '1'].includes(matches[0].label)) return { stem: text.trim(), subParts: [] };

  const stem = text.slice(0, matches[0].index).trim();
  const subParts = [];
  for (let k = 0; k < matches.length; k++) {
    const from = matches[k].end;
    const to = k + 1 < matches.length ? matches[k + 1].index : text.length;
    const content = text.slice(from, to).trim().replace(/^[:.\-]\s*/, '');
    if (content) subParts.push({ label: `(${matches[k].label})`, text: content });
  }
  return { stem, subParts };
}

/** Parse a standalone sub_question block like "(ii) √45 − √20" → label + content. */
function parseSubLabel(text) {
  const t = (text || '').trim();
  MARKER_RE.lastIndex = 0;
  const m = MARKER_RE.exec(t);
  if (m && m.index === 0) {
    return { label: `(${m[1].toLowerCase()})`, content: t.slice(m[0].length).trim().replace(/^[:.\-]\s*/, ''), isRoman: ROMAN_LABEL_RE.test(m[0]) };
  }
  return { label: '', content: t, isRoman: false };
}

// ── Embedded-text builder (the storage format) ────────────────────────────────

/** Combine a stem and its parts into one multi-line question string. */
function buildEmbeddedText(stem, subParts) {
  const lines = [];
  const s = (stem || '').trim();
  if (s) lines.push(s);
  for (const p of subParts || []) {
    const label = (p.label || '').trim();
    const body = (p.text || '').trim();
    lines.push(label ? `${label} ${body}` : body);
  }
  return lines.join('\n').trim();
}

// ── Block-level grouping ──────────────────────────────────────────────────────

/**
 * Merge parent stems with their sub-parts across an array of semantic blocks.
 *
 * Handles two shapes:
 *   (A) inline   — one block whose text already contains "(i)…(ii)…"
 *   (B) split    — a parent block followed by separate sub_question blocks
 *
 * Conservative: only groups when the parent is an explicit multi-part
 * instruction OR the parts are roman-numbered. MCQ option lists are left alone.
 *
 * @param {Array<{blockType,blockLabel,text,...}>} blocks
 * @returns {Array} grouped blocks; merged ones gain { hasSubParts:true, subParts }
 */
function groupSubQuestionBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  const out = [];
  let i = 0;

  while (i < blocks.length) {
    const b = blocks[i];
    const canParent = b.blockType === 'question' || b.blockType === 'example';

    // (B) parent block followed by standalone sub_question blocks
    if (canParent && i + 1 < blocks.length && blocks[i + 1].blockType === 'sub_question') {
      const parentPattern = detectEducationalPattern(b.text);
      const firstSub = parseSubLabel(blocks[i + 1].text);
      const allowMerge = parentPattern.isParent || firstSub.isRoman;

      if (allowMerge) {
        const subParts = [];
        let j = i + 1;
        while (j < blocks.length && blocks[j].blockType === 'sub_question') {
          const parsed = parseSubLabel(blocks[j].text);
          subParts.push({ label: parsed.label, text: parsed.content });
          j++;
        }
        const stem = b.text.trim().replace(/\s*:\s*$/, ':');
        out.push({
          ...b,
          text: buildEmbeddedText(stem, subParts),
          hasSubParts: true,
          subParts,
          instruction: parentPattern.instruction || null,
        });
        i = j;
        continue;
      }
    }

    // (A) inline multi-part within a single block
    if (canParent) {
      const pattern = detectEducationalPattern(b.text);
      const { stem, subParts } = splitSubParts(b.text);
      const romanFirst = subParts.length > 0 && ROMAN_LABEL_RE.test(subParts[0].label);
      if (subParts.length >= 2 && (pattern.isParent || romanFirst)) {
        out.push({
          ...b,
          text: buildEmbeddedText(stem, subParts),
          hasSubParts: true,
          subParts,
          instruction: pattern.instruction || null,
        });
        i++;
        continue;
      }
    }

    out.push(b);
    i++;
  }

  return out;
}

module.exports = {
  detectEducationalPattern,
  splitSubParts,
  parseSubLabel,
  buildEmbeddedText,
  groupSubQuestionBlocks,
};
