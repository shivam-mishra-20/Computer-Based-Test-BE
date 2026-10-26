import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import authRoutes from './routes/api/authRoutes';
import learnerRoutes from './routes/api/learnerRoutes';
import publicContentRoutes from './routes/api/publicContentRoutes';
import publicTestRoutes from './routes/api/publicTestRoutes';
import publicTestAdminRoutes from './routes/api/publicTestAdminRoutes';
import userRoutes from './routes/api/userRoutes';
import parentRoutes from './routes/api/parentRoutes';
import guardianLinkRoutes from './routes/api/guardianLinkRoutes';
import orgAdminRoutes from './routes/api/orgAdminRoutes';
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
import sessionRoutes from './routes/api/sessionRoutes';
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
import dailyHoursRoutes from './routes/api/dailyHoursRoutes';
import teacherActivityRoutes from './routes/api/teacherActivityRoutes';
import syllabusRoutes from './routes/api/syllabusRoutes';
import automationRoutes from './routes/api/automation';
import resourceRoutes from './routes/api/resourceRoutes';
import classRequestRoutes from './routes/api/classRequestRoutes';
import orgRegistrationPublicRoutes from './routes/api/orgRegistrationPublicRoutes';
import eodRoutes from './routes/api/eodRoutes';
import playlistRoutes from './routes/api/playlistRoutes';
import scholarshipRoutes from './routes/api/scholarshipRoutes';
import agtsRoutes from './routes/api/agtsRoutes';
import admissionRoutes from './routes/api/admissionRoutes';
import { errorHandler } from './middlewares/errorHandler';
import { globalLimiter } from './middlewares/rateLimiter';
import { tenantContextMiddleware } from './middlewares/tenantContext';
import meContextRoutes from './routes/api/meContextRoutes';
import subjectRoutes from './routes/api/subjectRoutes';
import { requireModule } from './middlewares/requireModule';
import orgPublicRoutes from './routes/api/orgPublicRoutes';
import platformRoutes from './routes/api/platformRoutes';
import platformMfaRoutes from './routes/api/platformMfaRoutes';
import { requirePlatformDeployment } from './middlewares/requirePlatformDeployment';
import { serviceRealm } from './core/realm/realm';
import { createPlatformGateway, platformRuntimeEntry } from './core/realm/platformGateway';
import { platformRuntimeTarget } from './core/realm/platformRuntime';
import { readinessOf } from './core/health/readiness';
import { requestId } from './middlewares/requestId';
import { corsPolicyFromEnv, corsVerdict } from './core/http/corsPolicy';
import { resolveOrgFromRequest } from './core/tenancy/hostResolution';
import mongoose from 'mongoose';
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

/*
 * ── Two systems, one server ─────────────────────────────────────────────────
 * /api/*           the existing system, served by THIS app in the main process,
 *                  on the existing database, with the existing authentication
 *                  and roles. No organization is required anywhere under it.
 * /platform-api/*  the organization platform: forwarded, before anything below
 *                  runs, to the platform runtime — the same application in its
 *                  own process, on the platform database, where organization
 *                  resolution and org-scoped authorization apply
 *                  (core/realm/realm.ts).
 *
 * Nothing of the platform's request pipeline runs for /api/*, and nothing of
 * the existing system's (CORS, limits, parsing) runs twice for /platform-api/*.
 */
// First of all, so the gateway forwards the same id and every log line —
// in either process — can carry it (middlewares/requestId).
app.use(requestId);

if (serviceRealm() === 'platform') {
  app.use(platformRuntimeEntry);
} else {
  // The gateway's own answers (a 503 while the platform runtime is not
  // serving) carry this server's CORS headers, so a browser can read why;
  // what it forwards is answered under the runtime's own CORS.
  app.use('/platform-api', createPlatformGateway({ cors: (req, res, next) => cors(corsOptions)(req, res, next) }));
}

// CORS — explicitly configured origins only (core/http/corsPolicy). An org's
// own domain is checked against the database on the platform realm, where the
// organizations live; the existing realm has none to check.
const corsPolicy = corsPolicyFromEnv();
const legacyOriginsLogged = new Set<string>();

