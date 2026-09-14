/**
 * Which EXISTING batch a transcribed timetable row belongs to.
 *
 * ── The rule this module exists to enforce ──────────────────────────────────
 * A photograph is not a batch registry. The row label "11th jee even" tells us
 * the CLASS is 11; it does not tell us that a batch called "jee even" exists,
 * and it must never cause one to. Batch identity comes from the organization's
 * own `Batch` documents — the same records the student forms, the schedule
 * pickers and the student/batch assignment already use.
 *
 * The importer previously did this:
 *
 *     const { matched } = matchBatchLabel(batchRaw, batchCandidates);
 *     ...
 *     batch: matched || batchRaw          // <- the photograph wins
 *
 * Two separate faults in one line. `matchBatchLabel` is a fuzzy token-overlap
 * matcher, so "jee even" shares the token "jee" with BOTH "JEE Morning" and
 * "JEE Evening" and it picked whichever it scored first — a coin flip written
 * into a real schedule. And when nothing matched at all, the raw image text was
 * stored as the batch, inventing a batch identity out of OCR output.
 *
 * ── What replaces it ────────────────────────────────────────────────────────
 * The organization's class -> batch map (`getStudentBatchConfigFromDatabase`,
 * already the authority everywhere else) is the only source of batch names.
 * The image contributes a HINT and nothing more. A hint is accepted only when
 * the application's own matcher — `matchBatchName`, exact or case-insensitive,
 * the same function the student forms use — identifies exactly one existing
 * batch. Anything looser is a guess, and a guess here silently puts a class in
 * front of the wrong students.
 *
 * When it cannot be decided, it is not decided: the entry keeps its schedule
 * (teacher, room, time, raw text) and carries the list of existing batches for
 * the admin to choose from. Nothing is written until that choice is explicit.
 */

import { matchBatchName } from '../batchConfigService';

export type BatchResolutionStatus =
  /** The class has exactly one existing batch, so there is nothing to decide. */
  | 'resolved-single'
  /** The row's hint names exactly one existing batch, by the app's own matcher. */
  | 'resolved-hint'
  /** Several existing batches are possible. The admin must choose. */
  | 'needs-selection'
  /** The class legitimately has no batches configured; batch does not apply. */
  | 'no-batches'
  /** No class could be read from the row label, so batches cannot be looked up. */
  | 'unknown-class'
  /** No organization context — the real batch list cannot be loaded at all. */
  | 'no-org-context';

export interface BatchResolution {
  status: BatchResolutionStatus;
  /**
   * An EXISTING batch name, or ''. Never the image's text.
   *
   * The invariant the tests pin: if this is non-empty it appears verbatim in
   * `availableBatches`.
   */
  batch: string;
  /** Every existing batch for this class, as the organization has them. */
  availableBatches: string[];
  /** The leftover row text ("jee even"). Diagnostic only — never a batch name. */
  hint: string;
  /**
   * Existing batches the hint might be referring to, for the admin's
   * convenience. Suggestions, not a decision: when this has entries and the
   * status is `needs-selection`, the system is explicitly declining to choose.
   */
  suggestions: string[];
}

/** The class -> batch-names map as `getStudentBatchConfigFromDatabase` returns it. */
export type BatchRules = Record<string, string[]>;

