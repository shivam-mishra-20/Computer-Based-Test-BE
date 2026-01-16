/**
 * Firebase Sync Service
 * Handles syncing data between Firebase and MongoDB
 */

import User from '../models/User';
import Batch from '../models/Batch';
import { initFirebaseAdmin } from './firebaseService';

let admin: any = null;

function getAdmin() {
  if (!admin) {
    try {
      admin = require('firebase-admin');
      initFirebaseAdmin();
    } catch (e) {
      console.error('firebase-admin not available');
    }
  }
  return admin;
}

export interface FirebaseUser {
  id: string;
  uid?: string;
  name?: string;
  email?: string;
  role?: string;
  classLevel?: string;
  Class?: string;
  batch?: string;
  phone?: string;
  firebaseUid?: string;
  source: 'firebase';
}

export interface SyncResult {
  success: boolean;
  synced: number;
  skipped: number;
  errors: string[];
  message: string;
}

/**
 * Fetch all users from Firebase Users collection
 */
export async function fetchFirebaseUsers(role?: string, classLevel?: string, batch?: string): Promise<FirebaseUser[]> {
  const firebase = getAdmin();
  if (!firebase) {
    console.warn('Firebase Admin SDK not available');
    return [];
  }

  try {
    const db = firebase.firestore();
    let query: any = db.collection('Users');

    // Apply filters
    if (role) {
      query = query.where('role', '==', role);
    }
    if (classLevel) {
      query = query.where('Class', '==', classLevel);
    }
    if (batch) {
      query = query.where('batch', '==', batch);
    }

    const snapshot = await query.get();
    const users: FirebaseUser[] = [];

    snapshot.forEach((doc: any) => {
      const data = doc.data();
      const att = data.attendance || {};
      
      users.push({
        id: doc.id,
        uid: data.uid || doc.id,
        name: att.name || data.name || data.displayName || '',
        email: att.email || data.email || '',
        role: data.role || 'student',
        classLevel: att.Class || data.Class || data.classLevel || '',
        Class: att.Class || data.Class || data.classLevel || '',
        batch: att.batch || data.batch || '',
        phone: att.phone || data.phone || '',
        firebaseUid: doc.id,
        source: 'firebase'
      });
    });

    return users;
  } catch (error) {
    console.error('Error fetching Firebase users:', error);
    return [];
  }
}

/**
 * Fetch unique batches from Firebase
 */
export async function fetchFirebaseBatches(): Promise<string[]> {
  const firebase = getAdmin();
  if (!firebase) {
    return [];
  }

  try {
    const db = firebase.firestore();
    const snapshot = await db.collection('Users').get();
    
    const batchSet = new Set<string>();
    snapshot.forEach((doc: any) => {
      const data = doc.data();
      const batch = data.batch || data.attendance?.batch;
      if (batch && typeof batch === 'string' && batch.trim()) {
        batchSet.add(batch.trim());
      }
    });

    return Array.from(batchSet);
  } catch (error) {
    console.error('Error fetching Firebase batches:', error);
    return [];
  }
}

/**
 * Fetch unique class levels from Firebase
 */
export async function fetchFirebaseClasses(): Promise<string[]> {
  const firebase = getAdmin();
  if (!firebase) {
    return [];
  }

  try {
    const db = firebase.firestore();
    const snapshot = await db.collection('Users').get();
    
    const classSet = new Set<string>();
    snapshot.forEach((doc: any) => {
      const data = doc.data();
      const classLevel = data.Class || data.classLevel || data.attendance?.Class;
      if (classLevel && typeof classLevel === 'string' && classLevel.trim()) {
        classSet.add(classLevel.trim());
      }
    });

    return Array.from(classSet).sort();
  } catch (error) {
    console.error('Error fetching Firebase classes:', error);
    return [];
  }
}

/**
 * Sync Firebase students to MongoDB
 * Creates new users or updates existing ones based on firebaseUid
 */
