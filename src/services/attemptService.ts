import { Types } from 'mongoose';
import Exam from '../models/Exam';
import User from '../models/User';
import Question, { IQuestion } from '../models/Question';
import Attempt, { IAnswerItem } from '../models/Attempt';
import ExamEvaluation from '../models/ExamEvaluation';
import { computeMaxScoreForExam, sanitizeQuestion, shuffleArray } from '../utils/exam';
import { gradeSubjectiveAnswerGroq } from './aiService';
import { getClassQuestionModel } from '../models/ClassQuestion';

export async function listAssignedExams(userId: string) {
  // Published exams assigned to this user: must match user's classLevel AND (batch OR "All Batches" OR explicitly assigned)
  const user = await User.findById(userId).select('classLevel batch');
  if (!user) throw new Error('User not found');
  
  // Normalize classLevel to handle both "9" and "Class 9" formats
  const userClass = user.classLevel || '';
  const classVariants = [
    userClass,
    userClass.replace(/^Class\s*/i, ''), // "Class 9" -> "9"
    `Class ${userClass}`, // "9" -> "Class 9"
  ].filter(Boolean);
  
  // An exam that names specific students (assignedTo.users) is individually
  // targeted — it must NOT also be exposed to the whole class/batch. Only the
  // class/batch branch needs this guard; the explicit-user branch is fine.
  const notIndividuallyTargeted = {
    $or: [
      { 'assignedTo.users': { $exists: false } },
      { 'assignedTo.users': { $size: 0 } },
    ],
  };

  const exams = await Exam.find({
    isPublished: true,
    $or: [
      // Explicitly assigned to this user
      { 'assignedTo.users': new Types.ObjectId(userId) },
      // Class and batch match (including "All Batches") — only when the exam is
      // not narrowed to specific students, otherwise an individually-assigned
      // exam would leak to every student in the class via this branch.
      {
        $and: [
          notIndividuallyTargeted,
          {
            classLevel: { $in: classVariants },
            $or: [
              { batch: user.batch },
              { batch: 'All Batches' },
              { 'assignedTo.groups': { $in: [user.classLevel, user.batch].filter(Boolean) } },
            ],
          },
        ],
      },
    ],
  }).sort({ createdAt: -1 }).lean();

  // Attach this user's attempt summary to each exam so the client has a SINGLE
  // authoritative source for "already attempted" — no fragile in-memory join
  // against a separately-cached /mine response. This is what closes the
  // cross-portal re-attempt gap: an exam finished on the web shows as
  // attempted (and unstartable) in the app and vice-versa.
  const examIds = exams.map((e: any) => e._id);
  const attempts = await Attempt.find({
    userId: new Types.ObjectId(userId),
    examId: { $in: examIds },
  })
    .select('examId status totalScore maxScore percentage rankInTest resultPublished submittedAt')
    .lean();
  const attemptByExam = new Map<string, any>();
  for (const a of attempts) {
    if (!a.examId) continue;
    attemptByExam.set(a.examId.toString(), a);
  }

  return exams.map((e: any) => {
    const a = attemptByExam.get(e._id.toString());
    if (!a) return { ...e, attempt: null };
    // Score stays hidden until results are published (the exams list must not
    // reveal a score right after submission). Status/resultPublished are still
    // sent so the client can show the correct "Awaiting results" / "View result"
    // state.
    const published = !!a.resultPublished;
    return {
      ...e,
      attempt: {
        _id: a._id,
        status: a.status,
        totalScore: published ? a.totalScore : null,
        maxScore: published ? a.maxScore : null,
        percentage: published ? a.percentage : null,
        rankInTest: published ? a.rankInTest : null,
        resultPublished: published,
        submittedAt: a.submittedAt,
      },
    };
  });
}

