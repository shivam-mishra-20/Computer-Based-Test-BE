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

/** Best-effort extraction of the first JSON object/array substring. */
function sliceJson(text: string): string | null {
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  let start = -1;
  let closeCh = '}';
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr;
    closeCh = ']';
  } else if (firstObj !== -1) {
    start = firstObj;
  }
  if (start === -1) return null;
  const end = text.lastIndexOf(closeCh);
  if (end <= start) return null;
  return text.slice(start, end + 1);
}

/** Auto-close unbalanced braces/brackets on a truncated response. */
function repairTruncation(s: string): string {
  const openBraces = (s.match(/\{/g) || []).length;
  const closeBraces = (s.match(/\}/g) || []).length;
  const openBrackets = (s.match(/\[/g) || []).length;
  const closeBrackets = (s.match(/\]/g) || []).length;
  let out = s;
  for (let i = 0; i < openBraces - closeBraces; i++) out += '}';
  for (let i = 0; i < openBrackets - closeBrackets; i++) out += ']';
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
  return s.replace(/(?<!\\)\\(u[0-9a-fA-F]{4}|[a-zA-Z])/g, (m, g) =>
    /^u[0-9a-fA-F]{4}$/.test(g) ? m : '\\\\' + g
  );
}

/**
 * Parse arbitrary model output into a JS value with several fallbacks:
 * 0. repair single-backslash LaTeX so it isn't silently mangled
 * 1. strip reasoning/fences → direct parse
 * 2. slice the first {...}/[...] → parse
 * 3. repair truncation (auto-close) → parse
 * 4. strip control chars / trailing commas → parse
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
    const sliced = sliceJson(base);
    if (sliced) {
      attempts.push(sliced);
      attempts.push(repairTruncation(sliced));
    }
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