export async function syncFirebaseStudentsToMongoDB(options?: {
  classLevel?: string;
  batch?: string;
  dryRun?: boolean;
}): Promise<SyncResult> {
  const result: SyncResult = {
    success: false,
    synced: 0,
    skipped: 0,
    errors: [],
    message: ''
  };

  try {
    // Fetch students from Firebase
    const firebaseStudents = await fetchFirebaseUsers('student', options?.classLevel, options?.batch);
    
    if (firebaseStudents.length === 0) {
      result.message = 'No students found in Firebase';
      result.success = true;
      return result;
    }

    console.log(`Found ${firebaseStudents.length} students in Firebase`);

    for (const fbStudent of firebaseStudents) {
      try {
        // Skip if no email or firebase UID
        if (!fbStudent.email || !fbStudent.firebaseUid) {
          result.skipped++;
          continue;
        }

        if (options?.dryRun) {
          console.log(`[DRY RUN] Would sync: ${fbStudent.name} (${fbStudent.email})`);
          result.synced++;
          continue;
        }

        // Check if user already exists by firebaseUid or email
        let existingUser = await User.findOne({ 
          $or: [
            { firebaseUid: fbStudent.firebaseUid },
            { email: fbStudent.email.toLowerCase() }
          ]
        });

        if (existingUser) {
          // Update existing user
          existingUser.name = fbStudent.name || existingUser.name;
          existingUser.classLevel = fbStudent.classLevel || existingUser.classLevel;
          existingUser.batch = fbStudent.batch || existingUser.batch;
          existingUser.phone = fbStudent.phone || existingUser.phone;
          existingUser.firebaseUid = fbStudent.firebaseUid;
          existingUser.authProvider = 'firebase';
          
          await existingUser.save();
          console.log(`Updated existing user: ${fbStudent.name}`);
          result.synced++;
        } else {
          // Create new user
          const newUser = new User({
            name: fbStudent.name || 'Unknown',
            email: fbStudent.email.toLowerCase(),
            password: `firebase_${Date.now()}_${Math.random().toString(36).slice(2)}`, // Random password
            role: 'student',
            classLevel: fbStudent.classLevel || '',
            batch: fbStudent.batch || '',
            phone: fbStudent.phone || '',
            firebaseUid: fbStudent.firebaseUid,
            authProvider: 'firebase',
            status: 'approved' // Auto-approve Firebase synced users
          });

          await newUser.save();
          console.log(`Created new user: ${fbStudent.name}`);
          result.synced++;
        }
      } catch (error: any) {
        const errMsg = `Failed to sync ${fbStudent.name}: ${error.message}`;
        console.error(errMsg);
        result.errors.push(errMsg);
      }
    }

    result.success = result.errors.length === 0;
    result.message = `Synced ${result.synced} students, skipped ${result.skipped}, errors: ${result.errors.length}`;
    
    return result;
  } catch (error: any) {
    result.errors.push(error.message);
    result.message = `Sync failed: ${error.message}`;
    return result;
  }
}

/**
 * Sync Firebase teachers to MongoDB
 */
