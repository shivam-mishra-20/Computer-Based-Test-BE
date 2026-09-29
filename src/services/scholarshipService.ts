import ScholarshipAttempt from '../models/ScholarshipAttempt';
import ScholarshipTest from '../models/ScholarshipTest';
import { getClassQuestionModel } from '../models/ClassQuestion';
import { Types } from 'mongoose';
import { randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { scorePaper, questionKind, type QuestionKey, type ResponseInput } from './assessment/assessmentScoring';

/**
 * The question bank this engine draws from. Questions were tagged
 * `board: "Scholarship"` before the test was renamed AGTS; both tags are
 * accepted so the existing bank keeps working and new questions can be tagged
 * "AGTS" without a data migration.
 */
export const ASSESSMENT_BOARD_PATTERN = /scholarship|agts/i;
const SCHOLARSHIP_BOARD_PATTERN = ASSESSMENT_BOARD_PATTERN;

/** Answers arriving this long after the timer ended are still accepted (network lag). */
export const SUBMIT_GRACE_MS = Math.max(0, Number(process.env.AGTS_SUBMIT_GRACE_SEC || 90)) * 1000;

/** When the candidate's time ends, from the server's own clock and record. */
export function attemptDeadline(attempt: { startedAt?: Date | string; durationMins?: number }): number {
  const started = attempt?.startedAt ? new Date(attempt.startedAt).getTime() : Date.now();
  return started + Math.max(1, Number(attempt?.durationMins) || 60) * 60 * 1000;
}

/** True once the timer AND the grace window have both passed. */
export function isPastDeadline(attempt: { startedAt?: Date | string; durationMins?: number }, now = Date.now()): boolean {
  return now > attemptDeadline(attempt) + SUBMIT_GRACE_MS;
}

function normalizePhone(phone: string): { raw: string; normalized: string } {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D+/g, '');

  // Common cases: 10-digit local number, or +91/91 prefix.
  let normalized = digits;
  if (normalized.length > 10) {
    normalized = normalized.slice(-10);
  }

  return { raw, normalized };
}

function generateAttemptAccessKey(): string {
  // 48 hex chars (~192 bits). Stored server-side; client keeps it in localStorage.
  return randomBytes(24).toString('hex');
}

function generateResultPublicToken(): string {
  // 40 hex chars (~160 bits), safe for public share links.
  return randomBytes(20).toString('hex');
}

/**
 * The per-attempt key is the only thing that authorises a guest to read or
 * change an attempt.
 *
 * An attempt with NO stored key (created before keys existed) is refused
 * outright. It used to be served — and issued a fresh key — to anyone who
 * named its id, and those ids (`SCH-<class>-<ddmmyy>-<4 chars>`) are guessable,
 * which exposed the candidate's name and phone number. Such results remain
 * reachable through the admin-issued public result link.
 */
export function hasValidAttemptAccess(attempt: any, providedKey?: string): boolean {
  const stored = String(attempt?.attemptAccessKey || '');
  const given = String(providedKey || '');
  if (!stored || !given || stored.length !== given.length) return false;
  return timingSafeEqual(Buffer.from(stored), Buffer.from(given));
}

function requireValidAttemptAccess(attempt: any, providedKey?: string) {
  if (!hasValidAttemptAccess(attempt, providedKey)) {
    throw new Error('Unauthorized attempt access');
  }
}

export function expandSubjectAliases(subject: string): string[] {
  const s = (subject || '').trim();
  if (!s) return [];

  const lower = s.toLowerCase();
  if (lower === 'math' || lower === 'mathematics') {
    return ['Math', 'Mathematics'];
  }
  if (lower === 'science') {
    return ['Science'];
  }
  if (lower === 'english') {
    return ['English'];
  }
  if (lower === 'history') {
    return ['History'];
  }

  return [s];
}

function normalizeSubjectName(subject: any): string | null {
  const raw = typeof subject === 'string'
    ? subject
    : typeof subject?.name === 'string'
      ? subject.name
      : typeof subject?.label === 'string'
        ? subject.label
        : typeof subject?.value === 'string'
          ? subject.value
          : '';

  const value = (raw || '').trim();
  if (!value) return null;

  const lower = value.toLowerCase();
  if (lower.includes('math')) return 'Math';
  if (lower.includes('science') || lower === 'sci') return 'Science';
  if (lower.includes('english') || lower === 'eng') return 'English';
  if (lower.includes('history') || lower.includes('social')) return 'History';

  return null;
}

export function normalizeSubjects(input: any[]): string[] {
  if (!Array.isArray(input)) return [];

  const canonical = input
    .map((s) => normalizeSubjectName(s))
    .filter((s): s is string => Boolean(s));

  return Array.from(new Set(canonical));
}

// Generate unique attempt ID. Legacy attempts keep the SCH- form; AGTS attempts
// are AGTS- with a longer, crypto-random tail. The id is not a credential (the
// attempt key is), but it should not be guessable either.
function generateAttemptId(classLevel: number, prefix: 'SCH' | 'AGTS' = 'SCH'): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const length = prefix === 'AGTS' ? 8 : 4;
  let randomStr = '';

  for (let i = 0; i < length; i++) {
    randomStr += chars.charAt(randomInt(0, chars.length));
  }

  return `${prefix}-${classLevel}-${dd}${mm}${yy}-${randomStr}`;
}

