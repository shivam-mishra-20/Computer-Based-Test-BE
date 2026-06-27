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
import examReviewRoutes from './routes/api/examReviewRoutes';
import reportRoutes from './routes/api/reportRoutes';
import aiRoutes from './routes/api/aiRoutes';
import paperRoutes from './routes/api/paperRoutes';
import analyticsRoutes from './routes/api/analyticsRoutes';
import adminAnalyticsRoutes from './routes/api/adminAnalyticsRoutes';
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
import roomAllocationRoutes from './routes/api/roomAllocationRoutes';
import homeworkRoutes from './routes/api/homeworkRoutes';
import studentProgressRoutes from './routes/api/studentProgressRoutes';
import commentRoutes from './routes/api/commentRoutes';
import practiceTestRoutes from './routes/api/practiceTestRoutes';
import leaveRoutes from './routes/api/leaveRoutes';
import attendanceRuleRoutes from './routes/api/attendanceRuleRoutes';
import syllabusRoutes from './routes/api/syllabusRoutes';
import automationRoutes from './routes/api/automation';
import resourceRoutes from './routes/api/resourceRoutes';
import eodRoutes from './routes/api/eodRoutes';
import playlistRoutes from './routes/api/playlistRoutes';
import scholarshipRoutes from './routes/api/scholarshipRoutes';
import { errorHandler } from './middlewares/errorHandler';
import { globalLimiter } from './middlewares/rateLimiter';
import path from 'path';
// Use require to avoid transient module resolution issues in some TS setups
// eslint-disable-next-line @typescript-eslint/no-var-requires
const uploadRoutes = require('./routes/api/uploadRoutes').default as import('express').Router;

dotenv.config();

const BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '10mb';
const MORGAN_FORMAT = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';

const app = express();
app.disable('x-powered-by');

// Trust proxy for proper IP detection behind load balancers
app.set('trust proxy', 1);

// Apply global rate limiter (must be early in middleware chain)
app.use(globalLimiter);

// Parse JSON bodies, but SKIP parsing when there is no body. A body-less POST
// (e.g. course enroll) that still carries `Content-Type: application/json`
// would otherwise make express.json try to parse an empty string and reject the
// whole request with "Unexpected token … is not valid JSON" — before the route
// even runs. Skipping empty bodies lets those requests through cleanly.
const jsonParser = express.json({ limit: BODY_LIMIT });
app.use((req, res, next) => {
	const contentLength = req.headers['content-length'];
	const hasBody =
		(contentLength !== undefined && contentLength !== '0') ||
		req.headers['transfer-encoding'] !== undefined;
	if (!hasBody) {
		// Mirror express.json's empty-body behavior so downstream handlers that
		// destructure req.body don't crash.
		if (req.body === undefined) req.body = {};
		return next();
	}
	return jsonParser(req, res, next);
});
app.use(express.urlencoded({ limit: BODY_LIMIT, extended: true, parameterLimit: 1000 }));

// CORS configuration - allow credentials and Authorization header
// When credentials is true, origin cannot be '*', so we use a function to dynamically allow origins
const allowedOrigins = process.env.CORS_ORIGIN
	? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
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
		'http://abhigyangurukul.com',
		'http://www.abhigyangurukul.com',
	];

const allowedOriginSet = new Set(allowedOrigins.map((o) => o.toLowerCase()));
const allowedHostSet = new Set(
	allowedOrigins
		.map((originValue) => {
			try {
				return new URL(originValue).hostname.toLowerCase();
			} catch {
				return null;
			}
		})
		.filter((hostname): hostname is string => Boolean(hostname))
);

const parseOriginHostname = (origin: string): string | null => {
	try {
		return new URL(origin).hostname.toLowerCase();
	} catch {
		return null;
	}
};

const corsOptions: cors.CorsOptions = {
	origin: (origin, callback) => {
		// Allow requests with no origin (Postman/curl/native) and null-origin webviews.
		if (!origin || origin === 'null') return callback(null, true);

		// Allow all origins if CORS_ORIGIN is explicitly set to '*'
		if (process.env.CORS_ORIGIN === '*') return callback(null, true);

		const originLower = origin.toLowerCase();
		if (allowedOriginSet.has(originLower)) {
			return callback(null, true);
		}

		const hostname = parseOriginHostname(originLower);
		if (!hostname) {
			console.warn('[CORS] Rejected malformed origin:', origin);
			return callback(new Error('Not allowed by CORS'));
		}

		// Allow listed hostnames irrespective of protocol.
		if (allowedHostSet.has(hostname)) {
			return callback(null, true);
		}

		// For development, allow localhost/127.0.0.1 with any port and protocol.
		if (hostname === 'localhost' || hostname === '127.0.0.1') {
			return callback(null, true);
		}

		// Allow Railway/Vercel preview deployments.
		if (hostname.endsWith('.railway.app') || hostname.endsWith('.up.railway.app') || hostname.endsWith('.vercel.app')) {
			return callback(null, true);
		}

		console.warn('[CORS] Rejected origin:', origin);
		return callback(new Error('Not allowed by CORS'));
	},
	credentials: true,
	allowedHeaders: [
		'Content-Type',
		'Authorization',
		'X-Requested-With',
		'Accept',
		// Scholarship attempt access control
		'X-Scholarship-Attempt-Key',
		'X-Attempt-Key',
	],
	exposedHeaders: ['Content-Range', 'X-Content-Range'],
	methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
	optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// Helmet with CSP disabled to avoid devtools CSP console noise on API root
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan(MORGAN_FORMAT, {
	skip: (req) => req.path === '/api/health' || req.path.startsWith('/.well-known/'),
}));

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
app.use('/api/exam-review', examReviewRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/admin-analytics', adminAnalyticsRoutes);
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
// Test room allocation (per offline test) — admin allocates Room 1–11, publishes,
// and students are notified of their room.
app.use('/api/room-allocations', roomAllocationRoutes);
// Homework & Study Materials routes
app.use('/api/homework', homeworkRoutes);
app.use('/api/progress', studentProgressRoutes);
app.use('/api/comments', commentRoutes);
// Student custom practice tests
app.use('/api/practice-tests', practiceTestRoutes);
// Leave management routes
app.use('/api/leaves', leaveRoutes);
// Attendance timing & deduction rules (admin-configurable)
app.use('/api/attendance-rules', attendanceRuleRoutes);
// Syllabus management routes
app.use('/api/syllabus', syllabusRoutes);
// Study resources (videos/PDFs) routes
app.use('/api/resources', resourceRoutes);
// EOD (End of Day) reports
app.use('/api/eod', eodRoutes);
// YouTube playlist import & sync
app.use('/api/playlist', playlistRoutes);

// Scholarship test routes
app.use('/api/scholarship', scholarshipRoutes);

// Webhook routes
import webhookRoutes from './routes/api/webhookRoutes';
app.use('/api/webhooks', webhookRoutes);

// Error handler
app.use(errorHandler);

export default app;

