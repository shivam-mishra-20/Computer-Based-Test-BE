/**
 * Teacher-facing subject picker: list what exists, add what doesn't.
 *
 * Read and write both scope through subjectService, which resolves the
 * current organization (or the shared pre-tenancy bucket) itself — this file
 * has no tenancy logic of its own on purpose, so there is exactly one place
 * that decides what "this org's subjects" means.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { createSubject, listSubjects, SubjectConflictError, SubjectValidationError } from '../../services/subjectService';

const router = Router();

// Teachers and admins only — the same pair every other subject-adjacent
// teacher endpoint (AI content, homework, materials) already guards with.
const guards = [authMiddleware, requireRole('teacher', 'admin')];

/**
 * @route   GET /api/subjects
 * @desc    Subjects available to pick from, for the caller's organization.
 * @access  Private (teacher, admin)
 */
router.get('/', ...guards, async (_req: Request, res: Response) => {
  try {
    const { subjects, usingDefaults } = await listSubjects();
    res.json({ success: true, subjects, usingDefaults });
  } catch (error) {
    console.error('[subjects] list failed:', error);
    res.status(500).json({ success: false, message: 'Failed to load subjects.' });
  }
});

/**
 * @route   POST /api/subjects
 * @desc    Create a new subject, reusable across every teacher screen.
 * @access  Private (teacher, admin)
 */
router.post('/', ...guards, async (req: Request, res: Response) => {
  try {
    const { subject, subjects } = await createSubject(req.body?.name);
    res.status(201).json({ success: true, subject, subjects });
  } catch (error) {
    if (error instanceof SubjectValidationError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    if (error instanceof SubjectConflictError) {
      return res.status(409).json({
        success: false,
        message: error.message,
        subject: { name: error.existingName },
      });
    }
    console.error('[subjects] create failed:', error);
    res.status(500).json({ success: false, message: 'Failed to create subject.' });
  }
});

export default router;