function isLegacyRandomShareLink(value?: string): boolean {
  if (!value) return false;

  if (/^SCH-LINK-/i.test(value)) return true;

  // Logical slugs are lowercase words joined by hyphens.
  return !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function slugify(value: string): string {
  return (value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolveFrontendBaseUrl(): string {
  const configured =
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_FRONTEND_URL ||
    process.env.CLIENT_URL;

  const fallback = process.env.NODE_ENV === 'production'
    ? 'https://abhigyangurukul.com'
    : 'http://localhost:5173';

  return (configured || fallback).replace(/\/$/, '');
}

async function generateLogicalShareLink(testName: string, eligibleClasses: number[]): Promise<string> {
  const classPart = (eligibleClasses || []).slice().sort((a, b) => a - b).join('-');
  const base = `${slugify(testName || 'agts-test') || 'agts-test'}${classPart ? `-class-${classPart}` : ''}`;
  let candidate = base;
  let index = 2;

  while (await ScholarshipTest.findOne({ shareLink: candidate }).lean()) {
    candidate = `${base}-${index}`;
    index += 1;
  }

  return candidate;
}

async function ensureLogicalShareLink(test: any): Promise<string> {
  if (test?.shareLink && !isLegacyRandomShareLink(test.shareLink)) {
    return test.shareLink;
  }

  const generated = await generateLogicalShareLink(test?.testName || 'agts-test', test?.eligibleClasses || []);
  await ScholarshipTest.updateOne({ _id: test._id }, { shareLink: generated });
  return generated;
}

// Get random questions from a pool
function shuffleInPlace<T>(arr: T[]): T[] {
  // Fisher-Yates with crypto randomness (more reliable than Math.random + sort).
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickRandomUniqueIds(
  docs: Array<{ _id?: any }> | undefined,
  count: number,
  alreadyUsed?: Set<string>
): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const doc of docs || []) {
    const id = doc?._id ? String(doc._id) : '';
    if (!id) continue;
    if (seen.has(id)) continue;
    if (alreadyUsed && alreadyUsed.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }

  shuffleInPlace(unique);
  return unique.slice(0, Math.min(count, unique.length));
}

function pickRandomUniqueDocs<T extends { _id?: any }>(
  docs: T[] | undefined,
  count: number,
  alreadyUsed?: Set<string>
): T[] {
  const unique: T[] = [];
  const seen = new Set<string>();

  for (const doc of docs || []) {
    const id = doc?._id ? String(doc._id) : '';
    if (!id) continue;
    if (seen.has(id)) continue;
    if (alreadyUsed && alreadyUsed.has(id)) continue;
    seen.add(id);
    unique.push(doc);
  }

  shuffleInPlace(unique);
  return unique.slice(0, Math.min(count, unique.length));
}

type NormalizedAnswer = {
  questionId: string;
  chosenOptionId?: string;
  textAnswer?: string;
  isCorrect?: boolean;
  marks?: number;
  markedForReview?: boolean;
};

function normalizeSingleAnswer(questionId: string, answer: any): NormalizedAnswer | null {
  if (!questionId) return null;

  if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
    // Picked, never spread: the client chooses an option or types an answer.
    // `isCorrect` and `marks` are the grader's to write; spreading the body
    // here used to let a request set them.
    const picked: NormalizedAnswer = { questionId };
    if (typeof answer.chosenOptionId === 'string') picked.chosenOptionId = answer.chosenOptionId.slice(0, 64);
    if (typeof answer.textAnswer === 'string' || typeof answer.textAnswer === 'number') {
      picked.textAnswer = String(answer.textAnswer).slice(0, 500);
    }
    if (typeof answer.markedForReview === 'boolean') picked.markedForReview = answer.markedForReview;
    return picked;
  }

  if (typeof answer === 'string') {
    const value = answer.slice(0, 500);
    return {
      questionId,
      // For MCQ answers, frontend sends selected option id as a string.
      chosenOptionId: value,
      // For short-answer questions, frontend may send text as a string.
      textAnswer: value,
    };
  }

  if (answer !== undefined && answer !== null) {
    return {
      questionId,
      textAnswer: String(answer).slice(0, 500),
    };
  }

  return null;
}

function normalizeSubmittedAnswers(answers: any): NormalizedAnswer[] {
  if (Array.isArray(answers)) {
    return answers
      .map((answer: any) => {
        const qid = typeof answer?.questionId === 'string' ? answer.questionId : '';
        return normalizeSingleAnswer(qid, answer);
      })
      .filter((answer): answer is NormalizedAnswer => Boolean(answer));
  }

  if (answers && typeof answers === 'object') {
    return Object.entries(answers)
      .map(([questionId, value]) => normalizeSingleAnswer(questionId, value))
      .filter((answer): answer is NormalizedAnswer => Boolean(answer));
  }

  return [];
}

const sameName = (a: unknown, b: unknown) =>
  String(a || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() ===
  String(b || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * What to tell a caller who registered with a phone number that already has an
 * attempt for this test.
 *
 * The phone number is typed, not verified, so it cannot on its own hand out
 * an attempt's key:
 *  - a SUBMITTED attempt is reported as locked and its key is withheld — the
 *    owner already holds it; anyone else would be reading a stranger's result;
 *  - an IN-PROGRESS attempt resumes only when the student name matches too,
 *    so a guessed number cannot take over someone else's running test.
 */
function existingAttemptResponse(existing: any, requestName: string) {
  const locked = existing.status === 'submitted' || isPastDeadline(existing);
  const resumable = !locked && sameName(existing.name, requestName);
  return {
    attemptId: existing.attemptId,
    _id: existing._id,
    startedAt: existing.startedAt,
    durationMins: existing.durationMins,
    status: existing.status,
    attemptAccessKey: resumable ? existing.attemptAccessKey || '' : '',
    created: false,
    resumed: resumable,
    locked,
    conflict: !locked && !resumable,
    message: locked
      ? 'This phone number has already taken this test. Retake is not allowed.'
      : resumable
        ? 'Resuming your previous attempt.'
        : 'A test is already in progress for this phone number on another device.',
  };
}

export interface AttemptExtras {
  program?: 'agts';
  leadId?: Types.ObjectId;
}

export async function createScholarshipAttempt(
  name: string,
  phone: string,
  classLevel: number | undefined,
  testId?: string,
  extras: AttemptExtras = {}
) {
  const safeName = String(name || '').trim();
  const { raw: rawPhone, normalized: phoneNormalized } = normalizePhone(phone);
  const phoneTailRegex = new RegExp(`${phoneNormalized}$`);

  if (!safeName) {
    throw new Error('Name is required');
  }

  if (!rawPhone || phoneNormalized.length < 10) {
    throw new Error('Valid phone number is required');
  }

  // Generate unique attempt ID
  let subjects = ['Mathematics', 'Science'];
  let questionsPerSubject = 15;
  let durationMins = 60;
  let scholarshipTestId = '';
  let scholarshipTestName = '';
  let scholarshipShareLink = '';

  let resolvedClassLevel: number | undefined =
    classLevel !== undefined && classLevel !== null ? Number(classLevel) : undefined;

  if (testId) {
    const test = Types.ObjectId.isValid(testId)
      ? await ScholarshipTest.findById(testId).lean()
      : await ScholarshipTest.findOne({ shareLink: testId }).lean();

    if (!test || !test.isActive) {
      throw new Error('Selected test is not available');
    }

    // If the test is for exactly one class, we can infer the class from the test.
    if ((test.eligibleClasses || []).length === 1) {
      resolvedClassLevel = Number(test.eligibleClasses[0]);
    }

    if (!resolvedClassLevel || !Number.isFinite(resolvedClassLevel)) {
      throw new Error('classLevel is required for this test');
    }

    if (!test.eligibleClasses.includes(resolvedClassLevel)) {
      throw new Error(`Class ${resolvedClassLevel} is not eligible for this test`);
    }

    const normalizedSubjects = normalizeSubjects(test.subjects || []);
    if (normalizedSubjects.length === 0) {
      throw new Error('Selected test has no valid subjects configured');
    }

    subjects = normalizedSubjects;
    questionsPerSubject = test.questionsPerSubject || 15;
    durationMins = test.durationMins || 60;
    scholarshipTestId = test._id.toString();
    scholarshipTestName = test.testName || '';
    scholarshipShareLink = test.shareLink || '';

    // Enforce: one attempt per phone per test.
    const existing = await ScholarshipAttempt.findOne({
      scholarshipTestId,
      $or: [
        { phoneNormalized },
        { phone: rawPhone },
        { phone: phoneNormalized },
        // Legacy records sometimes stored +91/spacing in `phone`.
        // Matching last 10 digits is a practical, reliable fallback.
        { phone: { $regex: phoneTailRegex } },
      ],
    }).lean();

    if (existing) {
      // Backfill an access key for pre-key attempts, but only hand it out
      // through the same resume rules as any other attempt.
      if (!existing.attemptAccessKey && existing.status !== 'submitted') {
        const key = generateAttemptAccessKey();
        await ScholarshipAttempt.updateOne({ _id: existing._id }, { attemptAccessKey: key });
        (existing as any).attemptAccessKey = key;
      }
      return existingAttemptResponse(existing, safeName);
    }
  }

  if (!resolvedClassLevel || resolvedClassLevel < 7 || resolvedClassLevel > 12) {
    throw new Error('ClassLevel must be between 7 and 12');
  }

  // Generate unique attempt ID (depends on classLevel)
  const idPrefix = extras.program === 'agts' ? 'AGTS' : 'SCH';
  let attemptId = generateAttemptId(resolvedClassLevel, idPrefix);
  let exists = await ScholarshipAttempt.findOne({ attemptId });

  while (exists) {
    attemptId = generateAttemptId(resolvedClassLevel, idPrefix);
    exists = await ScholarshipAttempt.findOne({ attemptId });
  }

  const ClassQuestionModel = getClassQuestionModel(`Class ${resolvedClassLevel}`);

  const subjectQuestions: Record<string, string[]> = {};
  const allQuestionIds: string[] = [];
  const usedQuestionIds = new Set<string>();

  for (const subject of subjects) {
    const subjectPool = expandSubjectAliases(subject);
    const questions = await ClassQuestionModel.find({
      subject: { $in: subjectPool },
      board: SCHOLARSHIP_BOARD_PATTERN,
      isActive: true,
    })
      .select('_id')
      .limit(questionsPerSubject * 6)
      .lean();

    if (questions.length < questionsPerSubject) {
      throw new Error(
        `Questions for Class ${resolvedClassLevel} - ${subject} are not available yet. ` +
          `Required: ${questionsPerSubject}, Found: ${questions.length}`
      );
    }

    const questionIds = pickRandomUniqueIds(questions as any, questionsPerSubject, usedQuestionIds);
    if (questionIds.length < questionsPerSubject) {
      throw new Error(
        `Unique questions for Class ${resolvedClassLevel} - ${subject} are not available yet. ` +
          `Required: ${questionsPerSubject}, Available unique (after de-duplication): ${questionIds.length}`
      );
    }

    questionIds.forEach((id) => usedQuestionIds.add(id));

    subjectQuestions[subject] = questionIds;
    allQuestionIds.push(...questionIds);
  }

  // Shuffle final question order for the actual attempt.
  shuffleInPlace(allQuestionIds);

  try {
    const attemptAccessKey = generateAttemptAccessKey();
    const attempt = await ScholarshipAttempt.create({
      attemptId,
      name: safeName,
      phone: rawPhone,
      phoneNormalized,
      attemptAccessKey,
      scholarshipTestId,
      scholarshipTestName,
      scholarshipShareLink,
      classLevel: resolvedClassLevel,
      durationMins,
      questions: allQuestionIds,
      subjectQuestions,
      status: 'in-progress',
      ...(extras.program ? { program: extras.program } : {}),
      ...(extras.leadId ? { leadId: extras.leadId } : {}),
    });

    return {
      attemptId: attempt.attemptId,
      _id: attempt._id,
      startedAt: attempt.startedAt,
      durationMins: attempt.durationMins,
      status: attempt.status,
      attemptAccessKey: attempt.attemptAccessKey || '',
      created: true,
      resumed: false,
      locked: false,
    };
  } catch (err: any) {
    // In case of race-condition duplicates, return the existing attempt.
    if (err?.code === 11000 && scholarshipTestId) {
      const existing = await ScholarshipAttempt.findOne({
        scholarshipTestId,
        $or: [
          { phoneNormalized },
          { phone: rawPhone },
          { phone: phoneNormalized },
          { phone: { $regex: phoneTailRegex } },
        ],
      }).lean();

      if (existing) {
        return existingAttemptResponse(existing, safeName);
      }
    }
    throw err;
  }
}

/**
 * The server's answer key for an attempt's paper, in the order the candidate
 * saw it. Shared by grading and by the AGTS report so both read one key.
 */
export async function loadAttemptPaper(attempt: { classLevel: number; questions: string[] }) {
  const ClassQuestionModel = getClassQuestionModel(`Class ${attempt.classLevel}`);
  const ids = (attempt.questions || []).filter((id) => Types.ObjectId.isValid(String(id)));
  const docs = await ClassQuestionModel.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }).lean();
  const byId = new Map(docs.map((q: any) => [String(q._id), q]));
  const ordered = ids.map((id) => byId.get(String(id))).filter(Boolean) as any[];
  const keys: QuestionKey[] = ordered.map((q: any) => ({
    id: String(q._id),
    type: q.type,
    marks: Number(q.marks) > 0 ? Number(q.marks) : 1,
    options: Array.isArray(q.options) ? q.options.map((o: any) => ({ id: String(o?._id || ''), isCorrect: Boolean(o?.isCorrect) })) : [],
    correctAnswerText: q.correctAnswerText || '',
    integerAnswer: typeof q.integerAnswer === 'number' ? q.integerAnswer : null,
    subject: q.subject,
    chapter: q.chapter,
    topic: q.topic,
    difficulty: q.difficulty,
  }));
  return { docs: ordered, keys };
}

/** Stored answers as scorer input. Reviewer marks count only where the engine cannot grade. */
export function responsesOf(attempt: any, keys: QuestionKey[]): ResponseInput[] {
  const reviewed = Boolean(attempt?.adminReview?.isReviewed);
  const kindById = new Map(keys.map((k) => [k.id, questionKind(k)]));
  return (attempt?.answers || []).map((a: any) => ({
    questionId: String(a?.questionId || ''),
    chosenOptionId: a?.chosenOptionId || '',
    textAnswer: a?.textAnswer || '',
    markedForReview: Boolean(a?.markedForReview),
    manualMarks:
      reviewed && kindById.get(String(a?.questionId || '')) === 'ungraded' && typeof a?.marks === 'number' ? a.marks : null,
  }));
}

function buildAttemptView(attempt: any, questions: any[], opts: { includeKey: boolean }) {
  // AGTS results are the server's report (agtsService), never an answer key:
  // publishing an AGTS attempt must not reveal the bank's solutions.
  const isAgts = attempt.program === 'agts';
  const includePublishedSolutions = Boolean(attempt.resultPublished) && !isAgts;
  const questionDetails = questions.map((q: any) => {
    const options = Array.isArray(q.options)
      ? q.options.map((opt: any) => ({
          _id: opt?._id ? String(opt._id) : '',
          text: opt?.text || '',
        }))
      : [];

    const baseQuestion: any = {
      _id: q._id.toString(),
      text: q.text,
      type: q.type || 'mcq',
      // SECURITY: never expose correct flags unless results are published.
      options,
      subject: q.subject,
      chapter: q.chapter,
      topic: q.topic,
      marks: q.marks || 1,
      difficulty: q.difficulty,
      diagramUrl: q.diagramUrl,
    };

    if (!includePublishedSolutions) {
      return baseQuestion;
    }

    const correctOption = Array.isArray(q.options)
      ? q.options.find((opt: any) => Boolean(opt?.isCorrect))
      : null;

    return {
      ...baseQuestion,
      correctOptionId: correctOption?._id ? String(correctOption._id) : '',
      correctOptionText: correctOption?.text || '',
      // Some question banks store the expected answer as text (esp. non-mcq).
      correctAnswerText: q.correctAnswerText || '',
    };
  });

  const base: any = {
    attemptId: attempt.attemptId,
    name: attempt.name,
    phone: attempt.phone,
    classLevel: attempt.classLevel,
    durationMins: attempt.durationMins,
    startedAt: attempt.startedAt,
    status: attempt.status,
    submittedAt: attempt.submittedAt,
    resultPublished: Boolean(attempt.resultPublished),
    questions: questionDetails,
    questionIds: attempt.questions,
    subjectQuestions: attempt.subjectQuestions,
    // Only what the candidate chose — never the grader's isCorrect/marks.
    answers: (attempt.answers || []).map((a: any) => ({
      questionId: a.questionId,
      chosenOptionId: a.chosenOptionId,
      textAnswer: a.textAnswer,
      markedForReview: Boolean(a.markedForReview),
      ...(includePublishedSolutions ? { isCorrect: a.isCorrect, marks: a.marks } : {}),
    })),
  };
  if (opts.includeKey) base.attemptAccessKey = attempt.attemptAccessKey || '';

  if (attempt.resultPublished && !isAgts) {
    base.totalScore = attempt.totalScore || 0;
    base.maxScore = attempt.maxScore || 0;
    base.batch = attempt.batch || '';
    base.adminReview = { isReviewed: Boolean(attempt.adminReview?.isReviewed), notes: attempt.adminReview?.notes || '' };
  }

  return base;
}

export async function getScholarshipAttempt(attemptId: string, accessKey?: string) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  requireValidAttemptAccess(attempt, accessKey);

  const { docs } = await loadAttemptPaper(attempt as any);
  return buildAttemptView(attempt, docs, { includeKey: true });
}

/** Resolve and validate one answer against the attempt's own paper. */
async function assertAnswerBelongsToPaper(attempt: any, answer: NormalizedAnswer) {
  if (!(attempt.questions || []).map(String).includes(String(answer.questionId))) {
    throw new Error('Question is not part of this attempt');
  }
  if (answer.chosenOptionId && Types.ObjectId.isValid(answer.chosenOptionId)) {
    const ClassQuestionModel = getClassQuestionModel(`Class ${attempt.classLevel}`);
    const q: any = await ClassQuestionModel.findById(answer.questionId).select('options._id type').lean();
    const optionIds = new Set((q?.options || []).map((o: any) => String(o._id)));
    if (optionIds.size > 0 && !optionIds.has(String(answer.chosenOptionId))) {
      throw new Error('Option is not part of this question');
    }
  }
}

export async function saveScholarshipAnswer(
  attemptId: string,
  questionId: string,
  answer: any,
  accessKey?: string
) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  requireValidAttemptAccess(attempt, accessKey);

  if (attempt.status === 'submitted') {
    throw new Error('Attempt already submitted');
  }

  if (isPastDeadline(attempt)) {
    throw new Error('Time is up for this attempt');
  }

  const normalizedAnswer = normalizeSingleAnswer(questionId, answer);
  if (!normalizedAnswer) {
    throw new Error('Invalid answer payload');
  }
  await assertAnswerBelongsToPaper(attempt, normalizedAnswer);

  const existingAnswerIndex = attempt.answers.findIndex(
    (a) => a.questionId === questionId
  );

  if (existingAnswerIndex >= 0) {
    const current: any = (attempt.answers[existingAnswerIndex] as any).toObject?.() ?? attempt.answers[existingAnswerIndex];
    attempt.answers[existingAnswerIndex] = {
      questionId,
      chosenOptionId: current.chosenOptionId,
      textAnswer: current.textAnswer,
      markedForReview: current.markedForReview,
      ...normalizedAnswer,
    };
  } else {
    attempt.answers.push(normalizedAnswer);
  }

  await attempt.save();
  return { success: true };
}

