/**
 * AGTS — Abhigyan Gurukul Test Series.
 *
 * Orchestrates the public flow on top of the existing test engine
 * (services/scholarshipService — question selection, attempt keys, the
 * one-attempt-per-phone-per-test rule), and the pure scoring and analytics
 * modules:
 *
 *   register → lead upsert → attempt (engine) → answers → submit
 *            → assessmentScoring + assessmentAnalytics → lead updated → report
 *
 * ── Trust boundary ──────────────────────────────────────────────────────────
 * The browser supplies registration details, which option it chose, and a
 * label for why it submitted. Everything that decides an outcome — the
 * deadline, the answer key, the score, the percentage, the lead status — is
 * the server's. A missing attempt and a wrong key produce the same 404, so an
 * attempt id cannot be probed.
 */

import { Types } from 'mongoose';
import ScholarshipAttempt from '../../models/ScholarshipAttempt';
import ScholarshipTest from '../../models/ScholarshipTest';
import Lead from '../../models/Lead';
import { getClassQuestionModel } from '../../models/ClassQuestion';
import {
  ASSESSMENT_BOARD_PATTERN,
  attemptDeadline,
  createScholarshipAttempt,
  expandSubjectAliases,
  hasValidAttemptAccess,
  isPastDeadline,
  loadAttemptPaper,
  normalizeSubjects,
  responsesOf,
} from '../scholarshipService';
import { scorePaper, type ScoreSummary } from '../assessment/assessmentScoring';
import { analyzeAttempt, ANALYTICS_VERSION, type AnalysisReport } from '../assessment/assessmentAnalytics';
import { agtsDisplayName, agtsPublicDescription, attemptDisplayName } from './agtsNaming';
import {
  AGTS_CLASS_LEVELS,
  parseAnswer,
  parseAnswerBatch,
  validateGuidance,
  type AnswerInput,
  type RegistrationInput,
} from './agtsValidation';
import {
  recordAgtsResult,
  recordAttemptStarted,
  recordGuidanceRequest,
  upsertLeadFromRegistration,
} from './leadService';

export class AgtsError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly errors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AgtsError';
  }
}

const MAX_ATTEMPTS_PER_PHONE_PER_DAY = Math.max(1, Number(process.env.AGTS_MAX_ATTEMPTS_PER_PHONE_PER_DAY || 3));

const notFound = () => new AgtsError(404, 'AGTS_ATTEMPT_NOT_FOUND', 'We could not find that test attempt.');

// ── The class-wise papers ───────────────────────────────────────────────────
//
// AGTS offers the papers already built in the test builder — the class-wise
// test series stored in `scholarshiptests` (the collection's name predates
// AGTS) with their questions in the `class_N` banks. Those records are READ
// here and never written: not renamed, not counted, not edited (the owner's
// instruction, 2026-09-28). Their public names come from agtsNaming.
//
// A paper is offered only when its class bank holds enough ACTIVE questions
// for every subject, so a paper the engine could not assemble is never shown
// and never started.

const AVAILABILITY_TTL_MS = 5 * 60 * 1000;
const bankCounts = new Map<string, { n: number; at: number }>();

async function activeQuestions(classLevel: number, subject: string): Promise<number> {
  const key = `${classLevel}|${subject}`;
  const hit = bankCounts.get(key);
  if (hit && Date.now() - hit.at < AVAILABILITY_TTL_MS) return hit.n;
  const Model = getClassQuestionModel(`Class ${classLevel}`);
  const n = await Model.countDocuments({
    subject: { $in: expandSubjectAliases(subject) },
    board: ASSESSMENT_BOARD_PATTERN,
    isActive: true,
  });
  bankCounts.set(key, { n, at: Date.now() });
  return n;
}