export async function startAttempt(examId: string, userId: string) {
  const exam = await Exam.findById(examId);
  if (!exam) throw new Error('Exam not found');
  // Access control: allow start only if exam is published and either explicitly assigned, matches user's class/batch, or is in open window
  const user = await User.findById(userId).select('classLevel batch');
  const now = new Date();
  const hasSchedule = !!(exam.schedule?.startAt && exam.schedule?.endAt);
  const openWindow = hasSchedule && exam.schedule!.startAt! <= now && exam.schedule!.endAt! >= now;
  const assignedUsers = exam.assignedTo?.users || [];
  // When an exam names specific students it is individually targeted: only those
  // students may start it, and the "open window = public" fallback below must not
  // apply. Keeps access in lock-step with listAssignedExams' visibility rule.
  const isIndividuallyTargeted = assignedUsers.length > 0;
  const explicitUser = assignedUsers.some((u) => u.toString() === userId.toString());
  const groupLabels = new Set<string>([user?.classLevel || '', user?.batch || ''].filter(Boolean));
  const inGroups = (exam.assignedTo?.groups || []).some((g) => groupLabels.has(g));
  // Handle both "9" and "Class 9" formats
  const normalizeClass = (cls?: string) => cls?.replace(/^Class\s*/i, '').trim().toLowerCase() || '';
  const classMatch = !!(user?.classLevel && exam.classLevel &&
    normalizeClass(exam.classLevel) === normalizeClass(user.classLevel));
  const batchMatch = !!(user?.batch && exam.batch &&
    (exam.batch === user.batch || exam.batch === 'All Batches'));
  const targeted = isIndividuallyTargeted
    ? explicitUser
    : (inGroups || classMatch || batchMatch);
  const canAccess = exam.isPublished && (
    (targeted && (!hasSchedule || openWindow)) ||
    (!isIndividuallyTargeted && !targeted && openWindow)
  );
  if (!canAccess) throw new Error('You are not allowed to start this exam');
  // Prevent multiple attempts for same exam-user
  let attempt = await Attempt.findOne({ examId, userId });
  if (attempt) return attempt;

  // Load questions from class-specific collection
  const qids = exam.sections.flatMap((s) => s.questionIds.map((id) => id.toString()));
  let questions: IQuestion[];
  if (exam.classLevel) {
    const ClassQuestionModel = getClassQuestionModel(exam.classLevel);
    questions = await ClassQuestionModel.find({ _id: { $in: qids } });
  } else {
    questions = await Question.find({ _id: { $in: qids } });
  }
  const qmap = new Map<string, IQuestion>(questions.map((q) => [(q as any)._id.toString(), q]));

  // Build snapshot with randomization
  const sectionOrder = exam.sections.map((s) => s._id);
  const questionOrderBySection: Record<string, Types.ObjectId[]> = {};
  const optionOrderByQuestion: Record<string, Types.ObjectId[]> = {};
  const adaptiveState = exam.mode === 'adaptive' ? { asked: [], currentDifficulty: 'medium' as const, topicMix: {} as Record<string, number> } : undefined;
  for (const sec of exam.sections) {
    // Randomize question order per student by DEFAULT so every attempt gets a
    // unique sequence. Each startAttempt call draws its own Math.random() based
    // Fisher-Yates shuffle, so concurrent starts produce independent orders and
    // can't collide. A teacher can still pin a fixed order by explicitly
    // unchecking "shuffle questions" on the section (shuffleQuestions === false).
    // The order is frozen into the attempt snapshot here and never regenerated,
    // so navigation / refresh / resume keep it stable, and grading stays correct
    // because answers are always keyed by the original questionId.
    const shuffleQuestions = sec.shuffleQuestions !== false;
    const order = shuffleQuestions ? shuffleArray(sec.questionIds.map((id) => id)) : [...sec.questionIds];
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

  try {
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
  } catch (err: any) {
    // Two concurrent "start" requests (e.g. the app and the web, a double-tap,
    // or a retried POST) can both pass the findOne() above and try to create an
    // attempt. The unique (examId, userId) index rejects the loser with E11000;
    // return the attempt that won instead of erroring or duplicating.
    if (err?.code === 11000) {
      const existing = await Attempt.findOne({ examId, userId });
      if (existing) return existing;
    }
    throw err;
  }
}

export async function getAttemptView(attemptId: string, userId: string) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (attempt.userId.toString() !== userId) throw new Error('Forbidden');
  
  // Check if this is a practice test attempt
  if (attempt.practiceTestId) {
    // Import dynamically to avoid circular deps
    const PracticeTest = (await import('../models/PracticeTest')).default;
    
    const practiceTest = await PracticeTest.findById(attempt.practiceTestId);
    if (!practiceTest) throw new Error('Practice test not found');
    
    // Get questions from the class-specific collection
    const mongoose = await import('mongoose');
    const classLevel = practiceTest.classLevel || 'class_11';
    const normalized = classLevel.toLowerCase().replace(/\s+/g, '_');
    const collection = mongoose.default.connection.collection(normalized);
    
    const qids = practiceTest.questionIds.map((id: any) => new mongoose.Types.ObjectId(id));
    const questionDocs = await collection.find({ _id: { $in: qids } }).toArray();
    
    // Build sections (practice tests have a single "main" section)
    const sections = [{
      _id: 'main',
      title: 'Questions',
      questionIds: practiceTest.questionIds,
    }];
    
    // Sanitize questions (remove correct answers for in-progress, show for submitted)
    const questionDict: Record<string, any> = {};
    for (const q of questionDocs) {
      const sanitized: any = {
        _id: q._id,
        text: q.text,
        type: q.type,
        diagramUrl: q.diagramUrl,
        assertionText: q.assertion,
        reasonText: q.reason,
      };
      if (q.options) {
        if (attempt.resultPublished) {
          // Show correct answers when results are published
          sanitized.options = q.options.map((o: any) => ({
            _id: o._id,
            text: o.text,
            isCorrect: o.isCorrect,
          }));
        } else {
          sanitized.options = q.options.map((o: any) => ({
            _id: o._id,
            text: o.text,
          }));
        }
      }
      // Include explanation when results are published
      if (attempt.resultPublished && q.explanation) {
        sanitized.explanation = q.explanation;
      }
      questionDict[q._id.toString()] = sanitized;
    }
    
    // Calculate total duration
    let totalDurationMins: number | undefined;
    if (practiceTest.duration.type === 'total') {
      totalDurationMins = practiceTest.duration.totalMins;
    } else if (practiceTest.duration.type === 'per-question') {
      totalDurationMins = Math.ceil((practiceTest.questionIds.length * (practiceTest.duration.perQuestionSecs || 60)) / 60);
    }
    
    return {
      attempt,
      exam: {
        _id: practiceTest._id,
        title: practiceTest.title,
        totalDurationMins,
      },
      sections,
      questions: questionDict,
    };
  }
  
  // Regular exam attempt handling
  const exam = await Exam.findById(attempt.examId);
  if (!exam) throw new Error('Exam not found');
  const qids = exam.sections.flatMap((s) => s.questionIds);
  let questions: IQuestion[];
  if (exam.classLevel) {
    const ClassQuestionModel = getClassQuestionModel(exam.classLevel);
    questions = await ClassQuestionModel.find({ _id: { $in: qids } });
  } else {
    questions = await Question.find({ _id: { $in: qids } });
  }
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
    // If result is published, show correct answers and explanations
    if (attempt.resultPublished) {
      if (q.explanation) {
        sanitized.explanation = q.explanation;
      }
      // Include isCorrect flag for students to see correct answers after results are published
      if (q.options) {
        sanitized.options = q.options.map((o) => ({ 
          _id: o._id, 
          text: o.text,
          isCorrect: o.isCorrect // Include correct answer flag when results are published
        }));
      }
    }
    // Reorder options if snapshot exists (only if options haven't been rebuilt above)
    if (!attempt.resultPublished) {
      const optOrder = attempt.snapshot.optionOrderByQuestion?.[qid];
      if (sanitized.options && optOrder && optOrder.length === sanitized.options.length) {
        const byId: Record<string, any> = Object.fromEntries(sanitized.options.map((o: any) => [o._id.toString(), o]));
        sanitized.options = optOrder.map((id) => byId[id.toString()]);
      }
    } else {
      // For published results, also maintain the order but with isCorrect
      const optOrder = attempt.snapshot.optionOrderByQuestion?.[qid];
      if (sanitized.options && optOrder && optOrder.length === sanitized.options.length) {
        const byId: Record<string, any> = Object.fromEntries(sanitized.options.map((o: any) => [o._id.toString(), o]));
        sanitized.options = optOrder.map((id) => byId[id.toString()]);
      }
    }
    questionDict[qid] = sanitized;
  }
  return { attempt, exam: { _id: exam._id, title: exam.title, totalDurationMins: exam.totalDurationMins, antiCheat: !!exam.antiCheat }, sections, questions: questionDict };
}

