import { Router } from 'express';
import { register, login, me, publicRegister, publicTeacherRegister, changePassword, updateProfile, uploadProfileImage } from '../../controllers/authController';
import { authMiddleware } from '../../middlewares/authMiddleware';
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

// POST endpoints used by clients
router.post('/register', register);
router.post('/public-register', publicRegister);
router.post('/public-register-teacher', publicTeacherRegister);
router.post('/login', login);
router.get('/me', authMiddleware, me);
router.post('/change-password', authMiddleware, changePassword);
router.patch('/profile', authMiddleware, updateProfile);
router.post('/profile/image', authMiddleware, upload.single('image'), uploadProfileImage);

// Provide helpful responses for accidental browser GETs (avoid 404 spam)
router.get('/register', (_req, res) => {
	res.status(405).json({ message: 'Use POST /api/auth/register to create an account' });
});
router.get('/login', (_req, res) => {
	res.status(405).json({ message: 'Use POST /api/auth/login to obtain a JWT' });
});

export default router;

