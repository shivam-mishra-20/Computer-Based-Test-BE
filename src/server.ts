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
      const decoded = Buffer.from(renderBase64, 'base64').toString('utf8');
      writeFileSync(outPath, decoded, { encoding: 'utf8' });
      process.env.GOOGLE_APPLICATION_CREDENTIALS = outPath;
      console.log('Using Render Google credentials: /tmp/vision-key.json');
      return;
    } catch (err) {
      console.error('Failed to write Render Google credentials:', err);
      process.exit(1);
    }
  }

  console.error('Google credentials not found. Provide ./vision-key.json or GOOGLE_APPLICATION_CREDENTIALS_BASE64');
  process.exit(1);
})();

import http from 'http';
import SocketService from './services/SocketService';

// Import application after credentials are configured
const app = require('./app').default || require('./app');
const { connectDB } = require('./config/db');

const PORT = parseInt(process.env.PORT || '5000', 10);

const httpServer = http.createServer(app);

// Initialize Socket.IO
SocketService.init(httpServer);

const server = httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

connectDB().then(() => {
  // Initialize attendance auto-sync cron after DB is ready
  const { AttendanceCron } = require('./services/AttendanceCron');
  AttendanceCron.init();
}).catch((err: any) => {
  console.error('Database connection failed at startup:', err);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

