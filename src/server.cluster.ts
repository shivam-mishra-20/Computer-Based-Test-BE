import cluster from 'cluster';
import os from 'os';

/**
 * Multi-threaded Node.js Cluster Setup
 * Utilizes all CPU cores for horizontal scaling on single server
 * 
 * Production Usage:
 * - Single server: Use this cluster mode
 * - Multiple servers: Use PM2 or Kubernetes for orchestration
 */

// A platform runtime forked from a worker runs this same bundle (its entry is
// this file). It is one server process, never another cluster.
const isPlatformRuntime = (process.env.SERVICE_REALM || '').trim().toLowerCase() === 'platform';

if (cluster.isPrimary && !isPlatformRuntime) {
  const numCPUs = os.cpus().length;
  const numWorkers = parseInt(process.env.WORKER_PROCESSES || String(numCPUs), 10);

  console.log(`🚀 Master process ${process.pid} is running`);
  console.log(`📊 CPU Cores: ${numCPUs}, Starting ${numWorkers} workers`);

  // Exactly one worker is the leader: it runs the attendance cron and the other
  // once-per-deployment work (see isClusterLeader in server.ts). The role goes
  // with the worker, so a restarted leader's replacement is the leader too —
  // worker ids are never reused, so "worker 1" cannot carry it.
  const leaders = new Set<number>();
  const forkWorker = (leader: boolean) => {
    const worker = cluster.fork({ CLUSTER_LEADER: leader ? 'true' : 'false' });
    if (leader) leaders.add(worker.id);
    return worker;
  };

  // Fork workers
  for (let i = 0; i < numWorkers; i++) {
    const worker = forkWorker(i === 0);
    console.log(`✅ Worker ${worker.process.pid} started${i === 0 ? ' (leader)' : ''}`);
  }

  // Handle worker exit and restart
  cluster.on('exit', (worker, code, signal) => {
    const wasLeader = leaders.delete(worker.id);
    console.warn(`❌ Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    const newWorker = forkWorker(wasLeader);
    console.log(`✅ Worker ${newWorker.process.pid} restarted${wasLeader ? ' (leader)' : ''}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received. Shutting down gracefully...');
    for (const id in cluster.workers) {
      cluster.workers[id]?.kill();
    }
    process.exit(0);
  });

} else {
  // Worker process - run the actual server
  require('./server');
  console.log(`🔧 Worker ${process.pid} started`);
}
