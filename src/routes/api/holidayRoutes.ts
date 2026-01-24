import { Router, Request, Response } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import Holiday from '../../models/Holiday';

const router = Router();

/**
 * @route   GET /api/holidays
 * @desc    Get holidays for a date range
 * @access  Private
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { from, to, year, month } = req.query;
    
    let dateFilter: any = {};
    
    if (from && to) {
      dateFilter = {
        date: {
          $gte: new Date(from as string),
          $lte: new Date(to as string)
        }
      };
    } else if (year && month) {
      const startOfMonth = new Date(Number(year), Number(month) - 1, 1);
      const endOfMonth = new Date(Number(year), Number(month), 0, 23, 59, 59);
      dateFilter = {
        date: { $gte: startOfMonth, $lte: endOfMonth }
      };
    } else if (year) {
      const startOfYear = new Date(Number(year), 0, 1);
      const endOfYear = new Date(Number(year), 11, 31, 23, 59, 59);
      dateFilter = {
        date: { $gte: startOfYear, $lte: endOfYear }
      };
    }
    
    const holidays = await Holiday.find(dateFilter)
      .sort({ date: 1 })
      .populate('createdBy', 'name');
    
    res.json({
      success: true,
      count: holidays.length,
      holidays: holidays.map(h => ({
        id: h._id,
        date: h.date.toISOString().split('T')[0],
        name: h.name,
        type: h.type,
        description: h.description,
        createdBy: h.createdBy
      }))
    });
  } catch (error) {
    console.error('Error fetching holidays:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch holidays' });
  }
});

/**
 * @route   POST /api/holidays
 * @desc    Create a new holiday
 * @access  Private (Admin)
 */
router.post('/', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { date, name, type, description } = req.body;
    const authUser = (req as any).user;
    
    if (!date || !name) {
      return res.status(400).json({ success: false, error: 'Date and name are required' });
    }
    
    // Check if holiday already exists for this date
    const existingHoliday = await Holiday.findOne({ 
      date: new Date(date) 
    });
    
    if (existingHoliday) {
      return res.status(400).json({ 
        success: false, 
        error: 'A holiday/working day already exists for this date' 
      });
    }
    
    const holiday = await Holiday.create({
      date: new Date(date),
      name,
      type: type || 'holiday',
      description,
      createdBy: authUser.id
    });
    
    res.status(201).json({
      success: true,
      message: `${type === 'working' ? 'Working day' : 'Holiday'} created successfully`,
      holiday: {
        id: holiday._id,
        date: holiday.date.toISOString().split('T')[0],
        name: holiday.name,
        type: holiday.type,
        description: holiday.description
      }
    });
  } catch (error) {
    console.error('Error creating holiday:', error);
    res.status(500).json({ success: false, error: 'Failed to create holiday' });
  }
});

/**
 * @route   PUT /api/holidays/:id
 * @desc    Update a holiday
 * @access  Private (Admin)
 */
router.put('/:id', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { date, name, type, description } = req.body;
    
    const holiday = await Holiday.findById(id);
    
    if (!holiday) {
      return res.status(404).json({ success: false, error: 'Holiday not found' });
    }
    
    // If changing date, check for conflicts
    if (date && new Date(date).getTime() !== holiday.date.getTime()) {
      const existingHoliday = await Holiday.findOne({ 
        date: new Date(date),
        _id: { $ne: id }
      });
      
      if (existingHoliday) {
        return res.status(400).json({ 
          success: false, 
          error: 'A holiday/working day already exists for this date' 
        });
      }
    }
    
    if (date) holiday.date = new Date(date);
    if (name) holiday.name = name;
    if (type) holiday.type = type;
    if (description !== undefined) holiday.description = description;
    
    await holiday.save();
    
    res.json({
      success: true,
      message: 'Holiday updated successfully',
      holiday: {
        id: holiday._id,
        date: holiday.date.toISOString().split('T')[0],
        name: holiday.name,
        type: holiday.type,
        description: holiday.description
      }
    });
  } catch (error) {
    console.error('Error updating holiday:', error);
    res.status(500).json({ success: false, error: 'Failed to update holiday' });
  }
});

/**
 * @route   DELETE /api/holidays/:id
 * @desc    Delete a holiday
 * @access  Private (Admin)
 */
router.delete('/:id', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const holiday = await Holiday.findByIdAndDelete(id);
    
    if (!holiday) {
      return res.status(404).json({ success: false, error: 'Holiday not found' });
    }
    
    res.json({
      success: true,
      message: 'Holiday deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting holiday:', error);
    res.status(500).json({ success: false, error: 'Failed to delete holiday' });
  }
});

export default router;