export async function getAttemptViewForTeacher(attemptId: string) {
  const attempt = await Attempt.findById(attemptId).populate('userId', 'name email classLevel batch firebaseUid');
  if (!attempt) throw new Error('Attempt not found');
  const exam = await Exam.findById(attempt.examId);
  if (!exam) throw new Error('Exam not found');
  const qids = exam.sections.flatMap((s) => s.questionIds);
  let questions: IQuestion[];
  if (exam.classLevel) {
    const ClassQuestionModel = getClassQuestionModel(exam.classLevel);
    questions = await ClassQuestionModel.find({ _id: { $in: qids } });
  } else {
    questions = await Question.find({ _id: { $in: qids } });
  }
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
    // For teacher, show explanation and correct answers
    if (q.explanation) base.explanation = q.explanation;
    // Include isCorrect flag for teachers to see correct answers
    if (q.options) {
      base.options = q.options.map((o) => ({ 
        _id: o._id, 
        text: o.text,
        isCorrect: o.isCorrect // Include the correct answer flag for teachers
      }));
    }
    questionDict[qid] = base;
  }
  return { attempt, exam: { _id: exam._id, title: exam.title, totalDurationMins: exam.totalDurationMins }, sections, questions: questionDict };
}

export async function saveAnswer(attemptId: string, userId: string, answer: IAnswerItem) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (attempt.userId.toString() !== userId) throw new Error('Forbidden');
  if (!['in-progress'].includes(attempt.status)) throw new Error('Attempt not editable');
  
  // Check for time expiry - handle both regular exams and practice tests
  if (attempt.practiceTestId) {
    // Practice test - check duration from practice test
    const PracticeTest = (await import('../models/PracticeTest')).default;
    const practiceTest = await PracticeTest.findById(attempt.practiceTestId);
    if (practiceTest && practiceTest.duration.type === 'total' && practiceTest.duration.totalMins && attempt.startedAt) {
      const deadline = new Date(attempt.startedAt.getTime() + practiceTest.duration.totalMins * 60 * 1000);
      if (new Date() > deadline) {
        return submitAttempt(attemptId, userId, true);
      }
    }
  } else if (attempt.examId) {
    // Regular exam - check duration from exam
    const exam = await Exam.findById(attempt.examId);
    if (!exam) throw new Error('Exam not found');
    if ((attempt.mode || exam.mode) === 'live' && exam.totalDurationMins && attempt.startedAt) {
      const deadline = new Date(attempt.startedAt.getTime() + exam.totalDurationMins * 60 * 1000);
      if (new Date() > deadline) {
        return submitAttempt(attemptId, userId, true);
      }
    }
  }
  
  const idx = attempt.answers.findIndex((a) => a.questionId.toString() === answer.questionId.toString());
  if (idx >= 0) {
    // Non-destructive merge: only overwrite fields that were actually provided.
    // A spread merge ({ ...existing, ...answer }) would clobber chosenOptionId /
    // textAnswer with `undefined` whenever a partial update (e.g. a mark-for-review
    // toggle) comes in, silently erasing the student's saved answer. Mutate the
    // existing subdocument in place so untouched fields survive.
    const existing = attempt.answers[idx] as any;
    for (const [key, value] of Object.entries(answer)) {
      if (value !== undefined) existing[key] = value;
    }
    attempt.markModified('answers');
  } else {
    attempt.answers.push(answer);
  }
  await attempt.save();
  return attempt;
}

