import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { parseAnyFiles } from '../../middlewares/formData';
import { evaluateSubjective, generateFromPdf, generateFromText, generatePaper, refineQuestion, generatePaperFromPdf } from '../../controllers/aiController';

const router = Router();

// Teachers/Admins can generate questions
router.post('/generate/pdf', authMiddleware, requireRole('teacher', 'admin'), parseAnyFiles, generateFromPdf);
router.post('/generate/text', authMiddleware, requireRole('teacher', 'admin'), generateFromText);
router.post('/generate/paper', authMiddleware, requireRole('teacher', 'admin'), generatePaper);
router.post('/generate/paper-pdf', authMiddleware, requireRole('teacher', 'admin'), parseAnyFiles, generatePaperFromPdf);
router.post('/refine', authMiddleware, requireRole('teacher', 'admin'), refineQuestion);

// On-demand subjective evaluation (teachers/admins)
router.post('/evaluate/subjective', authMiddleware, requireRole('teacher', 'admin'), evaluateSubjective);

export default router;
