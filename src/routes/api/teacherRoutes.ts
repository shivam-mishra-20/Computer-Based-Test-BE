import { Router, Request, Response } from 'express';
import User, { IUser } from '../../models/User';
import Exam from '../../models/Exam';
import Attempt from '../../models/Attempt';
import Doubt from '../../models/Doubt';
import Lecture from '../../models/Lecture';
import { authMiddleware } from '../../middlewares/authMiddleware';

interface AuthRequest extends Request {
  user?: IUser & { _id: any };
}

const router = Router();

// GET - Teacher profile (read-only)
router.get('/profile', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const teacher = await User.findById(req.user._id)
      .select('-password -passwordResetToken -passwordResetExpires')
      .lean();

    return res.json(teacher);
  } catch (error) {
    console.error('Error fetching teacher profile:', error);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// GET - Batches assigned to teacher with student counts
router.get('/batches', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get batches from exams created by this teacher
    const examBatches = await Exam.distinct('batch', { createdBy: req.user._id });
    
    // Also include the teacher's own batch if assigned
    const teacherBatch = req.user.batch;
    const allBatches = [...new Set([...examBatches, teacherBatch].filter(Boolean))];

    // Get student counts per batch
    const batchData = await Promise.all(
      allBatches.map(async (batch) => {
        const studentCount = await User.countDocuments({ 
          role: 'student', 
          batch,
          status: 'approved'
        });
        
        const examCount = await Exam.countDocuments({ 
          createdBy: req.user!._id, 
          batch 
        });

        return {
          name: batch,
          studentCount,
          examCount
        };
      })
    );

    return res.json({ batches: batchData });
  } catch (error) {
    console.error('Error fetching batches:', error);
    return res.status(500).json({ error: 'Failed to fetch batches' });
  }
});

