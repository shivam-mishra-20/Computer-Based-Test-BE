import { Types } from 'mongoose';
import Exam from '../models/Exam';
import User from '../models/User';
import Question, { IQuestion } from '../models/Question';
import Attempt, { IAnswerItem } from '../models/Attempt';
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
  
  const exams = await Exam.find({
    isPublished: true,
    $or: [
      // Explicitly assigned to this user
      { 'assignedTo.users': new Types.ObjectId(userId) },
      // Class and batch match (including "All Batches")
      {
        classLevel: { $in: classVariants },
        $or: [
          { batch: user.batch },
          { batch: 'All Batches' },
          { 'assignedTo.groups': { $in: [user.classLevel, user.batch].filter(Boolean) } },
        ],
      },
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
  // Handle both "9" and "Class 9" formats
  const normalizeClass = (cls?: string) => cls?.replace(/^Class\s*/i, '').trim().toLowerCase() || '';
  const classMatch = !!(user?.classLevel && exam.classLevel && 
    normalizeClass(exam.classLevel) === normalizeClass(user.classLevel));
  const batchMatch = !!(user?.batch && exam.batch && 
    (exam.batch === user.batch || exam.batch === 'All Batches'));
  const targeted = explicitUser || inGroups || classMatch || batchMatch;
  const canAccess = exam.isPublished && (
    (targeted && (!hasSchedule || openWindow)) ||
    (!targeted && openWindow)
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
  return { attempt, exam: { _id: exam._id, title: exam.title, totalDurationMins: exam.totalDurationMins }, sections, questions: questionDict };
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

  let qmap: Map<string, any>;
  let markingScheme = { correct: 1, incorrect: 0, unattempted: 0 };
  
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
  
  return attempts.map(a => {
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
    
    return {
      _id: a._id,
      examId: !isPracticeTest ? id : null,
      practiceTestId: isPracticeTest ? id : null,
      examTitle: title,
      isPracticeTest,
      submittedAt: a.submittedAt,
      totalScore: a.totalScore,
      maxScore: a.maxScore,
      status: a.status,
      resultPublished: a.resultPublished,
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
