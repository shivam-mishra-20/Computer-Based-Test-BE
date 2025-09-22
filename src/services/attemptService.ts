import { Types } from 'mongoose';
import Exam from '../models/Exam';
import User from '../models/User';
import Question, { IQuestion } from '../models/Question';
import Attempt, { IAnswerItem } from '../models/Attempt';
import { computeMaxScoreForExam, sanitizeQuestion, shuffleArray } from '../utils/exam';
import { gradeSubjectiveAnswerGroq } from './aiService';

export async function listAssignedExams(userId: string) {
  // Published exams assigned to this user, matching user's class/batch via groups, or open-window exams
  const now = new Date();
  const user = await User.findById(userId).select('classLevel batch');
  const groupLabels = [] as string[];
  if (user?.classLevel) groupLabels.push(user.classLevel);
  if (user?.batch) groupLabels.push(user.batch);
  const exams = await Exam.find({
    isPublished: true,
    $or: [
      { 'assignedTo.users': new Types.ObjectId(userId) },
      ...(groupLabels.length ? [{ 'assignedTo.groups': { $in: groupLabels } }] : []),
      // also include exams targeted by top-level class/batch
      ...(user?.classLevel ? [{ classLevel: user.classLevel }] : []),
      ...(user?.batch ? [{ batch: user.batch }] : []),
      { 'schedule.startAt': { $lte: now }, 'schedule.endAt': { $gte: now } },
    ],
  }).sort({ createdAt: -1 });
  return exams;
}

export async function startAttempt(examId: string, userId: string) {
  const exam = await Exam.findById(examId);
  if (!exam) throw new Error('Exam not found');
  // Access control: allow start only if exam is published and either explicitly assigned, matches user's class/batch, or is in open window
  const user = await User.findById(userId).select('classLevel batch');
  const now = new Date();
  const hasSchedule = !!(exam.schedule?.startAt && exam.schedule?.endAt);
  const openWindow = hasSchedule && exam.schedule!.startAt! <= now && exam.schedule!.endAt! >= now;
  const explicitUser = (exam.assignedTo?.users || []).some((u) => u.toString() === userId.toString());
  const groupLabels = new Set<string>([user?.classLevel || '', user?.batch || ''].filter(Boolean));
  const inGroups = (exam.assignedTo?.groups || []).some((g) => groupLabels.has(g));
  const classMatch = !!(user?.classLevel && exam.classLevel && exam.classLevel === user.classLevel);
  const batchMatch = !!(user?.batch && exam.batch && exam.batch === user.batch);
  const targeted = explicitUser || inGroups || classMatch || batchMatch;
  const canAccess = exam.isPublished && (
    (targeted && (!hasSchedule || openWindow)) ||
    (!targeted && openWindow)
  );
  if (!canAccess) throw new Error('You are not allowed to start this exam');
  // Prevent multiple attempts for same exam-user
  let attempt = await Attempt.findOne({ examId, userId });
  if (attempt) return attempt;

  // Load questions
  const qids = exam.sections.flatMap((s) => s.questionIds.map((id) => id.toString()));
  const questions = await Question.find({ _id: { $in: qids } });
  const qmap = new Map<string, IQuestion>(questions.map((q) => [(q as any)._id.toString(), q]));

  // Build snapshot with randomization
  const sectionOrder = exam.sections.map((s) => s._id);
  const questionOrderBySection: Record<string, Types.ObjectId[]> = {};
  const optionOrderByQuestion: Record<string, Types.ObjectId[]> = {};
  const adaptiveState = exam.mode === 'adaptive' ? { asked: [], currentDifficulty: 'medium' as const, topicMix: {} as Record<string, number> } : undefined;
  for (const sec of exam.sections) {
    const order = sec.shuffleQuestions ? shuffleArray(sec.questionIds.map((id) => id)) : [...sec.questionIds];
    questionOrderBySection[sec._id.toString()] = order;
    if (sec.shuffleOptions) {
      for (const qid of order) {
        const q = qmap.get(qid.toString());
        if (q?.options && q.options.length > 0) {
          optionOrderByQuestion[qid.toString()] = shuffleArray(q.options.map((o) => o._id));
        }
      }
    }
  }

  attempt = await Attempt.create({
    examId: new Types.ObjectId(examId),
    userId: new Types.ObjectId(userId),
    mode: exam.mode || 'live',
    status: 'in-progress',
    startedAt: new Date(),
    snapshot: { sectionOrder, questionOrderBySection, optionOrderByQuestion, adaptiveState },
    answers: [],
    maxScore: computeMaxScoreForExam(exam, qmap),
  });
  return attempt;
}

