import User from '../models/User';
import {
  buildClassVariants,
  isClassToken,
  normalizeBatchList,
  stripBatchWildcards,
} from '../utils/audienceTargeting';
import { INSTITUTE_ACCOUNT_CLAUSE } from '../utils/instituteAudience';

// ── Online Exam audience resolution ─────────────────────────────────────────
// Single source of truth for "which students does this exam target", used to
// pick notification recipients. Deliberately kept separate from delivery
// (notificationService) so the targeting rules can be reasoned about — and
// later tested — on their own.
//
// The rules below intentionally MIRROR the visibility query in
// `attemptService.listAssignedExams`. That is the whole point: a student who
// gets a "New Exam Assigned" notification must be a student who can actually
// open the exam, and vice versa. If one side changes, change the other.

/** Minimal shape needed to target an exam — matches the saved Exam document. */
export interface ExamAudienceSource {
  classLevel?: string;
  batch?: string;
  assignedTo?: {
    users?: unknown[];
    groups?: string[];
  };
}

/** Canonical string form of an id, so the same user can never dedupe as two. */
const toIdString = (value: unknown): string => {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  // ObjectId | populated doc | anything with a sane toString
  if (
    typeof value === 'object' &&
    '_id' in (value as Record<string, unknown>)
  ) {
    return String((value as Record<string, unknown>)._id).trim();
  }
  return String(value).trim();
};

const dedupe = (ids: string[]): string[] =>
  Array.from(new Set(ids.filter(Boolean)));

/**
 * Resolve the student ids an exam targets.
 *
 * Resolution order:
 *  1. Individually-targeted exam (`assignedTo.users` non-empty) — those users
 *     ONLY. This mirrors `listAssignedExams`, which excludes the class/batch
 *     branch entirely for such exams so an individually-assigned exam does not
 *     leak to the whole class. Notifying the class here would tell students
 *     about an exam they cannot open.
 *  2. Otherwise class + batch:
 *     - class scope  = exam.classLevel ∪ class-shaped tokens in assignedTo.groups
 *     - batch scope  = batch-shaped tokens in assignedTo.groups ∪ exam.batch,
 *                      minus "All Batches" wildcards
 *     - a batch scope is applied ONLY when it is non-empty, so a class with no
 *       batches (Class 6) still resolves to the whole class instead of nothing.
 *
 * Results are deduplicated by user id, so overlapping representations
 * ("11" and "Class 11") or overlapping rules can never yield two notifications.
 */
export async function resolveExamNotificationRecipients(
  exam: ExamAudienceSource,
): Promise<string[]> {
  const explicitUsers = dedupe((exam.assignedTo?.users || []).map(toIdString));

  // 1. Individually targeted — exclusive, per the visibility rules.
  if (explicitUsers.length > 0) return explicitUsers;

  const groups = Array.isArray(exam.assignedTo?.groups)
    ? exam.assignedTo!.groups!
    : [];

  // 2a. Class scope. `exam.classLevel` is the authoritative field (the mobile
  // wizard sends an empty `groups` when a batch is picked, relying purely on
  // classLevel+batch), with group class-tokens folded in for callers that only
  // express the audience through groups.
  const classSource = [exam.classLevel, ...groups.filter(isClassToken)];
  const classScope = buildClassVariants(classSource);
  if (classScope.length === 0) return [];

  const query: Record<string, unknown> = {
    role: 'student',
    ...INSTITUTE_ACCOUNT_CLAUSE,
    classLevel: { $in: classScope },
  };

  // 2b. Batch scope. Only real batch names narrow the audience — a wildcard or
  // an absent batch means "every batch in this class".
  const batchScope = stripBatchWildcards(
    normalizeBatchList([...groups.filter((g) => !isClassToken(g)), exam.batch]),
  );
  if (batchScope.length > 0) {
    query.batch = { $in: batchScope };
  }

  const students = await User.find(query).select('_id').lean();
  return dedupe(students.map((s) => toIdString(s._id)));
}
