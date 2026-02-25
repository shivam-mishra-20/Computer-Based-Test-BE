/**
 * Database Indexes Configuration
 * Run this to ensure optimal query performance
 */

import mongoose from 'mongoose';
import User from '../models/User';
import Exam from '../models/Exam';
import Attempt from '../models/Attempt';
import Course from '../models/Course';
import Doubt from '../models/Doubt';
import Attendance from '../models/Attendance';
import Schedule from '../models/Schedule';
import Material from '../models/Material';

/**
 * Create all recommended indexes
 */
export async function createOptimalIndexes() {
  console.log('🔧 Creating optimal database indexes...');

  try {
    // User indexes
    await User.collection.createIndex({ email: 1 }, { unique: true });
    await User.collection.createIndex({ role: 1, status: 1 });
    await User.collection.createIndex({ classLevel: 1, batch: 1, role: 1 });
    await User.collection.createIndex({ firebaseUid: 1 }, { sparse: true });
    await User.collection.createIndex({ empCode: 1 }, { unique: true, sparse: true });
    console.log('✅ User indexes created');

    // Exam indexes
    await Exam.collection.createIndex({ dueDate: 1, status: 1 });
    await Exam.collection.createIndex({ classLevel: 1, subject: 1 });
    await Exam.collection.createIndex({ batch: 1, status: 1 });
    await Exam.collection.createIndex({ createdBy: 1, createdAt: -1 });
    await Exam.collection.createIndex({ 
      status: 1, 
      dueDate: 1,
      classLevel: 1 
    });
    console.log('✅ Exam indexes created');

    // Attempt indexes
    await Attempt.collection.createIndex({ studentId: 1, examId: 1 });
    await Attempt.collection.createIndex({ examId: 1, submittedAt: -1 });
    await Attempt.collection.createIndex({ studentId: 1, status: 1 });
    await Attempt.collection.createIndex({ 
      examId: 1, 
      studentId: 1, 
      status: 1 
    }, { unique: true });
    console.log('✅ Attempt indexes created');

    // Course indexes
    await Course.collection.createIndex({ status: 1, classLevel: 1 });
    await Course.collection.createIndex({ subject: 1, status: 1 });
    await Course.collection.createIndex({ batch: 1, status: 1 });
    await Course.collection.createIndex({ instructor: 1, status: 1 });
    await Course.collection.createIndex({ 
      status: 1, 
      classLevel: 1, 
      subject: 1 
    });
    console.log('✅ Course indexes created');

    // Doubt indexes
    await Doubt.collection.createIndex({ student: 1, status: 1, createdAt: -1 });
    await Doubt.collection.createIndex({ teacher: 1, status: 1, createdAt: -1 });
    await Doubt.collection.createIndex({ status: 1, createdAt: -1 });
    await Doubt.collection.createIndex({ student: 1, teacher: 1 });
    console.log('✅ Doubt indexes created');

    // Attendance indexes
    await Attendance.collection.createIndex({ studentId: 1, date: -1 });
    await Attendance.collection.createIndex({ date: -1, classLevel: 1, batch: 1 });
    await Attendance.collection.createIndex({ classLevel: 1, batch: 1, status: 1 });
    await Attendance.collection.createIndex({ 
      studentId: 1, 
      date: 1 
    }, { unique: true });
    console.log('✅ Attendance indexes created');

    // Schedule indexes
    await Schedule.collection.createIndex({ 
      dayOfWeek: 1, 
      startTimeSlot: 1 
    });
    await Schedule.collection.createIndex({ 
      date: 1, 
      scheduleType: 1 
    });
    await Schedule.collection.createIndex({ 
      classLevel: 1, 
      batch: 1,
      dayOfWeek: 1 
    });
    await Schedule.collection.createIndex({ 
      instructor: 1, 
      dayOfWeek: 1 
    });
    console.log('✅ Schedule indexes created');

    // Material indexes
    await Material.collection.createIndex({ 
      classLevel: 1, 
      subject: 1,
      createdAt: -1 
    });
    await Material.collection.createIndex({ 
      batch: 1, 
      createdAt: -1 
    });
    await Material.collection.createIndex({ 
      uploadedBy: 1, 
      createdAt: -1 
    });
    console.log('✅ Material indexes created');

    console.log('🎉 All indexes created successfully!');
    console.log('\nTip: Run this script after major database changes or in production after deployment.');
  } catch (error) {
    console.error('❌ Error creating indexes:', error);
    throw error;
  }
}

/**
 * Drop all indexes (use with caution!)
 */
export async function dropAllIndexes() {
  console.log('⚠️  Dropping all indexes...');
  
  const collections = await mongoose.connection.db.collections();
  
  for (const collection of collections) {
    try {
      await collection.dropIndexes();
      console.log(`✅ Dropped indexes for ${collection.collectionName}`);
    } catch (error: any) {
      if (error.codeName !== 'NamespaceNotFound') {
        console.error(`❌ Error dropping indexes for ${collection.collectionName}:`, error);
      }
    }
  }
}

/**
 * Analyze index usage
 */
export async function analyzeIndexUsage() {
  console.log('📊 Analyzing index usage...');
  
  try {
    const collections = await mongoose.connection.db.collections();
    
    for (const collection of collections) {
      const stats = await collection.aggregate([
        { $indexStats: {} }
      ]).toArray();
      
      console.log(`\n${collection.collectionName}:`);
      stats.forEach((stat: any) => {
        console.log(`  - ${stat.name}: ${stat.accesses.ops} operations`);
      });
    }
  } catch (error) {
    console.error('❌ Error analyzing indexes:', error);
  }
}

// CLI commands
if (require.main === module) {
  const command = process.argv[2];
  
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/cbt-exam')
    .then(async () => {
      switch (command) {
        case 'create':
          await createOptimalIndexes();
          break;
        case 'drop':
          await dropAllIndexes();
          break;
        case 'analyze':
          await analyzeIndexUsage();
          break;
        default:
          console.log('Usage: ts-node indexes.ts [create|drop|analyze]');
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error('Database connection error:', error);
      process.exit(1);
    });
}
