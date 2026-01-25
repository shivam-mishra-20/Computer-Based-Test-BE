import mongoose, { Types } from 'mongoose';
import Question, { IQuestion, Difficulty } from '../models/Question';
import PracticeTest, { IPracticeTest, IFilters, IDuration, IMarkingScheme } from '../models/PracticeTest';
import Attempt, { IAnswerItem } from '../models/Attempt';
import User from '../models/User';
import { shuffleArray } from '../utils/exam';

/**
 * Get the question collection for a specific class level
 * Questions are stored in separate collections: class_10, class_11, class_12, etc.
 */
function getClassQuestionCollection(classLevel: string) {
  // Convert class level to collection name format (e.g., "Class 11" -> "class_11")
  const normalized = classLevel.toLowerCase().replace(/\s+/g, '_');
  return mongoose.connection.collection(normalized);
}

/**
 * Get the student's class level from their user record
 */
async function getUserClassLevel(userId: string): Promise<string> {
  const user = await User.findById(userId).select('classLevel').lean();
  if (!user?.classLevel) {
    throw new Error('User class level not found. Please update your profile.');
  }
  return user.classLevel;
}

// Preset configurations for quick tests
export const PRACTICE_TEST_PRESETS = [
  {
    id: 'quick-15',
    name: 'Quick Practice',
    description: '15 questions, untimed, no negative marking',
    icon: 'flash-outline',
    config: {
      questionCount: 15,
      duration: { type: 'none' as const },
      difficulty: { easy: 30, medium: 50, hard: 20 },
      markingScheme: { correct: 1, incorrect: 0, unattempted: 0 },
    },
  },
  {
    id: 'timed-20',
    name: 'Timed Test',
    description: '20 questions, 30 minutes, no negative marking',
    icon: 'timer-outline',
    config: {
      questionCount: 20,
      duration: { type: 'total' as const, totalMins: 30 },
      difficulty: { easy: 25, medium: 50, hard: 25 },
      markingScheme: { correct: 1, incorrect: 0, unattempted: 0 },
    },
  },
  {
    id: 'exam-sim',
    name: 'Exam Simulation',
    description: '40 questions, 60 minutes, with negative marking',
    icon: 'school-outline',
    config: {
      questionCount: 40,
      duration: { type: 'total' as const, totalMins: 60 },
      difficulty: { easy: 20, medium: 50, hard: 30 },
      markingScheme: { correct: 4, incorrect: -1, unattempted: 0 },
    },
  },
];

export interface PracticeTestMeta {
  subjects: { name: string; questionCount: number }[];
  chapters: Record<string, { name: string; questionCount: number }[]>;
  difficultyStats: { easy: number; medium: number; hard: number };
  totalQuestions: number;
}

export interface CreatePracticeTestRequest {
  subjects: string[];
  chapters?: string[];  // Empty or undefined = all chapters
  questionCount: number;
  difficulty: { easy: number; medium: number; hard: number };
  duration: IDuration;
  markingScheme: IMarkingScheme;
  preset?: string;
  title?: string;
}

export interface ChapterPerformance {
  chapter: string;
  subject: string;
  correct: number;
  incorrect: number;
  unattempted: number;
  total: number;
  percentage: number;
}

/**
 * Get metadata about available questions for the test builder UI
 * Queries the class-specific collection based on user's class level
 */
