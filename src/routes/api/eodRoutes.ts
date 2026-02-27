import { Router, Request, Response } from 'express';
import EOD from '../../models/EOD';
import Schedule from '../../models/Schedule';
import User from '../../models/User';
import { authMiddleware } from '../../middlewares/authMiddleware';
import mongoose from 'mongoose';

interface AuthRequest extends Request {
  user?: {
    _id: string;
    role: string;
    name?: string;
    firebaseUid?: string;
  };
}

const router = Router();

// GET - Get today's scheduled classes for teacher (to pre-fill EOD form)
router.get('/scheduled-classes', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { date } = req.query;
    const targetDate = date ? new Date(date as string) : new Date();
    const dayOfWeek = targetDate.getDay();

    const teacherId = req.user.firebaseUid || req.user._id;

    // Find regular schedules for this day
    const regularSchedules = await Schedule.find({
      teacherId,
      scheduleType: 'regular',
      dayOfWeek,
      isActive: true
    }).sort({ startTimeSlot: 1 });

    // Find custom schedules for this specific date
    const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
    const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

    const customSchedules = await Schedule.find({
      teacherId,
      scheduleType: 'custom',
      date: { $gte: startOfDay, $lte: endOfDay },
      isActive: true
    }).sort({ startTimeSlot: 1 });

    const allSchedules = [...regularSchedules, ...customSchedules].map(schedule => ({
      scheduleId: schedule._id,
      subject: schedule.subject,
      classLevel: schedule.classLevel,
      batch: schedule.batch,
      startTime: schedule.startTimeSlot,
      endTime: schedule.endTimeSlot,
      roomNumber: schedule.roomNumber
    }));

    res.json({ classes: allSchedules });
  } catch (error: any) {
    console.error('Error fetching scheduled classes:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST - Submit EOD report
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { date, classes, additionalNotes } = req.body;

    if (!date || !classes || !Array.isArray(classes)) {
      return res.status(400).json({ error: 'Date and classes are required' });
    }

    const teacherId = req.user.firebaseUid || req.user._id;
    const reportDate = new Date(date);

    // Check if EOD already exists for this date
    const existing = await EOD.findOne({
      teacherId,
      date: {
        $gte: new Date(reportDate.setHours(0, 0, 0, 0)),
        $lte: new Date(reportDate.setHours(23, 59, 59, 999))
      }
    });

    if (existing) {
      // Update existing EOD
      existing.classes = classes;
      existing.additionalNotes = additionalNotes;
      existing.submittedAt = new Date();
      existing.status = 'pending';
      await existing.save();
      return res.json(existing);
    }

    // Create new EOD
    const eod = new EOD({
      teacherId,
      teacherName: req.user.name || 'Teacher',
      date: reportDate,
      classes,
      additionalNotes,
      submittedAt: new Date(),
      status: 'pending'
    });

    await eod.save();
    res.status(201).json(eod);
  } catch (error: any) {
    console.error('Error submitting EOD:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET - Get teacher's EOD history
router.get('/my-eods', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { startDate, endDate, page = 1, limit = 30 } = req.query;
    const teacherId = req.user.firebaseUid || req.user._id;

    const query: any = { teacherId };

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate as string);
      if (endDate) query.date.$lte = new Date(endDate as string);
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [eods, total] = await Promise.all([
      EOD.find(query)
        .sort({ date: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      EOD.countDocuments(query)
    ]);

    res.json({
      eods,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error: any) {
    console.error('Error fetching EODs:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET - Get specific EOD by date
router.get('/by-date/:date', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const targetDate = new Date(req.params.date);
    const teacherId = req.user.firebaseUid || req.user._id;

    const eod = await EOD.findOne({
      teacherId,
      date: {
        $gte: new Date(targetDate.setHours(0, 0, 0, 0)),
        $lte: new Date(targetDate.setHours(23, 59, 59, 999))
      }
    });

    if (!eod) {
      return res.status(404).json({ error: 'EOD not found for this date' });
    }

    res.json(eod);
  } catch (error: any) {
    console.error('Error fetching EOD by date:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== STUDENT ROUTES ====================

// GET - Get class reports for a specific date (Student view - filtered by class/batch)
router.get('/student/by-date/:date', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'student') {
      return res.status(403).json({ error: 'Student access required' });
    }

    // Parse date and build UTC-safe day range
    const [year, month, day] = req.params.date.split('-').map(Number);
    const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
    const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);

    // Fetch full student record to get classLevel and batch
    const student = await User.findById(req.user._id).select('classLevel batch name').lean();

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const { classLevel, batch } = student as any;

    console.log(`[EOD Student] _id=${req.user._id} classLevel=${classLevel} batch=${batch} date=${req.params.date}`);

    if (!classLevel) {
      return res.json([]); // Student has no class assigned yet
    }

    // Normalize classLevel for comparison (e.g. "Class 8" → "8", "8" → "8")
    const normalizeClass = (val: string) => val?.replace(/^class\s*/i, '').trim();
    const studentClass = normalizeClass(classLevel);

    // Find all EODs submitted on this date
    const allEODs = await EOD.find({
      date: { $gte: startOfDay, $lte: endOfDay }
    }).lean();

    // Filter class reports matching student's class (and batch if available)
    const result = allEODs
      .map((eod: any) => {
        const matchingClasses = eod.classes.filter((cls: any) => {
          const classMatch = normalizeClass(cls.classLevel) === studentClass;
          const batchMatch = !batch || !cls.batch || cls.batch === batch;
          return classMatch && batchMatch;
        });
        if (matchingClasses.length === 0) return null;
        return {
          _id: eod._id,
          teacherName: eod.teacherName,
          date: eod.date,
          submittedAt: eod.submittedAt,
          additionalNotes: eod.additionalNotes,
          classes: matchingClasses,
        };
      })
      .filter(Boolean);

    res.json(result);
  } catch (error: any) {
    console.error('Error fetching student EODs:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN ROUTES ====================

// GET - Get all EODs (Admin only)
router.get('/admin/all', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { 
      startDate, 
      endDate, 
      teacherId, 
      status, 
      page = 1, 
      limit = 50 
    } = req.query;

    const query: any = {};

    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        const start = new Date(startDate as string);
        start.setHours(0, 0, 0, 0);
        query.date.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate as string);
        end.setHours(23, 59, 59, 999);
        query.date.$lte = end;
      }
    }

    if (teacherId) query.teacherId = teacherId;
    if (status) query.status = status;

    console.log('[EOD Admin] Query filter:', JSON.stringify(query, null, 2));

    const skip = (Number(page) - 1) * Number(limit);

    const [eods, total] = await Promise.all([
      EOD.find(query)
        .sort({ date: -1, submittedAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate('reviewedBy', 'name email')
        .lean(),
      EOD.countDocuments(query)
    ]);

    console.log('[EOD Admin] Found', total, 'total EODs matching query');
    console.log('[EOD Admin] Returning', eods.length, 'EODs for page', page);

    res.json({
      eods,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error: any) {
    console.error('Error fetching all EODs:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET - Get EOD statistics (Admin only)
router.get('/admin/stats', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { startDate, endDate } = req.query;
    const dateFilter: any = {};

    if (startDate || endDate) {
      if (startDate) dateFilter.$gte = new Date(startDate as string);
      if (endDate) dateFilter.$lte = new Date(endDate as string);
    } else {
      // Default to last 30 days
      dateFilter.$gte = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    }

    const query = Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {};

    const [statusCounts, submissionStats, teacherStats] = await Promise.all([
      // Status counts
      EOD.aggregate([
        { $match: query },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      // Submission stats
      EOD.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalSubmissions: { $sum: 1 },
            avgClassesPerDay: { $avg: { $size: '$classes' } },
            totalClassesConducted: {
              $sum: {
                $size: {
                  $filter: {
                    input: '$classes',
                    cond: { $eq: ['$$this.wasHeld', true] }
                  }
                }
              }
            }
          }
        }
      ]),
      // Teacher-wise submissions
      EOD.aggregate([
        { $match: query },
        {
          $group: {
            _id: '$teacherId',
            teacherName: { $first: '$teacherName' },
            submissionCount: { $sum: 1 },
            lastSubmission: { $max: '$submittedAt' }
          }
        },
        { $sort: { submissionCount: -1 } },
        { $limit: 10 }
      ])
    ]);

    res.json({
      statusCounts: statusCounts.reduce((acc: any, item: any) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      submissionStats: submissionStats[0] || {},
      topTeachers: teacherStats
    });
  } catch (error: any) {
    console.error('Error fetching EOD stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT - Update EOD Status (Admin only)
router.put('/admin/:eodId/status', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { status, reviewNotes } = req.body;

    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Use "approved" or "rejected"' });
    }

    const eod = await EOD.findById(req.params.eodId);

    if (!eod) {
      return res.status(404).json({ error: 'EOD not found' });
    }

    eod.status = status;
    eod.reviewNotes = reviewNotes;
    eod.reviewedBy = new mongoose.Types.ObjectId(req.user._id);
    eod.reviewedAt = new Date();

    await eod.save();
    await eod.populate('reviewedBy', 'name email');

    res.json(eod);
  } catch (error: any) {
    console.error('Error reviewing EOD:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
