import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
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
router.get('/dates', authMiddleware, requireRole('admin'), getExamDates);
router.get('/dates/:date/roster', authMiddleware, requireRole('admin'), getDateRoster);
router.put('/dates/:date', authMiddleware, requireRole('admin'), saveDraft);
router.post('/dates/:date/publish', authMiddleware, requireRole('admin'), publishAllocation);

export default router;