export async function submitScholarshipTest(attemptId: string, answers: any, accessKey?: string) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  requireValidAttemptAccess(attempt, accessKey);

  if (attempt.status === 'submitted') {
    throw new Error('Attempt already submitted');
  }

  // After the timer and its grace window, the stored answers are final: a late
  // submit is accepted but cannot add or change anything.
  const late = isPastDeadline(attempt);
  const paper = new Set((attempt.questions || []).map(String));
  const normalizedAnswers = late
    ? []
    : normalizeSubmittedAnswers(answers).filter((a) => paper.has(String(a.questionId)));

  for (const answer of normalizedAnswers) {
    const existingIndex = attempt.answers.findIndex(
      (a) => a.questionId === answer.questionId
    );

    if (existingIndex >= 0) {
      const current: any = (attempt.answers[existingIndex] as any).toObject?.() ?? attempt.answers[existingIndex];
      attempt.answers[existingIndex] = {
        questionId: answer.questionId,
        chosenOptionId: current.chosenOptionId,
        textAnswer: current.textAnswer,
        markedForReview: current.markedForReview,
        ...answer,
      };
    } else {
      attempt.answers.push(answer);
    }
  }

  attempt.status = 'submitted';
  attempt.submittedAt = late ? new Date(attemptDeadline(attempt)) : new Date();

  await attempt.save();

  return {
    attemptId: attempt.attemptId,
    status: attempt.status,
    submittedAt: attempt.submittedAt,
    message: 'Test submitted successfully.',
  };
}

