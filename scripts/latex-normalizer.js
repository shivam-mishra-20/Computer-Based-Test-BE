'use strict';

/**
 * LaTeX / KaTeX Normalization Layer  (Phase 4)
 *
 * Single source of truth for turning messy textbook math into clean,
 * KaTeX-renderable LaTeX. Replaces the ad-hoc regex in ai-enhancer's
 * `normalizeMath` and complements the server-side `convertToLatex`.
 *
 * Pipeline (normalizeLatex):
 *   1. Unicode  → LaTeX commands   (², ₂, ½, √, ×, α …)
 *   2. ASCII    → braced LaTeX     (x^2 → x^{2}, H_2 → H_{2}, 1/2 → \frac{1}{2})
 *   3. Wrap bare math runs in $…$  (skipping text already inside $…$)
 *   4. fixCommonErrors             (drop \frac{}{}, \sqrt{}, ^{}, _{}; balance { } and $)
 *
 * Guarantees on output: balanced braces, balanced $ delimiters, no empty
 * \frac / \sqrt / superscript / subscript macros. validateLatex() reports
 * any residual issues and feeds the quality score.
 *
 * Design notes:
 *   - We DO NOT translate English words like "alpha"/"pi" to commands
 *     (the old code did — it corrupted ordinary prose). Only real Unicode
 *     math glyphs are converted.
 *   - Conversions run everywhere (also inside existing $…$, which is fine —
 *     a command is valid there); only the $-wrapping step is segment-aware.
 */

// ── Unicode tables ────────────────────────────────────────────────────────────

const SUPERSCRIPTS = { '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9','⁺':'+','⁻':'-','⁼':'=','⁽':'(','⁾':')','ⁿ':'n','ⁱ':'i' };
const SUBSCRIPTS   = { '₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9','₊':'+','₋':'-','₌':'=','₍':'(','₎':')' };

const VULGAR_FRACTIONS = {
  '½':'\\frac{1}{2}', '⅓':'\\frac{1}{3}', '⅔':'\\frac{2}{3}',
  '¼':'\\frac{1}{4}', '¾':'\\frac{3}{4}', '⅕':'\\frac{1}{5}',
  '⅖':'\\frac{2}{5}', '⅗':'\\frac{3}{5}', '⅘':'\\frac{4}{5}',
  '⅙':'\\frac{1}{6}', '⅚':'\\frac{5}{6}', '⅛':'\\frac{1}{8}',
  '⅜':'\\frac{3}{8}', '⅝':'\\frac{5}{8}', '⅞':'\\frac{7}{8}',
};

const OPERATORS = {
  '×':'\\times', '÷':'\\div', '±':'\\pm', '∓':'\\mp',
  '≠':'\\neq', '≤':'\\leq', '≥':'\\geq', '≈':'\\approx', '≡':'\\equiv',
  '∞':'\\infty', '∝':'\\propto', '∴':'\\therefore', '∵':'\\because',
  '⋅':'\\cdot', '·':'\\cdot', '∙':'\\cdot',
  '→':'\\rightarrow', '⇒':'\\Rightarrow', '↔':'\\leftrightarrow', '⇌':'\\rightleftharpoons',
  '∑':'\\sum', '∏':'\\prod', '∫':'\\int', '∂':'\\partial', '∇':'\\nabla',
  '∆':'\\Delta', '°':'^{\\circ}', '′':"'", '″':"''",
  '∈':'\\in', '∉':'\\notin', '⊂':'\\subset', '⊆':'\\subseteq', '∪':'\\cup', '∩':'\\cap',
  '∅':'\\emptyset', '∀':'\\forall', '∃':'\\exists', '√':'\\sqrt',
};

const GREEK = {
  'α':'\\alpha','β':'\\beta','γ':'\\gamma','δ':'\\delta','ε':'\\epsilon','ζ':'\\zeta',
  'η':'\\eta','θ':'\\theta','ι':'\\iota','κ':'\\kappa','λ':'\\lambda','μ':'\\mu',
  'ν':'\\nu','ξ':'\\xi','π':'\\pi','ρ':'\\rho','σ':'\\sigma','τ':'\\tau',
  'υ':'\\upsilon','φ':'\\phi','χ':'\\chi','ψ':'\\psi','ω':'\\omega',
  'Γ':'\\Gamma','Δ':'\\Delta','Θ':'\\Theta','Λ':'\\Lambda','Ξ':'\\Xi','Π':'\\Pi',
  'Σ':'\\Sigma','Φ':'\\Phi','Ψ':'\\Psi','Ω':'\\Omega',
};

