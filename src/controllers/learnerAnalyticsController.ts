import { Request, Response } from 'express';
import mongoose from 'mongoose';
import LearnerProgress from '../models/LearnerProgress';
import LearnerSave from '../models/LearnerSave';
import PublicAttempt from '../models/PublicAttempt';
import PublicTest from '../models/PublicTest';
import StudyResource from '../models/StudyResource';
import User from '../models/User';
import { foldBreakdowns, rankSubjectPerformance } from '../utils/publicAssessment';

/**
 * Public learner analytics.
 *
 * ── Two halves, each reported only when it is real ───────────────────────────
 * LEARNING comes from LearnerProgress and LearnerSave: minutes watched,
 * lectures finished, per-subject breakdown, activity over time.
 *
 * ASSESSMENT comes from PublicAttempt: scores, accuracy, subject and difficulty
 * performance, and a score trend. This half did not exist when the screen was
 * first built, and the rule then was to say so rather than render zeroes — a
 * learner reading a real-looking 0% accuracy would conclude something false
 * about themselves. The same rule still applies in the other direction: a
 * learner who has watched lectures but never sat a test gets
 * `assessment.hasData: false`, not an empty chart.
 *
 * ── The distinction that matters most ────────────────────────────────────────
 * Score (marks over maximum) and accuracy (correct over attempted) diverge
 * under negative marking, and merged across many papers they answer genuinely
 * different questions: "how did I do" versus "when I commit to an answer, am I
 * right?". Both are reported; neither is presented as the other.
 *
 * ── Cost ─────────────────────────────────────────────────────────────────────
 * Two bounded reads on the learner's OWN rows, each index-backed by a
 * { learnerId, ... } compound index, plus one lookup per half to resolve titles.
 * Nothing here scans another learner's data or any institute collection.
 */

const requireLearner = async (req: Request, res: Response): Promise<string | null> => {
  const current = (req as any).user as { id: string } | undefined;
  if (!current) {
    res.status(401).json({ message: 'Unauthorized' });
    return null;
  }
  const user = await User.findById(current.id).select('accountType').lean();
  if (!user) {
    res.status(404).json({ message: 'Account not found' });
    return null;
  }
  if (user.accountType !== 'PUBLIC_LEARNER') {
    res.status(403).json({ message: 'Not a public learner account' });
    return null;
  }
  return current.id;
};

/** Local YYYY-MM-DD key for day bucketing. */
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * GET /api/learner/analytics
 *
 * A single call returning everything the analytics screen renders, so the
 * client never fans out into per-metric requests.
 */
