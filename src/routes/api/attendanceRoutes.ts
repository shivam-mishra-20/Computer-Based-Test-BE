import { Router, Request, Response } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import User from '../../models/User';
import {
  getStudentAttendance,
  getAttendanceSummary,
  getAllStudentAttendance,
  uploadAttendanceRecords,
  syncStudentsToAttendance,
  getAttendanceFilters,
} from '../../services/attendanceService';

const router = Router();

/**
 * @route   GET /api/attendance/my
 * @desc    Get current student's attendance records (Legacy - uses name matching)
 * @access  Private (Student)
 */
router.get('/my', authMiddleware, async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    
    // Fetch full user details from database
    const user = await User.findById(authUser.id).select('name classLevel');
    
    if (!user?.name || !user?.classLevel) {
      return res.status(400).json({ error: 'User name or class level not found' });
    }
    
    const records = await getStudentAttendance(user.name, user.classLevel, authUser.id);
    
    // Parse optional query params for filtering
    const { month, year } = req.query;
    
    let filtered = records;
    if (month && year) {
      filtered = records.filter((r) => {
        const d = new Date(r.dayAndDate);
        return d.getMonth() + 1 === Number(month) && d.getFullYear() === Number(year);
      });
    }
    
    // Calculate stats
    const presentDays = filtered.filter(r => r.clockIn !== '--:--' && r.clockOut !== '--:--').length;
    const absentDays = filtered.filter(r => r.clockIn === '--:--' || r.clockOut === '--:--').length;
    
    res.json({
      records: filtered.sort((a, b) => new Date(b.dayAndDate).getTime() - new Date(a.dayAndDate).getTime()),
      stats: {
        present: presentDays,
        absent: absentDays,
        total: filtered.length,
      },
    });
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

/**
 * @route   GET /api/attendance/me
 * @desc    Get current user's (teacher/student) attendance from Attendance collection
 *          Groups multiple punches per day: first punch = Clock IN, last punch = Clock OUT
 * @access  Private
 */
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const { from, to, month, year } = req.query;
    const mongoose = require('mongoose');
    const Attendance = require('../../models/Attendance').default;
    
    // Fetch user to get empCode and other info
    const user = await User.findById(authUser.id).select('name empCode role classLevel');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Build date match query
    const dateMatch: any = {};
    if (from && to) {
      dateMatch.$gte = new Date(from as string);
      dateMatch.$lte = new Date(to as string);
    } else if (month && year) {
      const startOfMonth = new Date(Number(year), Number(month) - 1, 1);
      const endOfMonth = new Date(Number(year), Number(month), 0, 23, 59, 59);
      dateMatch.$gte = startOfMonth;
      dateMatch.$lte = endOfMonth;
    }
    
    // Use aggregation to group multiple punches per day
    // First punch = Clock IN, Last punch = Clock OUT
    const aggregation: any[] = [
      { 
        $match: { 
          studentId: new mongoose.Types.ObjectId(authUser.id),
          ...(Object.keys(dateMatch).length > 0 ? { date: dateMatch } : {})
        } 
      },
      // Sort by clockIn to get proper first/last
      { $sort: { date: 1, clockIn: 1 } },
      // Group by date to combine multiple punches per day
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$date" }
          },
          date: { $first: "$date" },
          clockIn: { $first: "$clockIn" },  // First punch = Clock IN
          lastPunchClockIn: { $last: "$clockIn" },  // Last punch's clockIn value
          actualClockOut: { $last: "$clockOut" },  // Explicit clockOut if exists
          status: { $first: "$status" },
          lateIn: { $first: "$lateIn" },
          punchCount: { $sum: 1 }
        }
      },
      // Sort by date descending
      { $sort: { date: -1 } },
      // Limit results
      { $limit: 100 },
      // Project final shape with computed clockOut
      {
        $project: {
          _id: 1,
          date: 1,
          clockIn: 1,
          // Use actual clockOut if available, otherwise use last punch (if multiple punches)
          clockOut: {
            $cond: {
              if: { $and: [
                { $ne: ["$actualClockOut", null] },
                { $ne: ["$actualClockOut", "--:--"] }
              ]},
              then: "$actualClockOut",
              else: {
                $cond: {
                  if: { $gt: ["$punchCount", 1] },
                  then: "$lastPunchClockIn",  // Second punch becomes clock out
                  else: null
                }
              }
            }
          },
          status: 1,
          lateIn: 1,
          punchCount: 1
        }
      }
    ];
    
    const records = await Attendance.aggregate(aggregation);
    
    // Calculate summary stats
    const present = records.filter((r: any) => 
      r.status === 'present' || (r.clockIn && r.clockIn !== '--:--')
    ).length;
    
    const absent = records.filter((r: any) => r.status === 'absent').length;
    
    const late = records.filter((r: any) => 
      r.status === 'late' || (r.lateIn && parseInt(r.lateIn) > 0)
    ).length;
    
    res.json({
      user: {
        name: user.name,
        empCode: user.empCode || 'N/A',
        role: user.role,
      },
      stats: {
        present,
        absent,
        late,
        total: records.length,
      },
      records: records.map((r: any) => ({
        id: r._id,
        date: r.date.toISOString().split('T')[0],
        clockIn: r.clockIn && r.clockIn !== '--:--' ? r.clockIn : null,
        clockOut: r.clockOut && r.clockOut !== '--:--' ? r.clockOut : null,
        status: r.status,
        lateMinutes: r.lateIn ? parseInt(r.lateIn) : 0,
      }))
    });
  } catch (error) {
    console.error('Error fetching my attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

/**
 * @route   GET /api/attendance/summary
 * @desc    Get current student's attendance summary
 * @access  Private (Student)
 */
router.get('/summary', authMiddleware, async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    
    // Fetch full user details from database
    const user = await User.findById(authUser.id).select('name classLevel');
    
    if (!user?.name || !user?.classLevel) {
      return res.status(400).json({ error: 'User name or class level not found' });
    }
    
    const summary = await getAttendanceSummary(user.name, user.classLevel, authUser.id);
    res.json(summary);
  } catch (error) {
    console.error('Error fetching attendance summary:', error);
    res.status(500).json({ error: 'Failed to fetch attendance summary' });
  }
});