/**
 * Grade an attempt from the server's answer key (assessmentScoring).
 *
 * The maximum is the whole paper's, answered or not — see assessmentScoring
 * for why the previous per-answer maximum inflated percentages. Per-answer
 * `isCorrect`/`marks` are still written for the admin review screen.
 */
export async function gradeScholarshipAttempt(attemptId: string) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  const { keys } = await loadAttemptPaper(attempt as any);
  const summary = scorePaper(keys, responsesOf(attempt, keys));
  const resultById = new Map(summary.perQuestion.map((r) => [r.questionId, r]));

  for (const answer of attempt.answers) {
    const result = resultById.get(String(answer.questionId));
    if (!result || !result.gradable) continue;
    answer.marks = result.awarded;
    answer.isCorrect = result.outcome === 'correct';
  }

  attempt.totalScore = summary.score;
  attempt.maxScore = summary.maxScore;
  await attempt.save();

  return { totalScore: summary.score, maxScore: summary.maxScore, percentage: summary.percentage.toFixed(2), summary };
}

export async function getScholarshipResults(filters: any = {}) {
  const query: any = {};

  if (filters.classLevel) {
    query.classLevel = filters.classLevel;
  }

  if (filters.submittedOnly !== false) {
    query.status = 'submitted';
  }

  if (filters.testId) {
    query.$or = [
      { scholarshipTestId: String(filters.testId) },
      { scholarshipShareLink: String(filters.testId) },
    ];
  }

  if (filters.publishedOnly) {
    query.resultPublished = true;
  }

  const attempts = await ScholarshipAttempt.find(query)
    .select(
      'attemptId name phone classLevel scholarshipTestId scholarshipTestName scholarshipShareLink status totalScore maxScore resultPublished submittedAt resultPublicToken batch'
    )
    .sort({ submittedAt: -1 });

  return attempts;
}