export async function getAttemptView(attemptId: string, userId: string) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (attempt.userId.toString() !== userId) throw new Error('Forbidden');
  const exam = await Exam.findById(attempt.examId);
  if (!exam) throw new Error('Exam not found');
  const qids = exam.sections.flatMap((s) => s.questionIds);
  const questions = await Question.find({ _id: { $in: qids } });
  const qmap = new Map<string, IQuestion>(questions.map((q) => [(q as any)._id.toString(), q]));

  // Build sanitized view per snapshot order
  const sections = exam.sections.map((s) => ({
    _id: s._id,
    title: s.title,
    sectionDurationMins: s.sectionDurationMins,
    questionIds: attempt.snapshot.questionOrderBySection[s._id.toString()] || [],
  }));
  const questionDict: Record<string, any> = {};
  for (const [qid, q] of qmap) {
    const sanitized: any = sanitizeQuestion(q);
    // Practice mode: reveal explanation only if answered
    if (attempt.mode === 'practice') {
      const answered = attempt.answers.find((a) => a.questionId.toString() === qid);
      if (answered && q.explanation) {
        sanitized.explanation = q.explanation;
      }
    }
    // Reorder options if snapshot exists
    const optOrder = attempt.snapshot.optionOrderByQuestion?.[qid];
    if (sanitized.options && optOrder && optOrder.length === sanitized.options.length) {
      const byId: Record<string, any> = Object.fromEntries(sanitized.options.map((o: any) => [o._id.toString(), o]));
      sanitized.options = optOrder.map((id) => byId[id.toString()]);
    }
    questionDict[qid] = sanitized;
  }
  return { attempt, exam: { _id: exam._id, title: exam.title, totalDurationMins: exam.totalDurationMins }, sections, questions: questionDict };
}

export async function getAttemptViewForTeacher(attemptId: string) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  const exam = await Exam.findById(attempt.examId);
  if (!exam) throw new Error('Exam not found');
  const qids = exam.sections.flatMap((s) => s.questionIds);
  const questions = await Question.find({ _id: { $in: qids } });
  const qmap = new Map<string, IQuestion>(questions.map((q) => [(q as any)._id.toString(), q]));
  const sections = exam.sections.map((s) => ({
    _id: s._id,
    title: s.title,
    sectionDurationMins: s.sectionDurationMins,
    questionIds: attempt.snapshot.questionOrderBySection[s._id.toString()] || [],
  }));
  const questionDict: Record<string, any> = {};
  for (const [qid, q] of qmap) {
    const base: any = sanitizeQuestion(q);
    // For teacher show explanation
    if (q.explanation) base.explanation = q.explanation;
    questionDict[qid] = base;
  }
  return { attempt, exam: { _id: exam._id, title: exam.title, totalDurationMins: exam.totalDurationMins }, sections, questions: questionDict };
}

export async function saveAnswer(attemptId: string, userId: string, answer: IAnswerItem) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (attempt.userId.toString() !== userId) throw new Error('Forbidden');
  if (!['in-progress'].includes(attempt.status)) throw new Error('Attempt not editable');
  // Live mode: enforce totalDurationMins
  const exam = await Exam.findById(attempt.examId);
  if (!exam) throw new Error('Exam not found');
  if ((attempt.mode || exam.mode) === 'live' && exam.totalDurationMins && attempt.startedAt) {
    const deadline = new Date(attempt.startedAt.getTime() + exam.totalDurationMins * 60 * 1000);
    if (new Date() > deadline) {
      // autosubmit and return
      return submitAttempt(attemptId, userId, true);
    }
  }
  const idx = attempt.answers.findIndex((a) => a.questionId.toString() === answer.questionId.toString());
  if (idx >= 0) {
    attempt.answers[idx] = { ...attempt.answers[idx], ...answer };
  } else {
    attempt.answers.push(answer);
  }
  await attempt.save();
  return attempt;
}

export async function markForReview(attemptId: string, userId: string, questionId: string, marked: boolean) {
  return saveAnswer(attemptId, userId, { questionId: new Types.ObjectId(questionId), isMarkedForReview: marked });
}