export const getLearnerAnalytics = async (req: Request, res: Response) => {
  try {
    const learnerId = await requireLearner(req, res);
    if (!learnerId) return;

    const oid = new mongoose.Types.ObjectId(learnerId);

    const [rows, savedCount, assessment] = await Promise.all([
      LearnerProgress.find({ learnerId: oid }).sort({ lastAccessedAt: -1 }).limit(500).lean(),
      LearnerSave.countDocuments({ learnerId: oid }),
      buildAssessmentAnalytics(oid),
    ]);

    if (rows.length === 0) {
      return res.json({
        // `hasData` describes the LEARNING half only. A learner who has taken
        // tests but watched nothing still gets a populated screen, which is why
        // the two halves report independently.
        hasData: false,
        totals: {
          started: 0,
          completed: 0,
          savedCount,
          secondsWatched: 0,
          completionRate: 0,
        },
        subjects: [],
        activity: buildActivitySkeleton(),
        recent: [],
        assessment,
      });
    }

    // Resolve the resources these rows point at, so a subject breakdown is
    // possible. Only published+public items count — a resource pulled from the
    // library should not keep inflating a learner's totals.
    const resources = await StudyResource.find({
      _id: { $in: rows.map((r) => r.resourceId) },
      status: 'published',
      isPublic: true,
    })
      .select('subject type title classLevel')
      .lean();

    const byId = new Map(resources.map((r) => [String(r._id), r]));
    const live = rows.filter((r) => byId.has(String(r.resourceId)));

    // ── Totals ──
    const started = live.length;
    const completed = live.filter((r) => r.completed).length;
    const secondsWatched = live.reduce(
      (sum, r) => sum + Math.min(r.positionSec, r.durationSec || r.positionSec),
      0,
    );

    // ── Per-subject ──
    const subjectMap = new Map<
      string,
      {
        subject: string;
        started: number;
        completed: number;
        secondsWatched: number;
      }
    >();

    live.forEach((r) => {
      const resource = byId.get(String(r.resourceId))!;
      const subject = resource.subject || 'Other';
      const entry = subjectMap.get(subject) ?? {
        subject,
        started: 0,
        completed: 0,
        secondsWatched: 0,
      };
      entry.started += 1;
      if (r.completed) entry.completed += 1;
      entry.secondsWatched += Math.min(r.positionSec, r.durationSec || r.positionSec);
      subjectMap.set(subject, entry);
    });

    const subjects = Array.from(subjectMap.values())
      .map((s) => ({
        ...s,
        // Share of finished-vs-started within the subject. Honest about what it
        // measures: not a score, a completion ratio.
        completionRate: s.started > 0 ? s.completed / s.started : 0,
      }))
      .sort((a, b) => b.secondsWatched - a.secondsWatched);

    // ── Activity: last 14 days of touched-content counts ──
    const activity = buildActivitySkeleton();
    const activityIndex = new Map(activity.map((d, i) => [d.date, i]));
    live.forEach((r) => {
      const key = dayKey(new Date(r.lastAccessedAt));
      const i = activityIndex.get(key);
      if (i !== undefined) activity[i].count += 1;
    });

    // ── Recent items, for the history strip ──
    const recent = live.slice(0, 8).map((r) => {
      const resource = byId.get(String(r.resourceId))!;
      return {
        resourceId: String(r.resourceId),
        title: resource.title,
        subject: resource.subject,
        type: resource.type,
        percent: r.percent,
        completed: r.completed,
        lastAccessedAt: r.lastAccessedAt,
      };
    });

    return res.json({
      hasData: true,
      totals: {
        started,
        completed,
        savedCount,
        secondsWatched,
        completionRate: started > 0 ? completed / started : 0,
      },
      subjects,
      activity,
      recent,
      assessment,
    });
  } catch (error) {
    console.error('Error building learner analytics:', error);
    return res.status(500).json({ message: 'Unable to load your analytics right now.' });
  }
};

// ─── Assessment half ─────────────────────────────────────────────────────────

/** How many attempts the trend line plots. Enough to show a direction. */
const TREND_LENGTH = 12;

/**
 * Everything the assessment section renders, from the learner's own attempts.
 *
 * Merges the per-attempt breakdowns the grader already denormalised onto each
 * PublicAttempt, so this is a fold over documents rather than a re-grade — no
 * question is loaded and no marking scheme is re-applied.
 */
