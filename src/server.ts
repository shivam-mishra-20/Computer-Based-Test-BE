// AI uses NVIDIA (cloud) / Ollama (local) — no Google Cloud credentials needed.

// ── Fail fast on a missing/weak JWT secret ──────────────────────────────────
// Auth tokens are signed with JWT_SECRET; a missing or trivially short secret
// would let anyone forge tokens. Refuse to boot in production with an insecure
// secret (warn-only in dev so local setups aren't blocked).
(function validateJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    const msg =
      '[Startup] JWT_SECRET is missing or too short (need >= 32 chars) — insecure auth secret.';
    if (process.env.NODE_ENV === 'production') {
      console.error(msg + ' Refusing to start.');
      process.exit(1);
    }
    console.warn(msg + ' (continuing in non-production)');
  }
})();

import http from 'http';
import cluster from 'cluster';
import SocketService from './services/SocketService';
import { closeRedis } from './config/redis';

// Import application after credentials are configured
const app = require('./app').default || require('./app');
const { connectDB } = require('./config/db');

const PORT = parseInt(process.env.PORT || '5000', 10);
const WORKER_ID = process.env.WORKER_ID || process.pid;

function shouldRunCronJobs(): boolean {
  if (process.env.ENABLE_CRON === 'false') return false;
  if (process.env.CRON_ON_ALL_WORKERS === 'true') return true;
  if (!cluster.isWorker) return true;
  return cluster.worker?.id === 1;
}

/** The AI PPT pipeline worker runs EMBEDDED here by default so `npm start`
 * alone is a complete deployment — without it, ppt generations sit 'queued'
 * forever unless someone remembers to run the separate worker process. Same
 * one-instance gating as cron (cluster fork 1 only) so cluster mode doesn't
 * multiply queue concurrency. Set PPT_WORKER_EMBEDDED=false to opt out and
 * run `npm run start:worker:ppt` as its own process instead. */
function shouldRunEmbeddedPptWorker(): boolean {
  if (process.env.PPT_WORKER_EMBEDDED === 'false') return false;
  if (!cluster.isWorker) return true;
  return cluster.worker?.id === 1;
}

const httpServer = http.createServer(app);

// Initialize Socket.IO with Redis adapter
SocketService.init(httpServer);

const server = httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ [Worker ${WORKER_ID}] Server running on http://0.0.0.0:${PORT}`);
});

// Increase max connections for high traffic
server.maxConnections = 10000;

connectDB().then(async () => {
  if (shouldRunCronJobs()) {
    // Initialize attendance auto-sync cron after DB is ready
    const { AttendanceCron } = require('./services/AttendanceCron');
    AttendanceCron.init();

    // Initialize daily 8 PM IST reminder for teacher EOD work reports
    const { TeacherEodReminderCron } = require('./services/TeacherEodReminderCron');
    TeacherEodReminderCron.init();
    console.log(`✅ [Worker ${WORKER_ID}] Cron jobs initialized`);
  } else {
    console.log(`ℹ️ [Worker ${WORKER_ID}] Skipping cron initialization on this worker`);
  }

  if (shouldRunEmbeddedPptWorker()) {
    const { startPptPipelineWorker } = require('./workers/pptWorkerCore');
    startPptPipelineWorker();
    console.log(
      `✅ [Worker ${WORKER_ID}] Embedded AI PPT worker started (set PPT_WORKER_EMBEDDED=false to run it separately)`,
    );
  }
}).catch((err: any) => {
  console.error('Database connection failed at startup:', err);
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    console.log('✅ HTTP server closed');
  });

  // Stop the embedded PPT worker (no-op when not started) so in-flight jobs
  // release their locks cleanly instead of stalling.
  try {
    const { stopPptPipelineWorker } = require('./workers/pptWorkerCore');
    await stopPptPipelineWorker();
  } catch {
    /* best-effort */
  }

  // Close Redis connections
  await closeRedis();

  // Close MongoDB connection
  const mongoose = require('mongoose');
  await mongoose.connection.close();
  console.log('✅ MongoDB connection closed');

  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