/**
 * @route   GET /api/attendance/all
 * @desc    Get all students' attendance (admin/teacher view)
 * @access  Private (Admin, Teacher)
 */
router.get('/all', authMiddleware, requireRole('admin', 'teacher'), async (req: Request, res: Response) => {
  try {
    const { classLevel, batch } = req.query;
    
    const records = await getAllStudentAttendance({
      classLevel: classLevel as string | undefined,
      batch: batch as string | undefined,
    });
    
    res.json(records);
  } catch (error) {
    console.error('Error fetching all attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance records' });
  }
});

/**
 * @route   GET /api/attendance/filters
 * @desc    Get available filter options (classes, batches)
 * @access  Private (Admin, Teacher)
 */
router.get('/filters', authMiddleware, requireRole('admin', 'teacher'), async (req: Request, res: Response) => {
  try {
    const filters = await getAttendanceFilters();
    res.json(filters);
  } catch (error) {
    console.error('Error fetching filters:', error);
    res.status(500).json({ error: 'Failed to fetch filters' });
  }
});

/**
 * @route   POST /api/attendance/upload
 * @desc    Upload attendance records from parsed Excel/CSV data
 * @access  Private (Admin, Teacher)
 */
router.post('/upload', authMiddleware, requireRole('admin', 'teacher'), async (req: Request, res: Response) => {
  try {
    const { records } = req.body;
    
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'No records provided' });
    }
    
    // Validate records
    const validated = records.filter((r: any) => 
      r.name && r.class && r.dayAndDate
    ).map((r: any) => ({
      name: String(r.name).trim(),
      class: String(r.class).trim(),
      clockIn: String(r.clockIn || '--:--').trim(),
      clockOut: String(r.clockOut || '--:--').trim(),
      dayAndDate: String(r.dayAndDate).trim(),
    }));
    
    if (validated.length === 0) {
      return res.status(400).json({ error: 'No valid records found' });
    }
    
    const result = await uploadAttendanceRecords(validated);
    res.json(result);
  } catch (error) {
    console.error('Error uploading attendance:', error);
    res.status(500).json({ error: 'Failed to upload attendance' });
  }
});

/**
 * @route   POST /api/attendance/sync
 * @desc    Sync students from Users collection to studentLeaves
 * @access  Private (Admin)
 */
router.post('/sync', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const result = await syncStudentsToAttendance();
    res.json(result);
  } catch (error) {
    console.error('Error syncing students:', error);
    res.status(500).json({ error: 'Failed to sync students' });
  }
});

// Real-time Offline Sync routes
import AttendanceController from '../../controllers/AttendanceController';
import ExternalAttendanceController from '../../controllers/ExternalAttendanceController';

// Admin: Fetch External Sync (Admin only)
router.post('/fetch-external', authMiddleware, requireRole('admin'), ExternalAttendanceController.fetchExternal);

// Admin: Attendance APIs (Read-Only Views)
// Full paths: /api/attendance/admin/today, /api/attendance/admin/by-date, etc.
console.log('[AttendanceRoutes] Registering admin attendance routes...');
router.get('/admin/today', authMiddleware, requireRole('admin'), AttendanceController.getAdminToday);
router.get('/admin/by-date', authMiddleware, requireRole('admin'), AttendanceController.getAdminByDate);
router.get('/admin/summary', authMiddleware, requireRole('admin'), AttendanceController.getAdminSummary);
router.get('/admin/user/:userId', authMiddleware, requireRole('admin'), AttendanceController.getAdminUserAttendance);

export default router;