export async function syncFirebaseTeachersToMongoDB(options?: {
  dryRun?: boolean;
}): Promise<SyncResult> {
  const result: SyncResult = {
    success: false,
    synced: 0,
    skipped: 0,
    errors: [],
    message: ''
  };

  try {
    const firebaseTeachers = await fetchFirebaseUsers('teacher');
    
    if (firebaseTeachers.length === 0) {
      result.message = 'No teachers found in Firebase';
      result.success = true;
      return result;
    }

    console.log(`Found ${firebaseTeachers.length} teachers in Firebase`);

    for (const fbTeacher of firebaseTeachers) {
      try {
        if (!fbTeacher.email || !fbTeacher.firebaseUid) {
          result.skipped++;
          continue;
        }

        if (options?.dryRun) {
          console.log(`[DRY RUN] Would sync teacher: ${fbTeacher.name} (${fbTeacher.email})`);
          result.synced++;
          continue;
        }

        let existingUser = await User.findOne({ 
          $or: [
            { firebaseUid: fbTeacher.firebaseUid },
            { email: fbTeacher.email.toLowerCase() }
          ]
        });

        if (existingUser) {
          existingUser.name = fbTeacher.name || existingUser.name;
          existingUser.firebaseUid = fbTeacher.firebaseUid;
          existingUser.authProvider = 'firebase';
          existingUser.role = 'teacher';
          
          await existingUser.save();
          result.synced++;
        } else {
          const newUser = new User({
            name: fbTeacher.name || 'Unknown Teacher',
            email: fbTeacher.email.toLowerCase(),
            password: `firebase_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            role: 'teacher',
            firebaseUid: fbTeacher.firebaseUid,
            authProvider: 'firebase',
            status: 'approved'
          });

          await newUser.save();
          result.synced++;
        }
      } catch (error: any) {
        const errMsg = `Failed to sync teacher ${fbTeacher.name}: ${error.message}`;
        console.error(errMsg);
        result.errors.push(errMsg);
      }
    }

    result.success = result.errors.length === 0;
    result.message = `Synced ${result.synced} teachers, skipped ${result.skipped}, errors: ${result.errors.length}`;
    
    return result;
  } catch (error: any) {
    result.errors.push(error.message);
    result.message = `Sync failed: ${error.message}`;
    return result;
  }
}

/**
 * Sync Firebase batches to MongoDB Batch collection
 */
export async function syncFirebaseBatchesToMongoDB(): Promise<SyncResult> {
  const result: SyncResult = {
    success: false,
    synced: 0,
    skipped: 0,
    errors: [],
    message: ''
  };

  try {
    const firebaseBatches = await fetchFirebaseBatches();
    
    if (firebaseBatches.length === 0) {
      result.message = 'No batches found in Firebase';
      result.success = true;
      return result;
    }

    console.log(`Found ${firebaseBatches.length} unique batches in Firebase`);

    for (const batchName of firebaseBatches) {
      try {
        // Check if batch already exists
        const existing = await Batch.findOne({ name: batchName });
        
        if (existing) {
          result.skipped++;
        } else {
          // Create new batch with all class levels by default
          await Batch.create({
            name: batchName,
            classLevels: ['7', '8', '9', '10', '11', '12'],
            isDefault: false,
            description: `Synced from Firebase on ${new Date().toISOString()}`
          });
          
          console.log(`Created batch: ${batchName}`);
          result.synced++;
        }
      } catch (error: any) {
        const errMsg = `Failed to sync batch ${batchName}: ${error.message}`;
        console.error(errMsg);
        result.errors.push(errMsg);
      }
    }

    result.success = result.errors.length === 0;
    result.message = `Synced ${result.synced} batches, skipped ${result.skipped}, errors: ${result.errors.length}`;
    
    return result;
  } catch (error: any) {
    result.errors.push(error.message);
    result.message = `Sync failed: ${error.message}`;
    return result;
  }
}

/**
 * Sync all Firebase data to MongoDB (students, teachers, batches)
 */
export async function syncAllFirebaseData(options?: {
  classLevel?: string;
  batch?: string;
  dryRun?: boolean;
}): Promise<{
  students: SyncResult;
  teachers: SyncResult;
  batches: SyncResult;
}> {
  console.log('Starting full Firebase to MongoDB sync...');
  
  const results = {
    batches: await syncFirebaseBatchesToMongoDB(),
    teachers: await syncFirebaseTeachersToMongoDB(options),
    students: await syncFirebaseStudentsToMongoDB(options)
  };

  console.log('Sync complete:', {
    batches: results.batches.message,
    teachers: results.teachers.message,
    students: results.students.message
  });

  return results;
}

/**
 * Get sync statistics (compare Firebase vs MongoDB counts)
 */
export async function getSyncStats(): Promise<{
  firebase: {
    students: number;
    teachers: number;
    batches: number;
    classes: number;
  };
  mongodb: {
    students: number;
    teachers: number;
    batches: number;
  };
  synced: {
    students: number;
    teachers: number;
  };
}> {
  const firebaseStudents = await fetchFirebaseUsers('student');
  const firebaseTeachers = await fetchFirebaseUsers('teacher');
  const firebaseBatches = await fetchFirebaseBatches();
  const firebaseClasses = await fetchFirebaseClasses();

  const mongoStudents = await User.countDocuments({ role: 'student' });
  const mongoTeachers = await User.countDocuments({ role: 'teacher' });
  const mongoBatches = await Batch.countDocuments();

  const syncedStudents = await User.countDocuments({ role: 'student', authProvider: 'firebase' });
  const syncedTeachers = await User.countDocuments({ role: 'teacher', authProvider: 'firebase' });

  return {
    firebase: {
      students: firebaseStudents.length,
      teachers: firebaseTeachers.length,
      batches: firebaseBatches.length,
      classes: firebaseClasses.length
    },
    mongodb: {
      students: mongoStudents,
      teachers: mongoTeachers,
      batches: mongoBatches
    },
    synced: {
      students: syncedStudents,
      teachers: syncedTeachers
    }
  };
}