// GET - Students in assigned batches (read-only)
router.get('/students', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { batch, classLevel, page = 1, limit = 50, search } = req.query;

    // Get teacher's batches
    const examBatches = await Exam.distinct('batch', { createdBy: req.user._id });
    const teacherBatch = req.user.batch;
    const allowedBatches = [...new Set([...examBatches, teacherBatch].filter(Boolean))];

    const filter: any = {
      role: 'student',
      status: 'approved'
    };

    // Only filter by allowed batches if we have them
    if (allowedBatches.length > 0) {
      filter.batch = { $in: allowedBatches };
    }

    // Apply additional filters
    // If batch param is provided, filter by that specific batch
    if (batch) {
      filter.batch = batch;
    }
    if (classLevel) filter.classLevel = classLevel;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [students, total] = await Promise.all([
      User.find(filter)
        .select('name email classLevel batch phone createdAt')
        .sort({ name: 1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      User.countDocuments(filter)
    ]);

    return res.json({
      students,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
      allowedBatches
    });
  } catch (error) {
    console.error('Error fetching students:', error);
    return res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// GET - Dashboard stats for teacher
router.get('/dashboard-stats', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const teacherId = req.user._id;
    const teacherBatch = req.user.batch;

    // Parallel fetch all stats
    const [
      totalExams,
      publishedExams,
      totalLectures,
      publishedLectures,
      pendingDoubts,
      resolvedDoubts,
      studentCount,
      recentAttempts
    ] = await Promise.all([
      Exam.countDocuments({ createdBy: teacherId }),
      Exam.countDocuments({ createdBy: teacherId, isPublished: true }),
      Lecture.countDocuments({ instructor: teacherId }),
      Lecture.countDocuments({ instructor: teacherId, status: 'published' }),
      Doubt.countDocuments({ $or: [{ teacher: teacherId }, { batch: teacherBatch }], status: 'pending' }),
      Doubt.countDocuments({ teacher: teacherId, status: 'resolved' }),
      User.countDocuments({ role: 'student', batch: teacherBatch, status: 'approved' }),
      Attempt.find({ /* we'd need exam filter */ })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('userId', 'name')
        .populate('examId', 'title')
        .lean()
    ]);

    return res.json({
      exams: { total: totalExams, published: publishedExams },
      lectures: { total: totalLectures, published: publishedLectures },
      doubts: { pending: pendingDoubts, resolved: resolvedDoubts },
      studentCount,
      recentAttempts
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET - Performance reports for teacher's students
router.get('/performance', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { batch, examId, page = 1, limit = 50 } = req.query;

    // Get exams created by this teacher
    const teacherExamIds = await Exam.find({ createdBy: req.user._id }).distinct('_id');

    const matchFilter: any = {
      exam: { $in: teacherExamIds },
      status: 'submitted'
    };

    if (examId) matchFilter.exam = examId;

    // Aggregate performance data
    const performance = await Attempt.aggregate([
      { $match: matchFilter },
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'student'
        }
      },
      { $unwind: '$student' },
      {
        $match: batch ? { 'student.batch': batch } : {}
      },
      {
        $group: {
          _id: '$user',
          studentName: { $first: '$student.name' },
          studentEmail: { $first: '$student.email' },
          studentBatch: { $first: '$student.batch' },
          totalAttempts: { $sum: 1 },
          avgScore: { $avg: '$score' },
          maxScore: { $max: '$score' },
          totalCorrect: { $sum: '$correctAnswers' },
          totalWrong: { $sum: '$wrongAnswers' },
          totalQuestions: { $sum: '$totalQuestions' }
        }
      },
      {
        $addFields: {
          accuracy: {
            $cond: {
              if: { $gt: ['$totalQuestions', 0] },
              then: { $multiply: [{ $divide: ['$totalCorrect', '$totalQuestions'] }, 100] },
              else: 0
            }
          }
        }
      },
      { $sort: { avgScore: -1 } },
      { $skip: (Number(page) - 1) * Number(limit) },
      { $limit: Number(limit) }
    ]);

    // Get batch-level stats
    const batchStats = await Attempt.aggregate([
      { $match: matchFilter },
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'student'
        }
      },
      { $unwind: '$student' },
      {
        $group: {
          _id: '$student.batch',
          avgScore: { $avg: '$score' },
          totalAttempts: { $sum: 1 },
          uniqueStudents: { $addToSet: '$user' }
        }
      },
      {
        $project: {
          batch: '$_id',
          avgScore: { $round: ['$avgScore', 1] },
          totalAttempts: 1,
          studentCount: { $size: '$uniqueStudents' }
        }
      }
    ]);

    return res.json({
      performance,
      batchStats,
      page: Number(page)
    });
  } catch (error) {
    console.error('Error fetching performance:', error);
    return res.status(500).json({ error: 'Failed to fetch performance data' });
  }
});

