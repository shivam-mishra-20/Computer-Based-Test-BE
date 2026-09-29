/**
 * OPTIONAL standalone process entrypoint for the mobile app build worker.
 *
 * By default the worker runs EMBEDDED inside the API server (see server.ts) —
 * `npm start` alone is a complete deployment, and an administrator pressing
 * "Build App" in the console needs nobody to have started anything else. That
 * default matters more here than for the AI pipeline, because the failure mode
 * of forgetting is invisible: the build is accepted, the queue grows, and the
 * console reads "Waiting for a build worker" for ever.
 *
 * Run this separate process only when you want builds isolated from HTTP
 * serving — a build prepares a workspace, copies a project and shells out to
 * the EAS CLI, all of which are happier away from a request path:
 *
 *   1. set APP_BUILD_WORKER_EMBEDDED=false on the API server
 *   2. run: npm run start:worker:app-build   (or dev:worker:app-build)
 *
 * All actual behaviour lives in appBuildWorkerCore.ts, shared with the
 * embedded mode. This file starts it and nothing else.
 */
// Registered before ANY other import, because every one of them pulls in
// models and mongoose.plugin() only applies to schemas compiled after the
// call. This is a second entrypoint, so it needs its own registration — the
// one in server.ts never runs in this process.
import { registerTenancy, verifyTenantPluginApplied } from '../core/tenancy';
registerTenancy();

import { connectDB } from '../config/db';
import { closeRedis } from '../config/redis';
import { startAppBuildWorker, stopAppBuildWorker } from './appBuildWorkerCore';
import { reconcileOrphanedBuilds } from '../core/platform/appBuilds';

async function main() {
  verifyTenantPluginApplied();

  await connectDB();
  console.log('✅ [appBuildWorker] MongoDB connected');

  startAppBuildWorker();

  // Same reasoning as the embedded path: a BuildJob can outlive its queue
  // entry, and nothing else will ever notice.
  const { requeued } = await reconcileOrphanedBuilds().catch((err) => {
    console.error('⚠️ [appBuildWorker] Could not reconcile orphaned builds:', err?.message);
    return { requeued: 0, alreadyQueued: 0 };
  });
  if (requeued > 0) console.log(`♻️ [appBuildWorker] Re-queued ${requeued} build(s) that had no queue entry`);

  const shutdown = async (signal: string) => {
    console.log(`\n🛑 [appBuildWorker] ${signal} received. Shutting down gracefully...`);
    await stopAppBuildWorker();
    await closeRedis();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mongoose = require('mongoose');
    await mongoose.connection.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[appBuildWorker] Fatal startup error:', err);
  process.exit(1);
});
