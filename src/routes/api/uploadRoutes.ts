import { requireStaffAnyPermission } from '../../middlewares/requirePermission';
import { Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
import { upload } from '../../middlewares/upload';
import { uploadImageCtrl } from '../../controllers/uploadController';
import { uploadLimiter } from '../../middlewares/rateLimiter';

const router = Router();

// Upload an image and receive a public URL
router.post('/image', authMiddleware, requireStaffAnyPermission('questions.create', 'exams.create', 'materials.manage', 'courses.manage', 'homework.manage'), uploadLimiter, upload.single('image'), uploadImageCtrl);

export default router;