async function isAvailable(test: any): Promise<boolean> {
  const subjects = normalizeSubjects(test?.subjects || []);
  const perSubject = Number(test?.questionsPerSubject) || 15;
  const classes: number[] = (test?.eligibleClasses || []).filter((c: number) =>
    (AGTS_CLASS_LEVELS as readonly number[]).includes(Number(c)),
  );
  if (!subjects.length || !classes.length) return false;
  for (const c of classes) {
    for (const s of subjects) {
      if ((await activeQuestions(c, s)) < perSubject) return false;
    }
  }
  return true;
}

function publicTestView(test: any) {
  const subjects = normalizeSubjects(test?.subjects || []);
  const perSubject = Number(test?.questionsPerSubject) || 15;
  const classes: number[] = Array.isArray(test?.eligibleClasses) ? test.eligibleClasses : [];
  const questionCount = subjects.length * perSubject;
  const durationMins = Number(test?.durationMins) || 60;
  return {
    ref: test?.shareLink || String(test?._id || ''),
    name: agtsDisplayName({ testName: test?.testName, classes, questionCount, durationMins }),
    description: agtsPublicDescription(test?.description),
    classes,
    subjects: subjects.map((s) => (s === 'Math' ? 'Mathematics' : s)),
    durationMins,
    questionCount,
  };
}

async function findActiveTest(ref: string) {
  if (!ref) return null;
  const test = Types.ObjectId.isValid(ref) && /^[a-f0-9]{24}$/i.test(ref)
    ? await ScholarshipTest.findById(ref).lean()
    : await ScholarshipTest.findOne({ shareLink: ref }).lean();
  return test && (test as any).isActive ? test : null;
}

/** Active papers the engine can actually assemble, oldest first (paper order). */
async function availableTests() {
  const tests = await ScholarshipTest.find({ isActive: true }).sort({ createdAt: 1 }).limit(100).lean();
  const out: any[] = [];
  for (const test of tests) {
    if (await isAvailable(test)) out.push(test);
  }
  return out;
}

export async function listPublicTests() {
  const views = (await availableTests()).map(publicTestView);
  const classes = [...new Set(views.flatMap((v) => v.classes))]
    .filter((c) => (AGTS_CLASS_LEVELS as readonly number[]).includes(Number(c)))
    .sort((a, b) => a - b);
  return { classes, tests: views };
}

export async function getPublicTest(ref: string) {
  const test = await findActiveTest(ref);
  if (!test) throw new AgtsError(404, 'AGTS_TEST_UNAVAILABLE', 'This AGTS test link is no longer active.');
  if (!(await isAvailable(test))) {
    throw new AgtsError(503, 'AGTS_QUESTIONS_UNAVAILABLE', 'This AGTS paper is not available right now. Please choose another paper or try again later.');
  }
  return publicTestView(test);
}

// ── Registration → attempt ──────────────────────────────────────────────────

function engineError(err: any, classLevel: number): AgtsError {
  const message = String(err?.message || '');
  if (/not available yet/i.test(message)) {
    return new AgtsError(
      503,
      'AGTS_QUESTIONS_UNAVAILABLE',
      `AGTS for Class ${classLevel} is not available right now. Please try again later or contact us.`,
    );
  }
  if (/not eligible/i.test(message)) {
    return new AgtsError(400, 'AGTS_CLASS_NOT_ELIGIBLE', message, { classLevel: message });
  }
  if (/not available/i.test(message)) {
    return new AgtsError(404, 'AGTS_TEST_UNAVAILABLE', 'This AGTS test link is no longer active.');
  }
  return new AgtsError(500, 'AGTS_START_FAILED', 'We could not start your test. Please try again.');
}

export interface StartResult {
  attemptId: string;
  attemptAccessKey: string;
  created: boolean;
  resumed: boolean;
  durationMins: number;
  startedAt: Date;
  endsAt: string;
  serverNow: string;
}

const startResponse = (attempt: any, created: boolean): StartResult => ({
  attemptId: attempt.attemptId,
  attemptAccessKey: attempt.attemptAccessKey || '',
  created,
  resumed: !created,
  durationMins: attempt.durationMins,
  startedAt: attempt.startedAt,
  endsAt: new Date(attemptDeadline(attempt)).toISOString(),
  serverNow: new Date().toISOString(),
});

