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

// ── Periodic table (for chemistry detection) ──────────────────────────────────
// Symbol → atomic number. Doubles as (a) the set of *valid* element symbols used
// to gate chemistry conversions against false positives ("A+" grade, "The", …)
// and (b) the Z lookup that lets us tell a real isotope ("23Na11", Z(Na)=11)
// from a molecule coefficient ("2H2", Z(H)=1 ≠ 2 → left alone).
const ATOMIC_NUMBER = {
  H:1, He:2, Li:3, Be:4, B:5, C:6, N:7, O:8, F:9, Ne:10,
  Na:11, Mg:12, Al:13, Si:14, P:15, S:16, Cl:17, Ar:18, K:19, Ca:20,
  Sc:21, Ti:22, V:23, Cr:24, Mn:25, Fe:26, Co:27, Ni:28, Cu:29, Zn:30,
  Ga:31, Ge:32, As:33, Se:34, Br:35, Kr:36, Rb:37, Sr:38, Y:39, Zr:40,
  Nb:41, Mo:42, Tc:43, Ru:44, Rh:45, Pd:46, Ag:47, Cd:48, In:49, Sn:50,
  Sb:51, Te:52, I:53, Xe:54, Cs:55, Ba:56, La:57, Ce:58, Pr:59, Nd:60,
  Pm:61, Sm:62, Eu:63, Gd:64, Tb:65, Dy:66, Ho:67, Er:68, Tm:69, Yb:70,
  Lu:71, Hf:72, Ta:73, W:74, Re:75, Os:76, Ir:77, Pt:78, Au:79, Hg:80,
  Tl:81, Pb:82, Bi:83, Po:84, At:85, Rn:86, Fr:87, Ra:88, Ac:89, Th:90,
  Pa:91, U:92, Np:93, Pu:94, Am:95, Cm:96, Bk:97, Cf:98, Es:99, Fm:100,
  Md:101, No:102, Lr:103,
};
const ELEMENTS = new Set(Object.keys(ATOMIC_NUMBER));
// Elements that legitimately appear as "El2" molecules (O2, N2, Cl2 …). Used so a
// single-element formula converts only for these — never "B2"/"A2" style noise.
const DIATOMIC = new Set(['H', 'N', 'O', 'F', 'Cl', 'Br', 'I']);

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

// ── Scientific / chemical notation (Phase 4.1) ────────────────────────────────
// OCR routinely flattens chemistry & science notation into ambiguous ASCII:
//   O2- SO42- NH4+ Be-   (ions)      23Na11 (isotope)   nCr nPr (combinatorics)
//   x2 (bare exponent)   Be -> Be-   (reaction)
// This layer detects those *specific* shapes and rewrites them to clean LaTeX,
// leaving everything else — prose, existing LaTeX, plain numbers — untouched.
//
// Convention (confirmed with the team): a chemical species renders "braces per
// element" — each element that carries a subscript or the charge is wrapped in
// {…}; the trailing digit run is a subscript (count); a single trailing digit is
// a subscript, and only the LAST of ≥2 trailing digits is the charge magnitude:
//   O2-   → {O}_{2}^{-}      SO42- → S{O}_{4}^{2-}
//   NH4+  → N{H}_{4}^{+}     Be-   → {Be}^{-}

/**
 * Render "SO4"/"O2"/"Be" (+ optional charge like "2-") in braces-per-element form.
 * Wraps an element in {…} when it has a subscript, carries the charge, or is the
 * lone element of the species.
 */
function formatFormula(body, charge) {
  const elems = [];
  const re = /([A-Z][a-z]?)(\d*)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    elems.push({ el: m[1], sub: m[2] });
  }
  if (!elems.length) return body + (charge ? `^{${charge}}` : '');
  const sole = elems.length === 1;
  return elems
    .map((e, i) => {
      const isLast = i === elems.length - 1;
      const hasSub = !!e.sub;
      const wrap = hasSub || sole || (isLast && !!charge);
      let piece = wrap ? `{${e.el}}` : e.el;
      if (hasSub) piece += `_{${e.sub}}`;
      if (isLast && charge) piece += `^{${charge}}`;
      return piece;
    })
    .join('');
}

/**
 * Turn a raw species token ("SO42-", "O2-", "NH4+", "Be-", "Be") into LaTeX.
 * Splits the trailing charge from the formula body per the convention above.
 */
function parseSpeciesLatex(raw) {
  const m = raw.match(/^(.*?)(\d*)([+\-]+)$/);
  if (!m || !m[3]) return formatFormula(raw, '');       // neutral (e.g. "Be")
  let body = m[1];
  const mag = m[2];
  const sign = m[3];
  let charge;
  if (mag.length >= 2) { body += mag.slice(0, -1); charge = mag.slice(-1) + sign; }
  else { body += mag; charge = sign; }                  // 0/1 trailing digit → subscript
  return formatFormula(body, charge);
}

// Are all element symbols in a token real elements? (rejects "A+", "The", …)
function elementsValid(raw) {
  const els = raw.replace(/[+\-]+$/, '').match(/[A-Z][a-z]?/g) || [];
  return els.length > 0 && els.every((e) => ELEMENTS.has(e));
}

