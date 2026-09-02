/**
 * Daily Working Hours report — read-only.
 *
 * One endpoint serving both audiences, because the report is the same report:
 * only its scope differs. A teacher is pinned to their own id server-side and
 * cannot widen it; an administrator may filter to one teacher or see everyone.
 */

import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { buildDailyHoursReport, parseDateOnly, toYMD } from '../services/dailyHoursService';

/** A quarter of days is the most this report renders usefully in one page. */
const MAX_RANGE_DAYS = 92;

function resolveRange(query: any): { from: Date; to: Date } | { error: string } {
  const { from, to } = query || {};

  if (!from && !to) {
    // Default: the current month up to today.
    const now = new Date();
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
      to: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999),
    };
  }

  // A single `from` is read as a single day, which is what the date filter sends.
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

class DailyHoursController {
  /**
   * GET /api/daily-hours
   *
   * Query: from, to (YYYY-MM-DD), teacherId (admin only).
   */
  public static async getReport(req: Request, res: Response): Promise<void> {
    try {
      const authUser = (req as any).user;
      const isAdmin = authUser?.role === 'admin';

      const range = resolveRange(req.query);
      if ('error' in range) {
        res.status(400).json({ message: range.error });
        return;
      }

      // ── Scope ─────────────────────────────────────────────────────────────
      // A teacher's id comes from their token, never from the query string, so
      // there is no parameter for them to change to read a colleague's hours.
      let userId: string | undefined;
      if (isAdmin) {
        const requested = String(req.query.teacherId || '').trim();
        if (requested) {
          if (!mongoose.Types.ObjectId.isValid(requested)) {
            res.status(400).json({ message: 'Invalid teacherId' });
            return;
          }
          userId = requested;
        }
      } else {
        userId = String(authUser.id);
      }

      const { teachers, rows } = await buildDailyHoursReport({
        from: range.from,
        to: range.to,
        userId,
      });

      const totals = rows.reduce(
        (acc, row) => {
          acc.workingMinutes += row.workingMinutes;
          acc.classMinutes += row.classMinutes;
          acc.nonClassMinutes += row.nonClassMinutes;
          // A record with only one punch is still attendance; it is counted as
          // a day with a punch and reported separately as incomplete.
          if (row.inTime || row.outTime) acc.daysWithPunch += 1;
          if (row.incomplete) acc.incompleteDays += 1;
          if (row.eodStatus !== 'NOT_SUBMITTED') acc.daysWithEod += 1;
          return acc;
        },
        {
          workingMinutes: 0,
          classMinutes: 0,
          nonClassMinutes: 0,
          daysWithPunch: 0,
          incompleteDays: 0,
          daysWithEod: 0,
        }
      );

      res.json({
        period: { from: toYMD(range.from), to: toYMD(range.to) },
        generatedAt: new Date().toISOString(),
        scope: isAdmin ? 'all' : 'self',
        // Only an administrator gets the roster for the teacher filter; for a
        // teacher this is just themselves.
        teachers,
        filters: { teacherId: userId || null },
        totals,
        rows,
      });
    } catch (error: any) {
      console.error('[DailyHours] report error:', error);
      res.status(500).json({ message: 'Error building the daily working hours report' });
    }
  }
}

export default DailyHoursController;
