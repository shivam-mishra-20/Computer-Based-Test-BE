import mongoose from 'mongoose';
import { connectDB } from '../config/db';

async function dropLegacyIndex() {
  try {
    console.log('Connecting to database...');
    await connectDB();

    console.log('Dropping legacy index examId_1_userId_1...');
    const collection = mongoose.connection.collection('attempts');
    
    // Check if index exists first
    const indexes = await collection.indexes();
    const indexExists = indexes.some(idx => idx.name === 'examId_1_userId_1');

    if (indexExists) {
      await collection.dropIndex('examId_1_userId_1');
      console.log('✅ Successfully dropped index examId_1_userId_1');
    } else {
      console.log('ℹ️ Index examId_1_userId_1 does not exist, skipping.');
    }

    console.log('Verifying remaining indexes...');
    const remainingIndexes = await collection.indexes();
    console.log('Current indexes:', remainingIndexes.map(i => i.name));

  } catch (error) {
    console.error('❌ Error executing migration:', error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

dropLegacyIndex();
