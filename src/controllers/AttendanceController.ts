import { Request, Response } from 'express';
import QueueService from '../services/QueueService';
import Attendance from '../models/Attendance';
import absentService from '../services/absentCalculationService';

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
      
      res.json({
        date: today.toISOString().split('T')[0],
        lastSyncedAt: new Date(), 
        data: records.map((r: any) => ({
          userId: r.user._id,
          name: r.user.name,
          role: r.user.role,
          empCode: r.user.empCode,
          inTime: r.clockIn && r.clockIn !== '--:--' ? r.clockIn : null,
          outTime: r.clockOut && r.clockOut !== '--:--' ? r.clockOut : null,
          state: r.status === 'present' ? 'IN' : r.status === 'absent' ? 'ABSENT' : r.status,
          statusCode: r.status === 'present' ? 'P' : 'A',
          lateMinutes: r.lateIn ? parseInt(r.lateIn) : 0 
        }))
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

      res.json({
        date: date,
        data: records.map((r: any) => ({
          userId: r.user._id,
          name: r.user.name,
          role: r.user.role,
          empCode: r.user.empCode,
          inTime: r.clockIn && r.clockIn !== '--:--' ? r.clockIn : null,
          outTime: r.clockOut && r.clockOut !== '--:--' ? r.clockOut : null,
          state: r.status === 'present' ? 'IN' : r.status === 'absent' ? 'ABSENT' : r.status
        }))
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

         return {
           date: formatDateLocal(new Date(r.date)),
           inTime: r.clockIn && r.clockIn !== '--:--' ? r.clockIn : null,
           outTime: r.clockOut && r.clockOut !== '--:--' ? r.clockOut : null,
           state: normalizedState,
           lateMinutes,
           punchCount: r.punchCount || 1
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
      const totalUsers = await User.countDocuments({ role: { $in: ['student', 'teacher'] } }); // Active users

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