async function buildAssessmentAnalytics(learnerId: mongoose.Types.ObjectId) {
  const empty = {
    hasData: false,
    totals: {
      attempts: 0,
      inProgress: 0,
      averagePercentage: 0,
      bestPercentage: 0,
      accuracy: 0,
      correct: 0,
      incorrect: 0,
      unattempted: 0,
      secondsSpent: 0,
    },
    trend: [] as unknown[],
    bySubject: [] as unknown[],
    byDifficulty: [] as unknown[],
    strongest: null as string | null,
    weakest: null as string | null,
  };

  const [attempts, inProgress] = await Promise.all([
    PublicAttempt.find({ learnerId, status: { $ne: 'in-progress' } })
      .select(
        'testId status submittedAt durationSec totalScore maxScore percentage correctCount incorrectCount unattemptedCount bySubject byDifficulty',
      )
      .sort({ submittedAt: -1 })
      .limit(200)
      .lean(),
    PublicAttempt.countDocuments({ learnerId, status: 'in-progress' }),
  ]);

  if (attempts.length === 0) {
    return { ...empty, totals: { ...empty.totals, inProgress } };
  }

  // ── Totals ──
  const correct = attempts.reduce((n, a) => n + (a.correctCount ?? 0), 0);
  const incorrect = attempts.reduce((n, a) => n + (a.incorrectCount ?? 0), 0);
  const unattempted = attempts.reduce((n, a) => n + (a.unattemptedCount ?? 0), 0);
  const secondsSpent = attempts.reduce((n, a) => n + (a.durationSec ?? 0), 0);
  const percentages = attempts.map((a) => a.percentage ?? 0);

  // ── Per-subject and per-difficulty, merged across every attempt ──
  // The fold and the ranking rule live in utils/publicAssessment.ts so they can
  // be verified without a database (scripts/verify-public-assessment.ts).
  const subjectRows = foldBreakdowns(
    attempts.flatMap((a) =>
      (a.bySubject ?? []).map((r) => ({
        key: r.subject,
        correct: r.correct,
        total: r.total,
      })),
    ),
  );
  const difficultyRows = foldBreakdowns(
    attempts.flatMap((a) =>
      (a.byDifficulty ?? []).map((r) => ({
        key: r.difficulty,
        correct: r.correct,
        total: r.total,
      })),
    ),
  );

  const bySubject = subjectRows.map((r) => ({
    subject: r.key,
    correct: r.correct,
    total: r.total,
    accuracy: r.accuracy,
  }));

  // Ordered easy → medium → hard rather than by volume: difficulty is a scale,
  // and a chart that reorders a scale by count is unreadable.
  const byDifficultyByKey = new Map(difficultyRows.map((r) => [r.key, r]));
  const byDifficulty = ['easy', 'medium', 'hard']
    .filter((k) => byDifficultyByKey.has(k))
    .map((difficulty) => {
      const r = byDifficultyByKey.get(difficulty)!;
      return {
        difficulty,
        correct: r.correct,
        total: r.total,
        accuracy: r.accuracy,
      };
    });

  const { strongest, weakest } = rankSubjectPerformance(subjectRows);

  // ── Trend: oldest → newest, so the line reads left to right ──
  const trendSlice = attempts.slice(0, TREND_LENGTH).reverse();
  const tests = await PublicTest.find({
    _id: { $in: trendSlice.map((a) => a.testId) },
  })
    .select('title subject kind')
    .lean();
  const testById = new Map(tests.map((t: any) => [String(t._id), t]));

  const trend = trendSlice.map((a) => {
    const test = testById.get(String(a.testId));
    return {
      attemptId: String(a._id),
      testId: String(a.testId),
      title: test?.title ?? 'Test',
      subject: test?.subject,
      percentage: a.percentage ?? 0,
      submittedAt: a.submittedAt,
    };
  });

  return {
    hasData: true,
    totals: {
      attempts: attempts.length,
      inProgress,
      averagePercentage: round2(percentages.reduce((n, p) => n + p, 0) / percentages.length),
      bestPercentage: round2(Math.max(...percentages)),
      // Accuracy excludes skipped questions on purpose: it answers "when I
      // commit to an answer, am I right?", which is a different question from
      // the score and is the one a learner can act on.
      accuracy: correct + incorrect > 0 ? round2((correct / (correct + incorrect)) * 100) : 0,
      correct,
      incorrect,
      unattempted,
      secondsSpent,
    },
    trend,
    bySubject,
    byDifficulty,
    strongest,
    weakest,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 14 zero-filled days ending today, so the chart has a stable x-axis. */
function buildActivitySkeleton() {
  const days: { date: string; count: number }[] = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push({ date: dayKey(d), count: 0 });
  }
  return days;
}

/**
 * DELETE /api/learner/account
 *
 * A learner-specific deletion that also removes the rows only a learner owns.
 * The shared institute endpoint (DELETE /api/auth/account) deletes the User
 * document alone, which would leave LearnerSave and LearnerProgress orphaned —
 * and it is production institute code, so it is left untouched rather than
 * widened.
 *
 * Refuses non-learner accounts outright: an institute student must never be
 * deletable through the public surface.
 */
export const deleteLearnerAccount = async (req: Request, res: Response) => {
  try {
    const learnerId = await requireLearner(req, res);
    if (!learnerId) return;

    const oid = new mongoose.Types.ObjectId(learnerId);

    // Learner-owned data first, so a failure part-way cannot leave a deleted
    // account with live rows pointing at it.
    //
    // PublicAttempt is included because attempts are learner-owned personal
    // data: leaving them behind would keep a deleted person's answers and
    // scores in the database, and they would surface in any future
    // per-test aggregate with no account to attribute them to.
    await Promise.all([
      LearnerProgress.deleteMany({ learnerId: oid }),
      LearnerSave.deleteMany({ learnerId: oid }),
      PublicAttempt.deleteMany({ learnerId: oid }),
    ]);

    await User.findByIdAndDelete(oid);

    console.log(`[DeleteLearner] Public learner account deleted: ${learnerId}`);
    return res.json({ message: 'Account permanently deleted' });
  } catch (error) {
    console.error('Error deleting learner account:', error);
    return res.status(500).json({ message: 'Unable to delete your account right now.' });
  }
};
