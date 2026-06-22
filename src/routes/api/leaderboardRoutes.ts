import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import User from '../../models/User';
import TestResult from '../../models/TestResult';
import Exam from '../../models/Exam';
import Attempt from '../../models/Attempt';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// ── Online-exam leaderboard helpers ──────────────────────────────────────────
// Results from an online exam only enter the leaderboard once the teacher has
// PUBLISHED them. The authoritative "published" signal is the same one students
// see on their results — Attempt.resultPublished (set by the review module's
// publish AND any legacy per-attempt publish). Gating on this keeps the
// leaderboard in lock-step with what's actually visible to students.
async function publishedExamIds(): Promise<Types.ObjectId[]> {
  const ids = await Attempt.distinct('examId', { resultPublished: true, examId: { $ne: null } });
  return ids as Types.ObjectId[];
}

const examSubject = (e: any): string | undefined => e?.subject ?? e?.meta?.subject;
const examDate = (e: any): Date => e?.schedule?.startAt || e?.createdAt || new Date(0);

// ── /filters ───────────────────────────────────────────────────────────────
router.get('/filters', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const [classes, subjects] = await Promise.all([
      TestResult.distinct('class'),
      TestResult.distinct('subject'),
    ]);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      classes: classes.filter(Boolean).sort(),
      subjects: subjects.filter(Boolean).sort(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET / ───────────────────────────────────────────────────────────────────
// Universal leaderboard built from TestResult (offline results uploaded by
// teachers). Works for all users — students, teachers, admins.
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { classLevel, subject, limit = 100 } = req.query;

    // 1. Build the TestResult query
    const testQuery: any = {};
    if (classLevel) testQuery.class = classLevel as string;
    if (subject) testQuery.subject = new RegExp(`^${subject}$`, 'i');

    // 2. Load all matching tests in ONE query (only the fields we need)
    const allTests = await TestResult.find(testQuery)
      .select('class subject maxMarks studentResults')
      .lean() as any[];

    // 3. Walk every studentResult in every test and accumulate per-student scores.
    //    We key by both studentId AND studentName so we can match later.
    interface ScoreBucket {
      totalScore: number;
      maxPossibleScore: number;
      examsTaken: number;
      percentageSum: number;
      studentName: string; // latest name we saw
      studentId: string;   // latest id we saw
    }

    const byId   = new Map<string, ScoreBucket>();
    const byName = new Map<string, ScoreBucket>();

    const accumulate = (
      map: Map<string, ScoreBucket>,
      key: string,
      marks: number,
      maxMarks: number,
      studentId: string,
      studentName: string,
    ) => {
      if (!map.has(key)) {
        map.set(key, {
          totalScore: 0,
          maxPossibleScore: 0,
          examsTaken: 0,
          percentageSum: 0,
          studentName,
          studentId,
        });
      }
      const entry = map.get(key)!;
      entry.totalScore += marks;
      entry.maxPossibleScore += maxMarks;
      entry.examsTaken += 1;
      entry.percentageSum += maxMarks > 0 ? (marks / maxMarks) * 100 : 0;
      if (studentName) entry.studentName = studentName;
      if (studentId) entry.studentId = studentId;
    };

    for (const test of allTests) {
      for (const r of (test.studentResults || [])) {
        // Absent students must not affect leaderboard standings
        if (r.isAbsent) continue;
        const marks = r.marksObtained ?? 0;
        const sid = r.studentId || '';
        const sname = r.studentName || '';

        if (sid) accumulate(byId, sid, marks, test.maxMarks, sid, sname);
        if (sname) accumulate(byName, sname.toLowerCase().trim(), marks, test.maxMarks, sid, sname);
      }
    }

    // 4. Now fetch all approved students (optionally filtered by class)
    const studentQuery: any = { role: 'student', status: 'approved' };
    if (classLevel) {
      // Match users whose classLevel matches the filter.
      // classLevel in User could be "12" or "Class 12" while TestResult.class
      // is whatever the teacher typed. We support both.
      const raw = (classLevel as string).replace(/^Class\s*/i, '').trim();
      studentQuery.$or = [
        { classLevel: classLevel as string },
        { classLevel: raw },
        { classLevel: `Class ${raw}` },
      ];
    }

    const students = await User.find(studentQuery)
      .select('_id name classLevel batch')
      .lean() as any[];

    const totalParticipants = students.length;

    // 5. For each student, find their score bucket.
    //    Try by _id first, then by name.
    const leaderboard: any[] = [];

    for (const student of students) {
      const sid = student._id.toString();
      let bucket = byId.get(sid);
      if (!bucket) {
        bucket = byName.get(student.name.toLowerCase().trim());
      }

      const rawAvg = bucket && bucket.examsTaken > 0
        ? bucket.percentageSum / bucket.examsTaken
        : 0;

      leaderboard.push({
        userId: sid,
        name: student.name,
        classLevel: student.classLevel,
        batch: student.batch,
        totalScore: bucket?.totalScore || 0,
        maxPossibleScore: bucket?.maxPossibleScore || 0,
        examsTaken: bucket?.examsTaken || 0,
        avgPercentage: bucket ? Math.round(rawAvg) : 0,
        rawAvg,
        hasData: !!bucket && bucket.examsTaken > 0,
      });
    }

    // 6. Sort: students with data first (descending by avg%), then no-data students alphabetically
    leaderboard.sort((a, b) => {
      if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
      if (a.hasData && b.hasData) {
        if (b.rawAvg !== a.rawAvg) return b.rawAvg - a.rawAvg;
        if (b.examsTaken !== a.examsTaken) return b.examsTaken - a.examsTaken;
      }
      return a.name.localeCompare(b.name);
    });

    // 7. Assign ranks and cap
    const limitNum = Math.min(Number(limit) || 100, 500);
    const result = leaderboard.slice(0, limitNum).map((entry, idx) => ({
      ...entry,
      rank: idx + 1,
    }));

    // 8. Find current user's rank
    const myIdx = leaderboard.findIndex(r => r.userId === user.id);
    const myRank = myIdx >= 0 ? { ...leaderboard[myIdx], rank: myIdx + 1 } : null;

    res.setHeader('Cache-Control', 'no-store');
    res.json({ leaderboard: result, myRank, totalParticipants });
  } catch (error: any) {
    console.error('[Leaderboard] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── /online/filters ───────────────────────────────────────────────────────────
// Class/subject options drawn ONLY from exams whose results are published.
router.get('/online/filters', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const ids = await publishedExamIds();
    const exams = await Exam.find({ _id: { $in: ids } })
      .select('classLevel meta')
      .lean() as any[];
    const classes = Array.from(new Set(exams.map((e) => e.classLevel).filter(Boolean))).sort();
    const subjects = Array.from(new Set(exams.map(examSubject).filter(Boolean))).sort();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ classes, subjects });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── /online/exams ─────────────────────────────────────────────────────────────
// Published exams the student can pick to see a single-exam ranking.
router.get('/online/exams', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { classLevel, subject } = req.query;
    const ids = await publishedExamIds();
    const match: any = { _id: { $in: ids } };
    if (classLevel) match.classLevel = classLevel as string;
    const exams = await Exam.find(match)
      .select('title classLevel meta schedule createdAt')
      .lean() as any[];
    let rows = exams.map((e) => ({
      _id: e._id,
      title: e.title,
      classLevel: e.classLevel,
      subject: examSubject(e),
      date: examDate(e),
    }));
    if (subject) rows = rows.filter((r) => (r.subject || '') === (subject as string));
    rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    res.setHeader('Cache-Control', 'no-store');
    res.json({ exams: rows });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── /online ───────────────────────────────────────────────────────────────────
// Online-exam leaderboard. With `examId` → single-exam ranking (uses the stored
// per-test rank/percentile). Without it → aggregate across all published exams
// (optionally class/subject filtered), mirroring the offline leaderboard shape.
router.get('/online', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { examId, classLevel, subject, limit = 100 } = req.query;
    const limitNum = Math.min(Number(limit) || 100, 500);

    const countCorrect = (answers: any[] = []) =>
      answers.filter((ans) => ans.isCorrect === true || (typeof ans.scoreAwarded === 'number' && ans.scoreAwarded > 0)).length;

    // ── Single-exam ranking ──────────────────────────────────────────────────
    if (examId) {
      const exam = await Exam.findById(examId as string).select('title classLevel meta').lean() as any;
      const attempts = await Attempt.find({ examId: new Types.ObjectId(examId as string), resultPublished: true, submittedAt: { $ne: null } })
        .populate('userId', 'name classLevel batch')
        .lean() as any[];
      if (!exam || attempts.length === 0) {
        // No published results yet — keep standings hidden.
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ leaderboard: [], myRank: null, totalParticipants: 0, examTitle: exam?.title, published: false });
      }
      const rows = attempts
        .filter((a) => a.userId)
        .map((a) => ({
          userId: (a.userId._id || a.userId).toString(),
          name: a.userId.name || 'Student',
          classLevel: a.userId.classLevel,
          batch: a.userId.batch,
          totalScore: a.totalScore || 0,
          maxPossibleScore: a.maxScore || 0,
          examsTaken: 1,
          avgPercentage: typeof a.percentage === 'number' ? Math.round(a.percentage) : 0,
          percentage: a.percentage ?? 0,
          percentile: a.percentile ?? null,
          rankInTest: a.rankInTest ?? null,
          correctCount: countCorrect(a.answers),
          hasData: true,
        }));
      // Order by stored per-test rank (fallback: score desc).
      rows.sort((x, y) => {
        if (x.rankInTest != null && y.rankInTest != null) return x.rankInTest - y.rankInTest;
        return (y.totalScore || 0) - (x.totalScore || 0);
      });
      const ranked = rows.map((r, idx) => ({ ...r, rank: r.rankInTest ?? idx + 1 }));
      const myIdx = ranked.findIndex((r) => r.userId === user.id);
      const myRank = myIdx >= 0 ? ranked[myIdx] : null;
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ leaderboard: ranked.slice(0, limitNum), myRank, totalParticipants: ranked.length, examTitle: exam.title, published: true });
    }

    // ── Aggregate across all published exams ─────────────────────────────────
    let ids = await publishedExamIds();
    if (classLevel || subject) {
      const match: any = { _id: { $in: ids } };
      if (classLevel) match.classLevel = classLevel as string;
      const exams = await Exam.find(match).select('meta').lean() as any[];
      let keep = exams;
      if (subject) keep = exams.filter((e) => (examSubject(e) || '') === (subject as string));
      ids = keep.map((e) => e._id);
    }

    const attempts = await Attempt.find({ examId: { $in: ids }, resultPublished: true, submittedAt: { $ne: null } })
      .populate('userId', 'name classLevel batch')
      .lean() as any[];

    interface Bucket {
      userId: string; name: string; classLevel?: string; batch?: string;
      totalScore: number; maxPossibleScore: number; examsTaken: number; percentageSum: number;
    }
    const byUser = new Map<string, Bucket>();
    for (const a of attempts) {
      if (!a.userId) continue;
      const uid = (a.userId._id || a.userId).toString();
      if (!byUser.has(uid)) {
        byUser.set(uid, {
          userId: uid, name: a.userId.name || 'Student', classLevel: a.userId.classLevel, batch: a.userId.batch,
          totalScore: 0, maxPossibleScore: 0, examsTaken: 0, percentageSum: 0,
        });
      }
      const b = byUser.get(uid)!;
      b.totalScore += a.totalScore || 0;
      b.maxPossibleScore += a.maxScore || 0;
      b.examsTaken += 1;
      b.percentageSum += typeof a.percentage === 'number'
        ? a.percentage
        : (a.maxScore > 0 ? ((a.totalScore || 0) / a.maxScore) * 100 : 0);
    }

    const leaderboard = Array.from(byUser.values()).map((b) => {
      const rawAvg = b.examsTaken > 0 ? b.percentageSum / b.examsTaken : 0;
      return {
        userId: b.userId, name: b.name, classLevel: b.classLevel, batch: b.batch,
        totalScore: Math.round(b.totalScore * 100) / 100,
        maxPossibleScore: Math.round(b.maxPossibleScore * 100) / 100,
        examsTaken: b.examsTaken,
        avgPercentage: Math.round(rawAvg),
        rawAvg,
        hasData: b.examsTaken > 0,
      };
    });

    // Competition ranking by average %, mirroring the offline leaderboard.
    leaderboard.sort((a, b) => {
      if (b.rawAvg !== a.rawAvg) return b.rawAvg - a.rawAvg;
      if (b.examsTaken !== a.examsTaken) return b.examsTaken - a.examsTaken;
      return a.name.localeCompare(b.name);
    });
    const result = leaderboard.slice(0, limitNum).map((entry, idx) => ({ ...entry, rank: idx + 1 }));
    const myIdx = leaderboard.findIndex((r) => r.userId === user.id);
    const myRank = myIdx >= 0 ? { ...leaderboard[myIdx], rank: myIdx + 1 } : null;

    res.setHeader('Cache-Control', 'no-store');
    res.json({ leaderboard: result, myRank, totalParticipants: leaderboard.length });
  } catch (error: any) {
    console.error('[OnlineLeaderboard] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