export async function publishScholarshipResults(filters: { classLevel?: number; testId?: string; batch?: string; batchAssignedBy?: string } = {}) {
  const query: any = { status: 'submitted' };

  if (filters.classLevel) {
    query.classLevel = filters.classLevel;
  }

  if (filters.testId) {
    query.$or = [
      { scholarshipTestId: String(filters.testId) },
      { scholarshipShareLink: String(filters.testId) },
    ];
  }

  const attempts = await ScholarshipAttempt.find(query);

  for (const attempt of attempts) {
    await gradeScholarshipAttempt(attempt.attemptId);
  }

  for (const attempt of attempts) {
    attempt.resultPublished = true;

    if (!attempt.resultPublicToken) {
      attempt.resultPublicToken = generateResultPublicToken();
    }

    if (filters.batch) {
      attempt.batch = filters.batch;
      attempt.batchAssignedAt = new Date();
      attempt.batchAssignedBy = filters.batchAssignedBy || 'admin';
    }

    await attempt.save();
  }

  const frontendBase = resolveFrontendBaseUrl();
  const publishedLinks = attempts
    .filter((a) => Boolean(a.resultPublicToken))
    .map((a) => ({
      attemptId: a.attemptId,
      name: a.name,
      publicUrl: `${frontendBase}/agts/result?token=${encodeURIComponent(String(a.resultPublicToken))}`,
    }));

  return {
    published: attempts.length,
    linksGenerated: publishedLinks.length,
    resultLinks: publishedLinks,
    message: `${attempts.length} results published successfully${filters.batch ? ` and assigned to batch "${filters.batch}"` : ''}`,
  };
}

