/**
 * Robust LLM-output → JSON helpers. Consolidates the repair strategies that
 * previously lived in aiQuestionGenerationService.parseGeneratedQuestions,
 * aiService, and ai-enhancer._parseJsonResponse, and adds nemotron-specific
 * reasoning-trace stripping.
 */

// Control characters that frequently break JSON.parse. Built from ASCII-only
// escapes so no literal control bytes live in source.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');

/**
 * Remove `<think>…</think>` reasoning blocks emitted by nemotron / qwen3 style
 * reasoning models, plus markdown code fences. Safe on plain text.
 */
export function stripReasoning(raw: string): string {
  if (!raw) return '';
  let t = raw;
  // Remove complete <think>...</think> blocks (case-insensitive, multiline).
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Remove a dangling unterminated <think> ... (model truncated before answer).
  t = t.replace(/<think>[\s\S]*$/i, '');
  // Strip ```json / ``` fences.
  t = t.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');
  return t.trim();
}

/**
 * String-aware extraction + truncation repair in one pass. Starting at the first
 * `{`/`[`, it walks the text tracking string state (so braces inside LaTeX like
 * `\frac{a}{b}` are never miscounted) and a stack of open structures. If the
 * response ends mid-value (the 49B model frequently hits its token cap), it
 * closes the dangling string, drops a trailing comma / fills a dangling colon,
 * then closes every still-open `[`/`{` in the correct order. Returns a balanced
 * JSON candidate, or null if no object/array start is present.
 */
function extractBalancedJson(text: string): string | null {
  const objIdx = text.indexOf('{');
  const arrIdx = text.indexOf('[');
  let start = -1;
  if (arrIdx !== -1 && (objIdx === -1 || arrIdx < objIdx)) start = arrIdx;
  else if (objIdx !== -1) start = objIdx;
  if (start === -1) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let out = '';

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    out += ch;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
      if (stack.length === 0) return out; // complete top-level structure
    }
  }

  // Truncated mid-value — repair the tail, then close open structures.
  if (inString) out += '"';
  out = out.replace(/,\s*$/, '');        // dangling comma after last element
  out = out.replace(/:\s*$/, ':null');   // key with no value yet
  while (stack.length) out += stack.pop();
  return out;
}

/**
 * LLMs frequently emit LaTeX with SINGLE backslashes inside JSON strings
 * (e.g. "\frac{a}{b}"). JSON.parse then SILENTLY mangles them, because \f, \b,
 * \n, \r, \t are valid JSON escapes: "\frac" -> <FF>"rac", "\times" -> <TAB>"imes",
 * "\beta" -> <BS>"eta", "\neq" -> <LF>"eq". The result renders as broken LaTeX
 * (e.g. "\frac" shows as "rac"). This doubles any lone backslash that begins a
 * LaTeX-style command so the command survives parsing. Already-doubled (\\),
 * \uXXXX unicode escapes, \" and \/ are left intact.
 */
export function fixLatexBackslashes(s: string): string {
  return (
    s
      .replace(/(?<!\\)\\(u[0-9a-fA-F]{4}|[a-zA-Z])/g, (m, g) =>
        /^u[0-9a-fA-F]{4}$/.test(g) ? m : '\\\\' + g
      )
      // Backslash before a NON-letter that isn't a valid JSON escape start —
      // LaTeX delimiters like \( \) \[ \] \{ \} and \% \$ etc. `\(` is an
      // invalid JSON escape and JSON.parse rejects the whole document, which
      // no other repair pass can recover from. (Valid escapes \" \\ \/ are
      // excluded; letters were handled above.)
      .replace(/(?<!\\)\\(?=[^"\\/a-zA-Z])/g, '\\\\')
  );
}

/**
 * Parse arbitrary model output into a JS value with several fallbacks:
 * 0. repair single-backslash LaTeX so it isn't silently mangled
 * 1. strip reasoning/fences → direct parse
 * 2. string-aware extract of the first {...}/[...], auto-closing a truncated
 *    tail → parse
 * 3. strip control chars / trailing commas → parse
 * Returns `undefined` if everything fails.
 */
export function safeParse<T = any>(raw: string): T | undefined {
  const cleaned = stripReasoning(raw);
  if (!cleaned) return undefined;

  // Prefer the LaTeX-repaired text (preserves \frac etc.), then fall back to raw.
  const latexFixed = fixLatexBackslashes(cleaned);
  const bases = latexFixed === cleaned ? [cleaned] : [latexFixed, cleaned];

  const attempts: string[] = [];
  for (const base of bases) {
    attempts.push(base);
    const balanced = extractBalancedJson(base);
    if (balanced) attempts.push(balanced);
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try next */
    }
    // Tolerant pass: drop trailing commas + control chars.
    try {
      const lenient = candidate
        .replace(/,\s*([\]}])/g, '$1')
        .replace(CONTROL_CHARS, '');
      return JSON.parse(lenient) as T;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Parse and require an object. Throws with a snippet on failure. */
export function parseObject<T = any>(raw: string): T {
  const v = safeParse<T>(raw);
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  throw new Error(`Expected JSON object, got: ${String(raw).slice(0, 200)}`);
}

/** Parse an array, accepting either a bare array or `{ "<key>": [...] }`. */
export function parseArray<T = any>(raw: string, key?: string): T[] {
  const v = safeParse<any>(raw);
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === 'object') {
    if (key && Array.isArray(v[key])) return v[key] as T[];
    // Fall back to the first array-valued property.
    for (const k of Object.keys(v)) {
      if (Array.isArray(v[k])) return v[k] as T[];
    }
  }
  return [];
}
