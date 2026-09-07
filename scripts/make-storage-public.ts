import admin from 'firebase-admin';
import { config } from 'dotenv';

config();

/**
 * ⚠️ QUARANTINED — P0 production safety, 2026-08-17
 *
 * This script bulk-applies `file.makePublic()` to Firebase Storage objects,
 * making them readable by anyone with the URL and no credentials.
 *
 * That is the exact condition the multi-tenant migration exists to remove: once
 * a second organization's files share this bucket, a public object is a
 * cross-tenant data leak, and re-running this script would silently undo the
 * P1 file-isolation work with no error and no audit trail.
 *
 * It is NOT deleted, because it documents how the current public URLs came to
 * exist and may be needed to reason about historical data during migration.
 * It is guarded instead: running it now requires a deliberate, explicit act.
 *
 * See docs/production-safety.md § Known hazards.
 */
function assertHazardAcknowledged(): void {
  if (process.env.I_UNDERSTAND_THIS_MAKES_FILES_PUBLIC !== 'yes') {
    console.error(
      [
        '',
        '  ⚠️  REFUSED — this script makes stored files world-readable.',
        '',
        '  Running it re-opens the cross-tenant file exposure that the platform',
        '  migration is closing. It is retained for historical reference only.',
        '',
        '  If you genuinely intend this, set:',
        '    I_UNDERSTAND_THIS_MAKES_FILES_PUBLIC=yes',
        '',
        '  See docs/production-safety.md § Known hazards.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

/**
 * Script to make all existing files in Firebase Storage public
 * This ensures that public URLs work without signed URLs
 */
async function makeStoragePublic() {
  assertHazardAcknowledged();
  try {
    console.log('🔄 Starting Firebase Storage public access setup...');

    // Initialize Firebase Admin
    if (!admin.apps.length) {
      const serviceAccount = require('../firebase-admin.json');
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || serviceAccount.project_id + '.appspot.com'
      });
    }

    const bucket = admin.storage().bucket();
    console.log(`✅ Connected to Firebase Storage bucket: ${bucket.name}`);

    // Get all files in the doubts directory
    console.log('\n📁 Making files public...');
    const [files] = await bucket.getFiles({ prefix: 'doubts/' });
    
    let successCount = 0;
    let errorCount = 0;

    for (const file of files) {
      try {
        await file.makePublic();
        successCount++;
        
        if (successCount % 100 === 0) {
          console.log(`  Processed ${successCount} files...`);
        }
      } catch (error) {
        errorCount++;
        console.error(`  ❌ Failed to make public: ${file.name}`, error);
      }
    }

    // Also make profile-images public
    console.log('\n🖼️ Making profile images public...');
    const [profileFiles] = await bucket.getFiles({ prefix: 'profile-images/' });
    
    for (const file of profileFiles) {
      try {
        await file.makePublic();
        successCount++;
        
        if (successCount % 100 === 0) {
          console.log(`  Processed ${successCount} files...`);
        }
      } catch (error) {
        errorCount++;
        console.error(`  ❌ Failed to make public: ${file.name}`, error);
      }
    }

    console.log('\n✅ Storage public access setup completed!');
    console.log(`\nSummary:`);
    console.log(`  - Successfully made public: ${successCount} files`);
    console.log(`  - Errors: ${errorCount} files`);
    console.log(`\nAll files are now accessible via public URLs:`);
    console.log(`https://storage.googleapis.com/${bucket.name}/{filepath}`);

  } catch (error) {
    console.error('❌ Script failed:', error);
    throw error;
  }
}

// Run script
makeStoragePublic()
  .then(() => {
    console.log('\n🎉 Script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Script failed:', error);
    process.exit(1);
  });