export async function getScholarshipResultPublicLink(attemptId: string) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  if (!attempt.resultPublished) {
    throw new Error('Result is not published yet');
  }

  if (!attempt.resultPublicToken) {
    attempt.resultPublicToken = generateResultPublicToken();
    await attempt.save();
  }

  const frontendBase = resolveFrontendBaseUrl();
  return {
    attemptId: attempt.attemptId,
    name: attempt.name,
    publicUrl: `${frontendBase}/agts/result?token=${encodeURIComponent(String(attempt.resultPublicToken))}`,
  };
}

export async function getScholarshipPublicResultByToken(token: string) {
  const normalizedToken = String(token || '').trim();
  // Tokens are 40 hex chars; anything else cannot match and is not looked up.
  if (!/^[a-f0-9]{40}$/i.test(normalizedToken)) {
    throw new Error(normalizedToken ? 'Invalid or expired result link' : 'Result token is required');
  }

  const attempt = await ScholarshipAttempt.findOne({ resultPublicToken: normalizedToken });
  if (!attempt || !attempt.resultPublished) {
    throw new Error('Invalid or expired result link');
  }

  // The token is the authorisation here, so the view is built directly rather
  // than through the attempt-key check (which refuses pre-key attempts).
  const { docs } = await loadAttemptPaper(attempt as any);
  const data: any = buildAttemptView(attempt, docs, { includeKey: false });
  // A shared link is for the result, not for the candidate's contact details.
  delete data.phone;
  data.isPublicResult = true;

  return data;
}

