import { Router } from 'express';
import { register, login, me, publicRegister, publicTeacherRegister, changePassword, updateProfile, uploadProfileImage, publicStudentBatchConfig, deleteAccount } from '../../controllers/authController';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { authLimiter, uploadLimiter } from '../../middlewares/rateLimiter';
import multer from 'multer';

const router = Router();

// Multer config for profile image uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage, 
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// POST endpoints used by clients (with rate limiting)
router.post('/register', authLimiter, register);
router.post('/public-register', authLimiter, publicRegister);
router.post('/public-register-teacher', authLimiter, publicTeacherRegister);
router.get('/public-student-batch-config', publicStudentBatchConfig);
router.post('/login', authLimiter, login);
router.get('/me', authMiddleware, me);
router.post('/change-password', authMiddleware, changePassword);
router.patch('/profile', authMiddleware, updateProfile);
router.post('/profile/image', authMiddleware, uploadLimiter, upload.single('image'), uploadProfileImage);
router.delete('/account', authMiddleware, deleteAccount);

// Provide helpful responses for accidental browser GETs (avoid 404 spam)
router.get('/register', (_req, res) => {
	res.status(405).json({ message: 'Use POST /api/auth/register to create an account' });
});
router.get('/login', (_req, res) => {
	res.status(405).json({ message: 'Use POST /api/auth/login to obtain a JWT' });
});

export default router;