function gradeObjective(q: IQuestion, ans: IAnswerItem): { isCorrect: boolean; score: number } | null {
  if (q.type === 'mcq' || q.type === 'truefalse') {
    const correctOption = q.options?.find((o) => o.isCorrect);
    if (q.type === 'mcq') {
      if (!correctOption || !ans.chosenOptionId) return { isCorrect: false, score: 0 };
      const isCorrect = correctOption._id.toString() === ans.chosenOptionId.toString();
      return { isCorrect, score: isCorrect ? 1 : 0 };
    } else {
      // true/false: support either option-based or textAnswer-based
      if (correctOption && ans.chosenOptionId) {
        const isCorrect = correctOption._id.toString() === ans.chosenOptionId.toString();
        return { isCorrect, score: isCorrect ? 1 : 0 };
      }
      const expected = (q.correctAnswerText || '').trim().toLowerCase();
      const got = (ans.textAnswer || '').trim().toLowerCase();
      const isCorrect = !!expected && (got === expected || (got === 'true' && expected === 'true') || (got === 'false' && expected === 'false'));
      return { isCorrect, score: isCorrect ? 1 : 0 };
    }
  }
  if (q.type === 'fill') {
    const expected = (q.correctAnswerText || '').trim().toLowerCase();
    const got = (ans.textAnswer || '').trim().toLowerCase();
    const isCorrect = expected.length > 0 && expected === got;
    return { isCorrect, score: isCorrect ? 1 : 0 };
  }
  if (q.type === 'assertionreason') {
    // Expected mapping:
    // A: Both true and reason explains assertion
    // B: Both true but reason does not explain assertion
    // C: Assertion true, reason false
    // D: Assertion false, reason true
    const aT = !!q.assertionIsTrue; 
    const rT = !!q.reasonIsTrue;
    const explains = !!q.reasonExplainsAssertion;
    let correct: 'A'|'B'|'C'|'D' | null = null;
    if (aT && rT && explains) correct = 'A';
    else if (aT && rT && !explains) correct = 'B';
    else if (aT && !rT) correct = 'C';
    else if (!aT && rT) correct = 'D';
    // Accept textAnswer or chosenOptionId codes
    const given = ((ans.textAnswer !== undefined && ans.textAnswer !== null)
      ? ans.textAnswer
      : (ans.chosenOptionId !== undefined && ans.chosenOptionId !== null)
        ? ans.chosenOptionId
        : '').toString().trim().toUpperCase();
    const isCorrect = !!correct && typeof given === 'string' && given === correct ? true : false;
    return { isCorrect, score: isCorrect ? 1 : 0 };
  }
  return null; // subjective
}

export async function submitAttempt(attemptId: string, userId: string, auto = false) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (attempt.userId.toString() !== userId) throw new Error('Forbidden');
  if (!['in-progress', 'created'].includes(attempt.status)) throw new Error('Attempt already submitted');

  const exam = await Exam.findById(attempt.examId);
  if (!exam) throw new Error('Exam not found');
  // Live mode: if time is over, force auto submit path (still grade)
  if ((attempt.mode || exam.mode) === 'live' && exam.totalDurationMins && attempt.startedAt) {
    const deadline = new Date(attempt.startedAt.getTime() + exam.totalDurationMins * 60 * 1000);
    if (new Date() > deadline) {
      auto = true;
    }
  }
  const qids = exam.sections.flatMap((s) => s.questionIds);
  const questions = await Question.find({ _id: { $in: qids } });
  const qmap = new Map<string, IQuestion>(questions.map((q) => [(q as any)._id.toString(), q]));

  let total = 0;
  for (const ans of attempt.answers) {
    const q = qmap.get(ans.questionId.toString());
    if (!q) continue;
    const graded = gradeObjective(q, ans);
    if (graded) {
      ans.isCorrect = graded.isCorrect;
      ans.scoreAwarded = graded.score;
      total += graded.score;
    } else if (q.type === 'short' || q.type === 'long') {
      // subjective: use AI grading (Groq)
      try {
        const r = await gradeSubjectiveAnswerGroq({
          questionText: q.text,
          studentAnswer: ans.textAnswer || '',
          rubric: q.correctAnswerText || undefined,
        });
        ans.rubricScore = r.rubricScore;
        ans.aiFeedback = r.feedback;
        // Map rubricScore (0..1) to 1 point scale for now
        const score = typeof r.rubricScore === 'number' ? Number(r.rubricScore.toFixed(2)) : 0;
        ans.scoreAwarded = score;
        total += score;
      } catch (e) {
        // If AI grading fails, record zero but continue
        ans.rubricScore = 0;
        ans.aiFeedback = 'AI grading unavailable';
        ans.scoreAwarded = 0;
      }
    }
  }
  attempt.totalScore = total;
  attempt.submittedAt = new Date();
  attempt.status = auto ? 'auto-submitted' : 'submitted';
  await attempt.save();
  return attempt;
}