export async function getScholarshipAttemptReview(attemptId: string) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  const ClassQuestionModel = getClassQuestionModel(`Class ${attempt.classLevel}`);
  const questions = await ClassQuestionModel.find({
    _id: { $in: attempt.questions.map((id) => new Types.ObjectId(id)) },
  })
    .select('_id text type options subject chapter topic marks difficulty correctAnswerText')
    .lean();

  const questionMap = new Map(questions.map((q: any) => [q._id.toString(), q]));
  const answerMap = new Map(attempt.answers.map((a: any) => [a.questionId, a]));

  const reviewedQuestions = attempt.questions
    .map((qid) => {
      const q = questionMap.get(String(qid));
      if (!q) return null;

      const ans = answerMap.get(String(qid));
      const options = Array.isArray(q.options) ? q.options : [];
      const correctOption = options.find((opt: any) => opt.isCorrect);
      const selectedOption = options.find(
        (opt: any) => String(opt?._id) === String(ans?.chosenOptionId || '')
      );
      const maxMarks = Number(q.marks || 1);
      const awardedMarks = Number(ans?.marks || 0);

      const isCorrect =
        q.type === 'mcq'
          ? Boolean(
              correctOption && ans?.chosenOptionId && String(correctOption._id) === String(ans.chosenOptionId)
            )
          : Boolean(ans?.isCorrect);

      return {
        questionId: String(q._id),
        text: q.text,
        type: q.type || 'mcq',
        subject: q.subject,
        chapter: q.chapter,
        topic: q.topic,
        difficulty: q.difficulty,
        options,
        maxMarks,
        awardedMarks,
        isCorrect,
        correctAnswerText: q.correctAnswerText || (correctOption?.text || ''),
        correctOptionId: correctOption?._id ? String(correctOption._id) : '',
        selectedOptionId: ans?.chosenOptionId ? String(ans.chosenOptionId) : '',
        selectedOptionText: selectedOption?.text || '',
        textAnswer: ans?.textAnswer || '',
      };
    })
    .filter(Boolean);

  return {
    attempt: {
      attemptId: attempt.attemptId,
      name: attempt.name,
      phone: attempt.phone,
      classLevel: attempt.classLevel,
      scholarshipTestId: attempt.scholarshipTestId || '',
      scholarshipTestName: attempt.scholarshipTestName || '',
      status: attempt.status,
      submittedAt: attempt.submittedAt,
      totalScore: attempt.totalScore || 0,
      maxScore: attempt.maxScore || 0,
      resultPublished: Boolean(attempt.resultPublished),
      batch: attempt.batch || '',
      adminReview: attempt.adminReview || { isReviewed: false, notes: '' },
      scholarshipAward: attempt.scholarshipAward || {
        percentage: 0,
        earlyBirdDiscountPercentage: 0,
        amount: 0,
        notes: '',
      },
    },
    questions: reviewedQuestions,
  };
}

export async function updateScholarshipAttemptReview(
  attemptId: string,
  payload: {
    questionMarks?: Array<{ questionId: string; marks: number }>;
    adminNotes?: string;
    scholarshipAward?: {
      percentage?: number;
      earlyBirdDiscountPercentage?: number;
      amount?: number;
      notes?: string;
    };
  },
  reviewedBy = 'admin'
) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  const markUpdates = Array.isArray(payload?.questionMarks) ? payload.questionMarks : [];

  const ClassQuestionModel = getClassQuestionModel(`Class ${attempt.classLevel}`);
  const questions = await ClassQuestionModel.find({
    _id: { $in: attempt.questions.map((id) => new Types.ObjectId(id)) },
  })
    .select('_id marks')
    .lean();

  const maxMarksByQuestionId = new Map(
    questions.map((q: any) => [String(q._id), Number(q?.marks || 1)])
  );

  for (const item of markUpdates) {
    const questionId = String(item?.questionId || '');
    if (!questionId) continue;
    if (!maxMarksByQuestionId.has(questionId)) continue;

    const rawMarks = Number(item?.marks);
    const validMarks = Number.isFinite(rawMarks) ? rawMarks : 0;
    const maxMarks = maxMarksByQuestionId.get(questionId) || 0;
    const marks = Math.max(0, Math.min(validMarks, maxMarks));

    const idx = attempt.answers.findIndex((a) => a.questionId === questionId);
    if (idx >= 0) {
      attempt.answers[idx].marks = marks;
    } else {
      attempt.answers.push({
        questionId,
        marks,
      });
    }
  }

  const maxScore = questions.reduce((sum, q: any) => sum + Number(q?.marks || 1), 0);
  const validQuestionIds = new Set(questions.map((q: any) => String(q._id)));
  const totalScore = attempt.answers.reduce((sum, a) => {
    if (!validQuestionIds.has(String(a?.questionId || ''))) return sum;
    return sum + Number(a?.marks || 0);
  }, 0);

  attempt.maxScore = maxScore;
  attempt.totalScore = totalScore;
  attempt.adminReview = {
    isReviewed: true,
    reviewedBy,
    reviewedAt: new Date(),
    notes: payload?.adminNotes || attempt.adminReview?.notes || '',
  };

  if (payload?.scholarshipAward) {
    attempt.scholarshipAward = {
      percentage: Number(payload.scholarshipAward.percentage || 0),
      earlyBirdDiscountPercentage: Number(
        payload.scholarshipAward.earlyBirdDiscountPercentage || 0
      ),
      amount: Number(payload.scholarshipAward.amount || 0),
      notes: payload.scholarshipAward.notes || '',
      updatedBy: reviewedBy,
      updatedAt: new Date(),
    };
  }

  await attempt.save();

  return {
    attemptId: attempt.attemptId,
    totalScore: attempt.totalScore,
    maxScore: attempt.maxScore,
    adminReview: attempt.adminReview,
    scholarshipAward: attempt.scholarshipAward,
    message: 'Attempt review updated successfully',
  };
}

