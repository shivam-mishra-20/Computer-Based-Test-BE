import { IExam } from '../models/Exam';

interface AttemptTimingSource {
  startedAt?: Date;
}

interface DurationSource {
  totalDurationMins?: number;
}

// Shared deadline math for saveAnswer/submitAttempt/getAttemptView — previously
// duplicated (startedAt + totalDurationMins) independently in each function.
export function getDeadline(attempt: AttemptTimingSource, durationSource: DurationSource): Date | null {
  if (!attempt.startedAt || !durationSource.totalDurationMins) return null;
  return new Date(attempt.startedAt.getTime() + durationSource.totalDurationMins * 60 * 1000);
}

export function isPastDeadline(attempt: AttemptTimingSource, durationSource: DurationSource, now: Date = new Date()): boolean {
  const deadline = getDeadline(attempt, durationSource);
  return !!deadline && now > deadline;
}

// Earliest time a student may VOLUNTARILY submit (auto-submits bypass this
// entirely). Defaults to 50% of the exam duration if the exam doesn't set an
// explicit submitLockPercent.
export function getSubmitUnlockAt(
  attempt: AttemptTimingSource,
  exam: Pick<IExam, 'totalDurationMins' | 'submitLockPercent'>
): Date | null {
  if (!attempt.startedAt || !exam.totalDurationMins) return null;
  const pct = typeof exam.submitLockPercent === 'number' ? exam.submitLockPercent : 50;
  const unlockMs = exam.totalDurationMins * 60 * 1000 * (pct / 100);
  return new Date(attempt.startedAt.getTime() + unlockMs);
}

// Cutoff for STARTING a new attempt: schedule.startAt + lateEntryMins, capped at
// schedule.endAt. Only gates new starts — an attempt already in progress keeps
// running off its own startedAt + totalDurationMins deadline regardless of this.
// Unset lateEntryMins => students may start any time up to schedule.endAt.
export function getStartCutoff(exam: Pick<IExam, 'schedule' | 'lateEntryMins'>): Date | null {
  const startAt = exam.schedule?.startAt;
  const endAt = exam.schedule?.endAt;
  if (!startAt || !endAt) return null;
  if (typeof exam.lateEntryMins !== 'number') return endAt;
  const graceCutoff = new Date(startAt.getTime() + exam.lateEntryMins * 60 * 1000);
  return graceCutoff < endAt ? graceCutoff : endAt;
}

export type ExamStatus = 'draft' | 'scheduled' | 'live' | 'completed';

// Single source of truth for an exam's lifecycle state — attached server-side
// to every exam the API returns so web/mobile/admin never re-derive it
// independently (and disagree). A legacy exam with isPublished:true but no
// schedule is 'live' (unrestricted), matching getStartWindowState's treatment
// of a missing schedule as unrestricted access.
export function deriveExamStatus(exam: Pick<IExam, 'isPublished' | 'schedule'>, now: Date = new Date()): ExamStatus {
  if (!exam.isPublished) return 'draft';
  const startAt = exam.schedule?.startAt;
  const endAt = exam.schedule?.endAt;
  if (startAt && now < startAt) return 'scheduled';
  if (endAt && now > endAt) return 'completed';
  return 'live';
}

export type StartWindowState = 'not-started' | 'active' | 'closed';

// Only meaningful when the exam actually has schedule.startAt/endAt set — legacy
// exams without a schedule are unrestricted ('active') for this check.
export function getStartWindowState(
  exam: Pick<IExam, 'schedule' | 'lateEntryMins'>,
  now: Date = new Date()
): StartWindowState {
  const startAt = exam.schedule?.startAt;
  const endAt = exam.schedule?.endAt;
  if (!startAt || !endAt) return 'active';
  if (now < startAt) return 'not-started';
  const cutoff = getStartCutoff(exam) as Date;
  if (now > cutoff) return 'closed';
  return 'active';
}