export async function markForReview(attemptId: string, userId: string, questionId: string, marked: boolean) {
  return saveAnswer(attemptId, userId, { questionId: new Types.ObjectId(questionId), isMarkedForReview: marked });
}

/**
 * Clear a student's selected response for a question (deselect), keeping the
 * mark-for-review flag if set. If nothing else remains on the answer, the entry
 * is removed so the question reverts to "not attempted".
 */
export async function clearAnswerResponse(attemptId: string, userId: string, questionId: string) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (attempt.userId.toString() !== userId) throw new Error('Forbidden');
  if (!['in-progress'].includes(attempt.status)) throw new Error('Attempt not editable');

  const idx = attempt.answers.findIndex((a) => a.questionId.toString() === questionId.toString());
  if (idx >= 0) {
    const a = attempt.answers[idx] as any;
    const marked = a.isMarkedForReview;
    if (marked) {
      // Keep the review flag, drop only the response fields.
      a.chosenOptionId = undefined;
      a.textAnswer = undefined;
      a.isCorrect = undefined;
      a.scoreAwarded = undefined;
    } else {
      attempt.answers.splice(idx, 1);
    }
    attempt.markModified('answers');
    await attempt.save();
  }
  return attempt;
}

// Collapse the many type aliases the web/mobile players emit into a canonical
// key (e.g. "mcq-single" / "MCQ_Single" -> "mcqsingle"). Without this the grader
// silently skipped real question types and treated them as subjective.
export function normalizeQuestionType(t?: string): string {
  return (t || '').toLowerCase().replace(/[\s_-]+/g, '');
}

