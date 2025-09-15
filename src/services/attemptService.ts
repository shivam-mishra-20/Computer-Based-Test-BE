import { Types } from 'mongoose';
import Exam from '../models/Exam';
import Question, { IQuestion } from '../models/Question';
import Attempt, { IAttempt, IAnswerItem } from '../models/Attempt';
import { computeMaxScoreForExam, sanitizeQuestion, shuffleArray } from '../utils/exam';

export async function listAssignedExams(userId: string) {
  // Simple criteria: published exams assigned to this user or open-window exams
  const now = new Date();
  const exams = await Exam.find({
    isPublished: true,
    $or: [
      { 'assignedTo.users': new Types.ObjectId(userId) },
      { 'schedule.startAt': { $lte: now }, 'schedule.endAt': { $gte: now } },
    ],
  }).sort({ createdAt: -1 });
  return exams;
}

export async function startAttempt(examId: string, userId: string) {
  const exam = await Exam.findById(examId);
  if (!exam) throw new Error('Exam not found');
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
    status: 'in-progress',
    startedAt: new Date(),
    snapshot: { sectionOrder, questionOrderBySection, optionOrderByQuestion },
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
    const sanitized = sanitizeQuestion(q);
    // Reorder options if snapshot exists
    const optOrder = attempt.snapshot.optionOrderByQuestion?.[qid];
    if (sanitized.options && optOrder && optOrder.length === sanitized.options.length) {
      const byId: Record<string, any> = Object.fromEntries(sanitized.options.map((o) => [o._id.toString(), o]));
      sanitized.options = optOrder.map((id) => byId[id.toString()]);
    }
    questionDict[qid] = sanitized;
  }
  return { attempt, exam: { _id: exam._id, title: exam.title, totalDurationMins: exam.totalDurationMins }, sections, questions: questionDict };
}

export async function saveAnswer(attemptId: string, userId: string, answer: IAnswerItem) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (attempt.userId.toString() !== userId) throw new Error('Forbidden');
  if (!['in-progress'].includes(attempt.status)) throw new Error('Attempt not editable');
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
    if (!correctOption || !ans.chosenOptionId) return { isCorrect: false, score: 0 };
    const isCorrect = correctOption._id.toString() === ans.chosenOptionId.toString();
    return { isCorrect, score: isCorrect ? 1 : 0 };
  }
  if (q.type === 'fill') {
    const expected = (q.correctAnswerText || '').trim().toLowerCase();
    const got = (ans.textAnswer || '').trim().toLowerCase();
    const isCorrect = expected.length > 0 && expected === got;
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

export async function logActivity(attemptId: string, userId: string, type: 'focus-lost' | 'fullscreen-exit' | 'suspicious' | 'navigation', meta?: any) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (attempt.userId.toString() !== userId) throw new Error('Forbidden');
  attempt.activityLogs = attempt.activityLogs || [];
  attempt.activityLogs.push({ at: new Date(), type, meta });
  await attempt.save();
  return attempt.activityLogs[attempt.activityLogs.length - 1];
}
