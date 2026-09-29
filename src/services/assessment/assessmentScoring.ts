/**
 * Assessment scoring — pure, deterministic, no database.
 *
 * ── Why this lives outside any route or model ───────────────────────────────
 * A score is the one number a family acts on, so it is computed in exactly one
 * place and only ever from the server's own copy of the answer key. Nothing a
 * browser sends is consulted except WHICH option or text it chose: `isCorrect`,
 * `marks`, `score` or `percentage` in a request body are never read here.
 *
 * ── The paper, not the answers, is what is scored ───────────────────────────
 * The previous grader walked the ANSWERS and added each answered question's
 * marks to the maximum. Skipping a question therefore removed it from the
 * denominator: one correct answer and twenty-nine skips scored 100%. Here the
 * maximum is the sum over every gradable question on the paper, answered or
 * not, and answers to questions that are not on the paper are ignored.
 *
 * ── Question kinds ──────────────────────────────────────────────────────────
 *   option-based   any question with options and at least one `isCorrect`
 *                  (mcq, truefalse, assertionreason as stored in the bank)
 *   integer        `integerAnswer` is a finite number
 *   text key       `correctAnswerText` with no options (fill-in-the-blank)
 *   ungraded       none of the above (short/long answers). Excluded from the
 *                  maximum until a reviewer awards marks, so an unreviewed
 *                  essay never drags a percentage down.
 */

export type Outcome = 'correct' | 'incorrect' | 'skipped' | 'ungraded';

export interface QuestionKey {
  id: string;
  type?: string;
  /** Marks for a correct answer. Defaults to 1. */
  marks?: number;
  /** Marks deducted for a wrong answer. AGTS uses none; kept for reuse. */
  negativeMarks?: number;
  options?: Array<{ id: string; isCorrect?: boolean }>;
  correctAnswerText?: string;
  integerAnswer?: number | null;
  subject?: string;
  chapter?: string;
  topic?: string;
  difficulty?: string;
}

export interface ResponseInput {
  questionId: string;
  chosenOptionId?: string | null;
  textAnswer?: string | null;
  markedForReview?: boolean;
  /**
   * Marks a reviewer awarded by hand. Honoured only for questions the engine
   * cannot grade itself, and clamped to [0, max].
   */
  manualMarks?: number | null;
}

export interface QuestionResult {
  questionId: string;
  index: number;
  outcome: Outcome;
  awarded: number;
  max: number;
  attempted: boolean;
  markedForReview: boolean;
  gradable: boolean;
  subject: string;
  chapter: string;
  topic: string;
  difficulty: string;
}

export interface ScoreSummary {
  totalQuestions: number;
  attempted: number;
  correct: number;
  incorrect: number;
  skipped: number;
  ungraded: number;
  markedForReview: number;
  score: number;
  maxScore: number;
  /** 0–100, two decimals. Score over the whole paper's maximum. */
  percentage: number;
  /** 0–100, two decimals. Correct over (correct + incorrect). */
  accuracy: number;
  perQuestion: QuestionResult[];
}

export const round2 = (value: number): number =>
  Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;

const positive = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Case-, space- and trailing-punctuation-insensitive comparison key. */
export function normalizeTextAnswer(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/u, '')
    .trim();
}

function isAttempted(response: ResponseInput | undefined): boolean {
  if (!response) return false;
  const chosen = String(response.chosenOptionId ?? '').trim();
  const text = String(response.textAnswer ?? '').trim();
  return chosen.length > 0 || text.length > 0;
}

type Kind = 'option' | 'integer' | 'text' | 'ungraded';

export function questionKind(question: QuestionKey): Kind {
  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length > 0 && options.some((o) => Boolean(o?.isCorrect))) return 'option';
  if (typeof question.integerAnswer === 'number' && Number.isFinite(question.integerAnswer)) return 'integer';
  if (options.length === 0 && String(question.correctAnswerText ?? '').trim()) return 'text';
  return 'ungraded';
}

