// ── Configuration first ─────────────────────────────────────────────────────
// `.env` is loaded before anything below reads the environment: the JWT check,
// and above all the realm policy, which snapshots the configuration the
// platform runtime is started from (configuredEnv). Loaded later (by app.ts),
// a PLATFORM_MONGODB_URI kept in .env was never seen — /platform-api/*
// answered PLATFORM_NOT_CONFIGURED — and TENANT_MODE=claim reached /api/*
// after the policy had set it aside. Variables the process was started with
// still take precedence over .env, as before.
import 'dotenv/config';

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
import { applyDataSourcePolicy, configuredEnv, type DataSourcePolicy } from './core/tenancy/dataSource';
import { serviceRealm } from './core/realm/realm';
import { adminBootstrap } from './config/adminBootstrap';
import {
  RUNTIME_LISTENING,
  RUNTIME_SHUTDOWN,
  startPlatformRuntime,
  stopPlatformRuntime,
} from './core/realm/platformRuntime';

// ── The realm decides the rules ─────────────────────────────────────────────
// This process is the existing system (/api/*, its own database, no
// organization required) unless it was started as the platform runtime
// (SERVICE_REALM=platform — set by the backend itself when it forks one; see
// core/realm/realm.ts). Before tenancy is registered and before any model can
// reach the database, the realm's rules are applied: core/tenancy/dataSource.ts.
{
  let policy: DataSourcePolicy;
  try {
    policy = applyDataSourcePolicy();
  } catch (error) {
    console.error(`❌ [realm] ${(error as Error).message}`);
    console.error('❌ [realm] Refusing to start with this configuration.');
    process.exit(1);
  }
  console.log(
    `[realm] ${policy.realm === 'platform' ? 'platform runtime — serves /platform-api/*' : 'existing system — serves /api/*'}` +
      ` on database "${policy.database ?? '(none named in the URI)'}"`,
  );
  for (const change of policy.changes) console.log(`[realm]   ${change}`);
}

// ── The bootstrap administrator: the operator's credentials, or nothing ─────
// Only the platform runtime creates one (config/db.ts). In production it must
// come from ADMIN_EMAIL and ADMIN_PASSWORD — there is no default — so starting
// without them is refused here, before anything connects. /api/* never creates
// one and is not affected. See config/adminBootstrap.ts.
if (serviceRealm() === 'platform') {
  const bootstrap = adminBootstrap();
  if (bootstrap.action === 'refuse') {
    console.error(
      `❌ [bootstrap-admin] ${bootstrap.reason}. In production the platform's bootstrap ` +
        'administrator comes only from ADMIN_EMAIL and ADMIN_PASSWORD — there is no default. ' +
        'Set both; the platform runtime will not start without them.',
    );
    process.exit(1);
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

/**
 * The platform runtime is forked once per serving process. Only the one forked
 * by the singleton instance may run singleton work, and this process tells it
 * which it is (REALM_INSTANCE_PRIMARY) — inside the runtime `cluster.isWorker`
 * is false, which would otherwise make every one of them "the" instance.
 */
function isRealmSingleton(): boolean {
  return process.env.REALM_INSTANCE_PRIMARY !== 'false';
}

function shouldRunCronJobs(): boolean {
  if (process.env.ENABLE_CRON === 'false') return false;
  // The api-legacy deployment must not schedule jobs: both deployments share
  // one database, so duplicate cron would give Abhigyan two attendance syncs
  // and two EOD reminders a day. Only an explicit TENANT_MODE=pinned disables
  // this — a defaulted value must not change today's production behaviour.
  if (!shouldRunScheduledJobs()) return false;
  if (!isRealmSingleton()) return false;
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
  if (!isRealmSingleton()) return false;
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
  // Mobile app builds belong to organizations: the platform realm only. The
  // existing system's database has no build jobs, and its process must not
  // take builds off a queue it does not own.
  if (serviceRealm() !== 'platform') return false;
  if (process.env.APP_BUILD_WORKER_EMBEDDED === 'false') return false;
  if (!isRealmSingleton()) return false;
  if (!cluster.isWorker) return true;
  return cluster.worker?.id === 1;
}

const httpServer = http.createServer(app);

// Initialize Socket.IO with Redis adapter
SocketService.init(httpServer);

// The platform runtime listens on loopback only; the gateway is its only door.
const LISTEN_HOST = process.env.REALM_LISTEN_HOST || '0.0.0.0';

const server = httpServer.listen(PORT, LISTEN_HOST, () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : PORT;
  console.log(`✅ [Worker ${WORKER_ID}] Server running on http://${LISTEN_HOST}:${port}`);

  if (serviceRealm() === 'platform') {
    // Tell the gateway where to send /platform-api/*.
    if (process.send) process.send({ type: RUNTIME_LISTENING, port });
    return;
  }

  // The existing system: start the organization platform beside it when it is
  // configured. A platform that cannot start never takes /api/* down with it.
  try {
    const started = startPlatformRuntime(configuredEnv(), {
      entry: __filename,
      primary: !cluster.isWorker || cluster.worker?.id === 1,
    });
    if (!started) {
      console.log(
        `ℹ️ [Worker ${WORKER_ID}] PLATFORM_MONGODB_URI is not set: /platform-api/* is not served by this server.`,
      );
    }
  } catch (error) {
    console.error(
      `❌ [Worker ${WORKER_ID}] The platform runtime was not started: ${(error as Error).message} ` +
        '/platform-api/* answers 503; /api/* is unaffected.',
    );
  }
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
  } else if (serviceRealm() !== 'platform') {
    console.log(
      `ℹ️ [Worker ${WORKER_ID}] Mobile app builds run in the platform runtime, not in the existing system.`,
    );
  } else {
    console.log(
      `ℹ️ [Worker ${WORKER_ID}] Mobile app build worker is DISABLED here (APP_BUILD_WORKER_EMBEDDED=false) — run \`npm run start:worker:app-build\``,
    );
  }

  // An organization deletion that was running when the previous process
  // stopped carries on from its last saved step. Each one is claimed
  // atomically, so several workers booting together run it once. Organizations
  // live on the platform database only.
  if (serviceRealm() === 'platform') {
    import('./core/platform/orgDeletion')
      .then(({ resumeStalledDeletions }) => resumeStalledDeletions())
      .then((n: number) => {
        if (n > 0) console.log(`♻️ [Worker ${WORKER_ID}] Resumed ${n} organization deletion(s)`);
      })
      .catch((err: unknown) => {
        console.error(`⚠️ [Worker ${WORKER_ID}] Could not resume organization deletions:`, (err as Error)?.message);
      });
  }
}).catch((err: any) => {
  console.error('Database connection failed at startup:', err);
});

// Graceful shutdown
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    console.log('✅ HTTP server closed');
  });

  // The platform runtime is this process's child: it goes down with it.
  if (serviceRealm() !== 'platform') {
    await stopPlatformRuntime().catch(() => undefined);
  }

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

// The platform runtime is stopped by the process that started it — asked over
// IPC (a signal cannot be handled on Windows) — and never outlives it.
if (serviceRealm() === 'platform' && process.send) {
  process.on('message', (message: unknown) => {
    if ((message as { type?: string } | null)?.type === RUNTIME_SHUTDOWN) void shutdown('PARENT_SHUTDOWN');
  });
  process.on('disconnect', () => void shutdown('PARENT_EXITED'));
}

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

