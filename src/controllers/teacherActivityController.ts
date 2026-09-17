/**
 * Teacher activity — read-only.
 *
 * The companion to the daily working hours report. That one says how long a
 * teacher was present; this one says what they produced for students while
 * they were: homework, study material, syllabus progress, tests, exams, doubt
 * threads and notices.
 *
 * Two endpoints, because they answer two different questions at two very
 * different costs — see `services/teacherActivity/loaders.ts`.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * A teacher's id comes from their token and nowhere else. `teacherId` in the
 * query string is honoured for administrators only, so there is no parameter a
 * teacher can change to read a colleague's record. This mirrors
 * `dailyHoursController` exactly, and deliberately: two screens of the same
 * report must not disagree about who may see what.
 */

import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { parseDateOnly, toYMD } from '../services/dailyHoursService';
import {
  ACTIVITY_SOURCES,
  buildActivityDetail,
  buildActivitySummary,
  parseKinds,
} from '../services/teacherActivity';

/** The same ceiling the hours report uses, so the two stay in step. */
const MAX_RANGE_DAYS = 92;

type Range = { from: Date; to: Date };

function resolveRange(query: any): Range | { error: string } {
  const { from, to } = query || {};

  if (!from && !to) {
    const now = new Date();
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
      to: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999),
    };
  }

  // A single `from` reads as a single day, which is what the date filter sends.
  const fromDate = parseDateOnly(String(from || to), false);
  const toDate = parseDateOnly(String(to || from), true);
  if (!fromDate || !toDate) return { error: 'Invalid date format. Use YYYY-MM-DD' };
  if (fromDate.getTime() > toDate.getTime()) {
    return { error: 'From date cannot be later than to date' };
  }

  const days = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    return { error: `Select a range of ${MAX_RANGE_DAYS} days or fewer` };
  }
  return { from: fromDate, to: toDate };
}

/**
 * Whose records the caller may read.
 *
 * Returns the teacher id to pin to, or null meaning "the whole roster" — which
 * only an administrator can ever be given.
 */
function resolveScope(
  req: Request
): { userId: string | null; isAdmin: boolean } | { error: string } {
  const authUser = (req as any).user;
  const isAdmin = authUser?.role === 'admin';

  if (!isAdmin) return { userId: String(authUser.id), isAdmin: false };

  const requested = String(req.query.teacherId || '').trim();
  if (!requested) return { userId: null, isAdmin: true };
  if (!mongoose.Types.ObjectId.isValid(requested)) return { error: 'Invalid teacherId' };
  return { userId: requested, isAdmin: true };
}

/** The catalogue, so the client labels sections without hard-coding them. */
const KIND_CATALOGUE = ACTIVITY_SOURCES.map((source) => ({
  kind: source.kind,
  label: source.label,
  noun: source.noun,
  rangeMode: source.rangeMode,
}));

class TeacherActivityController {
  /**
   * GET /api/teacher-activity/summary
   *
   * Query: from, to (YYYY-MM-DD), teacherId (admin only).
   *
   * Counts only — no documents are loaded. This is what the teacher list uses,
   * so it has to stay cheap as the roster and the term both grow.
   */
  public static async getSummary(req: Request, res: Response): Promise<void> {
    try {
      const range = resolveRange(req.query);
      if ('error' in range) {
        res.status(400).json({ message: range.error });
        return;
      }

      const scope = resolveScope(req);
      if ('error' in scope) {
        res.status(400).json({ message: scope.error });
        return;
      }

      const { rows, errors } = await buildActivitySummary({
        from: range.from,
        to: range.to,
        userId: scope.userId || undefined,
      });

      res.json({
        period: { from: toYMD(range.from), to: toYMD(range.to) },
        generatedAt: new Date().toISOString(),
        scope: scope.isAdmin && !scope.userId ? 'all' : 'self',
        kinds: KIND_CATALOGUE,
        rows,
        // Named so the client can say which section is unavailable rather than
        // showing a zero that reads as "this teacher did nothing".
        unavailable: errors,
      });
    } catch (error: any) {
      console.error('[TeacherActivity] summary error:', error);
      res.status(500).json({ message: 'Error building the teacher activity summary' });
    }
  }

  /**
   * GET /api/teacher-activity/detail
   *
   * Query: from, to (YYYY-MM-DD), teacherId (admin only), kinds (comma list).
   */
  public static async getDetail(req: Request, res: Response): Promise<void> {
    try {
      const range = resolveRange(req.query);
      if ('error' in range) {
        res.status(400).json({ message: range.error });
        return;
      }

      const scope = resolveScope(req);
      if ('error' in scope) {
        res.status(400).json({ message: scope.error });
        return;
      }

      // Detail is always about one person. An administrator who asks for
      // nobody in particular is asking the wrong endpoint, and answering with
      // the whole roster's documents is exactly the payload this design
      // avoids, so it is refused rather than served.
      if (!scope.userId) {
        res.status(400).json({ message: 'teacherId is required' });
        return;
      }

      const result = await buildActivityDetail({
        from: range.from,
        to: range.to,
        userId: scope.userId,
        kinds: parseKinds(req.query.kinds),
      });

      if (!result.teacher) {
        res.status(404).json({ message: 'Teacher not found' });
        return;
      }

      res.json({
        period: { from: toYMD(range.from), to: toYMD(range.to) },
        generatedAt: new Date().toISOString(),
        scope: scope.isAdmin ? 'all' : 'self',
        teacher: result.teacher,
        sections: result.sections,
      });
    } catch (error: any) {
      console.error('[TeacherActivity] detail error:', error);
      res.status(500).json({ message: 'Error building the teacher activity report' });
    }
  }
}

export default TeacherActivityController;
