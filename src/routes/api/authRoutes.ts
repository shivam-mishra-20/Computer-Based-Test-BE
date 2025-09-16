import { Router } from 'express';
import { register, login, me } from '../../controllers/authController';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// POST endpoints used by clients
router.post('/register', register);
router.post('/login', login);
router.get('/me', authMiddleware, me);

// Provide helpful responses for accidental browser GETs (avoid 404 spam)
router.get('/register', (_req, res) => {
	res.status(405).json({ message: 'Use POST /api/auth/register to create an account' });
});
router.get('/login', (_req, res) => {
	res.status(405).json({ message: 'Use POST /api/auth/login to obtain a JWT' });
});

export default router;