// A chemical species inside a reaction expression: element run + optional charge,
// but never swallow the '-' of a "->" arrow.
const SP_SRC = '[A-Z][a-z]?[A-Za-z0-9]*(?:[+\\-](?!>))?';
// Connectors: arrows tolerate any spacing; a reactant "+" must be space-padded so
// it's never confused with a cation charge ("Na+ + Cl-" — first + is the charge).
const CONN_SRC = '(?:\\s*(?:-->|->|→|⟶|⇌|⇋|=>)\\s*|\\s+\\+\\s+)';
const REACTION_RE = new RegExp(`${SP_SRC}(?:${CONN_SRC}${SP_SRC})+`, 'g');

// Isotope: massNumber Element atomicNumber → ^{A}_{Z}\mathrm{El}
const ISOTOPE_RE = /(?<![\w\\{}$^_])(\d{1,3})([A-Z][a-z]?)(\d{1,3})(?![\w])/g;
// Combinatorics / permutations: nCr, nPr, 10C2 → {}^{n}C_{r}
const COMBO_RE = /(?<![\w\\{}$^_])([nm]|\d{1,3})([CP])([nrk]|\d{1,3})(?![\w])/g;
// Charged ion: element run ending in a single +/- sign (not part of "->").
const ION_RE = /(?<![\w\\{}$^_])((?:[A-Z][a-z]?\d*){1,8}[+\-])(?![\w>=+\-])/g;
// Uncharged formula candidate (gated hard in the replacer): H2O, CO2, CaCl2 …
const FORMULA_RE = /(?<![\w\\{}$^_])((?:[A-Z][a-z]?\d*){1,10})(?![\w+\-{}$^_=])/g;
// Bare exponent for the common italic unknowns only: x2 → x^{2}
const EXPONENT_RE = /(?<![\w\\{}$^_])([xyz])(\d{1,3})(?![\w{}$^_.])/g;

// Convert an uncharged formula only when it's unambiguously chemical.
function tryFormula(tok) {
  if (!/\d/.test(tok)) return null;                      // nothing to subscript
  const els = tok.match(/[A-Z][a-z]?/g) || [];
  if (!els.length || !els.every((e) => ELEMENTS.has(e))) return null;
  if (new Set(els).size < 2) {
    // one distinct element → only accept real diatomics written as "El2"
    if (!(els.length === 1 && DIATOMIC.has(els[0]) && /^[A-Z][a-z]?2$/.test(tok))) return null;
  }
  if (tok.length > 14) return null;
  return formatFormula(tok, '');
}

// Rewrite a reaction expression ("Be -> Be-", "H2 + O2 -> H2O") as one $…$ unit.
function replaceReaction(match) {
  const species = match.match(new RegExp(SP_SRC, 'g')) || [];
  // Require a real chemical signal (a digit or a charge) and valid elements —
  // this keeps prose like "cause -> effect" or math "A = B" untouched.
  const strong = species.some((s) => /\d/.test(s) || /[+\-]$/.test(s));
  if (!strong || !species.every(elementsValid)) return match;
  let inner = match.replace(new RegExp(SP_SRC, 'g'), (s) => parseSpeciesLatex(s));
  inner = inner
    .replace(/\s*(?:-->|->|→|⟶)\s*/g, ' \\rightarrow ')
    .replace(/\s*(?:⇌|⇋)\s*/g, ' \\rightleftharpoons ')
    .replace(/\s*=>\s*/g, ' \\Rightarrow ')
    .replace(/\s+\+\s+/g, ' + ');   // spaces required → never touches a ^{+} charge
  return `$${inner.trim()}$`;
}

/**
 * Detect malformed scientific notation and rewrite it to LaTeX. Existing $…$
 * math is protected; each conversion is stashed behind an inert sentinel so a
 * later pass never re-processes an earlier one. Returns a mix of finished $…$
 * segments (reactions) and raw LaTeX runs that the $-wrapping step will wrap.
 */
function convertScientific(text) {
  if (!text || typeof text !== 'string') return text;
  const store = [];
  const stash = (s) => { const k = `${store.length}`; store.push(s); return k; };

  let t = text;
  t = t.replace(/\$\$[^$]*\$\$|\$[^$]*\$/g, (m) => stash(m));      // protect existing math
  // Each conversion self-wraps in $…$ so it renders as an isolated math span and
  // never absorbs neighbouring sentence punctuation (e.g. "…is CO2." → "…is $C{O}_{2}$.").
  t = t.replace(REACTION_RE, (m) => { const r = replaceReaction(m); return r === m ? m : stash(r); });
  t = t.replace(ISOTOPE_RE, (m, a, el, z) =>
    ATOMIC_NUMBER[el] === Number(z) ? stash(`$^{${a}}_{${z}}\\mathrm{${el}}$`) : m);
  t = t.replace(COMBO_RE, (m, a, op, b) => stash('$' + `{}^{${a}}${op}_{${b}}` + '$'));
  t = t.replace(ION_RE, (m, tok) => (elementsValid(tok) ? stash(`$${parseSpeciesLatex(tok)}$`) : m));
  t = t.replace(FORMULA_RE, (m, tok) => { const l = tryFormula(tok); return l ? stash(`$${l}$`) : m; });
  t = t.replace(EXPONENT_RE, (m, v, d) => stash(`$${v}^{${d}}$`));
  t = t.replace(/(\d+)/g, (_, i) => store[Number(i)]);  // restore
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
  t = convertScientific(t);       // chemistry / isotopes / combinatorics / exponents
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

module.exports = { normalizeLatex, validateLatex, fixCommonErrors, convertScientific };
