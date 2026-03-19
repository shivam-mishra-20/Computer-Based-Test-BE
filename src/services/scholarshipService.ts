import ScholarshipAttempt from '../models/ScholarshipAttempt';
import ScholarshipTest from '../models/ScholarshipTest';
import { getClassQuestionModel } from '../models/ClassQuestion';
import { Types } from 'mongoose';

const SCHOLARSHIP_BOARD_PATTERN = /scholarship/i;

function expandSubjectAliases(subject: string): string[] {
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

function normalizeSubjects(input: any[]): string[] {
  if (!Array.isArray(input)) return [];

  const canonical = input
    .map((s) => normalizeSubjectName(s))
    .filter((s): s is string => Boolean(s));

  return Array.from(new Set(canonical));
}

// Generate unique attempt ID
function generateAttemptId(classLevel: number): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomStr = '';

  for (let i = 0; i < 4; i++) {
    randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return `SCH-${classLevel}-${dd}${mm}${yy}-${randomStr}`;
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
  const base = `${slugify(testName || 'scholarship-test') || 'scholarship-test'}${classPart ? `-class-${classPart}` : ''}`;
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

  const generated = await generateLogicalShareLink(test?.testName || 'scholarship-test', test?.eligibleClasses || []);
  await ScholarshipTest.updateOne({ _id: test._id }, { shareLink: generated });
  return generated;
}

// Get random questions from a pool
function getRandomQuestions<T>(questions: T[], count: number): T[] {
  const shuffled = [...questions].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
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
    return {
      questionId,
      ...answer,
    };
  }

  if (typeof answer === 'string') {
    return {
      questionId,
      // For MCQ answers, frontend sends selected option id as a string.
      chosenOptionId: answer,
      // For short-answer questions, frontend may send text as a string.
      textAnswer: answer,
    };
  }

  if (answer !== undefined && answer !== null) {
    return {
      questionId,
      textAnswer: String(answer),
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

export async function createScholarshipAttempt(
  name: string,
  phone: string,
  classLevel: number,
  testId?: string
) {
  // Generate unique attempt ID
  let attemptId = generateAttemptId(classLevel);
  let exists = await ScholarshipAttempt.findOne({ attemptId });

  while (exists) {
    attemptId = generateAttemptId(classLevel);
    exists = await ScholarshipAttempt.findOne({ attemptId });
  }

  let subjects = ['Mathematics', 'Science'];
  let questionsPerSubject = 15;
  let durationMins = 60;

  if (testId) {
    const test = Types.ObjectId.isValid(testId)
      ? await ScholarshipTest.findById(testId).lean()
      : await ScholarshipTest.findOne({ shareLink: testId }).lean();

    if (!test || !test.isActive) {
      throw new Error('Selected scholarship test is not available');
    }

    if (!test.eligibleClasses.includes(classLevel)) {
      throw new Error(`Class ${classLevel} is not eligible for this test`);
    }

    const normalizedSubjects = normalizeSubjects(test.subjects || []);
    if (normalizedSubjects.length === 0) {
      throw new Error('Selected scholarship test has no valid subjects configured');
    }

    subjects = normalizedSubjects;
    questionsPerSubject = test.questionsPerSubject || 15;
    durationMins = test.durationMins || 60;
  }

  const ClassQuestionModel = getClassQuestionModel(`Class ${classLevel}`);

  const subjectQuestions: Record<string, string[]> = {};
  const allQuestionIds: string[] = [];

  for (const subject of subjects) {
    const subjectPool = expandSubjectAliases(subject);
    const questions = await ClassQuestionModel.find({
      subject: { $in: subjectPool },
      board: SCHOLARSHIP_BOARD_PATTERN,
      isActive: true,
    })
      .select('_id')
      .limit(questionsPerSubject * 3)
      .lean();

    if (questions.length < questionsPerSubject) {
      throw new Error(
        `Not enough Scholarship-board questions for Class ${classLevel} - ${subject}. ` +
          `Required: ${questionsPerSubject}, Found: ${questions.length}`
      );
    }

    const randomQs = getRandomQuestions(questions, questionsPerSubject);
    const questionIds = randomQs.map((q: any) => q._id.toString());

    subjectQuestions[subject] = questionIds;
    allQuestionIds.push(...questionIds);
  }

  const attempt = await ScholarshipAttempt.create({
    attemptId,
    name,
    phone,
    classLevel,
    durationMins,
    questions: allQuestionIds,
    subjectQuestions,
    status: 'in-progress',
  });

  return {
    attemptId: attempt.attemptId,
    _id: attempt._id,
    startedAt: attempt.startedAt,
    durationMins: attempt.durationMins,
  };
}

export async function getScholarshipAttempt(attemptId: string) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  const ClassQuestionModel = getClassQuestionModel(`Class ${attempt.classLevel}`);
  const questions = await ClassQuestionModel.find({
    _id: { $in: attempt.questions.map((id) => new Types.ObjectId(id)) },
  }).lean();

  const questionDetails = questions.map((q: any) => ({
    _id: q._id.toString(),
    text: q.text,
    type: q.type || 'mcq',
    options: q.options || [],
    subject: q.subject,
    chapter: q.chapter,
    topic: q.topic,
    marks: q.marks || 1,
    difficulty: q.difficulty,
    diagramUrl: q.diagramUrl,
  }));

  return {
    attemptId: attempt.attemptId,
    name: attempt.name,
    classLevel: attempt.classLevel,
    durationMins: attempt.durationMins,
    startedAt: attempt.startedAt,
    status: attempt.status,
    questions: questionDetails,
    questionIds: attempt.questions,
    subjectQuestions: attempt.subjectQuestions,
    answers: attempt.answers,
  };
}

export async function saveScholarshipAnswer(
  attemptId: string,
  questionId: string,
  answer: any
) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  if (attempt.status === 'submitted') {
    throw new Error('Attempt already submitted');
  }

  const normalizedAnswer = normalizeSingleAnswer(questionId, answer);
  if (!normalizedAnswer) {
    throw new Error('Invalid answer payload');
  }

  const existingAnswerIndex = attempt.answers.findIndex(
    (a) => a.questionId === questionId
  );

  if (existingAnswerIndex >= 0) {
    attempt.answers[existingAnswerIndex] = {
      ...attempt.answers[existingAnswerIndex],
      ...normalizedAnswer,
    };
  } else {
    attempt.answers.push(normalizedAnswer);
  }

  await attempt.save();
  return { success: true };
}

export async function submitScholarshipTest(attemptId: string, answers: any) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  if (attempt.status === 'submitted') {
    throw new Error('Attempt already submitted');
  }

  const normalizedAnswers = normalizeSubmittedAnswers(answers);

  for (const answer of normalizedAnswers) {
    const existingIndex = attempt.answers.findIndex(
      (a) => a.questionId === answer.questionId
    );

    if (existingIndex >= 0) {
      attempt.answers[existingIndex] = {
        ...attempt.answers[existingIndex],
        ...answer,
      };
    } else {
      attempt.answers.push(answer);
    }
  }

  attempt.status = 'submitted';
  attempt.submittedAt = new Date();

  await attempt.save();

  return {
    attemptId: attempt.attemptId,
    status: attempt.status,
    submittedAt: attempt.submittedAt,
    message: 'Test submitted successfully. Results will be published soon.',
  };
}

