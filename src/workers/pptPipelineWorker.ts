/**
 * OPTIONAL standalone process entrypoint for the AI PPT pipeline worker.
 *
 * By default the worker runs EMBEDDED inside the API server (see server.ts) —
 * `npm start` alone is a complete deployment and nothing sits in the queue
 * unprocessed. Run this separate process only when you want to isolate the
 * CPU-heavy pipeline (PDF rasterization) from HTTP serving:
 *
 *   1. set PPT_WORKER_EMBEDDED=false on the API server
 *   2. run: npm run start:worker:ppt   (or dev:worker:ppt)
 *
 * All actual behavior lives in pptWorkerCore.ts, shared with the embedded mode.
 */
// Registered before ANY other import, because every one of them pulls in
// models and mongoose.plugin() only applies to schemas compiled after the
// call. This is a second entrypoint, so it needs its own registration — the
// one in server.ts never runs in this process.
import { registerTenancy, verifyTenantPluginApplied } from '../core/tenancy';
registerTenancy();

import { connectDB } from '../config/db';
import { closeRedis } from '../config/redis';
import { startPptPipelineWorker, stopPptPipelineWorker } from './pptWorkerCore';

async function main() {
  verifyTenantPluginApplied();

  await connectDB();
  console.log('✅ [pptPipelineWorker] MongoDB connected');

  startPptPipelineWorker();

  const shutdown = async (signal: string) => {
    console.log(`\n🛑 [pptPipelineWorker] ${signal} received. Shutting down gracefully...`);
    await stopPptPipelineWorker();
    await closeRedis();
    const mongoose = require('mongoose');
    await mongoose.connection.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[pptPipelineWorker] Fatal startup error:', err);
  process.exit(1);
});