export async function getAvailableMeta(userId: string): Promise<PracticeTestMeta> {
  // Get user's class level
  const classLevel = await getUserClassLevel(userId);
  const collection = getClassQuestionCollection(classLevel);
  
  // Filter for active questions (include undefined isActive as active)
  const activeFilter = { isActive: { $ne: false } };

  // Get subject statistics using native MongoDB collection
  const subjectStats = await collection.aggregate([
    { $match: activeFilter },
    {
      $group: {
        _id: '$subject',
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]).toArray();

  // Get chapter statistics grouped by subject
  const chapterStats = await collection.aggregate([
    { $match: activeFilter },
    {
      $group: {
        _id: { subject: '$subject', chapter: '$chapter' },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.subject': 1, '_id.chapter': 1 } },
  ]).toArray();

  // Get difficulty distribution
  const difficultyStats = await collection.aggregate([
    { $match: activeFilter },
    {
      $group: {
        _id: '$difficulty',
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  // Transform subject stats
  const subjects = subjectStats
    .filter((s) => s._id)
    .map((s) => ({
      name: s._id,
      questionCount: s.count,
    }));

  // Transform chapter stats grouped by subject
  const chapters: Record<string, { name: string; questionCount: number }[]> = {};
  for (const stat of chapterStats) {
    if (!stat._id.subject || !stat._id.chapter) continue;
    const subject = stat._id.subject;
    if (!chapters[subject]) {
      chapters[subject] = [];
    }
    chapters[subject].push({
      name: stat._id.chapter,
      questionCount: stat.count,
    });
  }

  // Transform difficulty stats
  const diffStats = { easy: 0, medium: 0, hard: 0 };
  for (const stat of difficultyStats) {
    if (stat._id === 'easy') diffStats.easy = stat.count;
    else if (stat._id === 'medium') diffStats.medium = stat.count;
    else if (stat._id === 'hard') diffStats.hard = stat.count;
  }

  const totalQuestions = await collection.countDocuments(activeFilter);

  return {
    subjects,
    chapters,
    difficultyStats: diffStats,
    totalQuestions,
  };
}

/**
 * Sample questions based on filters and difficulty distribution
 * Queries the class-specific collection
 */
async function sampleQuestions(
  classLevel: string,
  filters: IFilters,
  targetCount: number
): Promise<{ questions: Types.ObjectId[]; warning?: string }> {
  const { subjects, chapters, difficulty } = filters;
  const collection = getClassQuestionCollection(classLevel);

  // Calculate target counts per difficulty
  const easyCount = Math.round((targetCount * difficulty.easy) / 100);
  const mediumCount = Math.round((targetCount * difficulty.medium) / 100);
  // Hard gets the remainder to ensure we hit exact total
  const hardCount = targetCount - easyCount - mediumCount;

  const sampleByDifficulty = async (
    diff: Difficulty,
    count: number
  ): Promise<Types.ObjectId[]> => {
    if (count <= 0) return [];

    // Use top-level fields: subject, chapter, difficulty
    const matchStage: any = {
      isActive: { $ne: false },
      difficulty: diff,
    };

    if (subjects.length > 0) {
      matchStage.subject = { $in: subjects };
    }

    if (chapters && chapters.length > 0) {
      matchStage.chapter = { $in: chapters };
    }

    const pipeline = [
      { $match: matchStage },
      { $sample: { size: count } },
      { $project: { _id: 1 } },
    ];

    const results = await collection.aggregate(pipeline).toArray();
    return results.map((r) => new Types.ObjectId(r._id));
  };

  // Sample from each difficulty level
  const [easyQs, mediumQs, hardQs] = await Promise.all([
    sampleByDifficulty('easy', easyCount),
    sampleByDifficulty('medium', mediumCount),
    sampleByDifficulty('hard', hardCount),
  ]);

  const allQuestions = [...easyQs, ...mediumQs, ...hardQs];
  let warning: string | undefined;

  // Check if we got fewer questions than requested
  if (allQuestions.length < targetCount) {
    warning = `Only ${allQuestions.length} questions available matching your criteria (requested ${targetCount}). Test created with available questions.`;
  }

  // Shuffle the combined questions
  return {
    questions: shuffleArray(allQuestions),
    warning,
  };
}

/**
 * Create a new practice test
 */
export async function createPracticeTest(
  userId: string,
  request: CreatePracticeTestRequest
): Promise<IPracticeTest> {
  const {
    subjects,
    chapters = [],
    questionCount,
    difficulty,
    duration,
    markingScheme,
    preset,
    title,
  } = request;

  // Get user's class level for querying the correct collection
  const classLevel = await getUserClassLevel(userId);

  // Validate difficulty distribution
  if (difficulty.easy + difficulty.medium + difficulty.hard !== 100) {
    throw new Error('Difficulty distribution must sum to 100%');
  }

  // Sample questions from the class-specific collection
  const filters: IFilters = {
    subjects,
    chapters,
    difficulty,
  };

  const { questions, warning } = await sampleQuestions(classLevel, filters, questionCount);

  if (questions.length === 0) {
    throw new Error('No questions found matching your criteria. Please adjust your filters.');
  }

  // Generate title if not provided
  const autoTitle =
    title ||
    `${subjects.join(', ')} - ${questions.length}Q ${
      duration.type === 'total'
        ? `${duration.totalMins}min`
        : duration.type === 'per-question'
        ? `${duration.perQuestionSecs}s/Q`
        : 'Untimed'
    } (${new Date().toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true })})`;

  const practiceTest = await PracticeTest.create({
    userId: new Types.ObjectId(userId),
    title: autoTitle,
    classLevel: classLevel,
    filters,
    questionCount,
    actualQuestionCount: questions.length,
    questionIds: questions,
    duration,
    markingScheme,
    preset,
    status: 'created',
    insufficientQuestionsWarning: warning,
  });

  return practiceTest;
}

/**
 * Get practice test details for attempt screen
 */
export async function getPracticeTestView(
  practiceTestId: string,
  userId: string
): Promise<{
  practiceTest: IPracticeTest;
  questions: Record<string, IQuestion>;
}> {
  const practiceTest = await PracticeTest.findById(practiceTestId);
  if (!practiceTest) {
    throw new Error('Practice test not found');
  }
  if (practiceTest.userId.toString() !== userId) {
    throw new Error('Unauthorized');
  }

  // Load questions
  const questionDocs = await Question.find({
    _id: { $in: practiceTest.questionIds },
  });

  // Build question map (hide correct answers for non-submitted tests)
  const questions: Record<string, IQuestion> = {};
  for (const q of questionDocs) {
    const sanitized = q.toObject();
    // Remove correct answer indicators for active tests
    if (practiceTest.status !== 'completed') {
      if (sanitized.options) {
        sanitized.options = sanitized.options.map((opt: any) => ({
          _id: opt._id,
          text: opt.text,
        }));
      }
      delete sanitized.correctAnswerText;
      delete sanitized.integerAnswer;
      delete sanitized.assertionIsTrue;
      delete sanitized.reasonIsTrue;
      delete sanitized.reasonExplainsAssertion;
    }
    questions[String(q._id)] = sanitized;
  }

  return { practiceTest, questions };
}

/**
 * Start an attempt for a practice test
 */
export async function startPracticeTestAttempt(
  practiceTestId: string,
  userId: string
): Promise<any> {
  const practiceTest = await PracticeTest.findById(practiceTestId);
  if (!practiceTest) {
    throw new Error('Practice test not found');
  }
  if (practiceTest.userId.toString() !== userId) {
    throw new Error('Unauthorized');
  }

  // Check for existing attempt
  let attempt = await Attempt.findOne({
    practiceTestId: new Types.ObjectId(practiceTestId),
    userId: new Types.ObjectId(userId),
  });

  if (attempt) {
    if (attempt.status === 'submitted' || attempt.status === 'auto-submitted') {
      throw new Error('You have already completed this practice test');
    }
    return attempt;
  }

  // Calculate max score
  const maxScore = practiceTest.questionIds.length * practiceTest.markingScheme.correct;

  // Create new attempt
  attempt = await Attempt.create({
    practiceTestId: new Types.ObjectId(practiceTestId),
    userId: new Types.ObjectId(userId),
    mode: 'practice',
    startedAt: new Date(),
    status: 'in-progress',
    maxScore,
    snapshot: {
      sectionOrder: [new Types.ObjectId()], // Single section
      questionOrderBySection: {
        main: practiceTest.questionIds,
      },
    },
    answers: [],
  });

  // Update practice test status
  practiceTest.status = 'in-progress';
  await practiceTest.save();

  return attempt;
}

/**
 * Get chapter-wise performance analysis for a completed practice test
 */
export async function getChapterWiseAnalysis(
  practiceTestId: string,
  userId: string
): Promise<ChapterPerformance[]> {
  const practiceTest = await PracticeTest.findById(practiceTestId);
  if (!practiceTest) {
    throw new Error('Practice test not found');
  }
  if (practiceTest.userId.toString() !== userId) {
    throw new Error('Unauthorized');
  }

  const attempt = await Attempt.findOne({
    practiceTestId: new Types.ObjectId(practiceTestId),
    userId: new Types.ObjectId(userId),
  });

  if (!attempt || (attempt.status !== 'submitted' && attempt.status !== 'auto-submitted')) {
    throw new Error('Test not yet completed');
  }

  // Load questions with their chapter info
  const questions = await Question.find({
    _id: { $in: practiceTest.questionIds },
  });

  // Build answer map
  const answerMap = new Map<string, IAnswerItem>();
  for (const ans of attempt.answers) {
    answerMap.set(ans.questionId.toString(), ans);
  }

  // Group by chapter
  const chapterStats: Record<string, ChapterPerformance> = {};

  for (const q of questions) {
    const chapter = (q as any).chapter || 'Uncategorized';
    const subject = (q as any).subject || 'Unknown';
    const key = `${subject}::${chapter}`;

    if (!chapterStats[key]) {
      chapterStats[key] = {
        chapter,
        subject,
        correct: 0,
        incorrect: 0,
        unattempted: 0,
        total: 0,
        percentage: 0,
      };
    }

    const stats = chapterStats[key];
    stats.total++;

    const answer = answerMap.get(String(q._id));
    if (!answer || (!answer.chosenOptionId && !answer.textAnswer)) {
      stats.unattempted++;
    } else if (answer.isCorrect) {
      stats.correct++;
    } else {
      stats.incorrect++;
    }
  }

  // Calculate percentages
  const results = Object.values(chapterStats);
  for (const stat of results) {
    stat.percentage = stat.total > 0 ? Math.round((stat.correct / stat.total) * 100) : 0;
  }

  // Sort by subject, then chapter
  results.sort((a, b) => {
    if (a.subject !== b.subject) return a.subject.localeCompare(b.subject);
    return a.chapter.localeCompare(b.chapter);
  });

  return results;
}

/**
 * Get user's practice test history
 */
export async function listUserPracticeTests(
  userId: string,
  opts: { status?: string; limit?: number } = {}
): Promise<IPracticeTest[]> {
  const query: any = { userId: new Types.ObjectId(userId) };
  if (opts.status) {
    query.status = opts.status;
  }

  return PracticeTest.find(query)
    .sort({ createdAt: -1 })
    .limit(opts.limit || 20)
    .lean();
}

/**
 * Get presets for quick test creation
 */
export function getPresets() {
  return PRACTICE_TEST_PRESETS;
}