const SINGLE_CHOICE_TYPES = new Set(['mcq', 'mcqsingle', 'singlechoice', 'multiplechoice']);
const TRUEFALSE_TYPES = new Set(['truefalse']);
const MULTI_SELECT_TYPES = new Set(['mcqmulti', 'multiselect', 'multipleselect', 'msq']);
const INTEGER_TYPES = new Set(['integer', 'numerical', 'numeric', 'number']);
const FILL_TYPES = new Set(['fill', 'fillblank', 'fillintheblank', 'fillups']);
const SUBJECTIVE_TYPES = new Set(['short', 'long', 'subjective', 'text', 'essay', 'descriptive']);

export function isSubjectiveType(t?: string): boolean {
  return SUBJECTIVE_TYPES.has(normalizeQuestionType(t));
}

export function gradeObjective(q: IQuestion, ans: IAnswerItem): { isCorrect: boolean; score: number } | null {
  const type = normalizeQuestionType(q.type);
  const correctOptions = (q.options || []).filter((o) => o.isCorrect);

  // Single-choice MCQ
  if (SINGLE_CHOICE_TYPES.has(type)) {
    const correctOption = correctOptions[0];
    if (!correctOption || !ans.chosenOptionId) return { isCorrect: false, score: 0 };
    const isCorrect = correctOption._id.toString() === ans.chosenOptionId.toString();
    return { isCorrect, score: isCorrect ? 1 : 0 };
  }

  // True / false: option-based OR text-based
  if (TRUEFALSE_TYPES.has(type)) {
    const correctOption = correctOptions[0];
    if (correctOption && ans.chosenOptionId) {
      const isCorrect = correctOption._id.toString() === ans.chosenOptionId.toString();
      return { isCorrect, score: isCorrect ? 1 : 0 };
    }
    const expected = (q.correctAnswerText || '').trim().toLowerCase();
    const got = (ans.textAnswer || '').trim().toLowerCase();
    const isCorrect = !!expected && got === expected;
    return { isCorrect, score: isCorrect ? 1 : 0 };
  }

  // Multi-select: chosen set must exactly equal the correct set.
  if (MULTI_SELECT_TYPES.has(type)) {
    const correctIds = correctOptions.map((o) => o._id.toString()).sort();
    let chosenIds: string[] = [];
    if (Array.isArray((ans as any).selectedOptionIds) && (ans as any).selectedOptionIds.length) {
      chosenIds = (ans as any).selectedOptionIds.map((id: any) => id.toString());
    } else if (ans.textAnswer) {
      // Players persist multi-select as a JSON array of option ids in textAnswer.
      try {
        const parsed = JSON.parse(ans.textAnswer);
        if (Array.isArray(parsed)) chosenIds = parsed.map((id) => id.toString());
      } catch {
        /* not JSON */
      }
    }
    chosenIds = chosenIds.sort();
    const isCorrect =
      correctIds.length > 0 &&
      correctIds.length === chosenIds.length &&
      correctIds.every((id, i) => id === chosenIds[i]);
    return { isCorrect, score: isCorrect ? 1 : 0 };
  }

  // Integer / numerical
  if (INTEGER_TYPES.has(type)) {
    const expected = (q.correctAnswerText ?? '').toString().trim();
    const got = (ans.textAnswer ?? '').toString().trim();
    if (expected === '' || got === '' || Number.isNaN(Number(expected)) || Number.isNaN(Number(got))) {
      return { isCorrect: false, score: 0 };
    }
    const isCorrect = Number(expected) === Number(got);
    return { isCorrect, score: isCorrect ? 1 : 0 };
  }

  // Fill in the blank
  if (FILL_TYPES.has(type)) {
    const expected = (q.correctAnswerText || '').trim().toLowerCase();
    const got = (ans.textAnswer || '').trim().toLowerCase();
    const isCorrect = expected.length > 0 && expected === got;
    return { isCorrect, score: isCorrect ? 1 : 0 };
  }

  // Assertion-Reason
  if (type === 'assertionreason') {
    // Mobile renders q.options and submits an option id -> grade like single-choice.
    if (ans.chosenOptionId && correctOptions.length) {
      const isCorrect = correctOptions[0]._id.toString() === ans.chosenOptionId.toString();
      return { isCorrect, score: isCorrect ? 1 : 0 };
    }
    // Web submits an A/B/C/D code (textAnswer) derived from assertion flags.
    // A: both true & reason explains; B: both true & not explains;
    // C: assertion true, reason false; D: assertion false, reason true.
    const aT = !!q.assertionIsTrue;
    const rT = !!q.reasonIsTrue;
    const explains = !!q.reasonExplainsAssertion;
    let correct: 'A' | 'B' | 'C' | 'D' | null = null;
    if (aT && rT && explains) correct = 'A';
    else if (aT && rT && !explains) correct = 'B';
    else if (aT && !rT) correct = 'C';
    else if (!aT && rT) correct = 'D';
    const given = (ans.textAnswer ?? ans.chosenOptionId ?? '').toString().trim().toUpperCase();
    const isCorrect = !!correct && given === correct;
    return { isCorrect, score: isCorrect ? 1 : 0 };
  }

  return null; // subjective -> AI graded
}

