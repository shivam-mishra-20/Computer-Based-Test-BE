import admin from 'firebase-admin';
import path from 'path';
import { existsSync, writeFileSync } from 'fs';

// Load Firebase credentials from file or base64 env var
function loadFirebaseCredentials() {
  const localPath = path.join(process.cwd(), 'firebase-admin.json');
  const base64Creds = process.env.FIREBASE_ADMIN_CREDENTIALS_BASE64;

  if (existsSync(localPath)) {
    console.log('Using local Firebase credentials: firebase-admin.json');
    return require(localPath);
  }

  if (base64Creds) {
    try {
      const outPath = '/tmp/firebase-admin.json';
      const decoded = Buffer.from(base64Creds, 'base64').toString('utf8');
      writeFileSync(outPath, decoded, { encoding: 'utf8' });
      console.log('Using Railway Firebase credentials: /tmp/firebase-admin.json');
      return require(outPath);
    } catch (err) {
      console.error('Failed to decode Firebase credentials:', err);
      throw err;
    }
  }

  throw new Error('Firebase credentials not found. Provide firebase-admin.json or FIREBASE_ADMIN_CREDENTIALS_BASE64');
}

const serviceAccount = loadFirebaseCredentials();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'abhigyan-gurukul.appspot.com'
  });
}

const storage = admin.storage();
const bucket = storage.bucket();

export { admin, storage, bucket };
export default admin;

