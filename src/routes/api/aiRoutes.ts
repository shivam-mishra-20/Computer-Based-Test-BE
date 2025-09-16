import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { parseAnyFiles } from '../../middlewares/formData';
import { evaluateSubjective, generateFromPdf, generateFromText } from '../../controllers/aiController';

const router = Router();

// Teachers/Admins can generate questions
router.post('/generate/pdf', authMiddleware, requireRole('teacher', 'admin'), parseAnyFiles, generateFromPdf);
router.post('/generate/text', authMiddleware, requireRole('teacher', 'admin'), generateFromText);

// On-demand subjective evaluation (teachers/admins)
router.post('/evaluate/subjective', authMiddleware, requireRole('teacher', 'admin'), evaluateSubjective);

export default router;
