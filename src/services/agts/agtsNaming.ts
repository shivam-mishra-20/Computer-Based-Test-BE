/**
 * What an AGTS paper is called in front of a family — pure, no database.
 *
 * The class-wise papers already in production were created in the test
 * builder before the rename, so they are stored as "Scholarship Test" /
 * "Scholarship-cum-Admission Test". Those records are a read-only source
 * (the owner's instruction, 2026-09-28): they are never renamed in the
 * database. Instead every public surface names a paper from its own facts —
 * class, question count and duration — which also tells two papers for the
 * same class apart. A paper created later under its own name keeps that name.
 */

const LEGACY_NAME = /scholarship/i;

export interface NamingInput {
  testName?: string | null;
  classes?: number[];
  questionCount?: number;
  durationMins?: number;
}

export function agtsDisplayName(input: NamingInput): string {
  const stored = String(input.testName || '').trim();
  if (stored && !LEGACY_NAME.test(stored)) return stored;
  const classes = (input.classes || []).filter((c) => Number.isFinite(c));
  return [
    'AGTS',
    classes.length ? `Class ${classes.join(' & ')}` : '',
    input.questionCount ? `${input.questionCount} questions` : '',
    input.durationMins ? `${input.durationMins} min` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A stored description is shown only when it is not the retired scholarship copy. */
export function agtsPublicDescription(description?: string | null): string {
  const text = String(description || '').trim();
  return text && !LEGACY_NAME.test(text) ? text : '';
}

/** The display name for an attempt, from what the attempt itself recorded. */
export function attemptDisplayName(attempt: {
  scholarshipTestName?: string;
  classLevel?: number;
  questions?: unknown[];
  durationMins?: number;
}): string {
  return agtsDisplayName({
    testName: attempt.scholarshipTestName,
    classes: attempt.classLevel ? [attempt.classLevel] : [],
    questionCount: Array.isArray(attempt.questions) ? attempt.questions.length : 0,
    durationMins: attempt.durationMins,
  });
}
