import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { createPaperCtrl, deletePaperCtrl, generateSolutionsCtrl, getPaperCtrl, listPapersCtrl, updatePaperCtrl } from '../../controllers/paperController';
import { exportTempPdfCtrl, exportTempDocCtrl } from '../../controllers/tempExportController';

const router = Router();

router.post('/', authMiddleware, requireRole('teacher', 'admin'), createPaperCtrl);
router.get('/', authMiddleware, requireRole('teacher', 'admin'), listPapersCtrl);
router.get('/:id', authMiddleware, requireRole('teacher', 'admin'), getPaperCtrl);
router.put('/:id', authMiddleware, requireRole('teacher', 'admin'), updatePaperCtrl);
router.delete('/:id', authMiddleware, requireRole('teacher', 'admin'), deletePaperCtrl);

router.post('/:id/solutions', authMiddleware, requireRole('teacher', 'admin'), generateSolutionsCtrl);
router.get('/:id/export/pdf', authMiddleware, requireRole('teacher', 'admin'), (req, res, next) => (require('../../controllers/paperController') as any).exportPdfCtrl(req, res, next));
router.get('/:id/export/doc', authMiddleware, requireRole('teacher', 'admin'), (req, res, next) => (require('../../controllers/paperController') as any).exportDocCtrl(req, res, next));

// Temporary export routes for AI-generated papers (before saving)
router.post('/temp/export/pdf', authMiddleware, requireRole('teacher', 'admin'), exportTempPdfCtrl);
router.post('/temp/export/doc', authMiddleware, requireRole('teacher', 'admin'), exportTempDocCtrl);

export default router;
