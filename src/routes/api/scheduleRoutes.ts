import { Router, Request, Response } from 'express';
import Schedule from '../../models/Schedule';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// Get schedule for student
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { startDate, endDate, type } = req.query;
    
    const query: any = {};
    
    // Date range filter
    if (startDate && endDate) {
      query.startTime = { 
        $gte: new Date(startDate as string),
        $lte: new Date(endDate as string)
      };
    } else {
      // Default to current week
      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 7);
      
      query.startTime = { $gte: startOfWeek, $lte: endOfWeek };
    }
    
    if (type) query.type = type;
    
    // Filter by class/batch for students
    if (user.role === 'student') {
      query.$or = [
        { classLevel: { $exists: false } },
        { classLevel: user.classLevel }
      ];
      if (user.batch) {
        query.$or.push({ batch: user.batch });
      }
    }
    
    const schedules = await Schedule.find(query)
      .populate('instructor', 'name')
      .sort({ startTime: 1 })
      .lean();
    
    res.json(schedules);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get today's schedule
router.get('/today', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    
    const query: any = {
      startTime: { $gte: startOfDay, $lte: endOfDay }
    };
    
    // Filter by class/batch for students
    if (user.role === 'student') {
      query.$or = [
        { classLevel: { $exists: false } },
        { classLevel: user.classLevel }
      ];
    }
    
    const schedules = await Schedule.find(query)
      .populate('instructor', 'name')
      .sort({ startTime: 1 })
      .lean();
    
    res.json(schedules);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get upcoming schedule
router.get('/upcoming', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { limit = 5 } = req.query;
    
    const now = new Date();
    
    const query: any = {
      startTime: { $gte: now }
    };
    
    // Filter by class/batch for students
    if (user.role === 'student') {
      query.$or = [
        { classLevel: { $exists: false } },
        { classLevel: user.classLevel }
      ];
    }
    
    const schedules = await Schedule.find(query)
      .populate('instructor', 'name')
      .sort({ startTime: 1 })
      .limit(Number(limit))
      .lean();
    
    res.json(schedules);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Create schedule
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const schedule = new Schedule({
      ...req.body,
      createdBy: user.id
    });
    
    await schedule.save();
    res.status(201).json(schedule);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Update schedule
router.put('/:scheduleId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const schedule = await Schedule.findByIdAndUpdate(
      req.params.scheduleId,
      req.body,
      { new: true }
    );
    
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    
    res.json(schedule);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Delete schedule
router.delete('/:scheduleId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await Schedule.findByIdAndDelete(req.params.scheduleId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
