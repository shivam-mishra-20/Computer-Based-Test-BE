import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { upload } from '../../middlewares/upload';
import { uploadImageCtrl } from '../../controllers/uploadController';

const router = Router();

// Upload an image and receive a public URL
router.post('/image', authMiddleware, requireRole('teacher', 'admin'), upload.single('image'), uploadImageCtrl);

export default router;
