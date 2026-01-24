import admin from 'firebase-admin';
import path from 'path';

// Initialize Firebase Admin SDK
const serviceAccount = require(path.join(process.cwd(), 'firebase-admin.json'));

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