// Test management functions
export async function createScholarshipTest(testData: any) {
  const normalizedSubjects = normalizeSubjects(testData.subjects || []);
  if (normalizedSubjects.length === 0) {
    throw new Error('At least one valid subject is required');
  }

  const shareLink = await generateLogicalShareLink(
    testData.testName,
    testData.eligibleClasses || []
  );

  const test = await ScholarshipTest.create({
    testName: testData.testName,
    description: testData.description || '',
    eligibleClasses: testData.eligibleClasses,
    subjects: normalizedSubjects,
    durationMins: testData.durationMins || 60,
    questionsPerSubject: testData.questionsPerSubject || 15,
    shareLink,
  });

  return test;
}

export async function getScholarshipTestPreview(testId: string, classLevel?: number) {
  const test = await ScholarshipTest.findById(testId).lean();
  if (!test) {
    throw new Error('Test not found');
  }

  const previewClass = classLevel || test.eligibleClasses[0];
  if (!previewClass || !test.eligibleClasses.includes(previewClass)) {
    throw new Error('Invalid class for preview');
  }

  const ClassQuestionModel = getClassQuestionModel(`Class ${previewClass}`);
  const bySubject: Array<{
    subject: string;
    available: number;
    selected: number;
    questions: any[];
  }> = [];

  let totalSelected = 0;
  const usedPreviewQuestionIds = new Set<string>();

  const normalizedSubjects = normalizeSubjects(test.subjects || []);
  if (normalizedSubjects.length === 0) {
    throw new Error('Test has no valid subjects configured for preview');
  }

  for (const subject of normalizedSubjects) {
    const subjectPool = expandSubjectAliases(subject);
    const availableQuestions = await ClassQuestionModel.find({
      subject: { $in: subjectPool },
      board: SCHOLARSHIP_BOARD_PATTERN,
      isActive: true,
    })
      .select('_id text type options correctAnswerText subject chapter topic difficulty marks board')
      .lean();

    if (availableQuestions.length < (test.questionsPerSubject || 15)) {
      throw new Error(
        `Not enough AGTS questions for Class ${previewClass} - ${subject}. ` +
          `Required: ${test.questionsPerSubject || 15}, Found: ${availableQuestions.length}`
      );
    }

    const picked = pickRandomUniqueDocs(
      availableQuestions as any,
      test.questionsPerSubject || 15,
      usedPreviewQuestionIds
    );

    picked.forEach((q: any) => {
      if (q?._id) usedPreviewQuestionIds.add(String(q._id));
    });
    totalSelected += picked.length;

    bySubject.push({
      subject,
      available: availableQuestions.length,
      selected: picked.length,
      questions: picked.map((q: any) => ({
        _id: q._id.toString(),
        text: q.text,
        type: q.type,
        subject: q.subject,
        chapter: q.chapter,
        topic: q.topic,
        difficulty: q.difficulty,
        marks: q.marks || 1,
        board: q.board,
        options: q.options || [],
        correctAnswerText: q.correctAnswerText || '',
      })),
    });
  }

  return {
    test: {
      _id: test._id,
      testName: test.testName,
      description: test.description,
      durationMins: test.durationMins,
      questionsPerSubject: test.questionsPerSubject,
      subjects: normalizedSubjects,
      eligibleClasses: test.eligibleClasses,
    },
    previewClass,
    totalSelected,
    bySubject,
  };
}

export async function getActiveScholarshipTests() {
  return ScholarshipTest.find({ isActive: true }).sort({ createdAt: -1 });
}

export async function getScholarshipTestById(testId: string) {
  return ScholarshipTest.findById(testId);
}

export async function deleteScholarshipTest(testId: string) {
  return ScholarshipTest.findByIdAndDelete(testId);
}

export async function getTestShareLink(testId: string) {
  const test = await ScholarshipTest.findById(testId);
  if (!test) {
    throw new Error('Test not found');
  }

  const logicalShareLink = await ensureLogicalShareLink(test);

  return {
    shareLink: logicalShareLink,
    testName: test.testName,
    publicUrl: `${resolveFrontendBaseUrl()}/agts?test=${encodeURIComponent(logicalShareLink)}`,
  };
}

export async function incrementTestAttemptCount(testId: string) {
  return ScholarshipTest.findByIdAndUpdate(testId, { $inc: { totalAttempts: 1 } });
}
