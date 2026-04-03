import { existsSync, writeFileSync, readFileSync } from 'fs';

// Google credentials loader — run before importing app or any Google clients
(function loadGoogleCredentials() {
  const localPath = './vision-key.json';
  const renderBase64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;

  if (existsSync(localPath)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = localPath;
    console.log('Using local Google credentials: ./vision-key.json');
    return;
  }

  if (renderBase64) {
    try {
      const outPath = '/tmp/vision-key.json';
      let decoded = Buffer.from(renderBase64, 'base64').toString('utf8');
      
      // Normalize line endings: CRLF (\r\n) -> LF (\n)
      // This prevents OpenSSL "DECODER routines::unsupported" errors
      decoded = decoded.replace(/\r\n/g, '\n');
      
      // Validate JSON structure before writing
      try {
        const parsed = JSON.parse(decoded);
        if (!parsed.private_key || !parsed.project_id) {
          throw new Error('Invalid Google credentials: missing required fields');
        }
        console.log(`Google credentials validated: project=${parsed.project_id}`);
      } catch (parseErr) {
        console.error('Failed to parse Google credentials JSON:', parseErr);
        throw parseErr;
      }
      
      writeFileSync(outPath, decoded, { encoding: 'utf8' });
      process.env.GOOGLE_APPLICATION_CREDENTIALS = outPath;
      console.log('Using Render/Railway Google credentials: /tmp/vision-key.json');
      return;
    } catch (err) {
      console.error('Failed to load production Google credentials:', err);
      console.error('Make sure GOOGLE_APPLICATION_CREDENTIALS_BASE64 is properly base64-encoded');
      process.exit(1);
    }
  }

  console.error('Google credentials not found. Provide ./vision-key.json or GOOGLE_APPLICATION_CREDENTIALS_BASE64');
  process.exit(1);
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