function norm(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Existing batches a hint could plausibly mean.
 *
 * Token overlap, deliberately GENEROUS, because this list is only ever shown to
 * a person. It orders the dropdown; it never fills it in. The moment something
 * like this decides, "jee even" starts landing in "JEE Morning".
 */
export function suggestExistingBatches(
  hint: string,
  available: string[],
): string[] {
  const tokens = norm(hint).split(' ').filter(Boolean);
  if (!tokens.length) return [];

  return available
    .map((name) => {
      const nameTokens = new Set(norm(name).split(' ').filter(Boolean));
      const overlap = tokens.filter((t) => nameTokens.has(t)).length;
      // A prefix relation catches the common abbreviation ("comm" -> "Commerce",
      // "even" -> "Evening") without pretending to have resolved it.
      const prefix = tokens.filter((t) =>
        [...nameTokens].some((n) => n.startsWith(t) || t.startsWith(n)),
      ).length;
      return { name, score: overlap * 2 + prefix };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((c) => c.name);
}

export interface ResolveBatchInput {
  /** Normalized class level read from the row label ("9", "11"), or ''. */
  classLevel: string;
  /** The leftover row text after the class, e.g. "jee even". May be ''. */
  hint: string;
  /**
   * The organization's real class -> batches map, or null when there is no
   * organization context to load it from.
   */
  batchRules: BatchRules | null;
}

/**
 * Decide the batch, or decline to.
 *
 * Deterministic and pure — no database, no model, no randomness. Every branch
 * either returns an existing batch name or returns '' with a status saying why.
 */
export function resolveBatchForClass(
  input: ResolveBatchInput,
): BatchResolution {
  const hint = String(input.hint || '').trim();

  // Without the organization's data there is no authority to consult. The
  // schedule is still extracted; only the batch is left open.
  if (!input.batchRules) {
    return {
      status: 'no-org-context',
      batch: '',
      availableBatches: [],
      hint,
      suggestions: [],
    };
  }

  const classLevel = String(input.classLevel || '').trim();
  if (!classLevel) {
    return {
      status: 'unknown-class',
      batch: '',
      availableBatches: [],
      hint,
      suggestions: [],
    };
  }

  const available = Array.isArray(input.batchRules[classLevel])
    ? input.batchRules[classLevel]
    : [];

  if (available.length === 0) {
    return {
      status: 'no-batches',
      batch: '',
      availableBatches: [],
      hint,
      suggestions: [],
    };
  }

  // The application's OWN matcher, not a schedule-specific one: exact, then
  // case-insensitive. If the institute's batch really is called "JEE Even",
  // "jee even" resolves here and nowhere else.
  const exact = matchBatchName(hint, available);
  if (exact) {
    return {
      status: 'resolved-hint',
      batch: exact,
      availableBatches: available,
      hint,
      suggestions: [],
    };
  }

  const suggestions = suggestExistingBatches(hint, available);

  // One batch for the class is not a guess — there is no other answer it could
  // have. This is the existing unambiguous rule, applied automatically.
  if (available.length === 1) {
    return {
      status: 'resolved-single',
      batch: available[0],
      availableBatches: available,
      hint,
      suggestions: [],
    };
  }

  return {
    status: 'needs-selection',
    batch: '',
    availableBatches: available,
    hint,
    suggestions,
  };
}

/** True when the entry is ready to be written as far as batch identity goes. */
export function batchResolved(status: BatchResolutionStatus): boolean {
  return (
    status === 'resolved-single' ||
    status === 'resolved-hint' ||
    status === 'no-batches'
  );
}

export interface BatchCheckIssue {
  tempId?: string;
  field: string;
  severity: 'error';
  message: string;
  rule: string;
}

/**
 * The save-time gate: no entry may name a batch the organization does not have.
 *
 * The review screen already refuses to submit an unresolved entry, but a client
 * check is a convenience, not a control — `/api/schedule/bulk` accepts whatever
 * JSON it is posted. This is what actually makes "the image is not the batch
 * master" true: text that never matched an existing batch cannot reach the
 * database through this endpoint, whatever the caller sends.
 */
export function checkEntryBatches(
  entries: Array<{ tempId?: string; classLevel?: unknown; batch?: unknown }>,
  batchRules: BatchRules,
): BatchCheckIssue[] {
  const issues: BatchCheckIssue[] = [];

  entries.forEach((entry) => {
    const classLevel = String(entry?.classLevel ?? '').trim();
    const batch = String(entry?.batch ?? '').trim();
    const available = Array.isArray(batchRules[classLevel])
      ? batchRules[classLevel]
      : [];

    if (!batch) {
      // Only an omission when the class actually has batches to choose from.
      if (available.length > 0) {
        issues.push({
          tempId: entry?.tempId,
          field: 'batch',
          severity: 'error',
          rule: 'batchSelectionRequired',
          message:
            `Class ${classLevel || '?'} has ${available.length} batches ` +
            `(${available.join(', ')}). Choose which one this class is for before saving.`,
        });
      }
      return;
    }

    if (!matchBatchName(batch, available)) {
      issues.push({
        tempId: entry?.tempId,
        field: 'batch',
        severity: 'error',
        rule: 'batchMustExist',
        message: available.length
          ? `"${batch}" is not a batch for class ${classLevel || '?'}. Existing batches: ${available.join(', ')}.`
          : `Class ${classLevel || '?'} has no batches configured, so "${batch}" cannot be assigned.`,
      });
    }
  });

  return issues;
}