/** Grade one response against one question. */
export function gradeResponse(
  question: QuestionKey,
  response: ResponseInput | undefined,
): { outcome: Outcome; awarded: number; attempted: boolean; gradable: boolean } {
  const max = positive(question.marks, 1);
  const negative = Math.max(0, Number(question.negativeMarks) || 0);
  const attempted = isAttempted(response);
  const kind = questionKind(question);

  if (kind === 'ungraded') {
    const manual = response?.manualMarks;
    if (typeof manual === 'number' && Number.isFinite(manual)) {
      const awarded = Math.max(0, Math.min(manual, max));
      // A reviewer's award counts as correct when it is any credit at all;
      // the marks themselves carry the partial-credit detail.
      return { outcome: awarded > 0 ? 'correct' : 'incorrect', awarded, attempted, gradable: true };
    }
    return { outcome: attempted ? 'ungraded' : 'skipped', awarded: 0, attempted, gradable: false };
  }

  if (!attempted) return { outcome: 'skipped', awarded: 0, attempted: false, gradable: true };

  let correct = false;
  if (kind === 'option') {
    const chosen = String(response?.chosenOptionId ?? '').trim();
    correct = (question.options || []).some((o) => Boolean(o?.isCorrect) && String(o.id) === chosen);
  } else if (kind === 'integer') {
    const raw = String(response?.textAnswer ?? response?.chosenOptionId ?? '').trim();
    const value = raw === '' ? NaN : Number(raw);
    correct = Number.isFinite(value) && Math.abs(value - Number(question.integerAnswer)) < 1e-9;
  } else {
    correct =
      normalizeTextAnswer(response?.textAnswer ?? response?.chosenOptionId) ===
      normalizeTextAnswer(question.correctAnswerText);
  }

  return correct
    ? { outcome: 'correct', awarded: max, attempted: true, gradable: true }
    : { outcome: 'incorrect', awarded: -negative, attempted: true, gradable: true };
}

/**
 * Score a whole paper.
 *
 * @param paper      the questions on the attempt, in the order the candidate saw them
 * @param responses  whatever was stored for the attempt; extra or duplicate
 *                   entries are ignored (the last one for a question wins)
 */
export function scorePaper(paper: QuestionKey[], responses: ResponseInput[]): ScoreSummary {
  const byQuestion = new Map<string, ResponseInput>();
  for (const response of responses || []) {
    const id = String(response?.questionId ?? '');
    if (id) byQuestion.set(id, response);
  }

  const perQuestion: QuestionResult[] = [];
  let score = 0;
  let maxScore = 0;

  (paper || []).forEach((question, index) => {
    const response = byQuestion.get(String(question.id));
    const graded = gradeResponse(question, response);
    const max = positive(question.marks, 1);
    if (graded.gradable) maxScore += max;
    score += graded.awarded;
    perQuestion.push({
      questionId: String(question.id),
      index: index + 1,
      outcome: graded.outcome,
      awarded: graded.awarded,
      max,
      attempted: graded.attempted,
      markedForReview: Boolean(response?.markedForReview),
      gradable: graded.gradable,
      subject: String(question.subject || 'General'),
      chapter: String(question.chapter || ''),
      topic: String(question.topic || ''),
      difficulty: String(question.difficulty || ''),
    });
  });

  const count = (o: Outcome) => perQuestion.filter((q) => q.outcome === o).length;
  const correct = count('correct');
  const incorrect = count('incorrect');
  score = Math.max(0, score);

  return {
    totalQuestions: perQuestion.length,
    attempted: perQuestion.filter((q) => q.attempted).length,
    correct,
    incorrect,
    skipped: count('skipped'),
    ungraded: count('ungraded'),
    markedForReview: perQuestion.filter((q) => q.markedForReview).length,
    score: round2(score),
    maxScore: round2(maxScore),
    percentage: maxScore > 0 ? round2((score / maxScore) * 100) : 0,
    accuracy: correct + incorrect > 0 ? round2((correct / (correct + incorrect)) * 100) : 0,
    perQuestion,
  };
}