export async function registerAndStart(input: RegistrationInput, now = new Date()): Promise<StartResult> {
  // 1. The paper: the one the link or the family chose, else the class's
  //    latest available paper. Resolved before anything is written.
  let test: any = null;
  if (input.testRef) {
    test = await findActiveTest(input.testRef);
    if (!test) throw new AgtsError(404, 'AGTS_TEST_UNAVAILABLE', 'This AGTS test link is no longer active.');
    const classes: number[] = test.eligibleClasses || [];
    if (!classes.includes(input.classLevel)) {
      const msg = classes.length === 1 ? `This AGTS paper is for Class ${classes[0]}.` : `This AGTS paper is for Classes ${classes.join(', ')}.`;
      throw new AgtsError(400, 'AGTS_CLASS_NOT_ELIGIBLE', msg, { classLevel: msg });
    }
    if (!(await isAvailable(test))) {
      throw new AgtsError(503, 'AGTS_QUESTIONS_UNAVAILABLE', 'This AGTS paper is not available right now. Please choose another paper or try again later.');
    }
  } else {
    const forClass = (await availableTests()).filter((t) => (t.eligibleClasses || []).includes(input.classLevel));
    test = forClass[forClass.length - 1] || null;
    if (!test) {
      throw new AgtsError(
        503,
        'AGTS_QUESTIONS_UNAVAILABLE',
        `AGTS for Class ${input.classLevel} is not available right now. Please try again later or contact us.`,
      );
    }
  }

  // 2. The lead — created or refreshed, never duplicated.
  const lead = await upsertLeadFromRegistration(input, now);

  // 3. Abuse ceiling on NEW attempts per phone number.
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const recent = await ScholarshipAttempt.countDocuments({
    program: 'agts',
    phoneNormalized: input.phoneNormalized,
    createdAt: { $gte: since },
  });

  // 4. The engine: question selection, attempt key, and the rule that a phone
  //    number takes each paper once (an unfinished attempt resumes instead).
  let result: any;
  try {
    if (recent >= MAX_ATTEMPTS_PER_PHONE_PER_DAY) {
      // Only a NEW attempt is refused; resuming one already started is fine.
      const existing = await ScholarshipAttempt.findOne({
        scholarshipTestId: String(test._id),
        phoneNormalized: input.phoneNormalized,
      }).lean();
      if (!existing) {
        throw new AgtsError(
          429,
          'AGTS_ATTEMPT_LIMIT',
          `This phone number has already started ${recent} AGTS tests in the last 24 hours. Please try again tomorrow.`,
        );
      }
    }
    result = await createScholarshipAttempt(
      input.studentName,
      input.phoneNormalized,
      input.classLevel,
      String(test._id),
      { program: 'agts', leadId: lead._id as Types.ObjectId },
    );
  } catch (err) {
    if (err instanceof AgtsError) throw err;
    throw engineError(err, input.classLevel);
  }

  if (result.locked) {
    // An attempt that simply ran out of time is closed now, so its result
    // still reaches the lead even though its owner never pressed submit.
    const stale = await ScholarshipAttempt.findOne({ attemptId: result.attemptId, status: 'in-progress' });
    if (stale && isPastDeadline(stale)) await finalize(stale, 'expired');
    throw new AgtsError(409, 'AGTS_ALREADY_TAKEN', 'This phone number has already taken this AGTS paper.');
  }
  if (result.conflict) {
    throw new AgtsError(409, 'AGTS_IN_PROGRESS_ELSEWHERE', 'A test is already in progress for this phone number. Please finish it first.');
  }

  const attempt = await ScholarshipAttempt.findOne({ attemptId: result.attemptId });
  if (!attempt) throw new AgtsError(500, 'AGTS_START_FAILED', 'We could not start your test. Please try again.');

  if (result.created) {
    await recordAttemptStarted(lead._id as Types.ObjectId, now);
  } else if (!attempt.leadId || attempt.program !== 'agts') {
    // An attempt made before AGTS, resumed through it, joins the lead.
    await ScholarshipAttempt.updateOne({ _id: attempt._id }, { $set: { leadId: lead._id, program: 'agts' } });
  }

  return startResponse(attempt, Boolean(result.created));
}