// Detects a token that already "is math" — has a command or a braced script.
const HAS_MATH_INDICATOR = /\\[a-zA-Z]+|[\^_]\{/;

// ── Step 1: Unicode → LaTeX commands ──────────────────────────────────────────

function convertSuperSub(text) {
  // Collapse consecutive superscript glyphs into one ^{...}
  text = text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]+/g, (m) =>
    '^{' + [...m].map((c) => SUPERSCRIPTS[c] || '').join('') + '}'
  );
  // …and subscripts into _{...}
  text = text.replace(/[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎]+/g, (m) =>
    '_{' + [...m].map((c) => SUBSCRIPTS[c] || '').join('') + '}'
  );
  return text;
}

function convertFractions(text) {
  for (const [glyph, latex] of Object.entries(VULGAR_FRACTIONS)) {
    text = text.split(glyph).join(latex);
  }
  return text;
}

function convertRoot(text) {
  // √(expr) → \sqrt{expr}
  text = text.replace(/√\s*\(([^)]*)\)/g, (_, inner) => `\\sqrt{${inner}}`);
  // √word / √number → \sqrt{word}
  text = text.replace(/√\s*([A-Za-z0-9.]+)/g, (_, inner) => `\\sqrt{${inner}}`);
  // any leftover bare √ → \sqrt (fixCommonErrors will drop it if it stays empty)
  text = text.split('√').join('\\sqrt');
  return text;
}

function convertOperators(text) {
  for (const [glyph, latex] of Object.entries(OPERATORS)) {
    if (glyph === '√') continue; // handled by convertRoot
    // Word commands (\times, \rightarrow…) need a trailing space so a following
    // letter doesn't fuse into a bad control sequence (\rightarrowNa). Symbol
    // replacements like ^{\circ} or ' are left tight.
    const sep = /^\\[a-zA-Z]+$/.test(latex) ? latex + ' ' : latex;
    text = text.split(glyph).join(sep);
  }
  return text;
}

function convertGreek(text) {
  for (const [glyph, latex] of Object.entries(GREEK)) {
    // append a space so "λx" doesn't become "\lambdax"
    text = text.split(glyph).join(latex + ' ');
  }
  return text;
}

// ── Step 2: ASCII → braced LaTeX ──────────────────────────────────────────────

function fixAsciiScripts(text) {
  // x^2 → x^{2}, x^23 → x^{23}  (skip if already braced: x^{...})
  text = text.replace(/([A-Za-z0-9)\]}])\^(?!\{)([A-Za-z0-9]+)/g, '$1^{$2}');
  // H_2 → H_{2}  (single token + digits only — avoids snake_case prose)
  text = text.replace(/([A-Za-z0-9)\]}])_(?!\{)(\d+)/g, '$1_{$2}');
  return text;
}

function fixSimpleFractions(text) {
  // Standalone numeric fraction: 1/2 → \frac{1}{2}  (word-bounded)
  return text.replace(/\b(\d{1,3})\/(\d{1,3})\b/g, '\\frac{$1}{$2}');
}

// ── Step 3: wrap bare math runs in $…$ (segment-aware) ────────────────────────

// A maximal run of math-safe chars (no spaces) — split English on whitespace.
const MATH_RUN = /(?:\\[a-zA-Z]+(?:\{[^{}]*\})*|[\^_]\{[^{}]*\}|[A-Za-z0-9(){}\[\].,+\-*/=|^_])+/g;

function wrapRunsOutsideDollars(text) {
  // Split into segments that are inside $…$ / $$…$$ vs outside.
  const segmenter = /\$\$[^$]*\$\$|\$[^$]*\$/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = segmenter.exec(text)) !== null) {
    out += wrapBare(text.slice(last, m.index)); // outside chunk
    out += m[0];                                 // existing math, untouched
    last = m.index + m[0].length;
  }
  out += wrapBare(text.slice(last));
  return out;
}

function wrapBare(chunk) {
  if (!chunk) return chunk;
  return chunk.replace(MATH_RUN, (run) => {
    if (!HAS_MATH_INDICATOR.test(run)) return run;     // plain word/number — leave
    if (run.length === 1) return run;
    return '$' + run + '$';
  });
}

// ── Step 4: error repair ──────────────────────────────────────────────────────

