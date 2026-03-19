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
import holidayRoutes from './routes/api/holidayRoutes';
import metricsRoutes from './routes/api/metricsRoutes';
import offlineResultsRoutes from './routes/api/offlineResultsRoutes';
import homeworkRoutes from './routes/api/homeworkRoutes';
import studentProgressRoutes from './routes/api/studentProgressRoutes';
import commentRoutes from './routes/api/commentRoutes';
import practiceTestRoutes from './routes/api/practiceTestRoutes';
import leaveRoutes from './routes/api/leaveRoutes';
import syllabusRoutes from './routes/api/syllabusRoutes';
import automationRoutes from './routes/api/automation';
import resourceRoutes from './routes/api/resourceRoutes';
import eodRoutes from './routes/api/eodRoutes';
import scholarshipRoutes from './routes/api/scholarshipRoutes';
import { errorHandler } from './middlewares/errorHandler';
import { globalLimiter } from './middlewares/rateLimiter';
import path from 'path';
// Use require to avoid transient module resolution issues in some TS setups
// eslint-disable-next-line @typescript-eslint/no-var-requires
const uploadRoutes = require('./routes/api/uploadRoutes').default as import('express').Router;

dotenv.config();

const app = express();

// Trust proxy for proper IP detection behind load balancers
app.set('trust proxy', 1);

// Apply global rate limiter (must be early in middleware chain)
app.use(globalLimiter);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// CORS configuration - allow credentials and Authorization header
// When credentials is true, origin cannot be '*', so we use a function to dynamically allow origins
const allowedOrigins = process.env.CORS_ORIGIN 
	? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
	: [
		'http://localhost:3000', 
		'http://localhost:3001', 
		'http://127.0.0.1:3000', 
		'http://localhost:5173',
		'https://computer-based-test.vercel.app',
		'https://examease-pi.vercel.app',
		'https://computer-based-test-be-production.up.railway.app',
		// Abhigyan Gurukul website
		'https://abhigyangurukul.com',
		'https://www.abhigyangurukul.com',
	];

app.use(cors({
	origin: (origin, callback) => {
		// Allow requests with no origin (like mobile apps, Postman, curl, native apps)
		if (!origin) return callback(null, true);
		
		// Allow all origins if CORS_ORIGIN is explicitly set to '*'
		if (process.env.CORS_ORIGIN === '*') return callback(null, true);
		
		// Check if origin is in allowed list
		if (allowedOrigins.includes(origin)) {
			return callback(null, true);
		}
		
		// For development, allow localhost with any port
		if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
			return callback(null, true);
		}
		
		// Allow Railway preview deployments
		if (origin.includes('.railway.app') || origin.includes('.up.railway.app')) {
			return callback(null, true);
		}
		
		// Allow Vercel deployments
		if (origin.includes('.vercel.app')) {
			return callback(null, true);
		}
		
		// Log rejected origins for debugging
		console.warn('[CORS] Rejected origin:', origin);
		callback(new Error('Not allowed by CORS'));
	},
	credentials: true,
	allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
	exposedHeaders: ['Content-Range', 'X-Content-Range'],
	methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));

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
app.use('/api/automation', automationRoutes); // EPUB extraction automation
// New routes for enhanced student app
app.use('/api/courses', courseRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/materials', materialRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/bookmarks', bookmarkRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/holidays', holidayRoutes);
// Teacher dashboard routes
app.use('/api/doubts', doubtRoutes);
app.use('/api/lectures', lectureRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api/results', resultRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/offline-results', offlineResultsRoutes);
// Homework & Study Materials routes
app.use('/api/homework', homeworkRoutes);
app.use('/api/progress', studentProgressRoutes);
app.use('/api/comments', commentRoutes);
// Student custom practice tests
app.use('/api/practice-tests', practiceTestRoutes);
// Leave management routes
app.use('/api/leaves', leaveRoutes);
// Syllabus management routes
app.use('/api/syllabus', syllabusRoutes);
// Study resources (videos/PDFs) routes
app.use('/api/resources', resourceRoutes);
// EOD (End of Day) reports
app.use('/api/eod', eodRoutes);

// Scholarship test routes
app.use('/api/scholarship', scholarshipRoutes);

// Webhook routes
import webhookRoutes from './routes/api/webhookRoutes';
app.use('/api/webhooks', webhookRoutes);

// Error handler
app.use(errorHandler);

export default app;

