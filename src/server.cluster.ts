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

if (cluster.isPrimary) {
  const numCPUs = os.cpus().length;
  const numWorkers = parseInt(process.env.WORKER_PROCESSES || String(numCPUs), 10);

  console.log(`🚀 Master process ${process.pid} is running`);
  console.log(`📊 CPU Cores: ${numCPUs}, Starting ${numWorkers} workers`);

  // Fork workers
  for (let i = 0; i < numWorkers; i++) {
    const worker = cluster.fork();
    console.log(`✅ Worker ${worker.process.pid} started`);
  }

  // Handle worker exit and restart
  cluster.on('exit', (worker, code, signal) => {
    console.warn(`❌ Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    const newWorker = cluster.fork();
    console.log(`✅ Worker ${newWorker.process.pid} restarted`);
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