function balanceBraces(s) {
  let out = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '}') {
      if (depth > 0) { depth--; out += ch; } // drop unmatched closers
    } else {
      if (ch === '{') depth++;
      out += ch;
    }
  }
  while (depth-- > 0) out += '}';
  return out;
}

function balanceDollars(s) {
  const count = (s.match(/\$/g) || []).length;
  if (count % 2 !== 0) {
    const idx = s.lastIndexOf('$');
    if (idx !== -1) s = s.slice(0, idx) + s.slice(idx + 1);
  }
  return s;
}

/**
 * Repair malformed macros and drop empty ones. Run this BEFORE $-wrapping so
 * emptied macros disappear without leaving a stray "$$" (which would otherwise
 * fuse neighbouring fragments). Idempotent — safe to run again afterwards.
 */
function repairMacros(text) {
  let t = text;

  // \frac12 / \frac{1}2 → \frac{1}{2}  (repair missing braces before checking empties)
  t = t.replace(/\\frac\s*(\d)\s*(\d)/g, '\\frac{$1}{$2}');
  t = t.replace(/\\frac\s*\{([^{}]+)\}\s*([A-Za-z0-9])/g, '\\frac{$1}{$2}');
  t = t.replace(/\\frac\s*([A-Za-z0-9])\s*\{([^{}]+)\}/g, '\\frac{$1}{$2}');

  // Drop / collapse empty macros
  t = t.replace(/\\frac\s*\{\s*\}\s*\{\s*\}/g, '');             // \frac{}{}  → ''
  t = t.replace(/\\frac\s*\{([^{}]+)\}\s*\{\s*\}/g, '$1');       // \frac{a}{} → a
  t = t.replace(/\\frac\s*\{\s*\}\s*\{([^{}]+)\}/g, '$1');       // \frac{}{b} → b
  t = t.replace(/\\sqrt\s*\{\s*\}/g, '');                        // \sqrt{}    → ''
  t = t.replace(/\\sqrt(?![\{a-zA-Z])/g, '');                    // bare \sqrt → ''
  t = t.replace(/\^\{\s*\}/g, '');                               // ^{}        → ''
  t = t.replace(/_\{\s*\}/g, '');                                // _{}        → ''
  return t;
}

function fixCommonErrors(text) {
  let t = repairMacros(text);

  // Collapse 3+ dollars, then balance braces and dollars.
  // NOTE: we deliberately do NOT merge "$a$ $b$" — that would fuse separate
  // commands (e.g. "$\rightarrow$ $Q_2$" → broken "$\rightarrowQ_2$").
  t = t.replace(/\${3,}/g, '$$');
  t = balanceBraces(t);
  t = balanceDollars(t);

  // Tidy whitespace
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Full normalization. Safe to call on any string (returns it unchanged when
 * there's nothing math-like to do).
 */
function normalizeLatex(text) {
  if (!text || typeof text !== 'string') return text;

  let t = text;
  t = convertSuperSub(t);
  t = convertFractions(t);
  t = convertRoot(t);
  t = convertOperators(t);
  t = convertGreek(t);
  t = fixAsciiScripts(t);
  t = fixSimpleFractions(t);
  t = repairMacros(t);            // drop empty macros BEFORE wrapping (no stray $$)
  t = wrapRunsOutsideDollars(t);
  t = fixCommonErrors(t);
  return t.trim();
}

/**
 * Report structural LaTeX problems without modifying the text.
 * @returns {{ valid: boolean, issues: string[] }}
 */
function validateLatex(text) {
  const issues = [];
  if (!text || typeof text !== 'string') return { valid: true, issues };

  // Balanced braces
  let depth = 0;
  let braceOk = true;
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < 0) { braceOk = false; break; } }
  }
  if (!braceOk || depth !== 0) issues.push('unbalanced-braces');

  // Balanced $ delimiters
  if (((text.match(/\$/g) || []).length) % 2 !== 0) issues.push('unbalanced-dollars');

  // Empty macros
  if (/\\frac\s*\{\s*\}\s*\{\s*\}|\\frac\s*\{[^{}]*\}\s*\{\s*\}|\\frac\s*\{\s*\}\s*\{[^{}]*\}/.test(text)) issues.push('empty-frac');
  if (/\\sqrt\s*\{\s*\}/.test(text)) issues.push('empty-sqrt');
  if (/\^\{\s*\}|_\{\s*\}/.test(text)) issues.push('empty-script');

  return { valid: issues.length === 0, issues };
}

module.exports = { normalizeLatex, validateLatex, fixCommonErrors };
