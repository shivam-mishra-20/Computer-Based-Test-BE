import { Request, Response } from 'express';
import QueueService from '../services/QueueService';
import Attendance from '../models/Attendance';
import absentService from '../services/absentCalculationService';
import {
  classifyDay,
  getEffectiveRule,
  getEffectiveRulesBulk,
  formatMinutes,
} from '../services/attendanceRuleService';
import { INSTITUTE_ACCOUNT_CLAUSE } from '../utils/instituteAudience';

export class AttendanceController {
  
  // POST /api/attendance/sync
  public static async syncOffline(req: Request, res: Response): Promise<void> {
    try {
      const { events } = req.body;
      
      if (!Array.isArray(events)) {
        res.status(400).json({ message: 'Invalid payload: events must be an array' });
        return;
      }

      const results = [];
      const user = (req as any).user;

      for (const event of events) {
        // Basic validation
        if (!event.studentId || !event.date || !event.status) {
           results.push({ id: event.id, status: 'failed', error: 'Missing fields' });
           continue;
        }

        // Add to queue for processing
        await QueueService.add({
          ...event,
          source: 'sync',
          markedBy: user?.id || event.markedBy, // trusting client or token
          metadata: {
            syncedAt: new Date(),
            device: req.headers['user-agent']
          }
        });

        results.push({ id: event.id, status: 'queued' });
      }

      res.json({ message: 'Sync processed', results });

    } catch (error) {
      console.error('Sync Error:', error);
      res.status(500).json({ message: 'Internal Server Error' });
    }
  }

  // GET /api/attendance/history (Simple fetch for client reconciliation)
  public static async getHistory(req: Request, res: Response): Promise<void> {
      try {
          const { studentId, from, to } = req.query;
          const query: any = { studentId };
          
          if (from || to) {
              query.date = {};
              if (from) query.date.$gte = new Date(from as string);
              if (to) query.date.$lte = new Date(to as string);
          }

          const records = await Attendance.find(query).sort({ date: -1 }).limit(100);
          res.json(records);
      } catch (error) {
          res.status(500).json({ message: 'Error fetching history' });
      }
  }

