import { initFirebaseAdmin } from './firebaseService';
import Attendance from '../models/Attendance';
import User from '../models/User';

let admin: any = null;

function getAdmin() {
  if (!admin) {
    try {
      admin = require('firebase-admin');
      initFirebaseAdmin();
    } catch {
      console.error('firebase-admin not available');
    }
  }
  return admin;
}

export interface AttendanceEntry {
  clockIn: string;
  clockOut: string;
  dayAndDate: string;
  source?: 'firebase' | 'mongodb';
  status?: 'present' | 'absent' | 'late' | 'excused';
}

export interface StudentLeaveDoc {
  name: string;
  Class: string;
  batch?: string;
  attendance: AttendanceEntry[];
}

const buildDocId = (name: string, cls: string) =>
  `${name.replace(/\s+/g, '').toLowerCase()}_${cls.replace(/\s+/g, '').toLowerCase()}`;

/**
 * Get student attendance from Firebase Firestore studentLeaves collection
 */
async function getFirebaseAttendance(name: string, classLevel: string): Promise<AttendanceEntry[]> {
  const firebase = getAdmin();
  if (!firebase) return [];
  
  try {
    const db = firebase.firestore();
    // First try querying by name and Class
    const snap = await db.collection('studentLeaves')
      .where('name', '==', name)
      .where('Class', '==', classLevel)
      .limit(1)
      .get();
    
    if (!snap.empty) {
      const data = snap.docs[0].data() as StudentLeaveDoc;
      const records = Array.isArray(data.attendance) ? data.attendance : [];
      return records.map(r => ({ ...r, source: 'firebase' as const }));
    }
    
    // Try by doc ID
    const docId = buildDocId(name, classLevel);
    const doc = await db.collection('studentLeaves').doc(docId).get();
    if (doc.exists) {
      const data = doc.data() as StudentLeaveDoc;
      const records = Array.isArray(data.attendance) ? data.attendance : [];
      return records.map(r => ({ ...r, source: 'firebase' as const }));
    }
    
    return [];
  } catch (error) {
    console.error('Error fetching Firebase attendance:', error);
    return [];
  }
}

/**
 * Get student attendance from MongoDB Attendance collection
 */
async function getMongoAttendance(userId: string): Promise<AttendanceEntry[]> {
  try {
    const records = await Attendance.find({ studentId: userId })
      .sort({ date: -1 })
      .lean();
    
    return records.map(r => ({
      clockIn: r.status === 'present' || r.status === 'late' ? '09:00 AM' : '--:--',
      clockOut: r.status === 'present' || r.status === 'late' ? '04:00 PM' : '--:--',
      dayAndDate: r.date.toISOString().split('T')[0],
      source: 'mongodb' as const,
      status: r.status,
    }));
  } catch (error) {
    console.error('Error fetching MongoDB attendance:', error);
    return [];
  }
}

/**
 * Get student attendance from both Firebase and MongoDB, combined
 */
export async function getStudentAttendance(name: string, classLevel: string, userId?: string): Promise<AttendanceEntry[]> {
  // Fetch from both sources in parallel
  const [firebaseRecords, mongoRecords] = await Promise.all([
    getFirebaseAttendance(name, classLevel),
    userId ? getMongoAttendance(userId) : Promise.resolve([]),
  ]);
  
  // Combine records, using date as key to avoid duplicates
  // Firebase records take priority if same date exists in both
  const byDate = new Map<string, AttendanceEntry>();
  
  // Add MongoDB records first
  for (const rec of mongoRecords) {
    byDate.set(rec.dayAndDate, rec);
  }
  
  // Firebase records override if same date (biometric is more accurate)
  for (const rec of firebaseRecords) {
    byDate.set(rec.dayAndDate, rec);
  }
  
  return Array.from(byDate.values());
}

/**
 * Get attendance summary for a student
 */
export async function getAttendanceSummary(name: string, classLevel: string, userId?: string) {
  const records = await getStudentAttendance(name, classLevel, userId);
  
  const presentDays = records.filter(r => r.clockIn !== '--:--' && r.clockOut !== '--:--').length;
  const totalDays = records.length;
  const percentage = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;
  
  return {
    presentDays,
    totalDays,
    percentage,
    absentDays: totalDays - presentDays,
  };
}

/**
 * Get all student attendance records for admin view
 */
