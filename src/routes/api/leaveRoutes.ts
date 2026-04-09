import { Router, Request, Response } from 'express';
import Leave from '../../models/Leave';
import User from '../../models/User';
import Notification from '../../models/Notification';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { sendTeacherNotification } from '../../services/notificationService';

const router = Router();

const ALLOWED_LEAVE_TYPES = ['sick', 'personal', 'emergency', 'vacation', 'half_day', 'other'] as const;

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLeaveTypeLabel(leaveType: string): string {
  if (leaveType === 'half_day') return 'Half Day';
  return leaveType
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// Get all leaves (Admin: all, Teacher: their own)
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { status, leaveType, startDate, endDate, search } = req.query;

    let query: any = {};

    if (user.role === 'teacher') {
      // Teachers can only see their own leaves
      query.$or = [
        { teacherId: user.id },
        { teacherId: user._id?.toString() },
        { teacherId: user.firebaseUid }
      ];
    }

    // Filter by status if provided
    if (status) {
      query.status = status;
    }

    // Filter by leave type if provided
    if (leaveType) {
      query.leaveType = leaveType;
    }

    // Admin search by teacher name/email
    if (search) {
      const searchText = String(search).trim();
      if (searchText) {
        const regex = new RegExp(escapeRegex(searchText), 'i');
        query.$and = query.$and || [];
        query.$and.push({
          $or: [
            { teacherName: regex },
            { teacherEmail: regex }
          ]
        });
      }
    }

    // Filter by date range if provided
    if (startDate || endDate) {
      query.$and = query.$and || [];
      if (startDate) {
        query.$and.push({ endDate: { $gte: new Date(startDate as string) } });
      }
      if (endDate) {
        query.$and.push({ startDate: { $lte: new Date(endDate as string) } });
      }
    }

    const leaves = await Leave.find(query)
      .populate('approvedBy', 'name email')
      .sort({ createdAt: -1 });

    res.json(leaves);
  } catch (error: any) {
    console.error('Error fetching leaves:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a specific leave by ID
router.get('/:leaveId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const leave = await Leave.findById(req.params.leaveId)
      .populate('approvedBy', 'name email');

    if (!leave) {
      return res.status(404).json({ error: 'Leave not found' });
    }

    // Teachers can only view their own leaves
    if (user.role === 'teacher') {
      const isOwnLeave = 
        leave.teacherId === user.id ||
        leave.teacherId === user._id?.toString() ||
        leave.teacherId === user.firebaseUid;
      
      if (!isOwnLeave) {
        return res.status(403).json({ error: 'Not authorized to view this leave' });
      }
    }

    res.json(leave);
  } catch (error: any) {
    console.error('Error fetching leave:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a new leave request
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    if (user.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers can apply for leave' });
    }

    // Fetch full user details to get name and email
    const teacher = await User.findById(user.id);
    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const { leaveType, startDate, endDate, reason } = req.body;

    if (!leaveType || !ALLOWED_LEAVE_TYPES.includes(leaveType)) {
      return res.status(400).json({
        error: `Invalid leave type. Allowed values: ${ALLOWED_LEAVE_TYPES.join(', ')}`
      });
    }

    // Validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Invalid startDate or endDate' });
    }

    if (start > end) {
      return res.status(400).json({ error: 'Start date must be before end date' });
    }

    // Check if teacher already has a leave request for overlapping dates
    const overlappingLeave = await Leave.findOne({
      $and: [
        {
          $or: [
            { teacherId: user.id },
            { teacherId: user._id?.toString() },
            { teacherId: teacher.firebaseUid }
          ]
        },
        { status: { $in: ['pending', 'approved'] } },
        { startDate: { $lte: end }, endDate: { $gte: start } }
      ]
    });

    if (overlappingLeave) {
      return res.status(400).json({ 
        error: 'You already have a leave request for overlapping dates',
        existingLeave: overlappingLeave
      });
    }

    const leave = new Leave({
      teacherId: teacher.firebaseUid || teacher._id?.toString(),
      teacherName: teacher.name,
      teacherEmail: teacher.email,
      leaveType,
      startDate: start,
      endDate: end,
      reason,
      status: 'pending'
    });

    await leave.save();

    // Notify admin about new leave request
    const admins = await User.find({ role: 'admin' });
    for (const admin of admins) {
      const notification = new Notification({
        userId: admin._id,
        type: 'general',
        priority: 'medium',
        title: 'New Leave Request',
        message: `${user.name} has requested ${getLeaveTypeLabel(leaveType)} leave from ${start.toLocaleDateString()} to ${end.toLocaleDateString()}`,
        data: { leaveId: leave._id, teacherId: user.id },
        actionUrl: '/admin/leaves'
      });
      await notification.save();
    }

    res.status(201).json(leave);
  } catch (error: any) {
    console.error('Error creating leave:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update leave status (Admin only)
router.patch('/:leaveId/status', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can approve/reject leaves' });
    }

    const { status, rejectionReason } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be either approved or rejected' });
    }

    const leave = await Leave.findById(req.params.leaveId);

    if (!leave) {
      return res.status(404).json({ error: 'Leave not found' });
    }

    if (leave.status !== 'pending') {
      return res.status(400).json({ error: 'Leave has already been processed' });
    }

    leave.status = status as any;
    leave.approvedBy = user._id;
    leave.approvedAt = new Date();

    if (status === 'rejected' && rejectionReason) {
      leave.rejectionReason = rejectionReason;
    }

    await leave.save();

    // Find teacher and send notification
    console.log('[LeaveApproval] Finding teacher with ID:', leave.teacherId);
    const teacher = await User.findOne({
      $or: [
        { _id: leave.teacherId },
        { firebaseUid: leave.teacherId }
      ]
    });

    if (teacher) {
      console.log('[LeaveApproval] Teacher found:', {
        id: teacher._id,
        name: teacher.name,
        email: teacher.email,
        hasPushToken: !!teacher.pushToken,
        pushToken: teacher.pushToken ? `${teacher.pushToken.substring(0, 20)}...` : 'none'
      });

      const notification = new Notification({
        userId: teacher._id,
        type: 'general',
        priority: 'high',
        title: status === 'approved' ? 'Leave Approved' : 'Leave Rejected',
        message: status === 'approved'
          ? `Your leave request from ${leave.startDate.toLocaleDateString()} to ${leave.endDate.toLocaleDateString()} has been approved`
          : `Your leave request has been rejected. ${rejectionReason || ''}`,
        data: { leaveId: leave._id },
        actionUrl: '/teacher/leaves'
      });
      await notification.save();
      console.log('[LeaveApproval] In-app notification saved:', notification._id);

      // Send push notification
      console.log('[LeaveApproval] Sending push notification to teacher...');
      sendTeacherNotification(
        leave.teacherId,
        notification.title,
        notification.message
      ).then(() => {
        console.log('[LeaveApproval] Push notification sent successfully');
      }).catch(err => {
        console.error('[LeaveApproval] Push notification failed:', err);
      });
    } else {
      console.error('[LeaveApproval] Teacher not found with ID:', leave.teacherId);
    }

    res.json(leave);
  } catch (error: any) {
    console.error('Error updating leave status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete leave request (Teacher can delete only pending leaves)
router.delete('/:leaveId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const leave = await Leave.findById(req.params.leaveId);

    if (!leave) {
      return res.status(404).json({ error: 'Leave not found' });
    }

    // Only teacher who created the leave or admin can delete
    const isOwnLeave = 
      leave.teacherId === user.id ||
      leave.teacherId === user._id?.toString() ||
      leave.teacherId === user.firebaseUid;

    if (user.role === 'teacher') {
      if (!isOwnLeave) {
        return res.status(403).json({ error: 'Not authorized to delete this leave' });
      }
      if (leave.status !== 'pending') {
        return res.status(400).json({ error: 'Cannot delete a processed leave request' });
      }
    } else if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await Leave.findByIdAndDelete(req.params.leaveId);

    res.json({ message: 'Leave request deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting leave:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check if teacher is on leave for a specific date
router.get('/check/:teacherId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { teacherId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required' });
    }

    const checkDate = new Date(date as string);

    const leave = await Leave.findOne({
      teacherId,
      status: 'approved',
      startDate: { $lte: checkDate },
      endDate: { $gte: checkDate }
    });

    res.json({
      onLeave: !!leave,
      leave: leave || null
    });
  } catch (error: any) {
    console.error('Error checking leave:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