  // Helper for aggregation
  private static async aggregateAttendance(matchQuery: any, sort: any = { date: -1 }, pagination?: { page: number, limit: number }, postFilter: any = {}) {
    const aggregation: any[] = [
      { $match: matchQuery },
      { 
        $lookup: {
          from: 'users',
          localField: 'studentId',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      { 
        $project: {
          _id: 1,
          date: 1,
          status: 1,
          clockIn: 1,
          clockOut: 1,
          lateIn: 1,
          earlyOut: 1,
          source: 1,
          markedBy: 1,
          user: {
            _id: '$user._id',
            name: '$user.name',
            email: '$user.email',
            role: '$user.role',
            empCode: '$user.empCode',
            classLevel: '$user.classLevel',
            batch: '$user.batch'
          }
        }
      }
    ];

    if (Object.keys(postFilter).length > 0) {
      aggregation.push({ $match: postFilter });
    }

    aggregation.push({ $sort: sort });

    if (pagination) {
       const skip = (pagination.page - 1) * pagination.limit;
       aggregation.push({
        $facet: {
          metadata: [{ $count: "total" }],
          data: [{ $skip: skip }, { $limit: pagination.limit }]
        }
      });
    }

    return Attendance.aggregate(aggregation);
  }

  // Helper for grouped aggregation by user (combines multiple punch records)
  // First punch = Clock IN, Last punch = Clock OUT
  private static async aggregateGroupedByUser(matchQuery: any, postFilter: any = {}) {
    const aggregation: any[] = [
      { $match: matchQuery },
      // Sort by clockIn time to get proper first/last
      { $sort: { clockIn: 1 } },
      // Group by studentId to combine multiple punches per user per day
      {
        $group: {
          _id: '$studentId',
          clockIn: { $first: '$clockIn' },  // First punch = Clock IN
          clockOut: { $last: '$clockIn' },  // Last punch = Clock OUT (if multiple punches, use last clockIn value)
          actualClockOut: { $last: '$clockOut' },  // Or use explicit clockOut field if exists
          status: { $first: '$status' },
          lateIn: { $first: '$lateIn' },
          punchCount: { $sum: 1 },
          date: { $first: '$date' }
        }
      },
      // Lookup user info
      { 
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      // Project final shape
      { 
        $project: {
          _id: 1,
          date: 1,
          status: 1,
          // Use actual clockOut if available, otherwise use the last clockIn (second punch)
          clockIn: 1,
          clockOut: {
            $cond: {
              if: { $and: [
                { $ne: ['$actualClockOut', null] },
                { $ne: ['$actualClockOut', '--:--'] }
              ]},
              then: '$actualClockOut',
              else: {
                $cond: {
                  if: { $gt: ['$punchCount', 1] },
                  then: '$clockOut', // This is the last punch (second clockIn)
                  else: null
                }
              }
            }
          },
          lateIn: 1,
          punchCount: 1,
          user: {
            _id: '$user._id',
            name: '$user.name',
            email: '$user.email',
            role: '$user.role',
            empCode: '$user.empCode'
          }
        }
      }
    ];

    // Apply post filters (role, search)
    if (Object.keys(postFilter).length > 0) {
      aggregation.push({ $match: postFilter });
    }

    // Sort by name
    aggregation.push({ $sort: { 'user.name': 1 } });

    return Attendance.aggregate(aggregation);
  }

  // 1. Get Today's Attendance (Grouped by user - one row per person)
  public static async getAdminToday(req: Request, res: Response): Promise<void> {
    console.log('[AttendanceController] getAdminToday called with query:', req.query);
    try {
      const { role, status, search } = req.query;
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const query: any = { date: { $gte: today, $lt: tomorrow } };
      
      if (status) {
         if (status === 'ABSENT') {
             query.status = 'absent';
         } else if (status === 'IN') {
             query.clockIn = { $ne: '--:--' };
         } else if (status === 'OUT') {
             query.clockOut = { $ne: '--:--' };
         }
      }

      const postFilter: any = {};
      if (role) {
        postFilter['user.role'] = role;
      }
      if (search) {
        const regex = new RegExp(search as string, 'i');
        postFilter['$or'] = [
           { 'user.name': regex },
           { 'user.empCode': regex }
        ];
      }
      
      // Use grouped aggregation - one result per user per day
      const records = await AttendanceController.aggregateGroupedByUser(query, postFilter);

      // Load rules for all returned users in two queries
      const userIds = records.map((r: any) => String(r.user._id));
      const userRoles = new Map<string, string>(records.map((r: any) => [String(r.user._id), r.user.role]));
      const ruleMap = await getEffectiveRulesBulk(userIds, userRoles);

      res.json({
        date: today.toISOString().split('T')[0],
        lastSyncedAt: new Date(),
        data: records.map((r: any) => {
          const inTime = r.clockIn && r.clockIn !== '--:--' ? r.clockIn : null;
          const outTime = r.clockOut && r.clockOut !== '--:--' ? r.clockOut : null;
          const rule = ruleMap.get(String(r.user._id));
          const classification = classifyDay(inTime, outTime, rule!);
          return {
            userId: r.user._id,
            name: r.user.name,
            role: r.user.role,
            empCode: r.user.empCode,
            inTime,
            outTime,
            state: r.status === 'present' ? 'IN' : r.status === 'absent' ? 'ABSENT' : r.status,
            statusCode: r.status === 'present' ? 'P' : 'A',
            lateMinutes: r.lateIn ? parseInt(r.lateIn) : 0,
            classification,
          };
        }),
      });
    } catch (error) {
      console.error('Admin Today Attendance Error:', error);
      res.status(500).json({ message: 'Error fetching today attendance' });
    }
  }

  // 2. Attendance by Date (Grouped by user - one row per person)
  public static async getAdminByDate(req: Request, res: Response): Promise<void> {
    try {
      const { date, role, status, search } = req.query;
      if (!date) {
        res.status(400).json({ message: 'Date is required' });
        return;
      }
      
      const targetDate = new Date(date as string);
      targetDate.setHours(0,0,0,0);
      const nextDay = new Date(targetDate);
      nextDay.setDate(nextDay.getDate() + 1);
      
      const query: any = { date: { $gte: targetDate, $lt: nextDay } };

      if (status) {
         if (status === 'ABSENT') query.status = 'absent';
         else if (status === 'IN') query.clockIn = { $ne: '--:--' };
         else if (status === 'OUT') query.clockOut = { $ne: '--:--' };
      }

      const postFilter: any = {};
      if (role) postFilter['user.role'] = role;
      if (search) {
        const regex = new RegExp(search as string, 'i');
        postFilter['$or'] = [
           { 'user.name': regex },
           { 'user.empCode': regex }
        ];
      }

      // Use grouped aggregation - one result per user per day
      const records = await AttendanceController.aggregateGroupedByUser(query, postFilter);

      // Load rules for all returned users
      const userIds = records.map((r: any) => String(r.user._id));
      const userRoles = new Map<string, string>(records.map((r: any) => [String(r.user._id), r.user.role]));
      const ruleMap = await getEffectiveRulesBulk(userIds, userRoles);

      res.json({
        date,
        data: records.map((r: any) => {
          const inTime = r.clockIn && r.clockIn !== '--:--' ? r.clockIn : null;
          const outTime = r.clockOut && r.clockOut !== '--:--' ? r.clockOut : null;
          const rule = ruleMap.get(String(r.user._id));
          const classification = classifyDay(inTime, outTime, rule!);
          return {
            userId: r.user._id,
            name: r.user.name,
            role: r.user.role,
            empCode: r.user.empCode,
            inTime,
            outTime,
            state: r.status === 'present' ? 'IN' : r.status === 'absent' ? 'ABSENT' : r.status,
            classification,
          };
        }),
      });
    } catch (error) {
       console.error('Admin ByDate Attendance Error:', error);
       res.status(500).json({ message: 'Error fetching attendance by date' });
    }
  }

  // 3. Attendance History of ONE User
  public static async getAdminUserAttendance(req: Request, res: Response): Promise<void> {
     try {
       const { userId } = req.params;
       const { from, to } = req.query;

       const mongoose = require('mongoose');
       if (!mongoose.Types.ObjectId.isValid(userId)) {
         res.status(400).json({ message: 'Invalid user id' });
         return;
       }

       const parseDateOnly = (dateValue: string, endOfDay: boolean): Date | null => {
         const normalized = String(dateValue || '').trim();
         if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;

         const [yearStr, monthStr, dayStr] = normalized.split('-');
         const year = Number(yearStr);
         const month = Number(monthStr);
         const day = Number(dayStr);

         const parsed = endOfDay
           ? new Date(year, month - 1, day, 23, 59, 59, 999)
           : new Date(year, month - 1, day, 0, 0, 0, 0);

         if (
           Number.isNaN(parsed.getTime()) ||
           parsed.getFullYear() !== year ||
           parsed.getMonth() + 1 !== month ||
           parsed.getDate() !== day
         ) {
           return null;
         }

         return parsed;
       };

       const formatDateLocal = (value: Date): string => {
         const year = value.getFullYear();
         const month = String(value.getMonth() + 1).padStart(2, '0');
         const day = String(value.getDate()).padStart(2, '0');
         return `${year}-${month}-${day}`;
       };

       let fromDate: Date | null = null;
       let toDate: Date | null = null;

       if (from || to) {
         if (!from || !to) {
           res.status(400).json({ message: 'Both from and to dates are required' });
           return;
         }

         fromDate = parseDateOnly(from as string, false);
         toDate = parseDateOnly(to as string, true);

         if (!fromDate || !toDate) {
           res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
           return;
         }

         if (fromDate.getTime() > toDate.getTime()) {
           res.status(400).json({ message: 'From date cannot be greater than to date' });
           return;
         }
       }

       const User = require('../models/User').default;
       const userInfo = await User.findById(userId).select('name empCode role').lean();
       if (!userInfo) {
         res.status(404).json({ message: 'User not found' });
         return;
       }

       const matchQuery: any = {
         studentId: new mongoose.Types.ObjectId(userId)
       };

       if (fromDate && toDate) {
         matchQuery.date = {
           $gte: fromDate,
           $lte: toDate
         };
       }

       const records = await Attendance.aggregate([
         { $match: matchQuery },
         { $sort: { date: 1, clockIn: 1 } },
         {
           $group: {
             _id: {
               $dateToString: { format: '%Y-%m-%d', date: '$date' }
             },
             date: { $first: '$date' },
             clockIn: { $first: '$clockIn' },
             lastPunchClockIn: { $last: '$clockIn' },
             actualClockOut: { $last: '$clockOut' },
             status: { $first: '$status' },
             lateIn: { $first: '$lateIn' },
             punchCount: { $sum: 1 }
           }
         },
         {
           $project: {
             _id: 1,
             date: 1,
             clockIn: 1,
             clockOut: {
               $cond: {
                 if: {
                   $and: [
                     { $ne: ['$actualClockOut', null] },
                     { $ne: ['$actualClockOut', '--:--'] }
                   ]
                 },
                 then: '$actualClockOut',
                 else: {
                   $cond: {
                     if: { $gt: ['$punchCount', 1] },
                     then: '$lastPunchClockIn',
                     else: null
                   }
                 }
               }
             },
             status: 1,
             lateIn: 1,
             punchCount: 1
           }
         },
         { $sort: { date: -1 } }
       ]);

       // Load the effective rule for this user (single lookup, reused for every row)
       const effectiveRule = await getEffectiveRule(userId, userInfo.role);

       const attendance = records.map((r: any) => {
         const rawState = String(r.status || '').toLowerCase();
         const normalizedState =
           rawState === 'present' || rawState === 'in'
             ? 'IN'
             : rawState === 'absent' || rawState === 'a'
               ? 'ABSENT'
               : rawState === 'late'
                 ? 'LATE'
                 : rawState
                   ? rawState.toUpperCase()
                   : 'UNKNOWN';

         const lateMinutes = r.lateIn ? parseInt(r.lateIn, 10) || 0 : 0;
         const inTime = r.clockIn && r.clockIn !== '--:--' ? r.clockIn : null;
         const outTime = r.clockOut && r.clockOut !== '--:--' ? r.clockOut : null;

         const classification = classifyDay(inTime, outTime, effectiveRule);

         return {
           date: formatDateLocal(new Date(r.date)),
           inTime,
           outTime,
           state: normalizedState,
           lateMinutes,
           punchCount: r.punchCount || 1,
           classification,
         };
       });

       let statsFrom = fromDate;
       let statsTo = toDate;
       if (!statsFrom || !statsTo) {
         const now = new Date();
         statsFrom = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
         statsTo = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
       }

       const advancedStats = await absentService.calculateStats(userId, statsFrom, statsTo);

       const lateCount = attendance.filter(
         (row: any) => String(row.state || '').toUpperCase() === 'LATE' || Number(row.lateMinutes || 0) > 0
       ).length;

       const presentWorkingDays = Math.max(
         advancedStats.expectedDays - advancedStats.absentDays,
         0
       );

       res.json({
         user: {
           name: userInfo.name,
           empCode: userInfo.empCode,
           role: userInfo.role
         },
         period: {
           from: statsFrom ? formatDateLocal(statsFrom) : null,
           to: statsTo ? formatDateLocal(statsTo) : null
         },
         generatedAt: new Date().toISOString(),
         rule: effectiveRule,
         stats: {
           present: presentWorkingDays,
           absent: advancedStats.absentDays,
           late: lateCount,
           total: advancedStats.expectedDays,
           holidays: advancedStats.holidays,
           extraDays: advancedStats.extraDays
         },
         attendance,
         meta: {
           expectedDays: advancedStats.expectedDays,
           presentDates: advancedStats.presentDates,
           absentDates: advancedStats.absentDates,
           workingDates: advancedStats.workingDates,
           holidayDates: advancedStats.holidayDates
         }
       });
     } catch (error) {
       console.error('User Attendance Error:', error);
       res.status(500).json({ message: 'Error fetching user attendance' });
     }
  }

  // 3b. Bulk Export: ALL users across a date range (periodic report + roster)
  // Returns one entry per filtered user, each with day-by-day records and totals.
  // Designed to run in a handful of queries (holidays + users + attendance) rather
  // than N per-user calls, mirroring absentService's Mon-Sat + holiday rule in memory.
  public static async getAdminExport(req: Request, res: Response): Promise<void> {
    try {
      const mongoose = require('mongoose');
      const User = require('../models/User').default;
      const Holiday = require('../models/Holiday').default;

      const { from, to, role, search } = req.query;

      const parseDateOnly = (value: string, endOfDay: boolean): Date | null => {
        const normalized = String(value || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
        const [y, m, d] = normalized.split('-').map(Number);
        const parsed = endOfDay
          ? new Date(y, m - 1, d, 23, 59, 59, 999)
          : new Date(y, m - 1, d, 0, 0, 0, 0);
        if (
          Number.isNaN(parsed.getTime()) ||
          parsed.getFullYear() !== y ||
          parsed.getMonth() + 1 !== m ||
          parsed.getDate() !== d
        ) {
          return null;
        }
        return parsed;
      };

      const toYMD = (value: Date): string => {
        const d = new Date(value);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      };

      // Resolve range — default to current month when omitted.
      let fromDate: Date | null = null;
      let toDate: Date | null = null;
      if (from || to) {
        if (!from || !to) {
          res.status(400).json({ message: 'Both from and to dates are required' });
          return;
        }
        fromDate = parseDateOnly(from as string, false);
        toDate = parseDateOnly(to as string, true);
        if (!fromDate || !toDate) {
          res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
          return;
        }
        if (fromDate.getTime() > toDate.getTime()) {
          res.status(400).json({ message: 'From date cannot be greater than to date' });
          return;
        }
      } else {
        const now = new Date();
        fromDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      }

      // Cap absent calculation at today (don't count future working days as absent).
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      const effectiveTo = toDate > todayEnd ? todayEnd : toDate;

      // 1. Filtered user roster (role/search applied here so fully-absent users still appear).
      // Attendance is an institute process — public learners are never marked
      // present or absent, so they must not appear in the roster even when the
      // caller passes no role filter at all.
      const userQuery: any = { ...INSTITUTE_ACCOUNT_CLAUSE };
      if (role) userQuery.role = role;
      if (search) {
        const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        userQuery.$or = [{ name: regex }, { empCode: regex }];
      }
      const users = await User.find(userQuery)
        .select('name email empCode role classLevel batch')
        .sort({ name: 1 })
        .lean();

      if (users.length === 0) {
        res.json({
          period: { from: toYMD(fromDate), to: toYMD(toDate) },
          generatedAt: new Date().toISOString(),
          filters: { role: role || null, search: search || null },
          totals: { users: 0, present: 0, absent: 0, late: 0 },
          users: [],
        });
        return;
      }

      const userIds = users.map((u: any) => u._id);

      // 2. Holidays for the range (one query) + 3. Attendance grouped by user+day (one aggregation).
      const [holidays, attRows] = await Promise.all([
        Holiday.find({ date: { $gte: fromDate, $lte: effectiveTo } }).lean(),
        Attendance.aggregate([
          { $match: { studentId: { $in: userIds }, date: { $gte: fromDate, $lte: effectiveTo } } },
          { $sort: { date: 1, clockIn: 1 } },
          {
            $group: {
              _id: {
                studentId: '$studentId',
                day: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
              },
              studentId: { $first: '$studentId' },
              date: { $first: '$date' },
              clockIn: { $first: '$clockIn' },
              lastPunchClockIn: { $last: '$clockIn' },
              actualClockOut: { $last: '$clockOut' },
              status: { $first: '$status' },
              lateIn: { $first: '$lateIn' },
              punchCount: { $sum: 1 },
            },
          },
        ]),
      ]);

      // Holiday lookup: explicit 'holiday' / 'working' override, Sundays default to holiday.
      const holidayMap = new Map<string, string>();
      holidays.forEach((h: any) => holidayMap.set(toYMD(h.date), h.type));
      const isHoliday = (date: Date): boolean => {
        const type = holidayMap.get(toYMD(date));
        if (type === 'holiday') return true;
        if (type === 'working') return false;
        return date.getDay() === 0; // Sunday
      };

      // Working dates in the (capped) range — shared across all users.
      const workingDates: string[] = [];
      const cursor = new Date(fromDate);
      cursor.setHours(0, 0, 0, 0);
      const rangeEnd = new Date(effectiveTo);
      while (cursor <= rangeEnd) {
        if (!isHoliday(cursor)) workingDates.push(toYMD(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      const workingDateSet = new Set(workingDates);

      // Group attendance rows by user.
      const rowsByUser = new Map<string, any[]>();
      attRows.forEach((r: any) => {
        const key = String(r.studentId);
        const rawState = String(r.status || '').toLowerCase();
        const state =
          rawState === 'present' || rawState === 'in'
            ? 'IN'
            : rawState === 'absent' || rawState === 'a'
              ? 'ABSENT'
              : rawState === 'late'
                ? 'LATE'
                : rawState
                  ? rawState.toUpperCase()
                  : 'UNKNOWN';

        const outTime =
          r.actualClockOut && r.actualClockOut !== '--:--'
            ? r.actualClockOut
            : r.punchCount > 1 && r.lastPunchClockIn && r.lastPunchClockIn !== '--:--'
              ? r.lastPunchClockIn
              : null;

        const inTime = r.clockIn && r.clockIn !== '--:--' ? r.clockIn : null;
        // Mirror absentService: a day counts as present only when status is
        // present/late OR a real clock-in exists (explicit absent rows don't count).
        const countsPresent = state === 'IN' || state === 'LATE' || inTime !== null;

        const list = rowsByUser.get(key) || [];
        list.push({
          date: toYMD(new Date(r.date)),
          inTime,
          outTime,
          state,
          lateMinutes: r.lateIn ? parseInt(r.lateIn, 10) || 0 : 0,
          punchCount: r.punchCount || 1,
          countsPresent,
        });
        rowsByUser.set(key, list);
      });

      // Load rules for all users in the export (two queries total)
      const exportUserIds = users.map((u: any) => String(u._id));
      const exportUserRoles = new Map<string, string>(users.map((u: any) => [String(u._id), u.role]));
      const exportRuleMap = await getEffectiveRulesBulk(exportUserIds, exportUserRoles);

      // Build per-user export entries with stats computed in memory.
      let totalPresent = 0;
      let totalAbsent = 0;
      let totalLate = 0;

      const exportUsers = users.map((u: any) => {
        const records = (rowsByUser.get(String(u._id)) || []).sort(
          (a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime()
        );

        const presentDates = new Set(
          records.filter((row: any) => row.countsPresent).map((row: any) => row.date)
        );
        const absentDates = workingDates.filter((d) => !presentDates.has(d));
        const lateCount = records.filter(
          (row: any) => row.state === 'LATE' || Number(row.lateMinutes || 0) > 0
        ).length;
        // Present working days = working days with a qualifying attendance record.
        const presentWorkingDays = workingDates.filter((d) => presentDates.has(d)).length;
        // Extra days = qualifying attendance that landed on a non-working day (Sunday/holiday).
        const extraDays = records.filter(
          (row: any) => row.countsPresent && !workingDateSet.has(row.date)
        ).length;

        totalPresent += presentWorkingDays;
        totalAbsent += absentDates.length;
        totalLate += lateCount;

        return {
          userId: u._id,
          name: u.name,
          email: u.email || null,
          empCode: u.empCode || null,
          role: u.role,
          classLevel: u.classLevel || null,
          batch: u.batch || null,
          stats: {
            present: presentWorkingDays,
            absent: absentDates.length,
            late: lateCount,
            expected: workingDates.length,
            holidays: 0,
            extraDays,
            total: workingDates.length,
          },
          absentDates,
          records: records.map(({ countsPresent, ...rest }: any) => {
            const exportRule = exportRuleMap.get(String(u._id));
            const classification = classifyDay(rest.inTime, rest.outTime, exportRule!);
            return { ...rest, classification };
          }),
        };
      });

      res.json({
        period: { from: toYMD(fromDate), to: toYMD(toDate) },
        generatedAt: new Date().toISOString(),
        filters: { role: role || null, search: search || null },
        totals: {
          users: exportUsers.length,
          present: totalPresent,
          absent: totalAbsent,
          late: totalLate,
        },
        users: exportUsers,
      });
    } catch (error) {
      console.error('Admin Export Attendance Error:', error);
      res.status(500).json({ message: 'Error generating attendance export' });
    }
  }

  // 4b. Deduction Unit Summary — per-user aggregated deduction units for a date range.
  //     Salary-independent: returns day-fraction units (0, 0.25, 0.50, 1.0), never money.
  //     Supports filtering by role, search, and employeeType (full_time | half_time).
  public static async getAdminDeductionSummary(req: Request, res: Response): Promise<void> {
    try {
      const mongoose = require('mongoose');
      const User = require('../models/User').default;
      const Holiday = require('../models/Holiday').default;

      const { from, to, role, search, employeeType } = req.query;

      // ── Date range (mirrors getAdminExport) ──────────────────────────────────
      const parseDateOnly = (value: string, endOfDay: boolean): Date | null => {
        const normalized = String(value || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
        const [y, m, d] = normalized.split('-').map(Number);
        const parsed = endOfDay
          ? new Date(y, m - 1, d, 23, 59, 59, 999)
          : new Date(y, m - 1, d, 0, 0, 0, 0);
        if (
          Number.isNaN(parsed.getTime()) ||
          parsed.getFullYear() !== y ||
          parsed.getMonth() + 1 !== m ||
          parsed.getDate() !== d
        ) return null;
        return parsed;
      };

      const toYMD = (v: Date): string => {
        const d = new Date(v);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };

      let fromDate: Date;
      let toDate: Date;
      if (from || to) {
        if (!from || !to) { res.status(400).json({ message: 'Both from and to dates are required' }); return; }
        const f = parseDateOnly(from as string, false);
        const t = parseDateOnly(to as string, true);
        if (!f || !t) { res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' }); return; }
        if (f > t) { res.status(400).json({ message: 'from cannot be after to' }); return; }
        fromDate = f; toDate = t;
      } else {
        const now = new Date();
        fromDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      }

      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      const effectiveTo = toDate > todayEnd ? todayEnd : toDate;

      // ── Load users ───────────────────────────────────────────────────────────
      // Attendance is an institute process — public learners are never marked
      // present or absent, so they must not appear in the roster even when the
      // caller passes no role filter at all.
      const userQuery: any = { ...INSTITUTE_ACCOUNT_CLAUSE };
      if (role) userQuery.role = role;
      if (search) {
        const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        userQuery.$or = [{ name: regex }, { empCode: regex }];
      }
      const users = await User.find(userQuery)
        .select('name email empCode role classLevel batch')
        .sort({ name: 1 })
        .lean();

      if (users.length === 0) {
        res.json({
          period: { from: toYMD(fromDate), to: toYMD(toDate) },
          generatedAt: new Date().toISOString(),
          filters: { role: role || null, search: search || null, employeeType: employeeType || null },
          totals: { users: 0, workingDays: 0, fullDays: 0, partialFullDays: 0, halfDays: 0, absentDays: 0, lateDays: 0, totalDeductionUnits: 0 },
          users: [],
        });
        return;
      }

      const userIds = users.map((u: any) => u._id);

      // ── Load rules (bulk), then filter by employeeType ────────────────────────
      const summaryUserIds = users.map((u: any) => String(u._id));
      const summaryUserRoles = new Map<string, string>(users.map((u: any) => [String(u._id), u.role]));
      const ruleMap = await getEffectiveRulesBulk(summaryUserIds, summaryUserRoles);

      // Filter users by employeeType if requested
      const filteredUsers = employeeType
        ? users.filter((u: any) => {
            const r = ruleMap.get(String(u._id));
            return r ? r.userType === (employeeType as string) : false;
          })
        : users;

      if (filteredUsers.length === 0) {
        res.json({
          period: { from: toYMD(fromDate), to: toYMD(toDate) },
          generatedAt: new Date().toISOString(),
          filters: { role: role || null, search: search || null, employeeType: employeeType || null },
          totals: { users: 0, workingDays: 0, fullDays: 0, partialFullDays: 0, halfDays: 0, absentDays: 0, lateDays: 0, totalDeductionUnits: 0 },
          users: [],
        });
        return;
      }

      const filteredIds = filteredUsers.map((u: any) => u._id);

      // ── Holidays + attendance (two queries) ───────────────────────────────────
      const [holidays, attRows] = await Promise.all([
        Holiday.find({ date: { $gte: fromDate, $lte: effectiveTo } }).lean(),
        Attendance.aggregate([
          { $match: { studentId: { $in: filteredIds }, date: { $gte: fromDate, $lte: effectiveTo } } },
          { $sort: { date: 1, clockIn: 1 } },
          {
            $group: {
              _id: { studentId: '$studentId', day: { $dateToString: { format: '%Y-%m-%d', date: '$date' } } },
              studentId: { $first: '$studentId' },
              date: { $first: '$date' },
              clockIn: { $first: '$clockIn' },
              lastPunchClockIn: { $last: '$clockIn' },
              actualClockOut: { $last: '$clockOut' },
              status: { $first: '$status' },
              lateIn: { $first: '$lateIn' },
              punchCount: { $sum: 1 },
            },
          },
        ]),
      ]);

      // ── Working dates ─────────────────────────────────────────────────────────
      const holidayMap = new Map<string, string>();
      holidays.forEach((h: any) => holidayMap.set(toYMD(h.date), h.type));
      const isHoliday = (date: Date): boolean => {
        const type = holidayMap.get(toYMD(date));
        if (type === 'holiday') return true;
        if (type === 'working') return false;
        return date.getDay() === 0;
      };

      const workingDates: string[] = [];
      const cur = new Date(fromDate);
      cur.setHours(0, 0, 0, 0);
      while (cur <= effectiveTo) {
        if (!isHoliday(cur)) workingDates.push(toYMD(cur));
        cur.setDate(cur.getDate() + 1);
      }

      // ── Group attendance by user ──────────────────────────────────────────────
      const attByUser = new Map<string, Map<string, { inTime: string | null; outTime: string | null }>>();
      attRows.forEach((r: any) => {
        const uid = String(r.studentId);
        const date = r._id.day as string;
        const inTime = r.clockIn && r.clockIn !== '--:--' ? r.clockIn : null;
        const outTime =
          r.actualClockOut && r.actualClockOut !== '--:--' ? r.actualClockOut :
          r.punchCount > 1 && r.lastPunchClockIn && r.lastPunchClockIn !== '--:--' ? r.lastPunchClockIn : null;

        if (!attByUser.has(uid)) attByUser.set(uid, new Map());
        attByUser.get(uid)!.set(date, { inTime, outTime });
      });

      // ── Aggregate per user ────────────────────────────────────────────────────
      let gFullDays = 0, gPartialDays = 0, gHalfDays = 0, gAbsentDays = 0, gLateDays = 0;
      let gDeductionUnits = 0;

      const summaryUsers = filteredUsers.map((u: any) => {
        const uid = String(u._id);
        const rule = ruleMap.get(uid)!;
        const userAtt = attByUser.get(uid) || new Map();

        let fullDays = 0, partialFullDays = 0, halfDays = 0, absentDays = 0, lateDays = 0;
        let totalDeductionUnits = 0;

        workingDates.forEach((dateStr) => {
          const record = userAtt.get(dateStr);
          const cls = classifyDay(
            record?.inTime ?? null,
            record?.outTime ?? null,
            rule
          );

          if (cls.attendanceStatus === 'FULL_DAY') fullDays++;
          else if (cls.attendanceStatus === 'PARTIAL_FULL_DAY') partialFullDays++;
          else if (cls.attendanceStatus === 'HALF_DAY') halfDays++;
          else absentDays++;

          if (cls.isLate) lateDays++;
          totalDeductionUnits += cls.deductionUnit;
        });

        // Round to avoid floating-point accumulation drift (e.g., 3 × 0.25 = 0.75 exactly)
        totalDeductionUnits = Math.round(totalDeductionUnits * 100) / 100;

        gFullDays += fullDays;
        gPartialDays += partialFullDays;
        gHalfDays += halfDays;
        gAbsentDays += absentDays;
        gLateDays += lateDays;
        gDeductionUnits += totalDeductionUnits;

        return {
          userId: u._id,
          name: u.name,
          empCode: u.empCode || null,
          email: u.email || null,
          role: u.role,
          classLevel: u.classLevel || null,
          batch: u.batch || null,
          employeeType: rule.userType,
          requiredWorkingHours: rule.userType === 'half_time' ? rule.halfTimeRequiredHours : rule.fullDayMinHours,
          officialInTime: rule.officialInTime,
          stats: {
            workingDays: workingDates.length,
            fullDays,
            partialFullDays,
            halfDays,
            absentDays,
            lateDays,
            totalDeductionUnits,
          },
        };
      });

      gDeductionUnits = Math.round(gDeductionUnits * 100) / 100;

      res.json({
        period: { from: toYMD(fromDate), to: toYMD(toDate) },
        generatedAt: new Date().toISOString(),
        filters: { role: role || null, search: search || null, employeeType: employeeType || null },
        totals: {
          users: summaryUsers.length,
          workingDays: workingDates.length,
          fullDays: gFullDays,
          partialFullDays: gPartialDays,
          halfDays: gHalfDays,
          absentDays: gAbsentDays,
          lateDays: gLateDays,
          totalDeductionUnits: gDeductionUnits,
        },
        users: summaryUsers,
      });
    } catch (error) {
      console.error('Admin Deduction Summary Error:', error);
      res.status(500).json({ message: 'Error generating deduction summary' });
    }
  }

  // 4. Attendance Summary (Analytics)
  public static async getAdminSummary(req: Request, res: Response): Promise<void> {
    try {
      const { from, to } = req.query;
      const query: any = {};
      
      if (from && to) {
         query.date = { 
           $gte: new Date(from as string), 
           $lte: new Date(to as string) 
         };
      } else {
        // Default to current month
        const now = new Date();
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
        query.date = { $gte: firstDay };
      }

      // We need distinct user count? Or total attendance records?
      // User asked for: totalUsers, presentDays, absentDays, lateCount, halfDays
      
      const stats = await Attendance.aggregate([
        { $match: query },
        { 
          $group: {
            _id: null,
            totalRecords: { $sum: 1 },
            presentDays: { 
              $sum: { 
                $cond: [{ $in: ['$status', ['present', 'late']] }, 1, 0] 
              } 
            },
            absentDays: { 
              $sum: { 
                $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] 
              } 
            },
            lateCount: {
               $sum: { 
                $cond: [{ $eq: ['$status', 'late'] }, 1, 0] 
              }
            }
          }
        }
      ]);

      const result = stats[0] || { totalRecords: 0, presentDays: 0, absentDays: 0, lateCount: 0 };
      
      // Total Users? This implies fetching User count from DB, not just attendance.
      const User = require('../models/User').default;
      const totalUsers = await User.countDocuments({
        role: { $in: ['student', 'teacher'] },
        ...INSTITUTE_ACCOUNT_CLAUSE,
      }); // Active institute users

      res.json({
        totalUsers,
        presentDays: result.presentDays,
        absentDays: result.absentDays, // This is explicitly marked absences. Implicit absences (no record) are tricky. 
                                       // Assuming "absent" status is explicitly marked for now or we rely on scheduled vs present.
        lateCount: result.lateCount,
        halfDays: 0 // Placeholder logic for now
      });

    } catch (error) {
      console.error('Summary Error:', error);
      res.status(500).json({ message: 'Error fetching summary' });
    }
  }

  // Legacy/Generic Admin View (keeping for backward compat if needed, or remove)
  // public static async getAdminAttendance(...) {}
}

export default AttendanceController;
