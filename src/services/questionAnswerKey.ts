/**
 * Does a question carry the answer key the grader needs?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `gradeObjective()` marks a single-choice question ONLY from an option flagged
 * `isCorrect`. A multiple-choice question saved without one can never be
 * answered correctly: every student is marked wrong on it, and the exam's
 * negative marking is applied to all of them. Nothing stopped such a question
 * being saved, imported or published, so this is the one rule every write path
 * now applies before it persists or publishes a question.
 *
 * ── One definition, shared with the grader ──────────────────────────────────
 * The type sets below are the ones `gradeObjective()` branches on —
 * attemptService imports them from here. If the validator and the grader kept
 * separate lists, a type alias added to one would be graded by rules the other
 * never checks.
 *
 * Only questions whose key IS an option (or the assertion/reason truth flags
 * the grader derives A/B/C/D from) are checked. Integer, fill-in and
 * subjective questions are out of scope here.
 */

// Collapse the many type aliases the web/mobile players emit into a canonical
// key (e.g. "mcq-single" / "MCQ_Single" -> "mcqsingle"). Without this the grader
// silently skipped real question types and treated them as subjective.
export function normalizeQuestionType(t?: string): string {
  return (t || '').toLowerCase().replace(/[\s_-]+/g, '');
}

export const SINGLE_CHOICE_TYPES = new Set([
  'mcq',
  'mcqsingle',
  'singlechoice',
  'multiplechoice',
]);
export const TRUEFALSE_TYPES = new Set(['truefalse']);
export const MULTI_SELECT_TYPES = new Set([
  'mcqmulti',
  'multiselect',
  'multipleselect',
  'msq',
]);
export const INTEGER_TYPES = new Set([
  'integer',
  'numerical',
  'numeric',
  'number',
]);
export const FILL_TYPES = new Set([
  'fill',
  'fillblank',
  'fillintheblank',
  'fillups',
]);
export const SUBJECTIVE_TYPES = new Set([
  'short',
  'long',
  'subjective',
  'text',
  'essay',
  'descriptive',
]);

/** The fields `answerKeyProblem` reads. Select all of them, or every question looks keyless. */
export const ANSWER_KEY_FIELDS =
  'type options correctAnswerText assertionIsTrue reasonIsTrue';

export interface AnswerKeyFields {
  type?: string | null;
  options?: Array<{ isCorrect?: unknown } | null | undefined> | null;
  correctAnswerText?: unknown;
  assertionIsTrue?: unknown;
  reasonIsTrue?: unknown;
}

// Request bodies are not cast yet, so accept the values Mongoose would cast to
// `true` — a raw "false" string must not count as marked.
function isTrue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function hasCorrectOption(q: AnswerKeyFields): boolean {
  return (
    Array.isArray(q.options) && q.options.some((o) => isTrue(o?.isCorrect))
  );
}

/**
 * Why this question cannot be graded, or null when its key is usable.
 *
 * Mirrors `gradeObjective()`:
 *   • single-choice / multi-select — needs an option marked correct;
 *     `correctAnswerText` is never consulted for these.
 *   • true/false WITH options — the players submit the chosen option's id, so
 *     it needs a correct option. Without options it is graded by text, so
 *     `correctAnswerText` is the key.
 *   • assertion-reason — a correct option, or the truth flags. With both
 *     flags false the grader can derive no answer, so that is no key either.
 */
export function answerKeyProblem(
  q: AnswerKeyFields | null | undefined,
): string | null {
  if (!q) return null;
  const type = normalizeQuestionType(q.type ?? undefined);

  if (SINGLE_CHOICE_TYPES.has(type) || MULTI_SELECT_TYPES.has(type)) {
    return hasCorrectOption(q) ? null : 'No correct option is marked.';
  }

  if (TRUEFALSE_TYPES.has(type)) {
    if (hasCorrectOption(q)) return null;
    const optionCount = Array.isArray(q.options)
      ? q.options.filter(Boolean).length
      : 0;
    if (optionCount > 0) return 'No correct option is marked (True or False).';
    return String(q.correctAnswerText ?? '').trim()
      ? null
      : 'No correct answer is set (True or False).';
  }

  if (type === 'assertionreason') {
    if (
      hasCorrectOption(q) ||
      isTrue(q.assertionIsTrue) ||
      isTrue(q.reasonIsTrue)
    )
      return null;
    return 'No answer key: mark the correct option, or set whether the assertion and the reason are true.';
  }

  return null;
}

export interface AnswerKeyIssue {
  /** 1-based position in the list the caller checked. */
  position: number;
  /** Human label, e.g. "Q3" or "Physics Q2". */
  label: string;
  id?: string;
  text: string;
  reason: string;
}

function preview(text: unknown): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

/** Check a list; `labelOf` names each question the way its UI numbers it. */
export function findAnswerKeyIssues<
  T extends AnswerKeyFields & { _id?: unknown; id?: unknown; text?: unknown },
>(
  questions: T[],
  labelOf: (question: T, index: number) => string = (_q, i) => `Q${i + 1}`,
): AnswerKeyIssue[] {
  const issues: AnswerKeyIssue[] = [];
  questions.forEach((question, index) => {
    const reason = answerKeyProblem(question);
    if (!reason) return;
    const rawId = question?._id ?? question?.id;
    issues.push({
      position: index + 1,
      label: labelOf(question, index),
      id: rawId != null ? String(rawId) : undefined,
      text: preview(question?.text),
      reason,
    });
  });
  return issues;
}

/** One sentence naming every offending question, for the error a client shows. */
export function describeAnswerKeyIssues(
  issues: AnswerKeyIssue[],
  action: string,
): string {
  const shown = issues
    .slice(0, 10)
    .map((i) => (i.text ? `${i.label} ("${i.text}")` : i.label));
  const more =
    issues.length > shown.length
      ? ` and ${issues.length - shown.length} more`
      : '';
  const noun = issues.length === 1 ? 'question has' : 'questions have';
  return (
    `${action}: ${issues.length} ${noun} no correct answer marked — ${shown.join(', ')}${more}. ` +
    `Mark the correct option for each, or remove ${issues.length === 1 ? 'it' : 'them'}.`
  );
}

/** Thrown by service-level checks; controllers turn it into a 400 with `issues`. */
export class AnswerKeyError extends Error {
  readonly code = 'ANSWER_KEY_MISSING';
  constructor(
    readonly issues: AnswerKeyIssue[],
    action: string,
  ) {
    super(describeAnswerKeyIssues(issues, action));
    this.name = 'AnswerKeyError';
  }
}

/** The JSON body for a refused request. */
export function answerKeyErrorBody(error: AnswerKeyError) {
  return {
    success: false,
    message: error.message,
    code: error.code,
    issues: error.issues,
  };
}