export async function gradeScholarshipAttempt(attemptId: string) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  const ClassQuestionModel = getClassQuestionModel(`Class ${attempt.classLevel}`);
  const questions = await ClassQuestionModel.find({
    _id: { $in: attempt.questions.map((id) => new Types.ObjectId(id)) },
  }).lean();

  const questionMap = new Map(questions.map((q: any) => [q._id.toString(), q]));
  let totalScore = 0;
  let maxScore = 0;

  for (const answer of attempt.answers) {
    const question = questionMap.get(answer.questionId);
    if (!question) {
      continue;
    }

    const marks = question.marks || 1;
    maxScore += marks;

    if (question.type === 'mcq') {
      const correctOption = question.options?.find((opt: any) => opt.isCorrect);
      if (correctOption && answer.chosenOptionId === correctOption._id.toString()) {
        answer.marks = marks;
        answer.isCorrect = true;
        totalScore += marks;
      } else {
        answer.marks = 0;
        answer.isCorrect = false;
      }
    } else if (question.type === 'short-answer') {
      answer.marks = 0;
      answer.isCorrect = false;
    }
  }

  attempt.totalScore = totalScore;
  attempt.maxScore = maxScore;
  await attempt.save();

  const percentage = maxScore > 0 ? ((totalScore / maxScore) * 100).toFixed(2) : '0.00';
  return { totalScore, maxScore, percentage };
}

export async function getScholarshipResults(filters: any = {}) {
  const query: any = {};

  if (filters.classLevel) {
    query.classLevel = filters.classLevel;
  }

  if (filters.publishedOnly) {
    query.resultPublished = true;
  }

  const attempts = await ScholarshipAttempt.find(query)
    .select('attemptId name phone classLevel totalScore maxScore resultPublished submittedAt')
    .sort({ submittedAt: -1 });

  return attempts;
}

export async function publishScholarshipResults(classLevel?: number) {
  const query: any = { status: 'submitted' };

  if (classLevel) {
    query.classLevel = classLevel;
  }

  const attempts = await ScholarshipAttempt.find(query);

  for (const attempt of attempts) {
    await gradeScholarshipAttempt(attempt.attemptId);
  }

  const result = await ScholarshipAttempt.updateMany(query, { resultPublished: true });

  return {
    published: result.modifiedCount,
    message: `${result.modifiedCount} results published successfully`,
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
        `Not enough Scholarship-board questions for Class ${previewClass} - ${subject}. ` +
          `Required: ${test.questionsPerSubject || 15}, Found: ${availableQuestions.length}`
      );
    }

    const picked = getRandomQuestions(availableQuestions, test.questionsPerSubject || 15);
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
    publicUrl: `${resolveFrontendBaseUrl()}/scholarship?test=${encodeURIComponent(logicalShareLink)}`,
  };
}

export async function incrementTestAttemptCount(testId: string) {
  return ScholarshipTest.findByIdAndUpdate(testId, { $inc: { totalAttempts: 1 } });
}
