import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { parseAnyFiles } from '../../middlewares/formData';
import { evaluateSubjective, generateFromPdf, generateFromText, generatePaper, refineQuestion, generatePaperFromPdf, generateFromImage, createGuidance, listGuidance, updateGuidance, deleteGuidance, generatePaperFromImage } from '../../controllers/aiController';
import { upload } from '../../middlewares/upload';

const router = Router();

// Teachers/Admins can generate questions
router.post('/generate/pdf', authMiddleware, requireRole('teacher', 'admin'), parseAnyFiles, generateFromPdf);
router.post('/generate/image', authMiddleware, requireRole('teacher', 'admin'), upload.single('image'), generateFromImage);
router.post('/generate/text', authMiddleware, requireRole('teacher', 'admin'), generateFromText);
router.post('/generate/paper', authMiddleware, requireRole('teacher', 'admin'), generatePaper);
router.post('/generate/paper-pdf', authMiddleware, requireRole('teacher', 'admin'), parseAnyFiles, generatePaperFromPdf);
router.post('/generate/paper-image', authMiddleware, requireRole('teacher', 'admin'), upload.single('image'), generatePaperFromImage);
router.post('/refine', authMiddleware, requireRole('teacher', 'admin'), refineQuestion);

// On-demand subjective evaluation (teachers/admins)
router.post('/evaluate/subjective', authMiddleware, requireRole('teacher', 'admin'), evaluateSubjective);

// Admin guidance management
router.post('/guidance', authMiddleware, requireRole('admin'), createGuidance);
router.get('/guidance', authMiddleware, requireRole('admin'), listGuidance);
router.put('/guidance/:id', authMiddleware, requireRole('admin'), updateGuidance);
router.delete('/guidance/:id', authMiddleware, requireRole('admin'), deleteGuidance);

export default router;