export async function submitAttempt(attemptId: string, userId: string, auto = false) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (attempt.userId.toString() !== userId) throw new Error('Forbidden');
  if (!['in-progress', 'created'].includes(attempt.status)) {
    // Idempotent submit: an auto-submit (time-up / tab-violation / page-unload
    // beacon) may have already finalized this attempt. Returning the existing
    // attempt instead of throwing prevents the manual "Submit" button from
    // surfacing a spurious "Submit failed" error to the student.
    return attempt;
  }

  let qmap: Map<string, any>;
  let markingScheme = { correct: 1, incorrect: 0, unattempted: 0 };
  // Max attainable raw score (sum of per-question correct marks). For exams this
  // reflects the build-time marking scheme; for practice tests, the start value.
  let baseMaxScore = attempt.maxScore || 0;

  if (attempt.practiceTestId) {
    // Practice test - load from class-specific collection
    const PracticeTest = (await import('../models/PracticeTest')).default;
    const mongoose = await import('mongoose');
    
    const practiceTest = await PracticeTest.findById(attempt.practiceTestId);
    if (!practiceTest) throw new Error('Practice test not found');
    
    // Check for time expiry
    if (practiceTest.duration.type === 'total' && practiceTest.duration.totalMins && attempt.startedAt) {
      const deadline = new Date(attempt.startedAt.getTime() + practiceTest.duration.totalMins * 60 * 1000);
      if (new Date() > deadline) {
        auto = true;
      }
    }
    
    // Use practice test marking scheme
    markingScheme = practiceTest.markingScheme;
    
    // Load questions from class-specific collection
    const classLevel = practiceTest.classLevel || 'class_11';
    const normalized = classLevel.toLowerCase().replace(/\s+/g, '_');
    const collection = mongoose.default.connection.collection(normalized);
    
    const qids = practiceTest.questionIds.map((id: any) => new mongoose.Types.ObjectId(id));
    const questionDocs = await collection.find({ _id: { $in: qids } }).toArray();
    qmap = new Map(questionDocs.map((q: any) => [q._id.toString(), q]));
  } else {
    // Regular exam
    const exam = await Exam.findById(attempt.examId);
    if (!exam) throw new Error('Exam not found');
    
    // Live mode: if time is over, force auto submit path
    if ((attempt.mode || exam.mode) === 'live' && exam.totalDurationMins && attempt.startedAt) {
      const deadline = new Date(attempt.startedAt.getTime() + exam.totalDurationMins * 60 * 1000);
      if (new Date() > deadline) {
        auto = true;
      }
    }
    
    const qids = exam.sections.flatMap((s) => s.questionIds);
    let questions: IQuestion[];
    if (exam.classLevel) {
      const ClassQuestionModel = getClassQuestionModel(exam.classLevel);
      questions = await ClassQuestionModel.find({ _id: { $in: qids } });
    } else {
      questions = await Question.find({ _id: { $in: qids } });
    }
    qmap = new Map<string, IQuestion>(questions.map((q) => [(q as any)._id.toString(), q]));
    // Grade with the exam's build-time marking scheme (e.g. +4 / -1 / 0) so the
    // provisional score matches the same logic the review module finalises with.
    markingScheme = {
      correct: exam.markingScheme?.correct ?? 1,
      incorrect: exam.markingScheme?.incorrect ?? 0,
      unattempted: exam.markingScheme?.unattempted ?? 0,
    };
    baseMaxScore = Math.round(markingScheme.correct * qids.length * 100) / 100;
  }

  let total = 0;
  for (const ans of attempt.answers) {
    const q = qmap.get(ans.questionId.toString());
    if (!q) continue;
    const graded = gradeObjective(q as IQuestion, ans);
    if (graded) {
      ans.isCorrect = graded.isCorrect;
      // Apply marking scheme
      if (graded.isCorrect) {
        ans.scoreAwarded = markingScheme.correct;
      } else {
        ans.scoreAwarded = markingScheme.incorrect;
      }
      total += ans.scoreAwarded;
    } else if (isSubjectiveType(q.type)) {
      // subjective: use AI grading (Groq)
      try {
        const r = await gradeSubjectiveAnswerGroq({
          questionText: q.text,
          studentAnswer: ans.textAnswer || '',
          rubric: q.correctAnswerText || undefined,
        });
        ans.rubricScore = r.rubricScore;
        ans.aiFeedback = r.feedback;
        // Map rubricScore (0..1) to marking scheme
        const score = typeof r.rubricScore === 'number' ? r.rubricScore * markingScheme.correct : 0;
        ans.scoreAwarded = Number(score.toFixed(2));
        total += ans.scoreAwarded;
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

  // Record the immutable raw (pre-override) scores, then apply any active
  // test-level total-marks override so a late submission is presented on the
  // same scale as the rest of the cohort. Per-test ranks are (re)assigned by
  // the propagation engine across all attempts, not here.
  attempt.rawTotalScore = total;
  attempt.rawMaxScore = baseMaxScore;
  let effTotal = total;
  let effMax = baseMaxScore || 0;
  if (attempt.examId && !attempt.practiceTestId) {
    try {
      const evaluation = await ExamEvaluation.findOne({ examId: attempt.examId }).select('totalMarksOverride overrideMode');
      const override = evaluation?.totalMarksOverride;
      if (override !== null && override !== undefined && override > 0) {
        if (evaluation!.overrideMode === 'denominator') {
          effMax = override;
        } else {
          const factor = (attempt.rawMaxScore || 0) > 0 ? override / (attempt.rawMaxScore as number) : 0;
          effTotal = Math.round(total * factor * 100) / 100;
          effMax = override;
        }
      }
    } catch {
      /* fall back to raw values */
    }
  }
  attempt.totalScore = effTotal;
  attempt.maxScore = effMax;
  // Negative marking can push the total below zero; percentage is floored at 0.
  attempt.percentage = effMax > 0 ? Math.max(0, Math.round((effTotal / effMax) * 10000) / 100) : 0;

  // Practice tests: auto-publish results immediately so students can see scores
  if (attempt.practiceTestId) {
    attempt.resultPublished = true;
    attempt.status = 'graded';
  }
  
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
  // Fetch ALL submitted attempts (both pending and published) for the reviews dashboard
  const attempts = await Attempt.find({ submittedAt: { $ne: null } })
    .populate('userId', 'name email classLevel batch firebaseUid')
    .populate('examId', 'title')
    .sort({ submittedAt: -1 })
    .limit(100)
    .lean();
  return attempts;
}

export async function adjustAnswerScore(attemptId: string, answerId: string, score: number, feedback?: string) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  
  // Find existing answer or create a new one if it doesn't exist
  let ans = attempt.answers.find(a => a.questionId.toString() === answerId);
  if (!ans) {
    // Create a new answer entry if the student didn't answer this question
    const newAnswer: IAnswerItem = {
      questionId: new Types.ObjectId(answerId),
      scoreAwarded: score,
    } as IAnswerItem;
    if (feedback) newAnswer.aiFeedback = feedback;
    attempt.answers.push(newAnswer);
  } else {
    // Update existing answer
    ans.scoreAwarded = score;
    if (feedback) ans.aiFeedback = feedback;
  }
  
  // recompute total
  attempt.totalScore = attempt.answers.reduce((sum, a) => sum + (typeof a.scoreAwarded === 'number' ? a.scoreAwarded : 0), 0);
  await attempt.save();
  return attempt;
}

export async function listAttemptsForUser(userId: string, opts: { published?: boolean } = {}) {
  const criteria: any = { userId: new Types.ObjectId(userId) };
  if (opts.published) criteria.resultPublished = true;
  const attempts = await Attempt.find(criteria)
    .sort({ submittedAt: -1, createdAt: -1 })
    .populate('examId', 'title')
    .populate('practiceTestId', 'title')
    .lean();

  // Exclude orphaned attempts whose exam (or practice test) has been deleted.
  // After populate these have a null ref and would otherwise surface as
  // "Exam Not Found" in the student's results / recent attempts.
  const validAttempts = attempts.filter((a) => a.examId || a.practiceTestId);

  return validAttempts.map(a => {
    // Determine if this is a practice test or regular exam
    const isPracticeTest = !!a.practiceTestId;
    let title = 'Exam Not Found';
    let id: string | null = null;
    
    if (isPracticeTest && a.practiceTestId) {
      // Practice test attempt
      const pt = a.practiceTestId as any;
      title = pt.title || 'Practice Test';
      id = pt._id?.toString() || a.practiceTestId.toString();
    } else if (a.examId) {
      // Regular exam attempt
      const exam = a.examId as any;
      title = exam.title || 'Exam Not Found';
      id = exam._id?.toString() || (a.examId instanceof Types.ObjectId ? a.examId.toString() : null);
    }
    
    const maxScore = a.maxScore;
    const totalScore = a.totalScore;

    // Per-attempt counts so the results list/detail can show accurate
    // "X / Y correct" without a second round-trip. Mirrors the detail screen's
    // own tally: a question is "attempted" if it has a response, and "correct"
    // if auto-graded correct OR awarded positive marks (covers subjective).
    const answers = (a.answers || []) as any[];
    const attemptedCount = answers.filter(
      (ans) => ans.chosenOptionId || (ans.textAnswer != null && String(ans.textAnswer) !== '')
    ).length;
    const correctCount = answers.filter(
      (ans) => ans.isCorrect === true || (typeof ans.scoreAwarded === 'number' && ans.scoreAwarded > 0)
    ).length;
    // Total questions from the immutable per-attempt snapshot (no extra join).
    const orderBySection = (a.snapshot?.questionOrderBySection || {}) as Record<string, any[]>;
    const totalQuestions =
      Object.values(orderBySection).reduce((sum, ids) => sum + (Array.isArray(ids) ? ids.length : 0), 0) ||
      answers.length;

    // Results (score, percentage, rank, percentile, correct count) stay HIDDEN
    // until the teacher publishes them. Practice tests auto-publish, so they
    // pass. Withholding server-side guarantees the student can't see a score
    // pre-publish even if a client forgets to gate. (The web results page uses
    // ?published=1 so it only ever receives published rows anyway.)
    const published = !!a.resultPublished;
    const livePercentage =
      typeof a.percentage === 'number'
        ? a.percentage
        : maxScore && maxScore > 0
        ? Math.round(((totalScore || 0) / maxScore) * 10000) / 100
        : 0;

    return {
      _id: a._id,
      examId: !isPracticeTest ? id : null,
      practiceTestId: isPracticeTest ? id : null,
      examTitle: title,
      isPracticeTest,
      submittedAt: a.submittedAt,
      totalScore: published ? totalScore : null,
      maxScore: published ? maxScore : null,
      percentage: published ? livePercentage : null,
      rankInTest: published ? a.rankInTest ?? null : null,
      percentile: published && typeof a.percentile === 'number' ? a.percentile : null,
      correctCount: published ? correctCount : null,
      // Not a "result"/score — safe to show so the student knows what they did.
      attemptedCount,
      totalQuestions,
      status: a.status,
      resultPublished: published,
    };
  });
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
  let questions: IQuestion[];
  if (exam.classLevel) {
    const ClassQuestionModel = getClassQuestionModel(exam.classLevel);
    questions = await ClassQuestionModel.find({ _id: { $in: qids } });
  } else {
    questions = await Question.find({ _id: { $in: qids } });
  }
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
