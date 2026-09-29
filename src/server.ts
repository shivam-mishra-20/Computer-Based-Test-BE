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

// ── Tenancy must be registered before ANY model is compiled ─────────────────
// mongoose.plugin() applies only to schemas built after the call, and models
// compile at import time. Registering after `require('./app')` below would
// produce models with no orgId and no scoping hooks — and it would do so
// silently, which is the worst failure mode for a security control.
// verifyTenantPluginApplied() below turns that silence into a loud error.
import { registerTenancy, verifyTenantPluginApplied } from './core/tenancy';
import { applyDataSourcePolicy } from './core/tenancy/dataSource';

// ── The database decides the mode ───────────────────────────────────────────
// Before tenancy is registered and before any model can reach the database:
// pointed at the LEGACY database, this process runs in legacy mode (whatever
// TENANT_MODE says), creates and indexes nothing, seeds nothing and schedules
// nothing. See core/tenancy/dataSource.ts.
{
  const policy = applyDataSourcePolicy();
  if (policy.legacy) {
    console.warn(
      `[data-source] "${policy.database}" is listed in LEGACY_DB_NAMES: legacy mode, legacy accounts only, organization accounts refused.`,
    );
    for (const change of policy.changes) console.warn(`[data-source]   ${change}`);
  } else {
    console.log(
      `[data-source] "${policy.database ?? '(no database in MONGO_URI)'}" is not in LEGACY_DB_NAMES: ` +
        `TENANT_MODE=${process.env.TENANT_MODE || '(unset)'} applies as configured.`,
    );
  }
}
registerTenancy();

import http from 'http';
import cluster from 'cluster';
import SocketService from './services/SocketService';
import { closeRedis } from './config/redis';
import { shouldRunScheduledJobs } from './core/tenancy';

// Import application after credentials are configured
const app = require('./app').default || require('./app');
const { connectDB } = require('./config/db');

// Every model is now loaded. Prove the plugin reached all of them.
verifyTenantPluginApplied();

const PORT = parseInt(process.env.PORT || '5000', 10);
const WORKER_ID = process.env.WORKER_ID || process.pid;

function shouldRunCronJobs(): boolean {
  if (process.env.ENABLE_CRON === 'false') return false;
  // The api-legacy deployment must not schedule jobs: both deployments share
  // one database, so duplicate cron would give Abhigyan two attendance syncs
  // and two EOD reminders a day. Only an explicit TENANT_MODE=pinned disables
  // this — a defaulted value must not change today's production behaviour.
  if (!shouldRunScheduledJobs()) return false;
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

/**
 * The mobile app build worker, on the same terms — and its OWN switch.
 *
 * ── Why not reuse the flag above ────────────────────────────────────────────
 * It was written for the AI pipeline and is named for it. Hanging mobile
 * builds off it means that turning the PPT worker off — a reasonable thing to
 * do while debugging generation — silently stops every "Build App" click in
 * the console, with no message anywhere and a build that sits on "Waiting for
 * a build worker" until somebody thinks to look at the queue. Two unrelated
 * capabilities should not share one switch.
 *
 * Same one-instance gating as cron: under cluster mode only fork 1 runs it, so
 * one click does not become four uploads to EAS.
 */
function shouldRunEmbeddedAppBuildWorker(): boolean {
  if (process.env.APP_BUILD_WORKER_EMBEDDED === 'false') return false;
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

  if (shouldRunEmbeddedAppBuildWorker()) {
    // Wrapped, because the failure mode this replaces was silence. A worker
    // that throws on startup and is not caught leaves the server running, the
    // queue filling, and every build in the console reading "Waiting for a
    // build worker" with nothing in the log to say why.
    try {
      const { startAppBuildWorker } = require('./workers/appBuildWorkerCore');
      startAppBuildWorker();
      console.log(
        `✅ [Worker ${WORKER_ID}] Embedded mobile app build worker started (set APP_BUILD_WORKER_EMBEDDED=false to run it separately)`,
      );

      // A BuildJob can outlive its queue entry — Redis flushed, a job dropped,
      // or a server that accepted the build and was restarted before the
      // worker ever existed. Those sit in `queued` for ever. This puts them
      // back on the queue, and is safe to run on every boot: the queue id is
      // derived from the BuildJob id, so re-enqueueing one that is already
      // there is a no-op rather than a second build.
      const { reconcileOrphanedBuilds } = require('./core/platform/appBuilds');
      reconcileOrphanedBuilds()
        .then((result: { requeued: number; alreadyQueued: number }) => {
          if (result.requeued > 0) {
            console.log(
              `♻️ [Worker ${WORKER_ID}] Re-queued ${result.requeued} build(s) that had no queue entry`,
            );
          }
        })
        .catch((err: unknown) => {
          console.error(
            `⚠️ [Worker ${WORKER_ID}] Could not reconcile orphaned builds:`,
            (err as Error)?.message,
          );
        });
    } catch (err) {
      console.error(
        `❌ [Worker ${WORKER_ID}] The mobile app build worker FAILED to start — every build will sit in the queue:`,
        (err as Error)?.message,
      );
    }
  } else {
    console.log(
      `ℹ️ [Worker ${WORKER_ID}] Mobile app build worker is DISABLED here (APP_BUILD_WORKER_EMBEDDED=false) — run \`npm run start:worker:app-build\``,
    );
  }

  // An organization deletion that was running when the previous process
  // stopped carries on from its last saved step. Each one is claimed
  // atomically, so several workers booting together run it once.
  import('./core/platform/orgDeletion')
    .then(({ resumeStalledDeletions }) => resumeStalledDeletions())
    .then((n: number) => {
      if (n > 0) console.log(`♻️ [Worker ${WORKER_ID}] Resumed ${n} organization deletion(s)`);
    })
    .catch((err: unknown) => {
      console.error(`⚠️ [Worker ${WORKER_ID}] Could not resume organization deletions:`, (err as Error)?.message);
    });
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
    const { stopAppBuildWorker } = require('./workers/appBuildWorkerCore');
    await stopAppBuildWorker();
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

/**
 * A background promise failing must not drop live requests.
 *
 * Since Node 15 an unhandled rejection TERMINATES the process. Third-party
 * clients float promises we never see: `rate-limit-redis` fires its
 * `SCRIPT LOAD` at startup without awaiting it, so one unreachable Redis
 * rejected 5 seconds after boot ("Command timed out") and killed a server that
 * was otherwise healthy and serving.
 *
 * Rate limiting already degrades open (`passOnStoreError: true`) and the cache
 * helpers already swallow their own failures — the API is designed to run
 * without Redis. Only the missing handler made it fatal.
 *
 * Logged loudly, never silently: this must stay visible, because a rejection
 * from OUR code is still a bug worth fixing.
 */
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(
    `⚠️ [Worker ${WORKER_ID}] Unhandled promise rejection — the server keeps running:`,
    error.message,
  );
  console.error(error.stack);
});

/**
 * An uncaught EXCEPTION is different: the process state may be corrupt, so it
 * exits and lets the cluster restart it. Logged first so the reason is not lost
 * to a silent respawn.
 */
process.on('uncaughtException', (error) => {
  console.error(`💥 [Worker ${WORKER_ID}] Uncaught exception — exiting:`, error?.message);
  console.error(error?.stack);
  process.exit(1);
});