const corsOptions: cors.CorsOptions = {
	origin: (origin, callback) => {
		// Requests with no Origin (curl, native apps) and null-origin webviews carry
		// no browser credentials for another site to borrow.
		if (!origin || origin === 'null') return callback(null, true);

		const verdict = corsVerdict(origin, corsPolicy);
		if (verdict === 'allow') return callback(null, true);
		if (verdict === 'allow-legacy') {
			if (!legacyOriginsLogged.has(origin)) {
				legacyOriginsLogged.add(origin);
				console.warn(`[CORS] allowed ONLY by CORS_LEGACY_WILDCARDS: ${origin} — add it to CORS_ORIGIN before removing the switch`);
			}
			return callback(null, true);
		}
		if (verdict === 'check-org-domain' && serviceRealm() === 'platform') {
			const host = new URL(origin).hostname;
			resolveOrgFromRequest({ host })
				.then((orgId) => {
					if (orgId) return callback(null, true);
					console.warn('[CORS] Rejected origin:', origin);
					return callback(new Error('Not allowed by CORS'));
				})
				.catch(() => callback(new Error('Not allowed by CORS')));
			return;
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
		// AGTS attempt access control (and its pre-AGTS name, still accepted)
		'X-AGTS-Attempt-Key',
		'X-Scholarship-Attempt-Key',
		'X-Attempt-Key',
		// The institute onboarding draft: an applicant has no account, so the
		// draft token IS the authorisation. Without it listed here the browser
		// fails the preflight and every save after step 1 looks to the
		// applicant like the server is down.
		'X-Application-Token',
		// The pre-login organization hint (and the app identity beside it). A
		// web client sends X-Org-Id before anyone has signed in, so a login page
		// can be painted in its institute's colours; without these listed the
		// browser failed the preflight, the request never left, and every web
		// login page fell back to unbranded. Routing hints only — the server
		// never lets them outrank a signed token (tenantContext.ts).
		'X-Org-Id',
		'X-App-Id',
	],
	exposedHeaders: ['Content-Range', 'X-Content-Range', 'X-Request-Id'],
	methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
	optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

/*
 * ── Why the rate limiter and the body parsers come AFTER cors ──────────────
 * They used to come first, and the cost was paid in diagnosis rather than in
 * correctness. Anything that answers a cross-origin request BEFORE `cors()`
 * runs answers it with no `Access-Control-Allow-Origin` header, and a browser
 * reports that as "blocked by CORS policy" whatever the real reason was. So a
 * 429 from the global limiter, and a 400 from `express.json` on a malformed
 * body, both reached the client as a CORS error — sending whoever was
 * debugging to the allow-list, which was never the problem.
 *
 * Running cors first costs two response headers on requests that are about to
 * be refused, and in exchange every refusal says what it actually is. It also
 * means a preflight is answered before the limiter counts it, which is right:
 * a browser's OPTIONS is not a request the user made.
 */

// Apply global rate limiter (early, but never before CORS — see above)
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

// Helmet with CSP disabled to avoid devtools CSP console noise on API root
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan(MORGAN_FORMAT, {
	skip: (req) => req.path === '/api/health' || req.path.startsWith('/.well-known/'),
}));

// Open a tenant context for every request, before any route runs, so handlers
// and the services they call are scoped without needing to know it. Mounted
// after body parsing (it reads headers only) and before the routes.
//
// Under TENANT_ENFORCEMENT=warn — the default and the only setting used during
// migration — this changes no query result. It establishes the context and
// observes; read filtering begins only under `enforce`.
app.use(tenantContextMiddleware);

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

// Readiness for a load balancer: 503 while the database is not connected or the
// platform runtime is not listening (core/health/readiness). States only.
app.get('/api/health/ready', (_req, res) => {
	const target = platformRuntimeTarget();
	const verdict = readinessOf({
		mongoReadyState: mongoose.connection.readyState,
		platform: { configured: target.configured, listening: target.port !== null, restarts: target.restarts },
	});
	res.status(verdict.ready ? 200 : 503).json({ status: verdict.ready ? 'ready' : 'not-ready', ...verdict.checks });
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
// Client bootstrap: org + branding + modules + limits in ONE call. Additive —
// the legacy app never calls it.
// Master admin surface. Gated by token AUDIENCE, not by role — a tenant token
// is rejected at the door regardless of how privileged it is inside its own
// organization.
// ── Entitlement enforcement ─────────────────────────────────────────────────
// Until now `requireModule` existed and was wired to NOTHING. Both clients
// hid what an organization had not bought, and hiding is not enforcing: a
// client can be modified and `curl` ignores navigation entirely. An institute
// on a plan without AI could call /api/ai directly and be served.
//
// Mounted here, at the router level, rather than sprinkled across 487 route
// definitions — one table that can be read in a sitting and diffed in a review.
//
// `requireModule` fails OPEN when there is no tenant context and when
// entitlement resolution fails. That is why adding this cannot lock out
// Abhigyan: a pinned deployment with no subscription resolves to every module,
// and a Redis outage degrades to "allowed" rather than to a dead platform.
//
// Dependencies are expanded at resolution, so an organization holding `cbt`
// necessarily holds `exams` and `classes`; these keys do not need to restate
// their own prerequisites.
//
// DELIBERATELY ABSENT, and each for a reason:
//   /api/exams        serves exams, the question bank AND blueprints. One key
//                     cannot express three, and `questionBank` does not require
//                     `exams`, so gating the group on either would deny a
//                     legitimate combination. Needs per-route gating.
//   /api             importRoutes is mounted at the API root; a gate there
//                     would apply to everything. Its smart-import surface has
//                     its own prefix, so `/api/import-paper` IS gated below;
//                     the rest of that router (/imports/*, /blueprints) is not.
//   /api/teacher      mixed: rosters, analytics and exam tooling.
//   /api/users        core. Gating identity is how a packaging mistake bricks
//                     a tenant.
//   /api/notifications, /api/uploads, /api/auth, /api/me, /api/org — core.
const MODULE_GATED_ROUTES: [string, string][] = [
  ['/api/attempts', 'cbt'],
  ['/api/practice-tests', 'cbt'],
  ['/api/exam-review', 'evaluation'],
  ['/api/results', 'results'],
  ['/api/offline-results', 'offlineTests'],
  ['/api/leaderboard', 'rankings'],
  ['/api/analytics', 'analytics'],
  ['/api/admin-analytics', 'analytics'],
  ['/api/reports', 'analytics'],
  // /api/ai is gated PER ROUTE in aiRoutes.ts: it serves AI generation (`ai`)
  // and the class question bank (`questionBank`), and one key for both refused
  // organizations their own question bank for not having bought AI.
  ['/api/courses', 'courses'],
  ['/api/lectures', 'courses'],
  ['/api/playlist', 'courses'],
  ['/api/materials', 'materials'],
  ['/api/resources', 'materials'],
  ['/api/attendance', 'attendance'],
  ['/api/attendance-rules', 'attendance'],
  ['/api/schedule', 'scheduling'],
  ['/api/room-allocations', 'scheduling'],
  ['/api/holidays', 'scheduling'],
  ['/api/homework', 'homework'],
  ['/api/doubts', 'doubts'],
  // Smart import (upload → AI extraction → review → create paper). A path
  // prefix, so it gates every /api/import-paper/* route and nothing else
  // importRoutes serves. Must stay above `app.use('/api', importRoutes)`.
  ['/api/import-paper', 'questionImport'],
  // Firestore is a SINGLE-TENANT store — one global `Users` collection with no
  // organization dimension. This gate is what stops a second tenant writing
  // into the collection Abhigyan reads, and it is the mitigation the isolation
  // audit's ACCEPTED-GAP entries depend on.
  ['/api/admin/firebase', 'integrations'],
];

for (const [mountPath, moduleKey] of MODULE_GATED_ROUTES) {
  app.use(mountPath, requireModule(moduleKey));
}

/**
 * The platform control plane, served ONLY by api-platform.
 *
 * `requirePlatformDeployment` makes the whole surface invisible unless
 * TENANT_MODE=claim. api-legacy is a public, institute-facing host and has no
 * business exposing organization, plan, subscription or staff administration —
 * see the middleware for why the refusal is an indistinguishable 404 rather
 * than a 403.
 */
// BEFORE platformRoutes: its router-wide console guard would otherwise refuse
// the two-factor code step, which by definition has no session yet.
app.use('/api/platform', requirePlatformDeployment, platformMfaRoutes);
app.use('/api/platform', requirePlatformDeployment, platformRoutes);
app.use('/api/me', meContextRoutes);
app.use('/api/org', orgPublicRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/auth', passwordResetRoutes); // Password reset under /api/auth
app.use('/api/auth', sessionRoutes); // Refresh, sign out everywhere, invite + reset links
app.use('/api/learner', learnerRoutes); // Public Learner profile, home, saves, progress
// Public "Register your institute" submissions. Unauthenticated, rate
// limited, and able to write only to OrganizationRegistration — it creates
// no tenant. Approval happens in the console; see
// docs/organization-registration.md.
app.use('/api/public', orgRegistrationPublicRoutes);
app.use('/api/public', publicContentRoutes); // Guest + learner content discovery
app.use('/api/public', publicTestRoutes); // Guest + learner assessment discovery (browse-only)
app.use('/api/admin-assessments', publicTestAdminRoutes); // Staff authoring for public tests
app.use('/api/users', userRoutes);
app.use('/api/parent', parentRoutes); // Parent-scoped: verified wards only
app.use('/api/guardian-links', guardianLinkRoutes); // Org admins review parent links
// An institute's admins manage their OWN organization. Platform only: the
// existing system has no organizations, so there it is not served at all.
app.use('/api/org-admin', requirePlatformDeployment, orgAdminRoutes);
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
app.use('/api/subjects', subjectRoutes);
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
// Daily working hours report (attendance + schedule + EOD, read-only)
app.use('/api/daily-hours', dailyHoursRoutes);
app.use('/api/teacher-activity', teacherActivityRoutes);
// Syllabus management routes
app.use('/api/syllabus', syllabusRoutes);
// Study resources (videos/PDFs) routes
app.use('/api/resources', resourceRoutes);

// Public class requests (guest web/app submissions) + admin review queue
app.use('/api/class-requests', classRequestRoutes);
// EOD (End of Day) reports
app.use('/api/eod', eodRoutes);
// YouTube playlist import & sync
app.use('/api/playlist', playlistRoutes);

// AGTS — Abhigyan Gurukul Test Series (public test flow + staff lead desk)
app.use('/api/agts', agtsRoutes);
// Admissions — website enquiries, the application link, offers, enrolment, seats
app.use('/api/admissions', admissionRoutes);
// Pre-AGTS scholarship routes: kept for links and admin tooling already in use
app.use('/api/scholarship', scholarshipRoutes);

// Webhook routes
import webhookRoutes from './routes/api/webhookRoutes';
app.use('/api/webhooks', webhookRoutes);

// Error handler
app.use(errorHandler);

export default app;

