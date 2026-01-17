import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import authRoutes from './routes/api/authRoutes';
import userRoutes from './routes/api/userRoutes';
import testRoutes from './routes/api/testRoutes';
import examRoutes from './routes/api/examRoutes';
import attemptRoutes from './routes/api/attemptRoutes';
import reportRoutes from './routes/api/reportRoutes';
import aiRoutes from './routes/api/aiRoutes';
import paperRoutes from './routes/api/paperRoutes';
import analyticsRoutes from './routes/api/analyticsRoutes';
import adminRoutes from './routes/api/adminRoutes';
import importRoutes from './routes/api/importRoutes';
import courseRoutes from './routes/api/courseRoutes';
import attendanceRoutes from './routes/api/attendanceRoutes';
import materialRoutes from './routes/api/materialRoutes';
import announcementRoutes from './routes/api/announcementRoutes';
import scheduleRoutes from './routes/api/scheduleRoutes';
import leaderboardRoutes from './routes/api/leaderboardRoutes';
import bookmarkRoutes from './routes/api/bookmarkRoutes';
import passwordResetRoutes from './routes/api/passwordResetRoutes';
import doubtRoutes from './routes/api/doubtRoutes';
import lectureRoutes from './routes/api/lectureRoutes';
import teacherRoutes from './routes/api/teacherRoutes';
import notificationRoutes from './routes/api/notificationRoutes';
import resultRoutes from './routes/api/resultRoutes';
import metricsRoutes from './routes/api/metricsRoutes';
import offlineResultsRoutes from './routes/api/offlineResultsRoutes';
import { errorHandler } from './middlewares/errorHandler';
import path from 'path';
// Use require to avoid transient module resolution issues in some TS setups
// eslint-disable-next-line @typescript-eslint/no-var-requires
const uploadRoutes = require('./routes/api/uploadRoutes').default as import('express').Router;

dotenv.config();

const app = express();

app.use(express.json());
app.use(cors());
// Helmet with CSP disabled to avoid devtools CSP console noise on API root
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));

// Serve static uploads (images) from /uploads
app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')));

// Root endpoint to avoid 404 at /
app.get('/', (_req, res) => {
	res.json({
		name: 'CBT Exam Backend',
		status: 'ok',
		health: '/api/tests/health',
		docs: 'See README for API routes',
		timestamp: new Date().toISOString()
	});
});

// Health check endpoint for mobile app connectivity testing
app.get('/api/health', (_req, res) => {
	res.json({
		status: 'healthy',
		timestamp: new Date().toISOString(),
		uptime: process.uptime()
	});
});

// Chrome DevTools sometimes probes this path; return 200 to avoid 404 noise
app.get('/.well-known/appspecific/com.chrome.devtools.json', (_req, res) => {
	res.json({});
});

// Friendly handlers for common browser requests that might otherwise 404
app.get('/login', (_req, res) => {
	// Common when a user navigates to /login in a browser: instruct to use API
	res.status(405).json({ message: 'This server exposes an API. Use POST /api/auth/login to obtain a token.' });
});
app.get('/register', (_req, res) => {
	res.status(405).json({ message: 'Use POST /api/auth/register to create an account.' });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/auth', passwordResetRoutes); // Password reset under /api/auth
app.use('/api/users', userRoutes);
app.use('/api/tests', testRoutes);
app.use('/api/exams', examRoutes);
app.use('/api/attempts', attemptRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/papers', paperRoutes);
app.use('/api', importRoutes);
// New routes for enhanced student app
app.use('/api/courses', courseRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/materials', materialRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/bookmarks', bookmarkRoutes);
app.use('/api/notifications', notificationRoutes);
// Teacher dashboard routes
app.use('/api/doubts', doubtRoutes);
app.use('/api/lectures', lectureRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api/results', resultRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/offline-results', offlineResultsRoutes);

// Webhook routes
import webhookRoutes from './routes/api/webhookRoutes';
app.use('/api/webhooks', webhookRoutes);

// Error handler
app.use(errorHandler);

export default app;

