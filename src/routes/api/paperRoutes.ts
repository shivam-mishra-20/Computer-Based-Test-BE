import { requireStaffPermission } from '../../middlewares/requirePermission';
import { Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
import { createPaperCtrl, deletePaperCtrl, generateSolutionsCtrl, getPaperCtrl, listPapersCtrl, updatePaperCtrl } from '../../controllers/paperController';
import { exportTempPdfCtrl, exportTempDocCtrl } from '../../controllers/tempExportController';

const router = Router();

router.post('/', authMiddleware, requireStaffPermission('exams.create'), createPaperCtrl);
router.get('/', authMiddleware, requireStaffPermission('exams.read'), listPapersCtrl);
router.get('/:id', authMiddleware, requireStaffPermission('exams.read'), getPaperCtrl);
router.put('/:id', authMiddleware, requireStaffPermission('exams.update'), updatePaperCtrl);
router.delete('/:id', authMiddleware, requireStaffPermission('exams.delete'), deletePaperCtrl);

router.post('/:id/solutions', authMiddleware, requireStaffPermission('exams.update'), generateSolutionsCtrl);
router.get('/:id/export/pdf', authMiddleware, requireStaffPermission('exams.read'), (req, res, next) => (require('../../controllers/paperController') as any).exportPdfCtrl(req, res, next));
router.get('/:id/export/doc', authMiddleware, requireStaffPermission('exams.read'), (req, res, next) => (require('../../controllers/paperController') as any).exportDocCtrl(req, res, next));

// Temporary export routes for AI-generated papers (before saving)
router.post('/temp/export/pdf', authMiddleware, requireStaffPermission('exams.read'), exportTempPdfCtrl);
router.post('/temp/export/doc', authMiddleware, requireStaffPermission('exams.read'), exportTempDocCtrl);

export default router;
