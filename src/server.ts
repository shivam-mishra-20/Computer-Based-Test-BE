import fs from 'fs';
import app from './app';
import { connectDB } from './config/db';

/**
 * ---------------------------------------------------------
 *  Render.com – Google Vision + Vertex AI Credential Setup
 * ---------------------------------------------------------
 * Render does NOT allow storing JSON key files inside repo.
 * So we reconstruct the service account file from BASE64 and
 * write it into /tmp (the only writable directory).
 */
(function configureGoogleCredentials() {
  const base64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;

  if (!base64) {
    console.warn('⚠️ GOOGLE_APPLICATION_CREDENTIALS_BASE64 not provided.');
    return;
  }

  try {
    const keyPath = '/tmp/vision-key.json';

    // Decode Base64 → UTF-8 JSON
    const decodedJSON = Buffer.from(base64, 'base64').toString('utf8');

    // Write JSON file into /tmp
    fs.writeFileSync(keyPath, decodedJSON, { encoding: 'utf8' });

    // Set environment variable for Google SDKs
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;

    console.log('✅ Google Vision + Vertex AI credentials configured at /tmp/vision-key.json');
  } catch (err) {
    console.error('❌ Failed to configure Google credentials:', err);
  }
})();

/**
 * -----------------------------------
 * Start Express Server
 * -----------------------------------
 */
const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

/**
 * -----------------------------------
 * Connect to MongoDB (non-blocking)
 * -----------------------------------
 */
connectDB().catch((err) => {
  console.error('❌ MongoDB connection failed at startup:', err);
});

/**
 * -----------------------------------
 * Graceful Shutdown
 * -----------------------------------
 */
process.on('SIGINT', () => {
  console.log('🛑 Shutting down server...');
  server.close(() => process.exit(0));
});