export async function getAllStudentAttendance(filters?: { classLevel?: string; batch?: string }) {
  const firebase = getAdmin();
  if (!firebase) return [];
  
  try {
    const db = firebase.firestore();
    let query = db.collection('studentLeaves');
    
    if (filters?.classLevel) {
      query = query.where('Class', '==', filters.classLevel);
    }
    if (filters?.batch) {
      query = query.where('batch', '==', filters.batch);
    }
    
    const snap = await query.get();
    
    return snap.docs.map((doc: any) => {
      const data = doc.data() as StudentLeaveDoc;
      const attendance = data.attendance || [];
      const presentDays = attendance.filter((a: AttendanceEntry) => a.clockIn !== '--:--' && a.clockOut !== '--:--').length;
      const lastAttendanceDate = attendance
        .map((a: AttendanceEntry) => a.dayAndDate)
        .filter(Boolean)
        .sort()
        .reverse()[0] || null;
      
      return {
        id: doc.id,
        name: data.name,
        class: data.Class,
        batch: data.batch || 'Unknown',
        totalAttendanceDays: presentDays,
        totalRecords: attendance.length,
        lastAttendanceDate,
      };
    });
  } catch (error) {
    console.error('Error fetching all attendance:', error);
    return [];
  }
}

/**
 * Upload attendance records (admin)
 */
export async function uploadAttendanceRecords(records: Array<{
  name: string;
  class: string;
  clockIn: string;
  clockOut: string;
  dayAndDate: string;
}>) {
  const firebase = getAdmin();
  if (!firebase) throw new Error('Firebase not initialized');
  
  const db = firebase.firestore();
  
  // Group by student (name + class)
  const grouped = new Map<string, { name: string; Class: string; entries: Map<string, AttendanceEntry> }>();
  
  for (const rec of records) {
    const docId = buildDocId(rec.name, rec.class);
    if (!grouped.has(docId)) {
      grouped.set(docId, { name: rec.name, Class: rec.class, entries: new Map() });
    }
    const g = grouped.get(docId)!;
    if (!g.entries.has(rec.dayAndDate)) {
      g.entries.set(rec.dayAndDate, {
        clockIn: rec.clockIn || '--:--',
        clockOut: rec.clockOut || '--:--',
        dayAndDate: rec.dayAndDate,
      });
    }
  }
  
  const batch = db.batch();
  let upsertedCount = 0;
  
  for (const [docId, info] of grouped.entries()) {
    const ref = db.collection('studentLeaves').doc(docId);
    const existingDoc = await ref.get();
    const existingData = existingDoc.exists ? existingDoc.data() : null;
    const existingAttendance: AttendanceEntry[] = existingData?.attendance || [];
    
    // Merge by day
    const byDay = new Map(existingAttendance.map((e) => [e.dayAndDate, e]));
    for (const e of info.entries.values()) {
      byDay.set(e.dayAndDate, e);
    }
    const finalArr = Array.from(byDay.values());
    
    batch.set(ref, { name: info.name, Class: info.Class, attendance: finalArr }, { merge: true });
    upsertedCount += info.entries.size;
  }
  
  await batch.commit();
  
  return { success: true, upsertedCount, studentsAffected: grouped.size };
}

/**
 * Sync students from Firebase Users collection to studentLeaves
 */
export async function syncStudentsToAttendance() {
  const firebase = getAdmin();
  if (!firebase) throw new Error('Firebase not initialized');
  
  const db = firebase.firestore();
  
  // Get all students from Users collection
  const usersSnap = await db.collection('Users').where('role', '==', 'student').get();
  
  const batch = db.batch();
  let syncedCount = 0;
  
  for (const userDoc of usersSnap.docs) {
    const userData = userDoc.data();
    const name = userData.name;
    const cls = userData.Class || userData.classLevel;
    
    if (!name || !cls) continue;
    
    const docId = buildDocId(name, cls);
    const ref = db.collection('studentLeaves').doc(docId);
    
    batch.set(ref, {
      name,
      Class: cls,
      batch: userData.batch || null,
    }, { merge: true });
    
    syncedCount++;
  }
  
  await batch.commit();
  
  return { success: true, syncedCount };
}

/**
 * Get unique classes and batches for filters
 */
export async function getAttendanceFilters() {
  const firebase = getAdmin();
  if (!firebase) return { classes: [], batches: [] };
  
  const db = firebase.firestore();
  const snap = await db.collection('studentLeaves').get();
  
  const classes = new Set<string>();
  const batches = new Set<string>();
  
  snap.docs.forEach((doc: any) => {
    const data = doc.data();
    if (data.Class) classes.add(data.Class);
    if (data.batch) batches.add(data.batch);
  });
  
  return {
    classes: Array.from(classes).sort(),
    batches: Array.from(batches).sort(),
  };
}
