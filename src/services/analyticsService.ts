import Attempt from '../models/Attempt';
import Exam from '../models/Exam';
import Question from '../models/Question';
import { Types } from 'mongoose';

export async function studentProgressOverTime(userId: string) {
  const attempts = await Attempt.find({ userId: new Types.ObjectId(userId), status: { $in: ['submitted', 'auto-submitted', 'graded'] } })
    .sort({ submittedAt: 1 })
    .select('submittedAt totalScore maxScore examId');
  const withTitles = await Promise.all(
    attempts.map(async (a) => {
      const exam = await Exam.findById(a.examId).select('title');
      return {
        submittedAt: a.submittedAt,
        totalScore: a.totalScore ?? 0,
        maxScore: a.maxScore ?? 0,
        percent: a.maxScore ? Math.round(((a.totalScore ?? 0) / (a.maxScore || 1)) * 100) : null,
        examTitle: exam?.title || 'Exam',
      };
    })
  );
  return withTitles;
}

export async function examInsights(examId: string) {
  // Aggregate difficulty/topic distribution and average scores per topic
  const exam = await Exam.findById(examId);
  if (!exam) throw new Error('Exam not found');
  const qids = exam.sections.flatMap((s) => s.questionIds);
  const questions = await Question.find({ _id: { $in: qids } });

  const topicCount: Record<string, number> = {};
  const difficultyCount: Record<string, number> = { easy: 0, medium: 0, hard: 0 };
  for (const q of questions) {
    const topic = q.tags?.topic || 'general';
    topicCount[topic] = (topicCount[topic] || 0) + 1;
    const diff = q.tags?.difficulty || 'medium';
    difficultyCount[diff] = (difficultyCount[diff] || 0) + 1;
  }

  // Scores
  const attempts = await Attempt.find({ examId: new Types.ObjectId(examId), status: { $in: ['submitted', 'auto-submitted', 'graded'] } });
  const topicScores: Record<string, { sum: number; count: number }> = {};
  for (const a of attempts) {
    for (const ans of a.answers) {
      const q = questions.find((qq) => (qq as any)._id.toString() === ans.questionId.toString());
      if (!q) continue;
      const topic = q.tags?.topic || 'general';
      const score = ans.scoreAwarded ?? (ans.rubricScore ?? 0);
      if (!topicScores[topic]) topicScores[topic] = { sum: 0, count: 0 };
      topicScores[topic].sum += score;
      topicScores[topic].count += 1;
    }
  }
  const topicAvg = Object.fromEntries(Object.entries(topicScores).map(([k, v]) => [k, v.count ? v.sum / v.count : 0]));
  return { topicCount, difficultyCount, topicAvg };
}
