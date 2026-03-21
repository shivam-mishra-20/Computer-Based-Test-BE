import ScholarshipAttempt from '../models/ScholarshipAttempt';
import ScholarshipTest from '../models/ScholarshipTest';
import { getClassQuestionModel } from '../models/ClassQuestion';
import { Types } from 'mongoose';
import { randomBytes, randomInt } from 'crypto';

const SCHOLARSHIP_BOARD_PATTERN = /scholarship/i;

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

function requireValidAttemptAccess(attempt: any, providedKey?: string) {
  const stored = String(attempt?.attemptAccessKey || '');
  if (!stored) return;

  const given = String(providedKey || '');
  if (!given || given !== stored) {
    throw new Error('Unauthorized attempt access');
  }
}

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
  classLevel: number | undefined,
  testId?: string
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
      throw new Error('Selected scholarship test is not available');
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
      throw new Error('Selected scholarship test has no valid subjects configured');
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
      // Backfill access key for legacy attempts.
      if (!existing.attemptAccessKey) {
        const key = generateAttemptAccessKey();
        await ScholarshipAttempt.updateOne({ _id: existing._id }, { attemptAccessKey: key });
        (existing as any).attemptAccessKey = key;
      }

      const locked = existing.status === 'submitted';
      return {
        attemptId: existing.attemptId,
        _id: existing._id,
        startedAt: existing.startedAt,
        durationMins: existing.durationMins,
        status: existing.status,
        attemptAccessKey: (existing as any).attemptAccessKey || '',
        created: false,
        resumed: !locked,
        locked,
        message: locked
          ? 'This phone number has already submitted this scholarship test. Retake is not allowed.'
          : 'Resuming your previous scholarship test attempt.',
      };
    }
  }

  if (!resolvedClassLevel || resolvedClassLevel < 7 || resolvedClassLevel > 12) {
    throw new Error('ClassLevel must be between 7 and 12');
  }

  // Generate unique attempt ID (depends on classLevel)
  let attemptId = generateAttemptId(resolvedClassLevel);
  let exists = await ScholarshipAttempt.findOne({ attemptId });

  while (exists) {
    attemptId = generateAttemptId(resolvedClassLevel);
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
        `Not enough Scholarship-board questions for Class ${resolvedClassLevel} - ${subject}. ` +
          `Required: ${questionsPerSubject}, Found: ${questions.length}`
      );
    }

    const questionIds = pickRandomUniqueIds(questions as any, questionsPerSubject, usedQuestionIds);
    if (questionIds.length < questionsPerSubject) {
      throw new Error(
        `Not enough unique Scholarship-board questions for Class ${resolvedClassLevel} - ${subject}. ` +
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
        if (!existing.attemptAccessKey) {
          const key = generateAttemptAccessKey();
          await ScholarshipAttempt.updateOne({ _id: existing._id }, { attemptAccessKey: key });
          (existing as any).attemptAccessKey = key;
        }

        const locked = existing.status === 'submitted';
        return {
          attemptId: existing.attemptId,
          _id: existing._id,
          startedAt: existing.startedAt,
          durationMins: existing.durationMins,
          status: existing.status,
          attemptAccessKey: (existing as any).attemptAccessKey || '',
          created: false,
          resumed: !locked,
          locked,
          message: locked
            ? 'This phone number has already submitted this scholarship test. Retake is not allowed.'
            : 'Resuming your previous scholarship test attempt.',
        };
      }
    }
    throw err;
  }
}

export async function getScholarshipAttempt(attemptId: string, accessKey?: string) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  // Legacy-safe: if key isn't set yet, set it now and return it.
  if (!attempt.attemptAccessKey) {
    attempt.attemptAccessKey = generateAttemptAccessKey();
    await attempt.save();
  }

  requireValidAttemptAccess(attempt, accessKey);

  const ClassQuestionModel = getClassQuestionModel(`Class ${attempt.classLevel}`);
  const questions = await ClassQuestionModel.find({
    _id: { $in: attempt.questions.map((id) => new Types.ObjectId(id)) },
  }).lean();

  const includePublishedSolutions = Boolean(attempt.resultPublished);
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

  // Preserve the exact shuffled order stored on the attempt.
  const byId = new Map(questionDetails.map((q: any) => [String(q._id), q]));
  const orderedQuestionDetails = (attempt.questions || [])
    .map((id) => byId.get(String(id)))
    .filter(Boolean);

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
    attemptAccessKey: attempt.attemptAccessKey || '',
    questions: orderedQuestionDetails,
    questionIds: attempt.questions,
    subjectQuestions: attempt.subjectQuestions,
    answers: attempt.answers,
  };

  if (attempt.resultPublished) {
    base.totalScore = attempt.totalScore || 0;
    base.maxScore = attempt.maxScore || 0;
    base.batch = attempt.batch || '';
    base.scholarshipAward = attempt.scholarshipAward || {
      percentage: 0,
      earlyBirdDiscountPercentage: 0,
      amount: 0,
      notes: '',
    };
    base.adminReview = attempt.adminReview || { isReviewed: false, notes: '' };
  }

  return base;
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

  if (!attempt.attemptAccessKey) {
    attempt.attemptAccessKey = generateAttemptAccessKey();
  }

  requireValidAttemptAccess(attempt, accessKey);

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

export async function submitScholarshipTest(attemptId: string, answers: any, accessKey?: string) {
  const attempt = await ScholarshipAttempt.findOne({ attemptId });
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  if (!attempt.attemptAccessKey) {
    attempt.attemptAccessKey = generateAttemptAccessKey();
  }

  requireValidAttemptAccess(attempt, accessKey);

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
      publicUrl: `${frontendBase}/scholarship-results?resultToken=${encodeURIComponent(
        String(a.resultPublicToken)
      )}`,
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
    publicUrl: `${frontendBase}/scholarship-results?resultToken=${encodeURIComponent(
      String(attempt.resultPublicToken)
    )}`,
  };
}

export async function getScholarshipPublicResultByToken(token: string) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) {
    throw new Error('Result token is required');
  }

  const attempt = await ScholarshipAttempt.findOne({ resultPublicToken: normalizedToken });
  if (!attempt) {
    throw new Error('Invalid or expired result link');
  }

  const data: any = await getScholarshipAttempt(
    attempt.attemptId,
    attempt.attemptAccessKey || undefined
  );

  // Never expose attempt access key on public endpoint.
  delete data.attemptAccessKey;
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
        `Not enough Scholarship-board questions for Class ${previewClass} - ${subject}. ` +
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
    publicUrl: `${resolveFrontendBaseUrl()}/scholarship?test=${encodeURIComponent(logicalShareLink)}`,
  };
}

export async function incrementTestAttemptCount(testId: string) {
  return ScholarshipTest.findByIdAndUpdate(testId, { $inc: { totalAttempts: 1 } });
}
