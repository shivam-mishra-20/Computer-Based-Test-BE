import { requireStaffPermission } from '../../middlewares/requirePermission';
import { Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
import {
  getRooms,
  getExamDates,
  getDateRoster,
  saveDraft,
  publishAllocation,
  getMyRoom,
} from '../../controllers/roomAllocationController';

const router = Router();

// Shared constant — any authenticated user may read the fixed room list.
router.get('/rooms', authMiddleware, getRooms);

// Student: my own published room for a date (used by notification deep-link).
router.get('/student/:date', authMiddleware, getMyRoom);

// Admin: manage allocations per exam date.
router.get('/dates', authMiddleware, requireStaffPermission('rooms.manage'), getExamDates);
router.get('/dates/:date/roster', authMiddleware, requireStaffPermission('rooms.manage'), getDateRoster);
router.put('/dates/:date', authMiddleware, requireStaffPermission('rooms.manage'), saveDraft);
router.post('/dates/:date/publish', authMiddleware, requireStaffPermission('rooms.manage'), publishAllocation);

export default router;