export async function publishResult(attemptId: string, publish = true) {
  const attempt = await Attempt.findByIdAndUpdate(
    attemptId,
    { resultPublished: publish, status: 'graded' },
    { new: true }
  );
  return attempt;
}

export async function listPendingReviewAttempts() {
  return Attempt.find({ submittedAt: { $ne: null }, resultPublished: { $ne: true } })
    .sort({ submittedAt: -1 })
    .limit(100)
    .lean();
}

export async function adjustAnswerScore(attemptId: string, answerId: string, score: number, feedback?: string) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  const ans = attempt.answers.find(a => a.questionId.toString() === answerId);
  if (!ans) throw new Error('Answer not found');
  ans.scoreAwarded = score;
  if (feedback) ans.aiFeedback = feedback;
  // recompute total
  attempt.totalScore = attempt.answers.reduce((sum, a) => sum + (typeof a.scoreAwarded === 'number' ? a.scoreAwarded : 0), 0);
  await attempt.save();
  return attempt;
}

export async function listAttemptsForUser(userId: string, opts: { published?: boolean } = {}) {
  const criteria: any = { userId: new Types.ObjectId(userId) };
  if (opts.published) criteria.resultPublished = true;
  return Attempt.find(criteria)
    .sort({ submittedAt: -1, createdAt: -1 })
    .populate('examId', 'title')
    .lean()
    .then(list => list.map(a => ({
      _id: a._id,
      examId: a.examId instanceof Types.ObjectId ? a.examId.toString() : (a.examId as any)._id?.toString?.(),
      examTitle: (a as any).examId?.title || 'Exam',
      submittedAt: a.submittedAt,
      totalScore: a.totalScore,
      maxScore: a.maxScore,
      status: a.status,
      resultPublished: a.resultPublished,
    })));
}

export async function logActivity(attemptId: string, userId: string, type: 'focus-lost' | 'fullscreen-exit' | 'suspicious' | 'navigation', meta?: any) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (attempt.userId.toString() !== userId) throw new Error('Forbidden');
  attempt.activityLogs = attempt.activityLogs || [];
  attempt.activityLogs.push({ at: new Date(), type, meta });
  await attempt.save();
  return attempt.activityLogs[attempt.activityLogs.length - 1];
}

export async function nextAdaptiveQuestion(attemptId: string, userId: string) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (attempt.userId.toString() !== userId) throw new Error('Forbidden');
  const exam = await Exam.findById(attempt.examId);
  if (!exam) throw new Error('Exam not found');
  if (attempt.mode !== 'adaptive' && exam.mode !== 'adaptive') throw new Error('Attempt is not adaptive');

  // Gather pool
  const qids = exam.sections.flatMap((s) => s.questionIds);
  const questions = await Question.find({ _id: { $in: qids } });
  const askedSet = new Set((attempt.snapshot.adaptiveState?.asked || []).map((id) => id.toString()));

  // Determine current difficulty based on last answer
  const state = attempt.snapshot.adaptiveState || { asked: [], currentDifficulty: 'medium' as const };
  const last = [...attempt.answers].reverse().find((a) => !!a.scoreAwarded || a.isCorrect !== undefined);
  if (last) {
    // if answered correctly (or rubricScore > 0.6), go harder, else easier
    const correct = last.isCorrect || (typeof last.rubricScore === 'number' && last.rubricScore > 0.6);
    const order: ('easy'|'medium'|'hard')[] = ['easy','medium','hard'];
    let idx = order.indexOf(state.currentDifficulty);
    idx = correct ? Math.min(2, idx + 1) : Math.max(0, idx - 1);
    state.currentDifficulty = order[idx];
  }

  // Filter candidates
  const candidates = questions.filter((q) => !askedSet.has((q as any)._id.toString()) && (q.tags?.difficulty || 'medium') === state.currentDifficulty);
  const pick = (arr: any[]) => arr[Math.floor(Math.random() * arr.length)];
  let chosen = candidates.length ? pick(candidates) : undefined;
  if (!chosen) {
    // fallback to any unasked
    const unasked = questions.filter((q) => !askedSet.has((q as any)._id.toString()));
    chosen = unasked.length ? pick(unasked) : undefined;
  }
  if (!chosen) return { done: true };
  // Update state
  state.asked = [...(state.asked || []), (chosen as any)._id];
  attempt.snapshot.adaptiveState = state as any;
  await attempt.save();
  return { questionId: (chosen as any)._id };
}
