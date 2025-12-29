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
 * @desc    Get current student's attendance records
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
    
    const records = await getStudentAttendance(user.name, user.classLevel);
    
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
    
    const summary = await getAttendanceSummary(user.name, user.classLevel);
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

export default router;