// GET - Detailed student report with chapter-wise accuracy
router.get('/student-report/:studentId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { studentId } = req.params;

    // Get student details
    const student = await User.findById(studentId)
      .select('name email phone classLevel batch')
      .lean();

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Get all attempts by this student for exams created by this teacher
    const teacherExamIds = await Exam.find({ createdBy: req.user._id }).distinct('_id');

    const attempts = await Attempt.find({
      userId: studentId,
      examId: { $in: teacherExamIds },
      status: { $in: ['submitted', 'auto-submitted', 'graded'] }
    })
      .populate('examId', 'title subject chapters')
      .sort({ submittedAt: -1 })
      .lean();

    // Calculate overall stats
    const totalAttempts = attempts.length;
    const scores = attempts.map((a: any) => {
      return a.maxScore ? Math.round(((a.totalScore || 0) / a.maxScore) * 100) : 0;
    });
    const avgScore = totalAttempts > 0 ? scores.reduce((a: number, b: number) => a + b, 0) / totalAttempts : 0;
    const bestScore = totalAttempts > 0 ? Math.max(...scores) : 0;
    const totalTimeSpent = attempts.reduce((acc: number, a: any) => {
      if (a.submittedAt && a.startedAt) {
        return acc + Math.round((new Date(a.submittedAt).getTime() - new Date(a.startedAt).getTime()) / 1000);
      }
      return acc;
    }, 0);
    const totalCorrect = attempts.reduce((acc: number, a: any) => {
      return acc + (a.answers?.filter((ans: any) => ans.isCorrect).length || 0);
    }, 0);
    const totalQuestions = attempts.reduce((acc: number, a: any) => acc + (a.answers?.length || 0), 0);
    const overallAccuracy = totalQuestions > 0 ? (totalCorrect / totalQuestions) * 100 : 0;

    // Format recent attempts
    const recentAttempts = attempts.slice(0, 10).map((a: any) => {
      const correct = a.answers?.filter((ans: any) => ans.isCorrect).length || 0;
      const total = a.answers?.length || 0;
      const wrong = total - correct;
      const timeTaken = a.submittedAt && a.startedAt
        ? Math.round((new Date(a.submittedAt).getTime() - new Date(a.startedAt).getTime()) / 1000)
        : 0;
      return {
        _id: a._id,
        examTitle: a.examId?.title || 'Unknown',
        examSubject: a.examId?.subject || 'Unknown',
        score: a.maxScore ? Math.round(((a.totalScore || 0) / a.maxScore) * 100) : 0,
        totalQuestions: total,
        correctAnswers: correct,
        wrongAnswers: wrong,
        skipped: 0,
        timeTaken,
        submittedAt: a.submittedAt || a.createdAt
      };
    });

    // Calculate subject-wise stats
    const subjectMap = new Map<string, { total: number; sum: number }>();
    attempts.forEach((a: any) => {
      const subject = a.examId?.subject || 'Unknown';
      const score = a.maxScore ? Math.round(((a.totalScore || 0) / a.maxScore) * 100) : 0;
      const current = subjectMap.get(subject) || { total: 0, sum: 0 };
      subjectMap.set(subject, {
        total: current.total + 1,
        sum: current.sum + score
      });
    });

    const subjectWiseStats = Array.from(subjectMap.entries()).map(([subject, data]) => ({
      subject,
      avgScore: data.sum / data.total,
      attempts: data.total
    }));

    // Calculate chapter-wise accuracy from attempt answers
    const chapterAccuracyMap = new Map<string, { 
      subject: string; 
      correct: number; 
      total: number 
    }>();

    for (const attempt of attempts) {
      const attemptAny = attempt as any;
      const exam = attemptAny.examId;
      if (!exam?.chapters) continue;

      // Group questions by chapter if available
      const answers = attemptAny.answers || [];
      answers.forEach((ans: any) => {
        const chapter = ans.chapter || exam.chapters?.[0] || 'General';
        const subject = exam.subject || 'Unknown';
        const key = `${subject}-${chapter}`;
        
        const current = chapterAccuracyMap.get(key) || { subject, correct: 0, total: 0 };
        chapterAccuracyMap.set(key, {
          subject,
          correct: current.correct + (ans.isCorrect ? 1 : 0),
          total: current.total + 1
        });
      });
    }

    const chapterWiseAccuracy = Array.from(chapterAccuracyMap.entries()).map(([key, data]) => ({
      chapter: key.split('-')[1] || key,
      subject: data.subject,
      totalQuestions: data.total,
      correctAnswers: data.correct,
      accuracy: data.total > 0 ? (data.correct / data.total) * 100 : 0
    })).sort((a, b) => b.accuracy - a.accuracy);

    return res.json({
      student,
      overallStats: {
        totalAttempts,
        avgScore,
        bestScore,
        totalTimeSpent,
        overallAccuracy
      },
      recentAttempts,
      chapterWiseAccuracy,
      subjectWiseStats
    });
  } catch (error) {
    console.error('Error fetching student report:', error);
    return res.status(500).json({ error: 'Failed to fetch student report' });
  }
});

export default router;