// ── Attempt access ──────────────────────────────────────────────────────────

async function loadForKey(attemptId: string, key: string) {
  const id = String(attemptId || '').slice(0, 40);
  if (!/^[A-Z0-9-]{6,40}$/i.test(id)) throw notFound();
  const attempt = await ScholarshipAttempt.findOne({ attemptId: id });
  if (!attempt || !hasValidAttemptAccess(attempt, key)) throw notFound();
  return attempt;
}

const safeUrl = (value: unknown) => {
  const url = String(value || '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
};

export async function getPlayerView(attemptId: string, key: string) {
  const attempt = await loadForKey(attemptId, key);
  if (attempt.status === 'in-progress' && isPastDeadline(attempt)) {
    await finalize(attempt, 'expired');
  }

  const base = {
    attemptId: attempt.attemptId,
    status: attempt.status,
    testName: attemptDisplayName(attempt),
    student: { name: attempt.name, classLevel: attempt.classLevel },
    durationMins: attempt.durationMins,
    startedAt: attempt.startedAt,
    endsAt: new Date(attemptDeadline(attempt)).toISOString(),
    serverNow: new Date().toISOString(),
  };
  if (attempt.status === 'submitted') return { ...base, questions: [], answers: [] };

  const { docs } = await loadAttemptPaper(attempt as any);
  const questions = docs.map((q: any, index: number) => ({
    _id: String(q._id),
    index: index + 1,
    text: String(q.text || ''),
    type: q.type || 'mcq',
    // No isCorrect, no correctAnswerText, no integerAnswer, no explanation.
    options: Array.isArray(q.options) ? q.options.map((o: any) => ({ _id: String(o._id), text: String(o.text || '') })) : [],
    subject: q.subject || 'General',
    marks: Number(q.marks) > 0 ? Number(q.marks) : 1,
    diagramUrl: safeUrl(q.diagram?.url || q.diagramUrl),
    diagramAlt: String(q.diagram?.alt || q.diagramAlt || ''),
    table: q.tableData?.headers && q.tableData?.rows ? { headers: q.tableData.headers, rows: q.tableData.rows } : null,
  }));
  const answers = (attempt.answers || []).map((a: any) => ({
    questionId: a.questionId,
    chosenOptionId: a.chosenOptionId || '',
    textAnswer: a.textAnswer || '',
    markedForReview: Boolean(a.markedForReview),
  }));
  return { ...base, questions, answers };
}

async function assertOptionOnQuestion(attempt: any, answer: AnswerInput) {
  if (!(attempt.questions || []).map(String).includes(answer.questionId)) {
    throw new AgtsError(400, 'AGTS_QUESTION_NOT_ON_PAPER', 'That question is not part of this test.');
  }
  if (!answer.chosenOptionId) return;
  const Model = getClassQuestionModel(`Class ${attempt.classLevel}`);
  const q: any = await Model.findById(answer.questionId).select('options._id').lean();
  const ids = new Set((q?.options || []).map((o: any) => String(o._id)));
  if (!ids.has(answer.chosenOptionId)) {
    throw new AgtsError(400, 'AGTS_OPTION_NOT_ON_QUESTION', 'That option does not belong to this question.');
  }
}

/**
 * Save one answer atomically.
 *
 * The engine's save loads the attempt, edits the array and saves the whole
 * array back; two autosaves in flight at once (answer, then answer the next
 * question quickly) could each overwrite the other. Here each save touches
 * only its own array element, guarded on `status: 'in-progress'`.
 */
export async function saveAnswer(attemptId: string, key: string, body: any) {
  const attempt = await loadForKey(attemptId, key);
  if (attempt.status !== 'in-progress') {
    throw new AgtsError(409, 'AGTS_ALREADY_SUBMITTED', 'This test has already been submitted.');
  }
  if (isPastDeadline(attempt)) {
    await finalize(attempt, 'expired');
    throw new AgtsError(409, 'AGTS_TIME_UP', 'Time is up for this test. Your saved answers have been submitted.');
  }

  const answer = parseAnswer(body?.questionId, body?.answer ?? { chosenOptionId: body?.chosenOptionId, textAnswer: body?.textAnswer }, body?.markedForReview);
  await assertOptionOnQuestion(attempt, answer);

  const fields = {
    chosenOptionId: answer.chosenOptionId,
    textAnswer: answer.textAnswer,
    markedForReview: answer.markedForReview,
  };
  const updated = await ScholarshipAttempt.updateOne(
    { _id: attempt._id, status: 'in-progress', 'answers.questionId': answer.questionId },
    {
      $set: {
        'answers.$.chosenOptionId': fields.chosenOptionId,
        'answers.$.textAnswer': fields.textAnswer,
        'answers.$.markedForReview': fields.markedForReview,
      },
    },
  );
  if (updated.matchedCount === 0) {
    const pushed = await ScholarshipAttempt.updateOne(
      { _id: attempt._id, status: 'in-progress', 'answers.questionId': { $ne: answer.questionId } },
      { $push: { answers: { questionId: answer.questionId, ...fields } } },
    );
    if (pushed.matchedCount === 0) {
      // Either submitted meanwhile, or another save pushed this question first.
      const retry = await ScholarshipAttempt.updateOne(
        { _id: attempt._id, status: 'in-progress', 'answers.questionId': answer.questionId },
        { $set: { 'answers.$.chosenOptionId': fields.chosenOptionId, 'answers.$.textAnswer': fields.textAnswer, 'answers.$.markedForReview': fields.markedForReview } },
      );
      if (retry.matchedCount === 0) throw new AgtsError(409, 'AGTS_ALREADY_SUBMITTED', 'This test has already been submitted.');
    }
  }
  return { saved: true, questionId: answer.questionId, serverNow: new Date().toISOString() };
}

// ── Submission, grading, analysis ───────────────────────────────────────────

type SubmitReason = 'candidate' | 'time-up' | 'expired' | 'focus-violations';
const CLIENT_REASONS: SubmitReason[] = ['candidate', 'time-up', 'focus-violations'];

async function gradeAndAnalyze(attempt: any): Promise<{ summary: ScoreSummary; report: AnalysisReport }> {
  const { keys } = await loadAttemptPaper(attempt);
  const summary = scorePaper(keys, responsesOf(attempt, keys));
  const report = analyzeAttempt(summary, {
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    durationMins: attempt.durationMins,
  });
  const byId = new Map(summary.perQuestion.map((r) => [r.questionId, r]));
  const answers = (attempt.answers || []).map((a: any) => {
    const plain = typeof a.toObject === 'function' ? a.toObject() : a;
    const r = byId.get(String(plain.questionId));
    return r && r.gradable ? { ...plain, marks: r.awarded, isCorrect: r.outcome === 'correct' } : plain;
  });
  await ScholarshipAttempt.updateOne(
    { _id: attempt._id },
    {
      $set: {
        answers,
        totalScore: summary.score,
        maxScore: summary.maxScore,
        scoring: {
          correct: summary.correct,
          incorrect: summary.incorrect,
          skipped: summary.skipped,
          ungraded: summary.ungraded,
          percentage: summary.percentage,
          accuracy: summary.accuracy,
          timeTakenSec: report.time.timeTakenSec,
          gradedAt: new Date(),
          version: ANALYTICS_VERSION,
        },
        analysis: report,
      },
    },
  );
  attempt.analysis = report;
  attempt.totalScore = summary.score;
  attempt.maxScore = summary.maxScore;
  return { summary, report };
}

/**
 * Close an attempt exactly once. The status flip is a conditional update, so
 * two submits (a double-click, or the timer racing the button) cannot both
 * grade and both count against the lead.
 */
async function finalize(attempt: any, reason: SubmitReason, incoming: AnswerInput[] = []) {
  const late = isPastDeadline(attempt);
  const paper = new Set((attempt.questions || []).map(String));

  // Merge the final flush into the stored answers — unless time is up, in which
  // case what was saved in time is final.
  const merged = new Map<string, any>();
  for (const a of attempt.answers || []) {
    const plain = typeof a.toObject === 'function' ? a.toObject() : a;
    merged.set(String(plain.questionId), {
      questionId: String(plain.questionId),
      chosenOptionId: plain.chosenOptionId || '',
      textAnswer: plain.textAnswer || '',
      markedForReview: Boolean(plain.markedForReview),
    });
  }
  if (!late) {
    for (const a of incoming) {
      if (!paper.has(a.questionId)) continue;
      merged.set(a.questionId, { ...a });
    }
  }

  const submittedAt = late ? new Date(attemptDeadline(attempt)) : new Date();
  const finalReason: SubmitReason = late ? 'expired' : reason;
  const closed = await ScholarshipAttempt.findOneAndUpdate(
    { _id: attempt._id, status: 'in-progress' },
    {
      $set: {
        answers: [...merged.values()],
        status: 'submitted',
        submittedAt,
        submitReason: finalReason,
        autoSubmitted: finalReason !== 'candidate',
      },
    },
    { new: true },
  );
  if (!closed) {
    // Someone else closed it first; that call graded it.
    return ScholarshipAttempt.findById(attempt._id);
  }

  const { summary, report } = await gradeAndAnalyze(closed);
  if (closed.leadId) {
    await recordAgtsResult(closed.leadId as Types.ObjectId, {
      attemptId: closed.attemptId,
      testName: attemptDisplayName(closed),
      classLevel: closed.classLevel,
      submittedAt,
      score: summary.score,
      maxScore: summary.maxScore,
      percentage: summary.percentage,
      accuracy: summary.accuracy,
      correct: summary.correct,
      incorrect: summary.incorrect,
      skipped: summary.skipped,
      timeTakenSec: report.time.timeTakenSec,
      band: report.band.key,
    });
  }
  return ScholarshipAttempt.findById(attempt._id);
}

export async function submitAttempt(attemptId: string, key: string, body: any) {
  const attempt = await loadForKey(attemptId, key);
  if (attempt.status !== 'in-progress') return reportFor(attempt);

  const reason = CLIENT_REASONS.includes(body?.reason) ? (body.reason as SubmitReason) : 'candidate';
  const incoming = parseAnswerBatch(body?.answers);
  // Every option in the flush is checked against its own question.
  const valid: AnswerInput[] = [];
  for (const a of incoming) {
    try {
      await assertOptionOnQuestion(attempt, a);
      valid.push(a);
    } catch {
      /* an invalid entry is dropped; the rest of the submission stands */
    }
  }
  const closed = await finalize(attempt, reason, valid);
  return reportFor(closed);
}

// ── Reports ─────────────────────────────────────────────────────────────────

async function ensureAnalysis(attempt: any): Promise<AnalysisReport> {
  const current = attempt.analysis as AnalysisReport | undefined;
  if (current && current.version === ANALYTICS_VERSION) return current;
  // Attempts graded before AGTS (or by an older analytics version) are
  // analysed on first view, from the same stored answers.
  const { report } = await gradeAndAnalyze(attempt);
  return report;
}

async function reportFor(attempt: any) {
  if (!attempt) throw notFound();
  if (attempt.status !== 'submitted') {
    throw new AgtsError(409, 'AGTS_NOT_SUBMITTED', 'This test has not been submitted yet.');
  }
  const analysis = await ensureAnalysis(attempt);
  let guidanceRequested = false;
  if (attempt.leadId) {
    const lead = await Lead.findById(attempt.leadId).select('guidance.requested guidance.attemptId').lean();
    guidanceRequested = Boolean(lead?.guidance?.requested);
  }
  return {
    attemptId: attempt.attemptId,
    testName: attemptDisplayName(attempt),
    // Deliberately no phone, email or guardian — a report can be shared.
    student: { name: attempt.name, classLevel: attempt.classLevel },
    status: attempt.status,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    durationMins: attempt.durationMins,
    submitReason: attempt.submitReason || 'candidate',
    analysis,
    guidance: { requested: guidanceRequested, available: Boolean(attempt.leadId) },
  };
}

export async function getResult(attemptId: string, key: string) {
  const attempt = await loadForKey(attemptId, key);
  if (attempt.status === 'in-progress' && isPastDeadline(attempt)) {
    return reportFor(await finalize(attempt, 'expired'));
  }
  return reportFor(attempt);
}

/** A result link an admin shared (the token is the authorisation). */
export async function getSharedResult(token: string) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{40}$/i.test(t)) throw new AgtsError(404, 'AGTS_LINK_INVALID', 'This result link is invalid or has expired.');
  const attempt = await ScholarshipAttempt.findOne({ resultPublicToken: t, resultPublished: true });
  if (!attempt || attempt.status !== 'submitted') {
    throw new AgtsError(404, 'AGTS_LINK_INVALID', 'This result link is invalid or has expired.');
  }
  const report = await reportFor(attempt);
  return { ...report, shared: true, guidance: { requested: false, available: false } };
}

