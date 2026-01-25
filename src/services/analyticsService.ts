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

export async function getStudentAnalytics(userId: string, mode: 'online' | 'offline' | 'combined' = 'combined') {
  // --- Initialize Aggregates ---
  let totalExams = 0;
  let totalScoreSum = 0;
  let totalMaxScoreSum = 0;
  
  // Containers for Graph and Stats
  let recentGraph: any[] = [];
  const subjectStats: Record<string, { correct: number; total: number; attemptIds: Set<string> }> = {};
  const overallStats = { correct: 0, incorrect: 0, unattempted: 0 };
  let totalQuestionsAttempted = 0;

  // --- 1. Process Online Data (if mode is online or combined) ---
  if (mode === 'online' || mode === 'combined') {
    const attempts = await Attempt.find({
      userId: new Types.ObjectId(userId),
      status: { $in: ['submitted', 'auto-submitted', 'graded'] }
    })
    .sort({ submittedAt: -1 }) // Newest first
    .populate('examId', 'title')
    .populate('practiceTestId', 'title subjects filters')
    .lean();

    totalExams += attempts.length;

    // Pre-fetch Data for Subject Mapping
    const allQuestionIds = new Set<string>();
    attempts.forEach(a => {
      a.answers?.forEach(ans => {
        allQuestionIds.add(ans.questionId.toString());
      });
    });

    const questionDetails = await Question.find({ _id: { $in: Array.from(allQuestionIds) } })
      .select('subject')
      .lean();
    
    const questionSubjectMap = new Map<string, string>();
    questionDetails.forEach(q => {
      questionSubjectMap.set(q._id.toString(), (q as any).subject || 'General');
    });

    for (const a of attempts) {
      // Graph Data
      let title = 'Exam';
      if (a.practiceTestId) {
        title = (a.practiceTestId as any).title || 'Practice Test';
      } else if (a.examId) {
        title = (a.examId as any).title || 'Exam';
      }
      title = title.length > 15 ? title.substring(0, 15) + '...' : title;
      const percent = a.maxScore ? Math.round(((a.totalScore || 0) / a.maxScore) * 100) : 0;
      
      recentGraph.push({
        label: title,
        percent,
        date: a.submittedAt ? new Date(a.submittedAt).toISOString() : new Date().toISOString(),
        type: 'online'
      });

      // Aggregates
      totalScoreSum += (a.totalScore || 0);
      totalMaxScoreSum += (a.maxScore || 0);

      // Detailed Stats
      if (a.answers) {
        for (const ans of a.answers) {
          if (ans.isCorrect) {
            overallStats.correct++;
          } else if (ans.chosenOptionId || ans.textAnswer) {
            overallStats.incorrect++;
          } else {
            overallStats.unattempted++;
          }

          if (ans.chosenOptionId || ans.textAnswer) totalQuestionsAttempted++;
          
          const qId = ans.questionId.toString();
          const subject = questionSubjectMap.get(qId) || 'General';
          
          if (!subjectStats[subject]) {
            subjectStats[subject] = { correct: 0, total: 0, attemptIds: new Set() };
          }
          subjectStats[subject].total++;
          if (ans.isCorrect) {
            subjectStats[subject].correct++;
          }
          subjectStats[subject].attemptIds.add(a._id.toString());
        }
      }
    }
  }

  // --- 2. Process Offline Data (if mode is offline or combined) ---
  if (mode === 'offline' || mode === 'combined') {
    const user = await import('../models/User').then(m => m.default.findById(userId));
    if (user && user.name && user.classLevel) {
       const emailUsername = user.email ? user.email.split('@')[0] : '';
       const nameRegex = new RegExp(`^${user.name.trim()}$`, 'i');
       const usernameRegex = new RegExp(`^${emailUsername}$`, 'i');

       const offlineQuery: any = { 
         class: user.classLevel,
         $or: [
           { name: nameRegex },
           { name: usernameRegex },
           { name: /^student$/i } // Explicit fallback for testing
         ]
       };
       if (user.batch) {
         offlineQuery.batch = user.batch;
       }

       const offlineResults = await import('../models/OfflineResult').then(m => m.default.find(offlineQuery).sort({ testDate: -1 }));
       
       if (offlineResults.length > 0) {
         totalExams += offlineResults.length;
         
         const offlineGraph = offlineResults.map(r => {
             const percent = r.outOf > 0 ? Math.round((r.marks / r.outOf) * 100) : 0;
             
             // Add to totals
             totalScoreSum += r.marks;
             totalMaxScoreSum += r.outOf;
             
             // For Offline mode, we can try to infer some Subject Stats if needed, 
             // but strictly speaking, we don't have question-level data.
             // We CAN populate subjectStats with simple accuracy if we want:
             // But the chart expects `correct/total` questions. OfflineResult only has marks.
             // So we'll skip detailed subject stats for offline to strictly keep it clean, 
             // OR we can hack it: score = correct, max = total.
             if (mode === 'offline') {
                const subject = r.subject || 'General';
                if (!subjectStats[subject]) subjectStats[subject] = { correct: 0, total: 0, attemptIds: new Set() };
                subjectStats[subject].correct += r.marks; // Treat marks as "correct points"
                subjectStats[subject].total += r.outOf; // Treat max marks as "total points"
             }

             return {
                label: r.subject || 'Offline Test',
                percent,
                date: r.testDate ? new Date(r.testDate).toISOString() : new Date().toISOString(),
                type: 'offline'
             };
         });
         
         recentGraph = [...recentGraph, ...offlineGraph];
       }
    }
  }

  // --- Final Formatting ---

  // Sort combined graph by date (newest first)
  recentGraph.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  
  // Slice to last 10 for display (reverse for chart: oldest -> newest)
  const finalGraph = recentGraph.slice(0, 10).reverse();

  // Format Subject Performance
  const subjectPerformance = Object.entries(subjectStats).map(([subject, stats]) => ({
    subject,
    accuracy: stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
    totalQuestions: stats.total, // For online: question count. For offline: total marks.
    correctQuestions: stats.correct // For online: correct count. For offline: obtained marks.
  })).sort((a, b) => b.totalQuestions - a.totalQuestions); 

  // Averages
  const avgScore = totalMaxScoreSum > 0 ? Math.round((totalScoreSum / totalMaxScoreSum) * 100) : 0; 
  
  // Exact accuracy is tricky for combined.
  // For online: Correct Q / Total Q.
  // For offline: Marks / Max Marks.
  // If combined, we can't easily merge "Questions".
  // Best Proxy: Avg Score as Accuracy.
  let accuracy = 0;
  if (mode === 'online') {
    accuracy = totalQuestionsAttempted > 0 ? Math.round((overallStats.correct / totalQuestionsAttempted) * 100) : 0;
  } else {
     // Combined or Offline: Use Score Percentage as general accuracy
     accuracy = avgScore;
  }
  
  return {
    examsTaken: totalExams,
    avgScore: isNaN(avgScore) ? 0 : avgScore,
    accuracy,
    recentPerformance: finalGraph,
    totalQuestionsPracticed: totalQuestionsAttempted,
    subjectPerformance,
    overallStats
  };
}

