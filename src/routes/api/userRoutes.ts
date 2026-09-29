/**
 * An institute's people: its registrations, its staff and its students.
 *
 * ── Authorization ───────────────────────────────────────────────────────────
 * By permission, not by role name, so an organization's custom roles restrict
 * these routes as well as its screens. The legacy bridge grants exactly what
 * the old `requireRole` gates did: admins everything, teachers the teacher and
 * student accounts (never an admin's). Which ACCOUNT is being acted on is then
 * checked in the handler, where the target is known.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 * Every query is scoped to the authenticated principal's organization — by the
 * tenant plugin, and explicitly in the handler. An id from another
 * organization is simply not found.
 */

import { Router } from 'express';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { requireStaffAnyPermission, requireStaffPermission } from '../../middlewares/requirePermission';
import { adminCreateUser, adminListUsers, adminGetUser, adminUpdateUser, adminDeleteUser, adminDashboard, adminGetPendingUsers, adminApproveUser, adminRejectUser, adminGetRegistrationRecords, getStudentBatchConfig, getUserSettings, updateUserSettings, updateProfile } from '../../controllers/userController';
import { changePassword } from '../../controllers/authController';

const router = Router();

// Institute-wide head counts.
router.get('/dashboard', authMiddleware, requireStaffPermission('org.read'), adminDashboard);

// Registrations waiting for someone to let them in.
router.get('/pending', authMiddleware, requireStaffPermission('registrations.review'), adminGetPendingUsers);
router.get('/registrations', authMiddleware, requireStaffPermission('registrations.review'), adminGetRegistrationRecords);
router.put('/:id/approve', authMiddleware, requireStaffPermission('registrations.review'), adminApproveUser);
router.put('/:id/reject', authMiddleware, requireStaffPermission('registrations.review'), adminRejectUser);

// Accounts. The handler narrows by the TARGET account's role.
router.post('/', authMiddleware, requireStaffAnyPermission('users.create', 'students.create', 'teachers.create'), adminCreateUser);
router.get('/', authMiddleware, requireStaffAnyPermission('users.read', 'students.read', 'teachers.read'), adminListUsers);
router.get('/student-batch-config', authMiddleware, requireStaffAnyPermission('users.read', 'students.read', 'batches.read'), getStudentBatchConfig);
router.get('/:id', authMiddleware, requireStaffAnyPermission('users.read', 'students.read', 'teachers.read'), adminGetUser);
router.put('/:id', authMiddleware, requireStaffAnyPermission('users.update', 'students.update', 'teachers.update'), adminUpdateUser);
router.delete('/:id', authMiddleware, requireStaffAnyPermission('users.delete', 'students.delete', 'teachers.delete'), adminDeleteUser);

// User settings (for all authenticated users)
router.get('/me/settings', authMiddleware, getUserSettings);
router.put('/me/settings', authMiddleware, updateUserSettings);

// Change password (for all authenticated users). The same handler as
// /api/auth/change-password: one minimum length, and every other session is
// signed out. There used to be a second copy here that did neither.
router.post('/me/change-password', authMiddleware, changePassword);

// Update Profile (Self)
router.put('/me/profile', authMiddleware, updateProfile);

export default router;