export async function requestGuidance(attemptId: string, key: string, body: any) {
  const attempt = await loadForKey(attemptId, key);
  if (attempt.status !== 'submitted') {
    throw new AgtsError(409, 'AGTS_NOT_SUBMITTED', 'Please finish the test first.');
  }
  if (!attempt.leadId) {
    throw new AgtsError(409, 'AGTS_NO_LEAD', 'Guidance requests are available for AGTS tests only.');
  }
  const input = validateGuidance(body);
  await recordGuidanceRequest(attempt.leadId as Types.ObjectId, { ...input, attemptId: attempt.attemptId });
  return { requested: true };
}

// ── Admin: the complete analysis of one attempt ─────────────────────────────

export async function adminAttemptDetail(attempt: any) {
  const analysis = attempt.status === 'submitted' ? await ensureAnalysis(attempt) : null;
  const { docs, keys } = await loadAttemptPaper(attempt);
  const summary = scorePaper(keys, responsesOf(attempt, keys));
  const answersById = new Map((attempt.answers || []).map((a: any) => [String(a.questionId), a]));
  const questions = docs.map((q: any, i: number) => {
    const a: any = answersById.get(String(q._id)) || {};
    const r = summary.perQuestion[i];
    return {
      index: i + 1,
      questionId: String(q._id),
      text: String(q.text || ''),
      type: q.type || 'mcq',
      subject: q.subject || 'General',
      chapter: q.chapter || '',
      topic: q.topic || '',
      difficulty: q.difficulty || '',
      options: (q.options || []).map((o: any) => ({ id: String(o._id), text: String(o.text || ''), isCorrect: Boolean(o.isCorrect) })),
      correctAnswerText: q.correctAnswerText || (typeof q.integerAnswer === 'number' ? String(q.integerAnswer) : ''),
      chosenOptionId: a.chosenOptionId || '',
      textAnswer: a.textAnswer || '',
      markedForReview: Boolean(a.markedForReview),
      outcome: r?.outcome || 'skipped',
      awarded: r?.awarded ?? 0,
      max: r?.max ?? 1,
    };
  });
  return {
    attempt: {
      attemptId: attempt.attemptId,
      testName: attemptDisplayName(attempt),
      studentName: attempt.name,
      classLevel: attempt.classLevel,
      status: attempt.status,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      durationMins: attempt.durationMins,
      submitReason: attempt.submitReason || '',
      autoSubmitted: Boolean(attempt.autoSubmitted),
      totalScore: attempt.totalScore || 0,
      maxScore: attempt.maxScore || 0,
    },
    analysis,
    questions,
  };
}
