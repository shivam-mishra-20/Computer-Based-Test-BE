import mongoose from 'mongoose';
import FileMetadata from '../src/models/FileMetadata';
import Doubt from '../src/models/Doubt';
import { config } from 'dotenv';

config();

const FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'your-project.appspot.com';

/**
 * Migration script to convert all signed URLs to permanent public URLs
 * Run once to fix existing data
 */
async function migrateUrlsToPublic() {
  try {
    console.log('🔄 Starting URL migration to public URLs...');
    
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/abhigyan-gurukul';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // 1. Migrate FileMetadata collection
    console.log('\n📁 Migrating FileMetadata URLs...');
    const fileMetadatas = await FileMetadata.find({});
    let fileCount = 0;
    
    for (const file of fileMetadatas) {
      // Convert to public URL if it's a signed URL or invalid
      if (!file.url || file.url.includes('X-Goog-Signature') || !file.url.startsWith('https://storage.googleapis.com')) {
        const publicUrl = `https://storage.googleapis.com/${FIREBASE_STORAGE_BUCKET}/${file.storagePath}`;
        await FileMetadata.updateOne(
          { _id: file._id },
          { $set: { url: publicUrl } }
        );
        fileCount++;
      }
    }
    console.log(`✅ Updated ${fileCount} FileMetadata URLs`);

    // 2. Migrate Doubt attachment URLs
    console.log('\n💬 Migrating Doubt attachment URLs...');
    const doubts = await Doubt.find({});
    let doubtCount = 0;
    let attachmentCount = 0;

    for (const doubt of doubts) {
      let modified = false;
      
      if (doubt.messages && doubt.messages.length > 0) {
        for (const message of doubt.messages) {
          if (message.attachments && message.attachments.length > 0) {
            for (const attachment of message.attachments) {
              // Convert to public URL if it's a signed URL or invalid
              if (!attachment.url || attachment.url.includes('X-Goog-Signature') || !attachment.url.startsWith('https://storage.googleapis.com')) {
                attachment.url = `https://storage.googleapis.com/${FIREBASE_STORAGE_BUCKET}/${attachment.storagePath}`;
                attachmentCount++;
                modified = true;
              }
            }
          }
        }
      }

      if (modified) {
        await doubt.save();
        doubtCount++;
      }
    }
    console.log(`✅ Updated ${attachmentCount} attachments in ${doubtCount} doubts`);

    // 3. Make all files public in Firebase Storage (optional - requires Firebase Admin SDK)
    console.log('\n🔐 Firebase Storage files should be made public for best results.');
    console.log('You can run the following command to make all files public:');
    console.log('gsutil -m acl ch -r -u AllUsers:R gs://your-bucket-name/doubts');

    console.log('\n✅ Migration completed successfully!');
    console.log(`\nSummary:`);
    console.log(`  - FileMetadata URLs updated: ${fileCount}`);
    console.log(`  - Doubt attachments updated: ${attachmentCount} in ${doubtCount} doubts`);

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Disconnected from MongoDB');
  }
}

// Run migration
migrateUrlsToPublic()
  .then(() => {
    console.log('\n🎉 Migration script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Migration script failed:', error);
    process.exit(1);
  });
