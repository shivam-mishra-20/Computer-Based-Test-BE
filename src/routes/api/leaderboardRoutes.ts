import { Router, Request, Response } from 'express';
import User from '../../models/User';
import TestResult from '../../models/TestResult';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

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

export default router;
