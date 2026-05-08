'use strict';

/**
 * PDF Document Structure Analyzer
 *
 * Converts raw pdfjs-dist text items into semantic blocks that respect
 * NCERT/CBSE textbook document hierarchy:
 *   - Examples (Example 1:, Example 2.)
 *   - Exercises (Exercise 12.1, EXERCISE 6.2)
 *   - Numbered questions (Q1., 1., (i), (a))
 *   - Special sections (Think About It, Try These, In-Text Questions)
 *
 * Returns an array of SemanticBlock objects or null if no structure is found.
 */

// ── Boundary patterns (order matters — more specific first) ──────────────────

const QUESTION_BOUNDARIES = [
  // Chapter / exercise headers — group starters, not individual questions
  { re: /^(?:EXERCISE|Exercise)\s+[\d.]+\s*$/i,              type: 'exercise_header' },
  { re: /^CHAPTER\s+\d+/i,                                    type: 'chapter_header' },
  { re: /^(?:THINK ABOUT IT|TRY THESE|LET[''']S\s+THINK)/i,  type: 'section_header' },
  { re: /^(?:IN[-\s]TEXT\s*QUESTIONS?|CHECK YOUR PROGRESS)/i, type: 'section_header' },
  { re: /^(?:ACTIVITIES?|PROJECTS?)\s*$/i,                    type: 'section_header' },

  // Individual question / example starters
  { re: /^Example\s+\d+\s*[:.]/i,                            type: 'example' },
  { re: /^(?:Theorem|Lemma|Corollary)\s+\d+[\s:.]/i,         type: 'theorem' },
  { re: /^(?:Q\.?\s*|Question\s+)\d+[.:\)]/i,                type: 'question' },
  { re: /^\d{1,2}[.:\)]\s+[A-Z"'(‘’]/,            type: 'question' },
  { re: /^\(\s*(?:i{1,3}|iv|v|vi{0,3}|vii{1,2}|ix|x)\s*\)\s+/i, type: 'sub_question' },
  { re: /^\(\s*[a-h]\s*\)\s+[A-Z"'(‘’]/,           type: 'sub_question' },
  { re: /^(?:Solve|Find|Prove|Show|Draw|Construct|Verify|Calculate|Determine|Evaluate|Simplify|Factorise|Factorize|Write|State|Define|Explain|Describe|Compare|List|Give|Check|Examine)\s+/i, type: 'question' },
];

// Lines that are context/solution, NOT a new question
const SKIP_PREFIXES = [
  /^(?:Solution|Proof|Given|To\s+(?:find|prove)|Ans(?:wer)?)\s*:/i,
  /^(?:Note|Remark|Hint|Remember)\s*:/i,
  /^(?:Step\s+\d+|Case\s+\d+)\s*[:.]/i,
  /^(?:Therefore|Hence|Thus|So|Now|Here|Let)\b/i,
  /^We\s+(?:know|have|get|need|can|see)/i,
  /^\s*Fig(?:ure)?\.?\s*\d+/i,
];

// ── Text geometry helpers ────────────────────────────────────────────────────

const Y_LINE_SNAP   = 4;   // px — items within this y distance = same line
const Y_PARA_GAP    = 14;  // px — gap > this = paragraph break
const X_INDENT_SKIP = 50;  // px — indented by > this from page left = body text

/**
 * Group flat text items (with x, y) into visual lines by y-position clustering.
 */
function groupToLines(items) {
  if (!items || items.length === 0) return [];

  // Sort top-to-bottom, then left-to-right
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);

  const lines = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur  = sorted[i];
    if (Math.abs(cur.y - prev.y) <= Y_LINE_SNAP) {
      current.push(cur);
    } else {
      lines.push(current);
      current = [cur];
    }
  }
  if (current.length > 0) lines.push(current);

  return lines.map(lineItems => {
    const text  = lineItems.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
    const minX  = Math.min(...lineItems.map(it => it.x));
    const avgY  = lineItems.reduce((s, it) => s + it.y, 0) / lineItems.length;
    return { text, x: minX, y: avgY };
  }).filter(l => l.text.length > 0);
}

/**
 * Convert lines array into paragraph strings, splitting on blank lines and
 * large y-gaps.
 */
function linesToParagraphs(lines) {
  if (lines.length === 0) return [];

  const paragraphs = [];
  let buf = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = lines[i - 1];

    const gap = prev ? line.y - prev.y : 0;
    if (buf.length > 0 && gap > Y_PARA_GAP) {
      paragraphs.push(buf.join(' '));
      buf = [];
    }
    buf.push(line.text);
  }
  if (buf.length > 0) paragraphs.push(buf.join(' '));

  return paragraphs.filter(p => p.trim().length > 0);
}

// ── Boundary detection ───────────────────────────────────────────────────────

function classifyLine(text) {
  const t = text.trim();
  if (!t) return null;

  // Skip obvious non-question starts
  for (const re of SKIP_PREFIXES) {
    if (re.test(t)) return { type: 'skip', re };
  }

  for (const { re, type } of QUESTION_BOUNDARIES) {
    if (re.test(t)) return { type, re };
  }

  return null;
}

// ── Structural block assembly ────────────────────────────────────────────────

/**
 * @typedef {Object} SemanticBlock
 * @property {string} blockType  — 'example'|'question'|'sub_question'|'theorem'|'exercise_header'|'section_header'|'chapter_header'|'body'
 * @property {string} blockLabel — e.g. "Example 3:" or "Q.1." or "Exercise 12.1"
 * @property {string} text       — full text of this block
 * @property {number} pageStart
 * @property {number} pageEnd
 * @property {Array}  tables     — extracted table objects from those pages
 * @property {Array}  diagrams   — extracted diagram objects from those pages
 */

/**
 * Analyze page data and build semantic blocks.
 * Returns null if no recognizable structure is found (< MIN_BOUNDARIES).
 *
 * @param {Array<{pageNum, text, textItems, tables, diagrams}>} pageData
 * @returns {SemanticBlock[]|null}
 */
function analyzeDocumentStructure(pageData) {
  if (!pageData || pageData.length === 0) return null;

  // Phase 1: convert all pages into annotated lines
  const allLines = []; // { text, x, y, pageNum }
  for (const pd of pageData) {
    const lines = groupToLines(pd.textItems || []);
    for (const line of lines) {
      allLines.push({ ...line, pageNum: pd.pageNum });
    }
  }

  if (allLines.length === 0) return null;

  // Phase 2: find boundary lines
  const boundaries = [];
  for (let i = 0; i < allLines.length; i++) {
    const cls = classifyLine(allLines[i].text);
    if (cls && cls.type !== 'skip') {
      boundaries.push({ lineIdx: i, ...cls });
    }
  }

  const MIN_BOUNDARIES = 2;
  if (boundaries.length < MIN_BOUNDARIES) return null;

  // Phase 3: slice allLines into blocks between consecutive boundaries
  const blocks = [];

  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b].lineIdx;
    const end   = b + 1 < boundaries.length ? boundaries[b + 1].lineIdx : allLines.length;

    const blockLines = allLines.slice(start, end);
    if (blockLines.length === 0) continue;

    const blockText = blockLines.map(l => l.text).join('\n').trim();
    if (blockText.length < 10) continue; // skip trivially short blocks

    const pageStart = blockLines[0].pageNum;
    const pageEnd   = blockLines[blockLines.length - 1].pageNum;
    const label     = blockLines[0].text.trim();

    // Collect tables and diagrams from spanned pages
    const tables   = [];
    const diagrams = [];
    for (const pd of pageData) {
      if (pd.pageNum >= pageStart && pd.pageNum <= pageEnd) {
        tables.push(...(pd.tables   || []));
        diagrams.push(...(pd.diagrams || []));
      }
    }

    blocks.push({
      blockType:  boundaries[b].type,
      blockLabel: label,
      text:       blockText,
      pageStart,
      pageEnd,
      tables,
      diagrams,
    });
  }

  // Phase 4: discard header-only blocks with no meaningful body text
  // (exercise headers will be merged into following question blocks below)
  const meaningful = mergeHeadersIntoFollowing(blocks);

  if (meaningful.length === 0) return null;
  return meaningful;
}

/**
 * When an exercise_header or section_header block is immediately followed by
 * question/example blocks, prepend the header label to each child so the AI
 * has context ("Exercise 6.2 > Q1. ...").
 *
 * Also removes standalone header-only blocks that have no body text.
 */
function mergeHeadersIntoFollowing(blocks) {
  const result = [];
  let pendingHeader = null;

  for (const block of blocks) {
    if (block.blockType === 'exercise_header' || block.blockType === 'chapter_header') {
      // Don't emit yet — carry it forward as context prefix
      pendingHeader = block.blockLabel;
      // Still emit as a separate block so the frontend can label it
      result.push(block);
      continue;
    }

    if (block.blockType === 'section_header') {
      pendingHeader = block.blockLabel;
      result.push(block);
      continue;
    }

    if (pendingHeader) {
      // Annotate child with parent label
      result.push({
        ...block,
        parentLabel: pendingHeader,
        text: `[${pendingHeader}]\n${block.text}`,
      });
    } else {
      result.push(block);
    }
  }

  return result;
}

// ── Export ───────────────────────────────────────────────────────────────────

module.exports = { analyzeDocumentStructure, groupToLines, linesToParagraphs, classifyLine };
