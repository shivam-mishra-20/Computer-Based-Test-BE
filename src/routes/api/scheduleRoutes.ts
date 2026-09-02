import { Router, Request, Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import Schedule from '../../models/Schedule';
import Batch from '../../models/Batch';
import User from '../../models/User';
import Leave from '../../models/Leave';
import AppSetting from '../../models/AppSetting';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { aiLimiter, uploadLimiter } from '../../middlewares/rateLimiter';
import { sendScheduleNotification, sendTeacherNotification } from '../../services/notificationService';
import { initFirebaseAdmin, uploadToFirebase } from '../../services/firebaseService';
import { cacheMiddleware, invalidateCacheOn } from '../../utils/cacheHelpers';
import { normalizeClassValue } from '../../config/studentBatchConfig';
import { mergeAdvancedBasicBatchValues, getStudentBatchConfigFromDatabase } from '../../services/batchConfigService';
import { ai, safeParse, aiConfig } from '../../ai';
import { getSchedulePolicy } from '../../services/schedule/schedulePolicy';
import {
  ScheduleSession,
  ValidationIssue,
  clampRoomNumber,
  findSessionConflicts,
  hasBlockingIssue,
  isValidTimeString,
  validateSessionSet,
} from '../../services/schedule/scheduleValidator';
import { INSTITUTE_ACCOUNT_CLAUSE } from '../../utils/instituteAudience';

// Initialize Firebase Admin on module load
let firebaseAdmin: any = null;
function getFirebaseAdmin() {
  if (!firebaseAdmin) {
    try {
      firebaseAdmin = require('firebase-admin');
      initFirebaseAdmin();
    } catch (e) {
      console.warn('Firebase Admin SDK not available');
    }
  }
  return firebaseAdmin;
}

const router = Router();

let MORNING_TIME_SLOTS = [
  { start: '10:30', end: '11:30', label: '10:30 AM - 11:30 AM' },
  { start: '11:30', end: '12:30', label: '11:30 AM - 12:30 PM' },
  { start: '12:30', end: '13:30', label: '12:30 PM - 1:30 PM' },
  { start: '13:30', end: '14:30', label: '1:30 PM - 2:30 PM' },
  { start: '14:30', end: '15:30', label: '2:30 PM - 3:30 PM' },
];

let MORNING2_TIME_SLOTS = [
  { start: '09:00', end: '10:00', label: '9:00 AM - 10:00 AM' },
  { start: '10:00', end: '11:00', label: '10:00 AM - 11:00 AM' },
  { start: '11:00', end: '12:00', label: '11:00 AM - 12:00 PM' },
  { start: '12:00', end: '13:00', label: '12:00 PM - 1:00 PM' },
];

let EVENING_TIME_SLOTS = [
  { start: '15:30', end: '16:30', label: '3:30 PM - 4:30 PM' },
  { start: '16:30', end: '17:30', label: '4:30 PM - 5:30 PM' },
  { start: '17:30', end: '18:30', label: '5:30 PM - 6:30 PM' },
  { start: '18:30', end: '19:30', label: '6:30 PM - 7:30 PM' },
  { start: '19:30', end: '20:30', label: '7:30 PM - 8:30 PM' },
  { start: '20:30', end: '21:30', label: '8:30 PM - 9:30 PM' },
  { start: '21:30', end: '22:30', label: '9:30 PM - 10:30 PM' },
];

// All regular slots are used for live schedule, timetable grid defaults, and labels.
function buildCombinedTimeSlots() {
  return [...MORNING2_TIME_SLOTS, ...MORNING_TIME_SLOTS, ...EVENING_TIME_SLOTS]
    .filter((slot) => slot?.start && slot?.end)
    .sort((a, b) => parseTimeToMinutes(a.start) - parseTimeToMinutes(b.start));
}

let TIME_SLOTS = buildCombinedTimeSlots();

// Load time slots from DB
async function loadTimeSlots() {
  try {
    const morningSetting = await AppSetting.findOne({ key: 'MORNING_TIME_SLOTS' });
    if (morningSetting && morningSetting.value && Array.isArray(morningSetting.value)) {
      MORNING_TIME_SLOTS = morningSetting.value;
    } else if (!morningSetting) {
      await AppSetting.create({ key: 'MORNING_TIME_SLOTS', value: MORNING_TIME_SLOTS });
    }

    const morning2Setting = await AppSetting.findOne({ key: 'MORNING2_TIME_SLOTS' });
    if (morning2Setting && morning2Setting.value && Array.isArray(morning2Setting.value)) {
      MORNING2_TIME_SLOTS = morning2Setting.value;
    } else if (!morning2Setting) {
      await AppSetting.create({ key: 'MORNING2_TIME_SLOTS', value: MORNING2_TIME_SLOTS });
    }

    const eveningSetting = await AppSetting.findOne({ key: 'EVENING_TIME_SLOTS' });
    if (eveningSetting && eveningSetting.value && Array.isArray(eveningSetting.value)) {
      EVENING_TIME_SLOTS = eveningSetting.value;
    } else if (!eveningSetting) {
      await AppSetting.create({ key: 'EVENING_TIME_SLOTS', value: EVENING_TIME_SLOTS });
    }

    TIME_SLOTS = buildCombinedTimeSlots();
  } catch (error) {
    console.error('Failed to load time slots from DB:', error);
  }
}

// Call on startup
loadTimeSlots();

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ========================
// UTILITY FUNCTIONS
// ========================

function to12HourLabelBE(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function getCurrentTimeSlot(): { currentSlot: string | null; nextSlot: string | null } {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  let currentSlot = null;
  let nextSlot = null;
  
  for (let i = 0; i < TIME_SLOTS.length; i++) {
    const slotStart = parseTimeToMinutes(TIME_SLOTS[i].start);
    const slotEnd = parseTimeToMinutes(TIME_SLOTS[i].end);
    
    if (currentMinutes >= slotStart && currentMinutes < slotEnd) {
      currentSlot = TIME_SLOTS[i].start;
      if (i + 1 < TIME_SLOTS.length) {
        nextSlot = TIME_SLOTS[i + 1].start;
      }
      break;
    } else if (currentMinutes < slotStart) {
      nextSlot = TIME_SLOTS[i].start;
      break;
    }
  }
  
  return { currentSlot, nextSlot };
}

// Check if string is a valid MongoDB ObjectId
function isValidObjectId(id: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(id);
}

function normalizeClassLevels(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  const normalized = input
    .map((value) => normalizeClassValue(String(value)))
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(normalized)).sort((a, b) => Number(a) - Number(b));
}

function normalizeBatchName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBatchList(values: unknown, fallback?: unknown): string[] {
  const parsed = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? values.split(',')
      : [];

  const merged = [...parsed];
  const fallbackBatch = normalizeBatchName(fallback);
  if (fallbackBatch) {
    merged.push(fallbackBatch);
  }

  return Array.from(
    new Set(
      merged
        .map((value) => normalizeBatchName(value))
        .filter(Boolean)
    )
  );
}

function getScheduleBatches(schedule: any): string[] {
  const multi = Array.isArray(schedule?.batches)
    ? schedule.batches
    : [];

  const normalizedMulti = multi
    .map((value: unknown) => normalizeBatchName(value))
    .filter(Boolean);

  if (normalizedMulti.length > 0) {
    return Array.from(new Set(normalizedMulti));
  }

  const single = normalizeBatchName(schedule?.batch);
  return single ? [single] : [];
}

function applyBatchFilter(query: any, batchValue: unknown): void {
  const normalizedBatch = normalizeBatchName(batchValue);
  if (!normalizedBatch) return;

  query.$or = [
    { batch: normalizedBatch },
    { batches: normalizedBatch },
  ];
}

function buildStudentClassAudienceClause(classVariants: string[], userBatch: string) {
  const normalizedBatch = normalizeBatchName(userBatch);
  const classClause: any = {
    classLevel: { $in: classVariants },
  };

  if (normalizedBatch) {
    classClause.$or = [
      { batch: { $in: [normalizedBatch, 'All Batches', 'All'] } },
      { batches: normalizedBatch },
      { batches: { $in: ['All Batches', 'All'] } },
    ];
    return classClause;
  }

  classClause.$or = [
    { batch: { $in: ['', null] } },
    { batch: { $exists: false } },
    { batches: { $size: 0 } },
    { batches: { $exists: false } },
  ];

  return classClause;
}

async function notifyScheduleAudienceByBatches(
  title: string,
  body: string,
  classLevel: string,
  batches: string[]
) {
  const targets = Array.from(
    new Set(batches.map((batch) => normalizeBatchName(batch)).filter(Boolean))
  );

  if (targets.length === 0) {
    await sendScheduleNotification(title, body, classLevel);
    return;
  }

  await Promise.all(
    targets.map((batch) => sendScheduleNotification(title, body, classLevel, batch))
  );
}

/**
 * Sync a Firebase teacher to MongoDB Users collection
 * This ensures Firebase teachers can receive notifications
 */
// Sync Firebase teacher to MongoDB users collection
async function syncFirebaseTeacherToMongo(firebaseTeacherId: string, teacherName: string) {
  try {
    // Skip if it's already a valid MongoDB ObjectId
    if (isValidObjectId(firebaseTeacherId)) {
      return;
    }
    
    // Check if teacher already exists in MongoDB by firebaseUid
    const existingTeacher = await User.findOne({ firebaseUid: firebaseTeacherId });
    if (existingTeacher) {
      console.log(`Teacher ${firebaseTeacherId} already synced to MongoDB`);
      return;
    }
    
    // Create a new MongoDB user for this Firebase teacher
    const newTeacher = new User({
      name: teacherName || 'Firebase Teacher',
      email: `${firebaseTeacherId.toLowerCase()}@firebase.sync`,
      password: `firebase_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      role: 'teacher',
      status: 'approved',
      firebaseUid: firebaseTeacherId,
      authProvider: 'firebase'
    });
    
    await newTeacher.save();
    console.log(`Synced Firebase teacher ${firebaseTeacherId} to MongoDB with _id ${newTeacher._id}`);
  } catch (error: any) {
    // Ignore duplicate key errors (teacher may have been synced by another request)
    if (error.code !== 11000) {
      console.error(`Failed to sync Firebase teacher ${firebaseTeacherId}:`, error.message);
    }
  }
}

/**
 * Resolve teacher name from ID (Mongo ObjectId, Mongo firebaseUid, or Firebase Doc ID)
 * And sync to MongoDB if found in Firebase but not Mongo
 */
async function resolveTeacherNameAndSync(teacherId: string): Promise<string> {
  let teacherName = '';
  
  // 1. Try MongoDB first (if it's a valid ObjectId)
  try {
    if (isValidObjectId(teacherId)) {
      const teacher = await User.findById(teacherId).select('name');
      return teacher?.name || '';
    }
  } catch { /* not a MongoDB ObjectId */ }
  
  // 2. Try MongoDB by firebaseUid if not found
  try {
    const syncedTeacher = await User.findOne({ firebaseUid: teacherId }).select('name');
    if (syncedTeacher) {
      return syncedTeacher.name;
    }
  } catch (e) { console.error('Error finding teacher by firebaseUid:', e); }

  // 3. If still not found, try Firebase and sync to MongoDB
  const admin = getFirebaseAdmin();
  if (admin) {
    try {
      const db = admin.firestore();
      const doc = await db.collection('Users').doc(teacherId).get();
      if (doc.exists) {
        const data = doc.data();
        const att = data?.attendance || {};
        teacherName = att.name || data?.name || data?.displayName || '';
        
        // Sync Firebase teacher to MongoDB for notifications
        if (teacherName) {
           await syncFirebaseTeacherToMongo(teacherId, teacherName);
        }
      }
    } catch (fbError) {
      console.error('Firebase teacher lookup failed:', fbError);
    }
  }
  
  return teacherName;
}

// ========================
// CONFLICT CHECKING (shared by POST /, PUT /:scheduleId, and bulk import)
// ========================

interface ScheduleConflictInput {
  scheduleType: 'regular' | 'custom';
  startTimeSlot: string;
  endTimeSlot?: string;
  dayOfWeek?: number;
  date?: Date | string;
  roomNumber: number;
  teacherId?: string;
  teacherName?: string;
  /** Needed by the combined-batch policy rule — without these, two batches of
   *  one class look like two unrelated classes fighting over a room. */
  classLevel?: string;
  batch?: string;
  batches?: string[];
}

type ScheduleConflictResult =
  | { ok: true }
  | { ok: false; status: number; body: { error: string; leaveDetails?: any } };

/** Slot end time, from the row itself or the configured slot table. */
function resolveEndTimeSlot(startTimeSlot: string, explicitEnd?: string): string {
  if (isValidTimeString(explicitEnd)) return explicitEnd;
  const slot = TIME_SLOTS.find((s) => s.start === startTimeSlot);
  if (slot?.end) return slot.end;
  // Unknown slot — assume the institute's standard one-hour block rather than
  // silently treating the row as zero-length (which would never overlap).
  const mins = parseTimeToMinutes(startTimeSlot) + 60;
  return `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function docToSession(doc: any): ScheduleSession {
  return {
    id: String(doc._id || ''),
    classLevel: String(doc.classLevel ?? ''),
    batch: doc.batch || '',
    batches: Array.isArray(doc.batches) ? doc.batches : undefined,
    startTimeSlot: doc.startTimeSlot,
    endTimeSlot: resolveEndTimeSlot(doc.startTimeSlot, doc.endTimeSlot),
    roomNumber: doc.roomNumber ?? null,
    teacherId: doc.teacherId ? String(doc.teacherId) : undefined,
    teacherName: doc.teacherName || undefined,
  };
}

const CONFLICT_CANDIDATE_FIELDS = 'classLevel batch batches startTimeSlot endTimeSlot roomNumber teacherId teacherName';

/**
 * Room/teacher double-booking + teacher-leave overlap for the single-entry
 * create/update routes. The RULES live in scheduleValidator.ts — this function
 * only decides which existing rows are candidates and turns the first blocking
 * issue into an HTTP response, so the manual routes and the bulk importer can
 * never again disagree about what a conflict is.
 */
async function checkScheduleConflict(
  input: ScheduleConflictInput,
  opts: { excludeId?: string } = {}
): Promise<ScheduleConflictResult> {
  const policy = getSchedulePolicy();

  const conflictQuery: any = { isActive: true };
  if (opts.excludeId) conflictQuery._id = { $ne: opts.excludeId };

  if (input.scheduleType === 'regular') {
    conflictQuery.scheduleType = 'regular';
    conflictQuery.dayOfWeek = input.dayOfWeek;
  } else {
    conflictQuery.scheduleType = 'custom';
    // Whole-day window rather than exact Date equality: two rows on the same
    // calendar day can carry different times-of-day and must still be compared.
    const day = new Date(input.date as any);
    const startOfDay = new Date(day);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(day);
    endOfDay.setHours(23, 59, 59, 999);
    conflictQuery.date = { $gte: startOfDay, $lte: endOfDay };
  }

  // Candidates are fetched by day (not by exact start time) so the engine can
  // apply proper overlap detection — the same rule the bulk importer uses.
  const existingDocs = await Schedule.find(conflictQuery).select(CONFLICT_CANDIDATE_FIELDS).lean();

  const candidate: ScheduleSession = {
    classLevel: String(input.classLevel ?? ''),
    batch: input.batch,
    batches: input.batches,
    startTimeSlot: input.startTimeSlot,
    endTimeSlot: resolveEndTimeSlot(input.startTimeSlot, input.endTimeSlot),
    roomNumber: Number.isFinite(Number(input.roomNumber)) ? Number(input.roomNumber) : null,
    teacherId: input.teacherId ? String(input.teacherId) : undefined,
    teacherName: input.teacherName,
  };

  const blocking = findSessionConflicts(candidate, existingDocs.map(docToSession), policy)
    .find((i) => i.severity === 'error');
  if (blocking) {
    return { ok: false, status: 400, body: { error: blocking.message } };
  }

  if (
    policy.teacherOnApprovedLeave !== 'off' &&
    input.teacherId &&
    input.scheduleType === 'custom' &&
    input.date
  ) {
    const scheduleDate = new Date(input.date);
    const teacherLeave = await Leave.findOne({
      teacherId: input.teacherId,
      status: 'approved',
      leaveType: { $ne: 'half_day' },
      startDate: { $lte: scheduleDate },
      endDate: { $gte: scheduleDate },
    });
    if (teacherLeave) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `${input.teacherName || 'This teacher'} is on approved leave on ${scheduleDate.toLocaleDateString()}`,
          leaveDetails: {
            startDate: teacherLeave.startDate,
            endDate: teacherLeave.endDate,
            leaveType: teacherLeave.leaveType,
          },
        },
      };
    }
  }

  return { ok: true };
}

// ========================
// BATCH MANAGEMENT
// ========================

// Get all batches
router.get('/batches', authMiddleware, async (req: Request, res: Response) => {
  try {
    await mergeAdvancedBasicBatchValues();
    const { classLevel } = req.query;
    
    const query: any = {};
    if (classLevel) {
      const normalizedClass = normalizeClassValue(String(classLevel));
      query.classLevels = normalizedClass || classLevel;
    }
    
    const batches = await Batch.find(query).sort({ name: 1 });
    res.json(batches);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create new batch
router.post('/batches', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create batches' });
    }

    const normalizedClassLevels = normalizeClassLevels(req.body?.classLevels);
    if (!req.body?.name || normalizedClassLevels.length === 0) {
      return res.status(400).json({ error: 'Batch name and valid class levels are required' });
    }
    
    const batch = new Batch({
      ...req.body,
      classLevels: normalizedClassLevels,
    });
    await batch.save();
    res.status(201).json(batch);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update batch
router.put('/batches/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can update batches' });
    }

    const updatePayload: Record<string, unknown> = { ...req.body };

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'classLevels')) {
      const normalizedClassLevels = normalizeClassLevels(req.body?.classLevels);
      if (normalizedClassLevels.length === 0) {
        return res.status(400).json({ error: 'At least one valid class level is required' });
      }
      updatePayload.classLevels = normalizedClassLevels;
    }

    const updatedBatch = await Batch.findByIdAndUpdate(req.params.id, updatePayload, {
      new: true,
      runValidators: true,
    });

    if (!updatedBatch) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    return res.json(updatedBatch);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// Delete batch
router.delete('/batches/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can delete batches' });
    }
    
    await Batch.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// FIREBASE DATA ENDPOINTS
// ========================

// Get students from Firebase Users collection
router.get('/firebase/students', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { classLevel, batch } = req.query;
    const admin = getFirebaseAdmin();
    
    if (!admin) {
      // Fallback to MongoDB users
      const mongoQuery: any = { role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE };
      if (classLevel) mongoQuery.classLevel = classLevel;
      if (batch) mongoQuery.batch = batch;

      const mongoStudents = await User.find(mongoQuery)
        .select('_id name email classLevel batch')
        .sort({ name: 1 });
      
      return res.json(mongoStudents.map((s: any) => ({
        id: s._id.toString(),
        name: s.name,
        email: s.email,
        classLevel: s.classLevel,
        batch: s.batch,
        source: 'mongodb'
      })));
    }
    
    // Fetch from Firebase
    const db = admin.firestore();
    const snapshot = await db.collection('Users').get();
    
    const students: any[] = [];
    snapshot.forEach((doc: any) => {
      const data = doc.data();
      const att = data.attendance || {};
      const res = data.results || {};
      
      // Role is in results.role
      const role = res.role || data.role || '';
      
      // Skip teachers and admins
      if (role === 'teacher' || role === 'Teacher' || role === 'admin' || role === 'Admin') {
        return;
      }
      
      // Class is at top level, format: "Class 11"
      const rawClass = data.Class || data.classLevel || '';
      // Extract just the number (e.g., "Class 11" -> "11")
      const studentClass = String(rawClass).replace(/^Class\s*/i, '').trim();
      
      // Batch is in attendance.batch
      const studentBatch = att.batch || data.batch || '';
      
      // Name is in attendance.name
      const studentName = att.name || data.name || data.displayName || '';
      
      // Email is in attendance.email
      const studentEmail = att.email || data.email || '';
      
      // Skip if no class (not a student)
      if (!studentClass) {
        return;
      }
      
      // Filter by class level if query param provided
      if (classLevel) {
        const queryClass = String(classLevel).replace(/^Class\s*/i, '').trim();
        if (studentClass !== queryClass) {
          return;
        }
      }
      
      // Filter by batch if query param provided
      if (batch && studentBatch && studentBatch !== batch) {
        return;
      }
      
      students.push({
        id: doc.id,
        name: studentName || 'Unknown',
        email: studentEmail,
        classLevel: studentClass,
        batch: studentBatch,
        phone: att.phone || data.phone,
        source: 'firebase'
      });
    });
    
    // Sort by name
    students.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    console.log(`Firebase students: Found ${students.length} students for class=${classLevel}, batch=${batch}`);
    
    res.json(students);
  } catch (error: any) {
    console.error('Error fetching Firebase students:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get teachers from Firebase Users collection
router.get('/firebase/teachers', authMiddleware, async (req: Request, res: Response) => {
  try {
    const admin = getFirebaseAdmin();
    
    if (!admin) {
      // Fallback to MongoDB teachers
      const mongoTeachers = await User.find({ role: 'teacher' })
        .select('_id name email')
        .sort({ name: 1 });
      
      return res.json(mongoTeachers.map((t: any) => ({
        id: t._id.toString(),
        name: t.name,
        email: t.email,
        source: 'mongodb'
      })));
    }
    
    // Fetch from Firebase
    const db = admin.firestore();
    const snapshot = await db.collection('Users').get();
    
    const teachers: any[] = [];
    snapshot.forEach((doc: any) => {
      const data = doc.data();
      const role = data.role || data.results?.role;
      
      // Only include teachers
      if (role === 'teacher' || role === 'Teacher') {
        teachers.push({
          id: doc.id,
          name: data.name || 'Unknown Teacher',
          email: data.email,
          phone: data.phone,
          subject: data.subject,
          source: 'firebase'
        });
      }
    });
    
    // Sort by name
    teachers.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    res.json(teachers);
  } catch (error: any) {
    console.error('Error fetching Firebase teachers:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get unique batches from MongoDB only (Firebase removed due to auth issues)
router.get('/firebase/batches', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { classLevel } = req.query;

    await mergeAdvancedBasicBatchValues();
    
    // Fetch all batches from MongoDB
    const query: any = {};
    if (classLevel) {
      const normalizedClass = normalizeClassValue(String(classLevel));
      query.classLevels = normalizedClass || classLevel;
    }
    
    const batches = await Batch.find(query).sort({ name: 1 }).lean();
    
    res.json(batches);
  } catch (error: any) {
    console.error('Error fetching batches:', error);
    res.status(500).json({ error: error.message || 'Internal server error fetching batches' });
  }
});

// Get students from MongoDB only (Firebase removed due to auth issues)
router.get('/students', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { classLevel, batch } = req.query;
    
    // Build query for MongoDB - handle both "9" and "Class 9" formats
    const mongoQuery: any = { role: 'student', status: 'approved', ...INSTITUTE_ACCOUNT_CLAUSE };

    if (classLevel) {
      // Try to match both "9" and "Class 9" formats
      mongoQuery.$or = [
        { classLevel: classLevel },
        { classLevel: `Class ${classLevel}` },
        { classLevel: { $regex: new RegExp(`^Class\\s*${classLevel}$`, 'i') } }
      ];
    }
    
    if (batch) {
      mongoQuery.batch = batch;
    }
    
    // Fetch students from MongoDB
    const mongoStudents = await User.find(mongoQuery)
      .select('_id name email classLevel batch phone')
      .sort({ name: 1 })
      .lean();
    
    // Format response
    const students = mongoStudents.map((s: any) => ({
      id: s._id.toString(),
      name: s.name,
      email: s.email,
      classLevel: s.classLevel,
      batch: s.batch,
      phone: s.phone,
      source: 'mongodb'
    }));
    
    console.log(`Students: Found ${students.length} students for class=${classLevel}, batch=${batch}`);
    console.log(`Query used:`, JSON.stringify(mongoQuery));
    res.json(students);
  } catch (error: any) {
    console.error('Error fetching students:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// TEACHERS & ROOMS
// ========================

// Get all teachers
router.get('/teachers', authMiddleware, async (req: Request, res: Response) => {
  try {
    const teachers = await User.find({ role: 'teacher' })
      .select('_id name email firebaseUid')
      .sort({ name: 1 });
    res.json(teachers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get rooms (static list 1-11)
router.get('/rooms', authMiddleware, async (_req: Request, res: Response) => {
  const rooms = Array.from({ length: 11 }, (_, i) => ({
    number: i + 1,
    name: `Room ${i + 1}`
  }));
  res.json(rooms);
});

// Get time slots
router.get('/timeslots', authMiddleware, async (req: Request, res: Response) => {
  await loadTimeSlots(); // ensure latest
  const { view } = req.query;
  if (view === 'morning') {
    return res.json(MORNING_TIME_SLOTS);
  } else if (view === 'morning2') {
    return res.json(MORNING2_TIME_SLOTS);
  } else if (view === 'all') {
    return res.json(TIME_SLOTS);
  }
  res.json(EVENING_TIME_SLOTS); // Default
});

// Update time slots
router.put('/timeslots', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can update time slots' });
    }

    const { morningSlots, morning2Slots, eveningSlots } = req.body;
    
    if (morningSlots && Array.isArray(morningSlots)) {
      await AppSetting.findOneAndUpdate(
        { key: 'MORNING_TIME_SLOTS' },
        { value: morningSlots },
        { upsert: true, new: true }
      );
    }

    if (morning2Slots && Array.isArray(morning2Slots)) {
      await AppSetting.findOneAndUpdate(
        { key: 'MORNING2_TIME_SLOTS' },
        { value: morning2Slots },
        { upsert: true, new: true }
      );
    }
    
    if (eveningSlots && Array.isArray(eveningSlots)) {
      await AppSetting.findOneAndUpdate(
        { key: 'EVENING_TIME_SLOTS' },
        { value: eveningSlots },
        { upsert: true, new: true }
      );
    }
    
    await loadTimeSlots(); // refresh cache
    
    res.json({
      success: true,
      morningSlots: MORNING_TIME_SLOTS,
      morning2Slots: MORNING2_TIME_SLOTS,
      eveningSlots: EVENING_TIME_SLOTS
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// TIMETABLE GRID
// ========================

// Get timetable grid for a class/batch
router.get('/timetable', authMiddleware, async (req: Request, res: Response) => {
  try {
    // Always refresh slots first so grid keys and response are consistent
    await loadTimeSlots();

    const { classLevel, batch, dayOfWeek } = req.query;

    // Accept both "11" and "Class 11" formats so nothing is missed
    const rawClass = classLevel as string | undefined;
    const classVariants = rawClass
      ? Array.from(new Set([
          rawClass.trim(),
          `Class ${rawClass.trim().replace(/^Class\s*/i, '')}`,
          rawClass.trim().replace(/^Class\s*/i, ''),
        ])).filter(Boolean)
      : [];

    const query: any = { scheduleType: 'regular', isActive: true };
    if (classVariants.length > 0) query.classLevel = { $in: classVariants };
    if (dayOfWeek !== undefined) query.dayOfWeek = Number(dayOfWeek);

    // Batch filter: include exact batch + "All Batches" / no-batch schedules
    if (batch) {
      const nb = normalizeBatchName(batch as string);
      if (nb) {
        query.$or = [
          { batch: nb },
          { batches: nb },
          { batch: { $in: ['All Batches', 'All', '', null] } },
          { batches: { $in: ['All Batches', 'All'] } },
          { batches: { $size: 0 } },
          { batch: { $exists: false } },
        ];
      }
    }

    const schedules = await Schedule.find(query)
      .populate('teacherId', 'name')
      .sort({ dayOfWeek: 1, startTimeSlot: 1 });

    console.log(`[Timetable] query classVariants=${JSON.stringify(classVariants)} batch=${batch} → ${schedules.length} schedules`);

    // Build grid: initialise all day×slot cells to null, then fill with schedule data
    const grid: any = {};
    DAYS_OF_WEEK.forEach((_day, index) => {
      grid[index] = {};
      TIME_SLOTS.forEach(slot => { grid[index][slot.start] = null; });
    });

    schedules.forEach(schedule => {
      if (schedule.dayOfWeek === undefined) return;
      // Ensure the cell exists even if the slot wasn't in TIME_SLOTS
      if (!grid[schedule.dayOfWeek]) grid[schedule.dayOfWeek] = {};
      grid[schedule.dayOfWeek][schedule.startTimeSlot] = {
        _id: schedule._id,
        title: schedule.title,
        subject: schedule.subject,
        scheduleType: schedule.scheduleType,
        type: schedule.type,
        dayOfWeek: schedule.dayOfWeek,
        startTimeSlot: schedule.startTimeSlot,
        endTimeSlot: schedule.endTimeSlot,
        roomNumber: schedule.roomNumber,
        teacherName: schedule.teacherName || (schedule.teacherId as any)?.name,
        teacherId: typeof schedule.teacherId === 'object' && schedule.teacherId !== null
          ? (schedule.teacherId as any)._id?.toString() || (schedule.teacherId as any).id?.toString()
          : schedule.teacherId,
        batch: normalizeBatchName((schedule as any).batch),
        batches: getScheduleBatches(schedule),
        batchLabel: getScheduleBatches(schedule).join(', ') || normalizeBatchName((schedule as any).batch) || '',
        classLevel: schedule.classLevel,
        students: schedule.students || [],
      };
    });

    // Build schedule-derived time slots so the frontend can always render occupied columns
    const scheduleTimeSlots = schedules
      .filter(s => s.startTimeSlot && s.endTimeSlot)
      .map(s => ({ start: s.startTimeSlot, end: s.endTimeSlot, label: `${to12HourLabelBE(s.startTimeSlot)} - ${to12HourLabelBE(s.endTimeSlot)}` }));

    res.json({
      grid,
      timeSlots: TIME_SLOTS,
      scheduleTimeSlots,   // extra: actual slots used by schedules
      days: DAYS_OF_WEEK
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// LIVE SCHEDULE
// ========================

// Get institute-wide view of all classes for a specific date
router.get('/institute-view', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { date } = req.query;
    
    // Parse date or use today
    const targetDate = date ? new Date(date as string) : new Date();
    const dayOfWeek = targetDate.getDay();
    
    // Get start and end of the day
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);
    
    // Fetch all regular schedules for this day of week
    const regularSchedules = await Schedule.find({
      scheduleType: 'regular',
      dayOfWeek,
      isActive: true
    })
      .populate('teacherId', 'name')
      .sort({ startTimeSlot: 1 })
      .lean();
    
    // Fetch all custom schedules for this specific date
    const customSchedules = await Schedule.find({
      scheduleType: 'custom',
      date: { $gte: startOfDay, $lte: endOfDay },
      isActive: true
    })
      .populate('teacherId', 'name')
      .sort({ startTimeSlot: 1 })
      .lean();
    
    // Combine and format all schedules
    const allSchedules = [...regularSchedules, ...customSchedules].map(formatScheduleResponse);
    
    res.json(allSchedules);
  } catch (error: any) {
    console.error('Error fetching institute view:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current and next class for a user - Cached per user for 1 minute (keep status fresh)
router.get('/live', authMiddleware, cacheMiddleware({ ttl: 60, keyFn: (req) => `schedule-live:user:${(req as any).user.id}` }), async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    // Fetch full user details from DB to get classLevel and batch
    const user = await User.findById(authUser.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const today = new Date();
    const dayOfWeek = today.getDay();
    await loadTimeSlots();
    let { currentSlot, nextSlot } = getCurrentTimeSlot();
    
    let currentClass = null;
    let nextClass = null;
    
    // Normalize class level (remove "Class " prefix if present)
    const userClassLevel = String(user.classLevel || '').replace(/^Class\s*/i, '').trim();
    const userBatch = user.batch || '';
    
    console.log(`[Schedule Live] User: ${user.name}, Class: ${userClassLevel}, Batch: ${userBatch}, Day: ${dayOfWeek}`);
    
    // Build query based on user role
    const baseQuery: any = { isActive: true };
    
    if (user.role === 'student') {
      const classAudience = buildStudentClassAudienceClause(
        [userClassLevel, `Class ${userClassLevel}`, user.classLevel].filter(Boolean) as string[],
        userBatch
      );

      baseQuery.$or = [
        classAudience,
        { students: user.id },
        { students: user.firebaseUid }
      ];
    } else if (user.role === 'teacher') {
      // Match by teacherId OR teacherName (case-insensitive)
      // Note: Some schedules store teacher name in teacherId field
      baseQuery.$or = [
        { teacherId: user.id },
        { teacherId: user.firebaseUid },
        { teacherId: user._id?.toString() },
        { teacherId: user.name }, // Some schedules store name in teacherId
        { teacherId: { $regex: new RegExp(`^${user.name?.trim()}$`, 'i') } },
        { teacherName: user.name },
        { teacherName: { $regex: new RegExp(`^${user.name?.trim()}$`, 'i') } }
      ];
    }
    
    // Fix: Use $and to combine baseQuery filters with time slot check
    // This prevents baseQuery.$or from being overwritten by the time slot $or
    if (currentSlot) {
      currentClass = await Schedule.findOne({
        $and: [
          baseQuery,
          {
            $or: [
              { startTimeSlot: currentSlot }, 
              { startTimeslot: currentSlot }
            ]
          }
        ],
        scheduleType: 'regular',
        dayOfWeek
      }).lean();
    }
    
    if (nextSlot) {
      nextClass = await Schedule.findOne({
        $and: [
          baseQuery,
          {
            $or: [
              { startTimeSlot: nextSlot },
              { startTimeslot: nextSlot }
            ]
          }
        ],
        scheduleType: 'regular',
        dayOfWeek
      }).lean();
    }
    
    // Also check custom schedules for today
    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);
    
    const customSchedules = await Schedule.find({
      ...baseQuery,
      scheduleType: 'custom',
      date: { $gte: startOfDay, $lte: endOfDay }
    }).sort({ startTimeSlot: 1 }).lean();
    
    // Get today's full schedule
    let todayRegular = await Schedule.find({
      ...baseQuery,
      scheduleType: 'regular',
      dayOfWeek
    }).lean(); 
    
    // FALLBACK: If strict match returns nothing, try relaxed batch match but still enforce batch
    if (todayRegular.length === 0 && user.role === 'student') {
      console.log('[Schedule Live] Strict match failed, trying relaxed batch match (still batch-restricted)...');
      const classLevels = [userClassLevel, `Class ${userClassLevel}`, user.classLevel].filter(Boolean);
      const batchValues = userBatch
        ? [userBatch, 'All Batches', 'All', '', null]
        : ['All Batches', 'All', '', null];

      const fallbackQuery: any = {
        isActive: true,
        classLevel: { $in: classLevels },
        $or: [
          { batch: { $in: batchValues } },
          { batch: { $exists: false } },
          { batches: { $in: userBatch ? [userBatch, 'All Batches', 'All'] : ['All Batches', 'All'] } },
          { batches: { $size: 0 } },
          { batches: { $exists: false } },
          { students: user.id },
          { students: user.firebaseUid }
        ]
      };

      todayRegular = await Schedule.find({
        ...fallbackQuery,
        scheduleType: 'regular',
        dayOfWeek
      }).lean();
    }

    const nowMinutes = today.getHours() * 60 + today.getMinutes();
    const getScheduleStartMinutes = (s: any) => parseTimeToMinutes(s.startTimeSlot || s.startTimeslot || '00:00');
    const getScheduleEndMinutes = (s: any) => parseTimeToMinutes(s.endTimeSlot || s.endTimeslot || '23:59');
    const sortedRegular = [...todayRegular].sort(
      (a, b) => getScheduleStartMinutes(a) - getScheduleStartMinutes(b)
    );

    if (!currentClass) {
      currentClass = sortedRegular.find(
        (s) => nowMinutes >= getScheduleStartMinutes(s) && nowMinutes < getScheduleEndMinutes(s)
      ) || null;
      if (currentClass) {
        currentSlot = currentClass.startTimeSlot || currentClass.startTimeslot || currentSlot;
      }
    }

    if (!nextClass) {
      nextClass = sortedRegular.find((s) => getScheduleStartMinutes(s) > nowMinutes) || null;
      if (nextClass) {
        nextSlot = nextClass.startTimeSlot || nextClass.startTimeslot || nextSlot;
      }
    }
    
    // Merge and sort in memory to handle field casing issues safely
    const allSchedules = [...todayRegular, ...customSchedules].map(s => {
      // Ensure compatible type for formatScheduleResponse (which takes any)
      return s as any;
    });

    // Helper to get start time safely
    const getStartTime = (s: any) => s.startTimeSlot || s.startTimeslot || '00:00';

    allSchedules.sort((a, b) => {
      return getStartTime(a).localeCompare(getStartTime(b));
    });
    
    console.log(`[Schedule Live] Found ${todayRegular.length} regular + ${customSchedules.length} custom schedules`);
    
    res.json({
      currentClass: currentClass ? formatScheduleResponse(currentClass) : null,
      nextClass: nextClass ? formatScheduleResponse(nextClass) : null,
      todaySchedule: allSchedules.map(formatScheduleResponse),
      currentTime: today.toISOString(),
      dayOfWeek,
      currentSlot,
      nextSlot,
      debug: {
        userClass: userClassLevel,
        userBatch,
        userRole: user.role, 
        baseQuery: JSON.stringify(baseQuery)
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

function formatScheduleResponse(schedule: any) {
  // Calculate status
  let status = 'upcoming';
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  // Handle casing for startTimeSlot/startTimeslot
  const startTime = schedule.startTimeSlot || schedule.startTimeslot || '00:00';
  const endTime = schedule.endTimeSlot || schedule.endTimeslot || '23:59';
  
  const start = parseInt(startTime.split(':')[0]) * 60 + parseInt(startTime.split(':')[1]);
  const end = parseInt(endTime.split(':')[0]) * 60 + parseInt(endTime.split(':')[1]);
  
  if (currentMinutes >= end) {
    status = 'past';
  } else if (currentMinutes >= start && currentMinutes < end) {
    status = 'ongoing';
  }
  
  const batches = getScheduleBatches(schedule);

  return {
    _id: schedule._id,
    title: schedule.title,
    type: schedule.type,
    subject: schedule.subject,
    scheduleType: schedule.scheduleType,
    startTimeSlot: startTime,
    endTimeSlot: endTime,
    roomNumber: schedule.roomNumber,
    classLevel: schedule.classLevel,
    batch: normalizeBatchName(schedule.batch),
    batches,
    batchLabel: batches.length > 0 ? batches.join(', ') : 'No Batch',
    teacherName: schedule.teacherName || 'TBA',
    teacherId: schedule.teacherId,
    students: schedule.students || [],
    dayOfWeek: schedule.dayOfWeek,
    date: schedule.date,
    status // 'past', 'ongoing', 'upcoming'
  };
}

// ========================
// DAY VIEW - Student's personalized schedule for a specific date
// ========================

// Get schedules for the logged-in user for a specific day (used by "My Schedule" in the app)
router.get('/day-view', authMiddleware, async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const user = await User.findById(authUser.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const { date } = req.query;
    
    // Parse date or use today
    const targetDate = date ? new Date(date as string) : new Date();
    const dayOfWeek = targetDate.getDay();
    
    // Get start and end of the day for custom schedule lookup
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);
    
    // Normalize class level (remove "Class " prefix if present)
    const userClassLevel = String(user.classLevel || '').replace(/^Class\s*/i, '').trim();
    const userBatch = user.batch || '';
    
    console.log(`[Day View] User: ${user.name}, Class: ${userClassLevel}, Batch: ${userBatch}, Day: ${dayOfWeek}, Date: ${date}`);
    
    // Build query based on user role
    const baseQuery: any = { isActive: true };
    
    if (user.role === 'student') {
      const classAudience = buildStudentClassAudienceClause(
        [userClassLevel, `Class ${userClassLevel}`, user.classLevel].filter(Boolean) as string[],
        userBatch
      );

      baseQuery.$or = [
        classAudience,
        { students: user.id },
        { students: user.firebaseUid }
      ];
    } else if (user.role === 'teacher') {
      // Match by teacherId OR teacherName (case-insensitive)
      // Note: Some schedules store teacher name in teacherId field
      baseQuery.$or = [
        { teacherId: user.id },
        { teacherId: user.firebaseUid },
        { teacherId: user._id?.toString() },
        { teacherId: user.name },
        { teacherId: { $regex: new RegExp(`^${user.name?.trim()}$`, 'i') } },
        { teacherName: user.name },
        { teacherName: { $regex: new RegExp(`^${user.name?.trim()}$`, 'i') } }
      ];
    }
    
    // Fetch regular schedules for this day of week
    let regularSchedules = await Schedule.find({
      ...baseQuery,
      scheduleType: 'regular',
      dayOfWeek
    }).lean();
    
    // FALLBACK for students: If strict match returns nothing, try with relaxed batch matching
    // but still enforce that the schedule is either for the student's batch, all batches, or no batch
    if (regularSchedules.length === 0 && user.role === 'student') {
      console.log('[Day View] Strict match failed, trying relaxed batch match (still batch-restricted)...');
      const classLevels = [userClassLevel, `Class ${userClassLevel}`, user.classLevel].filter(Boolean);
      const batchValues = userBatch
        ? [userBatch, 'All Batches', 'All', '', null]
        : ['All Batches', 'All', '', null];

      const fallbackQuery: any = {
        isActive: true,
        classLevel: { $in: classLevels },
        $or: [
          { batch: { $in: batchValues } },
          { batch: { $exists: false } },
          { batches: { $in: userBatch ? [userBatch, 'All Batches', 'All'] : ['All Batches', 'All'] } },
          { batches: { $size: 0 } },
          { batches: { $exists: false } },
          { students: user.id },
          { students: user.firebaseUid }
        ]
      };

      regularSchedules = await Schedule.find({
        ...fallbackQuery,
        scheduleType: 'regular',
        dayOfWeek
      }).lean();
    }
    
    // Fetch custom schedules for this specific date
    const customSchedules = await Schedule.find({
      ...baseQuery,
      scheduleType: 'custom',
      date: { $gte: startOfDay, $lte: endOfDay }
    }).lean();
    
    // Merge and sort
    const allSchedules = [...regularSchedules, ...customSchedules];
    
    // Helper to get start time safely
    const getStartTime = (s: any) => s.startTimeSlot || s.startTimeslot || '00:00';
    
    allSchedules.sort((a, b) => {
      return getStartTime(a).localeCompare(getStartTime(b));
    });
    
    console.log(`[Day View] Found ${regularSchedules.length} regular + ${customSchedules.length} custom schedules`);
    
    res.json(allSchedules.map(formatScheduleResponse));
  } catch (error: any) {
    console.error('Error in day-view:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// SCHEDULE CRUD
// ========================

// Get schedules (with filters)
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { scheduleType, classLevel, batch, startDate, endDate } = req.query;
    
    const query: any = { isActive: true };

    if (scheduleType) query.scheduleType = scheduleType;

    // Accept both "11" and "Class 11" formats
    if (classLevel) {
      const raw = (classLevel as string).trim();
      const stripped = raw.replace(/^Class\s*/i, '');
      query.classLevel = { $in: Array.from(new Set([raw, `Class ${stripped}`, stripped])) };
    }

    applyBatchFilter(query, batch);
    
    // Date range for custom schedules
    if (startDate && endDate) {
      query.date = {
        $gte: new Date(startDate as string),
        $lte: new Date(endDate as string)
      };
    }
    
    // Filter for students
    if (user.role === 'student') {
      const normalizedUserBatch = normalizeBatchName(user.batch);
      query.$or = [
        {
          classLevel: user.classLevel,
          $or: normalizedUserBatch
            ? [
                { batch: normalizedUserBatch },
                { batches: normalizedUserBatch },
              ]
            : [
                { batch: { $in: ['', null] } },
                { batches: { $size: 0 } },
              ]
        },
        { students: user.id }
      ];
    } else if (user.role === 'teacher') {
      // Match by teacherId OR teacherName (case-insensitive)
      // Note: Some schedules store teacher name in teacherId field
      query.$or = [
        { teacherId: user.id },
        { teacherId: user._id?.toString() },
        { teacherId: user.firebaseUid },
        { teacherId: user.name },
        { teacherId: { $regex: new RegExp(`^${user.name?.trim()}$`, 'i') } },
        { teacherName: user.name },
        { teacherName: { $regex: new RegExp(`^${user.name?.trim()}$`, 'i') } }
      ];
    }
    
    const schedules = await Schedule.find(query)
      .populate('teacherId', 'name')
      .sort({ dayOfWeek: 1, startTimeSlot: 1 });
    
    res.json(schedules.map(formatScheduleResponse));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get schedule for a specific day (defaults to today)
router.get('/day-view', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const dateStr = req.query.date as string;
    
    // Use provided date or default to today
    const targetDate = dateStr ? new Date(dateStr) : new Date();
    
    // check if valid date
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    const dayOfWeek = targetDate.getDay();
    
    const baseQuery: any = { isActive: true };
    
    if (user.role === 'student') {
      const normalizedUserBatch = normalizeBatchName(user.batch);
      baseQuery.$or = [
        {
          classLevel: user.classLevel,
          $or: normalizedUserBatch
            ? [
                { batch: normalizedUserBatch },
                { batches: normalizedUserBatch },
              ]
            : [
                { batch: { $in: ['', null] } },
                { batches: { $size: 0 } },
              ]
        },
        { students: user.id },
        { students: user.firebaseUid }
      ];
    } else if (user.role === 'teacher') {
      // Match by teacherId OR teacherName (case-insensitive)
      // Note: Some schedules store teacher name in teacherId field
      baseQuery.$or = [
        { teacherId: user.id },
        { teacherId: user._id?.toString() },
        { teacherId: user.firebaseUid },
        { teacherId: user.name },
        { teacherId: { $regex: new RegExp(`^${user.name?.trim()}$`, 'i') } },
        { teacherName: user.name },
        { teacherName: { $regex: new RegExp(`^${user.name?.trim()}$`, 'i') } }
      ];
    }
    
    // Regular schedule for this day of week
    const regularSchedules = await Schedule.find({
      ...baseQuery,
      scheduleType: 'regular',
      dayOfWeek
    }).sort({ startTimeSlot: 1 });
    
    // Custom schedules for this specific date
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);
    
    const customSchedules = await Schedule.find({
      ...baseQuery,
      scheduleType: 'custom',
      date: { $gte: startOfDay, $lte: endOfDay }
    }).sort({ startTimeSlot: 1 });
    
    res.json([...regularSchedules, ...customSchedules].map(formatScheduleResponse));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get complete institute schedule for a specific date (Admin/Public view)
router.get('/institute-view', authMiddleware, async (req: Request, res: Response) => {
  try {
    const dateStr = req.query.date as string;
    const targetDate = dateStr ? new Date(dateStr) : new Date();

    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    const dayOfWeek = targetDate.getDay();
    const baseQuery: any = { isActive: true };

    // Regular schedule matching day of week
    const regularSchedules = await Schedule.find({
      ...baseQuery,
      scheduleType: 'regular',
      dayOfWeek
    }).sort({ startTimeSlot: 1, classLevel: 1, batch: 1 });

    // Custom schedules for this specific date
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const customSchedules = await Schedule.find({
      ...baseQuery,
      scheduleType: 'custom',
      date: { $gte: startOfDay, $lte: endOfDay }
    }).sort({ startTimeSlot: 1, classLevel: 1, batch: 1 });

    res.json([...regularSchedules, ...customSchedules].map(formatScheduleResponse));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create schedule - Invalidates schedule caches
router.post('/', authMiddleware, invalidateCacheOn(['schedule']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { teacherId, batches: rawBatches, ...scheduleData } = req.body;
    const normalizedBatches = normalizeBatchList(rawBatches, scheduleData.batch);
    const primaryBatch = normalizedBatches[0] || '';
    
    // Get teacher name for denormalization (try MongoDB first, then Firebase)
    let teacherName = '';
    if (teacherId) {
      teacherName = await resolveTeacherNameAndSync(teacherId);
    }
    
    // Check for conflicts (room + teacher double-booking, teacher leave) — shared helper
    const conflictResult = await checkScheduleConflict({
      scheduleType: scheduleData.scheduleType,
      startTimeSlot: scheduleData.startTimeSlot,
      endTimeSlot: scheduleData.endTimeSlot,
      dayOfWeek: scheduleData.dayOfWeek,
      date: scheduleData.date,
      roomNumber: scheduleData.roomNumber,
      teacherId,
      teacherName,
      classLevel: scheduleData.classLevel,
      batch: primaryBatch,
      batches: normalizedBatches,
    });
    if (conflictResult.ok === false) {
      return res.status(conflictResult.status).json(conflictResult.body);
    }

    // For regular schedules: also check for clashes with future custom schedules
    // on the same day of week. Evaluated through the same rule engine, so the
    // combined-batch policy applies here too — a regular 11th B1 slot must not
    // be rejected by a custom 11th B2 session sharing its room.
    if (scheduleData.scheduleType === 'regular') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      // MongoDB $dayOfWeek: 1=Sunday, 2=Monday ... 7=Saturday; JS: 0=Sunday, 1=Monday
      const mongoDay = (Number(scheduleData.dayOfWeek) % 7) + 1;

      const futureCustomDocs = await Schedule.find({
        isActive: true,
        scheduleType: 'custom',
        date: { $gte: today },
        $expr: { $eq: [{ $dayOfWeek: '$date' }, mongoDay] },
      })
        .select(`${CONFLICT_CANDIDATE_FIELDS} date`)
        .lean();

      const candidate: ScheduleSession = {
        classLevel: String(scheduleData.classLevel ?? ''),
        batch: primaryBatch,
        batches: normalizedBatches,
        startTimeSlot: scheduleData.startTimeSlot,
        endTimeSlot: resolveEndTimeSlot(scheduleData.startTimeSlot, scheduleData.endTimeSlot),
        roomNumber: Number.isFinite(Number(scheduleData.roomNumber)) ? Number(scheduleData.roomNumber) : null,
        teacherId: teacherId ? String(teacherId) : undefined,
        teacherName,
      };

      for (const doc of futureCustomDocs) {
        const blocking = findSessionConflicts(candidate, [docToSession(doc)]).find(
          (i) => i.severity === 'error'
        );
        if (blocking) {
          const d = new Date((doc as any).date).toLocaleDateString('en-IN');
          return res.status(400).json({
            error: `${blocking.message} That is a custom class on ${d} — remove or reschedule it first.`,
          });
        }
      }
    }

    // Teacher-leave overlap for custom schedules is already covered by checkScheduleConflict above.

    const schedule = new Schedule({
      ...scheduleData,
      batch: primaryBatch,
      batches: normalizedBatches,
      teacherId,
      teacherName,
      createdBy: user.id
    });
    
    await schedule.save();
    
    // Send notifications
    const dayName = scheduleData.dayOfWeek !== undefined ? DAYS_OF_WEEK[scheduleData.dayOfWeek] : '';
    const timeLabel = TIME_SLOTS.find(t => t.start === scheduleData.startTimeSlot)?.label || scheduleData.startTimeSlot;
    
    const notificationTitle = `New Class: ${schedule.subject}`;
    const notificationBody = schedule.scheduleType === 'regular'
      ? `${schedule.subject} class scheduled every ${dayName} at ${timeLabel} in Room ${schedule.roomNumber}`
      : `${schedule.subject} class on ${new Date(schedule.date!).toLocaleDateString()} at ${timeLabel} in Room ${schedule.roomNumber}`;
    
    // Notify students
    notifyScheduleAudienceByBatches(
      notificationTitle,
      notificationBody,
      schedule.classLevel,
      getScheduleBatches(schedule)
    ).catch(err => console.error('Schedule notification failed:', err));
    
    // Notify teacher
    if (teacherId) {
      sendTeacherNotification(
        teacherId,
        `New Class Assigned: ${schedule.subject}`,
        notificationBody
      ).catch(err => console.error('Teacher notification failed:', err));
    }
    
    res.status(201).json(schedule);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update schedule - Invalidates schedule caches
router.put('/:scheduleId', authMiddleware, invalidateCacheOn(['schedule']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { teacherId, batches: rawBatches, ...updateData } = req.body;

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'batches') || Object.prototype.hasOwnProperty.call(req.body || {}, 'batch')) {
      const normalizedBatches = normalizeBatchList(rawBatches, updateData.batch);
      updateData.batches = normalizedBatches;
      updateData.batch = normalizedBatches[0] || '';
    }

    // Get teacher name if changed
    let resolvedTeacherName = '';
    if (teacherId) {
      resolvedTeacherName = await resolveTeacherNameAndSync(teacherId);
      updateData.teacherName = resolvedTeacherName || '';
      updateData.teacherId = teacherId;
    }

    // Fetch current document to fill in any fields not present in updateData
    const existing = await Schedule.findById(req.params.scheduleId);
    if (!existing) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    const effectiveStart = updateData.startTimeSlot || existing.startTimeSlot;
    const effectiveType: string = updateData.scheduleType || existing.scheduleType;
    const effectiveDayOfWeek = updateData.dayOfWeek ?? existing.dayOfWeek;
    const effectiveDate = updateData.date || existing.date;
    const effectiveRoom = updateData.roomNumber ?? existing.roomNumber;
    const effectiveTeacherId = teacherId || existing.teacherId;
    const effectiveEnd = updateData.endTimeSlot || existing.endTimeSlot;
    const effectiveClassLevel = updateData.classLevel ?? existing.classLevel;
    const effectiveBatches =
      updateData.batches ?? (Array.isArray(existing.batches) ? existing.batches : undefined);
    const effectiveBatch = updateData.batch ?? existing.batch;

    // Conflict check (room + teacher double-booking, teacher leave) — exclude self, shared helper.
    // Note: this now also enforces the teacher-leave check for custom schedules, which PUT
    // previously lacked (POST already had it) — an intentional fix, not just a refactor.
    const conflictResult = await checkScheduleConflict(
      {
        scheduleType: effectiveType as 'regular' | 'custom',
        startTimeSlot: effectiveStart,
        endTimeSlot: effectiveEnd,
        dayOfWeek: effectiveDayOfWeek,
        date: effectiveDate,
        roomNumber: effectiveRoom,
        teacherId: effectiveTeacherId,
        teacherName: resolvedTeacherName || existing.teacherName,
        classLevel: effectiveClassLevel,
        batch: effectiveBatch,
        batches: effectiveBatches,
      },
      { excludeId: req.params.scheduleId }
    );
    if (conflictResult.ok === false) {
      return res.status(conflictResult.status).json(conflictResult.body);
    }

    const schedule = await Schedule.findByIdAndUpdate(
      req.params.scheduleId,
      updateData,
      { new: true }
    );

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    
    // Send update notification
    notifyScheduleAudienceByBatches(
      `Schedule Updated: ${schedule.subject}`,
      'Class schedule has been updated. Please check the timetable for details.',
      schedule.classLevel,
      getScheduleBatches(schedule)
    ).catch(err => console.error('Update notification failed:', err));
    
    res.json(schedule);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete schedule
// Get students from both MongoDB and Firebase for targeting
router.get('/students', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { classLevel, batch, search } = req.query;
    const students: any[] = [];

    // 1. Fetch from MongoDB
    const mongoQuery: any = { role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE };
    if (classLevel) mongoQuery.classLevel = classLevel;
    if (batch) mongoQuery.batch = batch;
    if (search) {
      mongoQuery.name = { $regex: search, $options: 'i' };
    }

    const mongoStudents = await User.find(mongoQuery)
      .select('name email classLevel batch fcmToken')
      .lean();

    students.push(...mongoStudents.map(s => ({
      id: s._id,
      name: s.name,
      email: s.email,
      classLevel: s.classLevel,
      batch: s.batch,
      source: 'mongo',
      pushToken: s.pushToken
    })));

    // 2. Fetch from Firebase
    try {
      const admin = getFirebaseAdmin();
      if (admin) {
        let firestoreQuery = admin.firestore().collection('users')
          .where('role', '==', 'student');
        
        if (classLevel) firestoreQuery = firestoreQuery.where('classLevel', '==', classLevel);
        if (batch) firestoreQuery = firestoreQuery.where('batch', '==', batch);
        
        const snapshot = await firestoreQuery.get();
        
        snapshot.docs.forEach((doc: any) => {
          const data = doc.data();
          // Simple client-side search filter for Firebase results if search param exists
          if (search && !data.name?.toLowerCase().includes((search as string).toLowerCase())) {
            return;
          }
          
          // Avoid duplicates if user exists in both (matching by email)
          if (!students.find(s => s.email === data.email)) {
            students.push({
              id: doc.id,
              name: data.name || 'Unknown Student',
              email: data.email,
              classLevel: data.classLevel,
              batch: data.batch,
              source: 'firebase',
              fcmToken: data.fcmToken
            });
          }
        });
      }
    } catch (fbError) {
      console.error('Error fetching from Firebase:', fbError);
      // Continue with just Mongo students if Firebase fails
    }

    res.json(students);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
// Delete schedule - Invalidates schedule caches
router.delete('/:scheduleId', authMiddleware, invalidateCacheOn(['schedule']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const schedule = await Schedule.findById(req.params.scheduleId);
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // ── Retire, don't erase ───────────────────────────────────────────────
    // A weekly slot that has been running for months is not undone by being
    // removed today. Hard-deleting it erased every past occurrence from every
    // historical report — a class that was genuinely taught in July silently
    // stopped having been scheduled. So the default is retirement: the row is
    // deactivated and given an end date, which keeps it out of every live view
    // (they all filter `isActive`) while leaving history intact.
    //
    // `effectiveTo` defaults to TODAY rather than yesterday: on the day of
    // removal we cannot know whether the class had already run. Keeping it
    // risks one explainable "uncovered class" flag that the timeline makes
    // obvious; dropping it would silently delete a lesson the teacher taught
    // this morning. Callers who know better can pass an explicit date.
    //
    // `?hard=true` is the escape hatch for a row created in error, which never
    // ran and should not appear in any report.
    const hard = String(req.query.hard || '') === 'true';
    if (hard) {
      await Schedule.findByIdAndDelete(req.params.scheduleId);
    } else {
      const requested = String(req.query.effectiveTo || '').trim();
      let endDate = new Date();
      if (/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
        const [y, m, d] = requested.split('-').map(Number);
        endDate = new Date(y, m - 1, d);
      }
      endDate.setHours(23, 59, 59, 999);

      schedule.isActive = false;
      // Custom sessions carry their own single date; an end date on them would
      // be noise, and a session removed before its date should simply not count.
      if (schedule.scheduleType === 'regular') {
        schedule.effectiveTo = endDate;
      }
      await schedule.save();
    }

    // Notify about cancellation
    notifyScheduleAudienceByBatches(
      `Class Cancelled: ${schedule.subject}`,
      `The ${schedule.subject} class has been cancelled.`,
      schedule.classLevel,
      getScheduleBatches(schedule)
    ).catch(err => console.error('Cancel notification failed:', err));
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// SCHEDULE IMAGE IMPORT (AI extraction → review → bulk save)
// ========================
//
// Flow: POST /extract-image (vision read, nothing persisted) → admin reviews/edits
// client-side, calling POST /bulk/validate as they go → POST /bulk (re-validates,
// then Schedule.insertMany + one consolidated notification per affected batch/teacher).
// The existing single-entry POST/PUT above are completely untouched by this section.

const scheduleImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req: any, file: any, cb: any) => {
    const okTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (okTypes.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Only image files (PNG/JPEG/WEBP) are allowed'));
  },
});

function normalizeForMatch(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Exact → prefix → token-overlap match against a small candidate list (tens of items). */
function matchBatchLabel(raw: string | undefined, candidates: string[]): { matched: string | null } {
  const needle = normalizeForMatch(raw || '');
  if (!needle) return { matched: null };

  for (const c of candidates) {
    if (normalizeForMatch(c) === needle) return { matched: c };
  }
  for (const c of candidates) {
    const cn = normalizeForMatch(c);
    if (cn.startsWith(needle) || needle.startsWith(cn)) return { matched: c };
  }
  const needleTokens = new Set(needle.split(' ').filter(Boolean));
  let best: { name: string; score: number } | null = null;
  for (const c of candidates) {
    const overlap = normalizeForMatch(c).split(' ').filter((t) => needleTokens.has(t)).length;
    if (overlap > 0 && (!best || overlap > best.score)) best = { name: c, score: overlap };
  }
  return { matched: best ? best.name : null };
}

/** Never silently pick between two equally-good matches (e.g. two "Priya"s). */
function matchTeacherName(
  raw: string | undefined,
  teachers: { id: string; name: string }[]
): { id: string | null; name: string; ambiguous: boolean } {
  const rawTrimmed = String(raw || '').trim();
  const needle = normalizeForMatch(rawTrimmed);
  if (!needle) return { id: null, name: rawTrimmed, ambiguous: false };

  const exact = teachers.filter((t) => normalizeForMatch(t.name) === needle);
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].name, ambiguous: false };
  if (exact.length > 1) return { id: null, name: rawTrimmed, ambiguous: true };

  const needleTokens = needle.split(' ').filter(Boolean);
  const partial = teachers.filter((t) => {
    const tTokens = normalizeForMatch(t.name).split(' ').filter(Boolean);
    return needleTokens.some((nt) => tTokens.includes(nt));
  });
  if (partial.length === 1) return { id: partial[0].id, name: partial[0].name, ambiguous: false };
  if (partial.length > 1) return { id: null, name: rawTrimmed, ambiguous: true };

  return { id: null, name: rawTrimmed, ambiguous: false };
}

// Cell text follows "Teacher Name [note] Room-Number", e.g. "Harsh sir 3" or
// "Archit sir extra class 6". A trailing 1-2 digit number (1-11) is the room —
// never part of the teacher's name — and a small set of recognizable note
// keywords (extra class, makeup, etc.) get pulled out separately. This is a
// deterministic safety net: it runs regardless of whether the model itself
// split the cell cleanly, so a model that dumps the whole cell into
// "teacherName" still resolves correctly.
const CELL_NOTE_KEYWORDS: RegExp[] = [
  /extra\s*-?\s*class/i,
  /make\s*-?\s*up/i,
  /doubt\s*-?\s*class/i,
  /revision\s*-?\s*class/i,
  /special\s*-?\s*class/i,
  /demo\s*-?\s*class/i,
];

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function splitCellText(rawCellText: string): { teacherName: string; roomNumber: number | null; note: string } {
  let text = String(rawCellText || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let note = '';
  for (const kw of CELL_NOTE_KEYWORDS) {
    const m = text.match(kw);
    if (m) {
      note = titleCase(m[0].replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim());
      text = text.replace(kw, ' ').replace(/\s+/g, ' ').trim();
      break;
    }
  }

  let roomNumber: number | null = null;
  let teacherName = text;
  const roomMatch = text.match(/^(.*?)[\s,\-–—]*?(\d{1,2})$/);
  if (roomMatch) {
    const n = Number(roomMatch[2]);
    if (n >= 1 && n <= 11) {
      roomNumber = n;
      teacherName = roomMatch[1].trim();
    }
  }

  teacherName = teacherName.replace(/[\s,\-–—]+$/, '').trim();
  return { teacherName, roomNumber, note };
}

/**
 * Deterministically parse a verbatim column header like "4:30-5:30PM" into
 * 24h start/end. The model is NEVER trusted to compute or normalize this
 * itself (per anti-hallucination requirement) — it only transcribes the
 * printed text, and this is the one place that turns it into a time. Meridiem
 * is read from the trailing AM/PM only; the start hour's AM/PM is inferred by
 * picking whichever interpretation yields a short, positive duration (handles
 * ranges that cross noon, e.g. "11:30-12:30PM" = 11:30 AM to 12:30 PM).
 * Returns null if the header can't be confidently parsed — callers must flag
 * for review rather than guess.
 */
function parseTimeRangeLabel(label: string): { startTimeSlot: string; endTimeSlot: string } | null {
  const m = String(label || '').match(/(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  const startHour = Number(m[1]);
  const startMin = Number(m[2]);
  const endHour = Number(m[3]);
  const endMin = Number(m[4]);
  const meridiem = m[5].toUpperCase();
  if (startHour < 1 || startHour > 12 || endHour < 1 || endHour > 12) return null;
  if (startMin > 59 || endMin > 59) return null;

  const to24 = (h: number, isPM: boolean) => (h === 12 ? (isPM ? 12 : 0) : isPM ? h + 12 : h);
  const endIsPM = meridiem === 'PM';
  const end24 = to24(endHour, endIsPM);
  const endTotalMin = end24 * 60 + endMin;

  const candidates = [false, true]
    .map((isPM) => {
      const h24 = to24(startHour, isPM);
      const totalMin = h24 * 60 + startMin;
      return { h24, duration: endTotalMin - totalMin };
    })
    .filter((c) => c.duration > 0 && c.duration <= 180);
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.duration - b.duration);

  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    startTimeSlot: `${pad(candidates[0].h24)}:${pad(startMin)}`,
    endTimeSlot: `${pad(end24)}:${pad(endMin)}`,
  };
}

/**
 * Deterministically split a verbatim row label ("8th adv", "11th JEE B1",
 * "7th") into classLevel + batch. The model only transcribes the label; it
 * never decides this split itself, removing an entire class of drift where
 * the same row could be split differently across cells.
 */
function parseRowLabel(label: string): { classLevel: string; batch: string } | null {
  const m = String(label || '').trim().match(/^(\d{1,2})\s*(?:st|nd|rd|th)?\.?\s*(.*)$/i);
  if (!m) return null;
  return { classLevel: m[1], batch: m[2].trim() };
}

// A populated timetable cell is a teacher allocation (+ optional room/note),
// NOT a general announcement or reminder — those must never become schedule
// entries. Strong signals: a trailing room number, or a common honorific.
// Short cells (<=3 words, no sentence punctuation) are still allowed through
// since most genuine allocations are just a bare name; longer sentence-like
// text is treated as a note and excluded.
const HONORIFIC_RE = /\b(sir|ma'?am|madam|miss|mr|mrs|ms)\b/i;
function looksLikeScheduleCell(rawText: string): boolean {
  const text = String(rawText || '').trim();
  if (!text) return false;
  if (HONORIFIC_RE.test(text)) return true;
  if (/\d{1,2}\s*$/.test(text)) return true;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 3 && !/[.!?](\s+\w)/.test(text)) return true;
  return false;
}

/** Trust the extracted date only if it parses and lands near the admin's hint date. */
function resolveScheduleDate(extractedIso: unknown, hintIso: string): { date: string; needsReview: boolean } {
  const hint = /^\d{4}-\d{2}-\d{2}$/.test(hintIso) ? hintIso : new Date().toISOString().split('T')[0];
  if (typeof extractedIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(extractedIso)) {
    return { date: hint, needsReview: true };
  }
  const extractedMs = new Date(extractedIso).getTime();
  const hintMs = new Date(hint).getTime();
  if (Number.isNaN(extractedMs)) return { date: hint, needsReview: true };

  const diffDays = (extractedMs - hintMs) / (1000 * 60 * 60 * 24);
  return diffDays >= -3 && diffDays <= 14
    ? { date: extractedIso, needsReview: false }
    : { date: hint, needsReview: true };
}

// clampRoomNumber / isValidTimeString now come from scheduleValidator — the
// room range is an institute policy value, not a constant of this route file.

async function normalizeImageForVision(buffer: Buffer): Promise<{ buffer: Buffer; mimeType: string }> {
  try {
    const meta = await sharp(buffer).metadata();
    const format = meta.format;
    if (format === 'jpeg' || format === 'png' || format === 'webp') {
      const resized = await sharp(buffer).resize({ width: 2500, withoutEnlargement: true }).toBuffer();
      return { buffer: resized, mimeType: format === 'jpeg' ? 'image/jpeg' : `image/${format}` };
    }
    // heic/bmp/gif/tiff/unknown → re-encode to PNG (mirrors aiService.ts's OCR normalize step).
    const png = await sharp(buffer).resize({ width: 2500, withoutEnlargement: true }).png().toBuffer();
    return { buffer: png, mimeType: 'image/png' };
  } catch (convErr) {
    console.warn('[schedule/extract-image] image normalize failed, sending original bytes:', convErr instanceof Error ? convErr.message : convErr);
    return { buffer, mimeType: 'image/png' };
  }
}

function buildScheduleExtractionPrompt(): string {
  // KEEP THIS PROMPT SHORT. Verified A/B against the real 20x9 timetable, both
  // runs using the "detailed thinking off" directive and identical settings:
  //   1719 prompt tokens -> 312s, TRUNCATED at 32k tokens, 0 cells parsed
  //   1478 prompt tokens -> 144s, clean stop, 63 cells parsed
  // A mere ~240 extra tokens of instructions is enough to tip this reasoning
  // model into a runaway loop it never recovers from. Every rule deliberately
  // omitted here is enforced deterministically in the backend instead:
  //   non-class/announcement cells -> looksLikeScheduleCell()
  //   teacher/room/note splitting  -> splitCellText()
  //   row label -> class/batch     -> parseRowLabel()
  //   column header -> start/end   -> parseTimeRangeLabel()
  //   date sanity check            -> resolveScheduleDate()
  // Do NOT "improve" this by adding more instructions without re-running that
  // A/B — extra guidance here makes accuracy worse, not better.
  return `You are a STRICT TRANSCRIBER of a photographed DAILY CLASS SCHEDULE (timetable). Transcribe exactly what is printed. Never invent, guess, compute, or normalize anything.

TABLE STRUCTURE:
- The image may contain MULTIPLE STACKED TIMETABLE SECTIONS, each with its OWN column headers. Never reuse one section's columns for another.
- Columns are TIME-SLOT headers (e.g. "3:30-4:30PM"). Rows are CLASS/BATCH labels (e.g. "8th adv", "9th JEE", "11th JEE B1", "7th").
- A cell is the intersection of one row and one column. Transcribe a cell ONLY if it has visible text. Blank cells produce NOTHING.

PER CELL: transcribe the literal visible text verbatim on a SINGLE LINE, joining multiple lines with one space.

DATE: find the date printed once. Source format DD-MM-YYYY; output ISO YYYY-MM-DD.

Return ONLY this raw JSON object, plain JSON (do NOT backslash-escape quotes), no markdown, no commentary:
{"scheduleDate":"YYYY-MM-DD","sections":[{"columns":["3:30-4:30PM"],"rows":["9th JEE"],"cells":[{"row":"9th JEE","column":"3:30-4:30PM","rawText":"Archit sir 4"}]}],"warnings":[]}

Rules:
- Each cell's "row"/"column" must copy EXACTLY a string from that section's own "rows"/"columns" arrays.
- List every populated cell once. Never list a blank cell or duplicate an intersection.`;
}

/**
 * Fallback prompt for the one retry: extraction only, nothing else. Kept
 * deliberately tiny — the full prompt is already short, so if the model still
 * narrated instead of transcribing, MORE instructions are the wrong answer.
 */
function buildMinimalScheduleExtractionPrompt(): string {
  return `Transcribe this timetable image to JSON. Output JSON only. First character must be {.
{"scheduleDate":"YYYY-MM-DD","sections":[{"columns":["3:30-4:30PM"],"rows":["9th JEE"],"cells":[{"row":"9th JEE","column":"3:30-4:30PM","rawText":"Archit sir 4"}]}],"warnings":[]}
Columns are time slots, rows are class labels. Copy each non-empty cell's text verbatim. Skip blank cells. The printed date is DD-MM-YYYY.`;
}

/** ai.vision() has no JSON mode and no built-in retry (unlike chatJSON) — hand-roll one corrective retry. */
async function visionExtractJSON<T = any>(
  prompt: string,
  image: { data: Buffer; mimeType: string },
  label: string
): Promise<T> {
  // This model is a REASONING model, so the only thing that keeps it an
  // extractor is `reasoning: 'off'` actually taking effect. It does now:
  // nemotron-3 ignores every system-prompt thinking directive and honors only
  // the chat-template flag the provider sends — see templateKwargsFor() in
  // nvidiaProvider.ts for the measured before/after. With thinking genuinely
  // off, a 20x9 timetable is ~3k completion tokens in ~30s.
  //
  // Reasoning-off is necessary but NOT sufficient: with thinking fully off and
  // zero reasoning bytes, this model still degenerates into repeating JSON
  // cells on roughly one run in five, climbing to its 32,768-token ceiling.
  // maxStreamChunks below is what catches that; `json: true` and the duration
  // cap are backstops.
  const model = aiConfig.nvidia.scheduleVisionModel;
  // Sized for a dense real timetable (~75 cells ≈ 3k tokens of JSON) with
  // headroom. NOTE: verified live that this endpoint IGNORES max_tokens for
  // nemotron-3 (a 200-token cap still returned 2,980 completion tokens), so
  // treat this as advisory only — never as the thing that bounds a runaway.
  const maxTokens = 6000;
  // Belt-and-braces only. This endpoint delivers ALL text in one final chunk,
  // so a content-length bound cannot trip until everything has already been
  // generated — it is inert here and kept purely for providers that stream
  // incrementally. maxStreamChunks below is what actually bounds this model.
  const maxOutputChars = 24000;
  // THE effective runaway bound. Chunk count tracks generated tokens ~1:0.96 on
  // this endpoint, so this is a ~14.5k-token ceiling. Sized off measurements:
  // healthy runs came in at 2,980 / 3,021 / 3,058 / 7,141 completion tokens, so
  // this leaves ~2x headroom over the largest good run, while cutting a runaway
  // (which climbs to the model's 32,768 ceiling) at roughly 110s instead of
  // 250s. Aborting costs us nothing real: because the text only arrives at the
  // end, a run that blew this budget had produced no usable output anyway.
  const maxStreamChunks = 14000;
  // Pure backstop now, deliberately generous. It must NOT be the thing that
  // stops a slow run: this endpoint hands over the whole response in its last
  // chunk, so aborting on time throws away a complete, correct answer and
  // reports it as 'empty'. That is exactly what a 120s cap did to a healthy
  // 49s-to-250s spread of runs. maxStreamChunks fails a runaway earlier and on
  // the right signal; this only catches a stream that stalls in a way neither
  // the chunk cap nor the idle watchdog can see.
  const attemptMaxDurationMs = 150000;
  // Ceiling on the admin's TOTAL wait across both attempts, so a retry can
  // never double a worst case into multiple minutes. Attempt two runs on
  // whatever is left, and is skipped entirely if too little remains to matter.
  const totalBudgetMs = 260000;
  const deadline = Date.now() + totalBudgetMs;
  const remainingMs = () => deadline - Date.now();

  const attempt = async (attemptPrompt: string, attemptLabel: string) => {
    const res = await ai.vision(attemptPrompt, [image], {
      model,
      maxTokens,
      temperature: 0,
      json: true,
      // Decisive for dense tables — see the comment in NvidiaProvider.vision().
      reasoning: 'off',
      maxDurationMs: Math.min(attemptMaxDurationMs, Math.max(remainingMs(), 0)),
      maxOutputChars,
      maxStreamChunks,
      label: attemptLabel,
    });

    const text = res.text || '';
    const truncated = res.finishReason === 'length';
    // Diagnostics on the RAW response (never the image/base64) so a future
    // failure is debuggable from logs alone. streamChunks is the important one
    // on this endpoint: it is the only measure of how much the model generated
    // when the response never arrives (all text lands in the final chunk, so a
    // cut-off run reports 0 length and 0 tokens while having worked for
    // minutes). chunks >= maxStreamChunks means it ran away, not that it hung.
    console.log(`[${attemptLabel}] raw response diagnostics`, {
      length: text.length,
      finishReason: res.finishReason,
      truncated,
      completionTokens: res.usage?.completionTokens,
      streamChunks: res.streamChunks,
      hitChunkCap: (res.streamChunks || 0) > maxStreamChunks,
      hasMarkdownFence: /```/.test(text),
      jsonObjectStarts: (text.match(/\{/g) || []).length,
      head: text.slice(0, 200),
      tail: text.slice(-200),
    });

    if (truncated) {
      // Never try to repair a half-written document into a partial schedule.
      return { ok: false as const, reason: 'truncated' as const };
    }

    // No content at all. On this endpoint that does NOT mean the model sat
    // idle — text only ever arrives in the final chunk, so any abort before
    // that point looks identical to silence. Retryable for exactly that reason.
    if (!text.trim()) return { ok: false as const, reason: 'empty' as const };

    // Cheapest possible tell that the model answered as an assistant instead of
    // as an extractor ("The user wants me to transcribe…"). Bail on the FIRST
    // character rather than letting safeParse salvage a JSON blob out of the
    // middle of a narration — a response that starts with prose was reasoning,
    // and whatever JSON it eventually reached is not trustworthy.
    if (text.trimStart()[0] !== '{') return { ok: false as const, reason: 'not-json' as const };

    const parsed = safeParse<any>(text);
    if (parsed === undefined) return { ok: false as const, reason: 'unparseable' as const };

    // Shape check: JSON.parse succeeding is NOT enough. An over-escaped
    // response (observed live: `{"scheduleDate\":\"...` ) parses "fine" into
    // a single garbage key and would otherwise surface as a silent
    // "0 rows extracted" instead of an honest error.
    const sections = (parsed as any)?.sections;
    if (!Array.isArray(sections)) return { ok: false as const, reason: 'wrong-shape' as const };

    return { ok: true as const, value: parsed as T };
  };

  const first = await attempt(prompt, label);
  if (first.ok) return first.value;

  // EVERY failure mode here is retryable, because all of them are re-rolls of
  // the same non-deterministic model rather than verdicts on the image:
  // measured at temperature 0, the identical request converged in 38s on one
  // run and looped to the token ceiling on the next. The retry is bounded by
  // the shared deadline, so this can never become an unbounded wait.
  const MIN_USEFUL_RETRY_MS = 45000;
  if (remainingMs() < MIN_USEFUL_RETRY_MS) {
    throw new Error(`Schedule extraction did not complete (${first.reason}, no time left to retry)`);
  }

  // ONE retry, on a SMALLER prompt — not the same prompt plus more rules. The
  // failure mode being retried is "the model started explaining instead of
  // transcribing", and appending corrective instructions to an already-failed
  // prompt only gives it more to reason about. Never re-feed the previous
  // (potentially huge/garbled) output back either — that was what produced the
  // 32k-token, 186-second retry.
  console.warn(
    `[${label}] first attempt failed (${first.reason}) — retrying once with the minimal extraction prompt ` +
    `(${Math.round(remainingMs() / 1000)}s of budget left)`
  );
  const second = await attempt(buildMinimalScheduleExtractionPrompt(), `${label}:minimal`);
  if (second.ok) return second.value;

  throw new Error(`Schedule extraction failed to produce usable JSON (${first.reason} → ${second.reason})`);
}

// Extract entries from an uploaded schedule photo. Nothing is written to Mongo here.
router.post(
  '/extract-image',
  authMiddleware,
  requireRole('admin'),
  aiLimiter,
  uploadLimiter,
  scheduleImageUpload.single('image'),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
      }

      const dateHint = typeof req.body?.dateHint === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.dateHint)
        ? req.body.dateHint
        : new Date().toISOString().split('T')[0];

      const { buffer: visionBuffer, mimeType } = await normalizeImageForVision(req.file.buffer);

      // Upload the ORIGINAL bytes (not the downscaled copy sent to the model) so the
      // review screen's compare-to-original panel is full quality.
      const ext = (req.file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const imageUrl = await uploadToFirebase(
        req.file.buffer,
        `schedule-imports/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`,
        req.file.mimetype
      );

      const [batchConfig, teacherDocs] = await Promise.all([
        getStudentBatchConfigFromDatabase(),
        User.find({ role: 'teacher' }).select('_id name').lean(),
      ]);
      const teacherList = teacherDocs.map((t: any) => ({ id: String(t._id), name: String(t.name || '') }));

      // batchConfig/teacherList are NOT sent to the model — they're used below,
      // after extraction, for deterministic backend matching.
      const prompt = buildScheduleExtractionPrompt();

      let raw: {
        scheduleDate?: string;
        sections?: Array<{ columns?: any[]; rows?: any[]; cells?: any[] }>;
        warnings?: string[];
      };
      try {
        raw = await visionExtractJSON(prompt, { data: visionBuffer, mimeType }, 'schedule-extract');
      } catch (visionErr) {
        // Don't surface err.message here: on a real NVIDIA failure, withFallback's
        // Ollama fallback throws its own unrelated "OLLAMA_VISION_MODEL not configured"
        // error and that (not the real failure) is what a naive res.json({error:err.message})
        // would show the admin. Log the real one, show a generic, actionable one.
        console.error('[schedule/extract-image] vision extraction failed:', visionErr);
        return res.status(502).json({
          error: "Couldn't read this schedule image. Try a clearer photo, or add classes manually with Add Schedule.",
        });
      }

      const { date: scheduleDate, needsReview: scheduleDateNeedsReview } = resolveScheduleDate(raw?.scheduleDate, dateHint);

      // ---- Structural validation pipeline ----
      // The model only transcribed sections/rows/columns/cells verbatim (never
      // computed class/time itself). Every cell is validated against its own
      // section's DECLARED rows/columns before it can become an entry — a cell
      // whose row or column doesn't match anything the model itself declared is
      // hallucinated and gets rejected, not guessed into shape. This structurally
      // caps entries at (rows × columns) per section — no amount of over-eager
      // model output can produce more real entries than there are grid cells.
      interface RejectedCell { row: string; column: string; rawText: string; reason: string }
      const rejected: RejectedCell[] = [];
      let declaredCellCount = 0;
      const seenCellKeys = new Set<string>();
      const seenResolvedKeys = new Set<string>();

      type BuiltEntry = ReturnType<typeof buildEntry>;
      function buildEntry(idx: number, opts: {
        rowLabel: string; columnLabel: string; rawText: string;
        classLevel: string; classLevelRaw: string;
        columnParsed: { startTimeSlot: string; endTimeSlot: string } | null;
      }) {
        const uncertainFields = new Set<string>();

        const classLevel = normalizeClassValue(opts.classLevel) || opts.classLevel;
        if (!classLevel) uncertainFields.add('classLevel');

        const batchCandidates = classLevel ? batchConfig.batchRules[classLevel] || [] : [];
        const rowParsed = parseRowLabel(opts.rowLabel);
        const batchRaw = rowParsed?.batch || '';
        const { matched: matchedBatch } = matchBatchLabel(batchRaw, batchCandidates);
        if (batchRaw && !matchedBatch) uncertainFields.add('batch');

        const split = splitCellText(opts.rawText);
        const teacherRaw = split.teacherName.replace(/[\s,\-–—]*\d{1,2}\s*$/, '').trim();
        const roomNumber = split.roomNumber;
        const note = split.note;

        const { id: teacherId, name: teacherName, ambiguous: teacherAmbiguous } = matchTeacherName(teacherRaw, teacherList);
        if (!teacherRaw || !teacherId || teacherAmbiguous) uncertainFields.add('teacherName');
        if (roomNumber === null) uncertainFields.add('roomNumber');

        const startTimeSlot = opts.columnParsed?.startTimeSlot || '';
        const endTimeSlot = opts.columnParsed?.endTimeSlot || '';
        if (!opts.columnParsed) {
          uncertainFields.add('startTimeSlot');
          uncertainFields.add('endTimeSlot');
        }

        const subject = `Class ${classLevel || opts.classLevelRaw || '?'}${matchedBatch ? ' · ' + matchedBatch : ''}`.trim();

        return {
          tempId: `extract-${idx}-${Date.now()}`,
          classLevel,
          classLevelRaw: opts.classLevelRaw,
          batch: matchedBatch || batchRaw,
          batchRaw,
          startTimeSlot,
          endTimeSlot,
          roomNumber,
          teacherId: teacherId || '',
          teacherName: teacherName || teacherRaw,
          note,
          subject,
          confidence: (uncertainFields.size > 0 ? 'low' : 'high') as 'high' | 'low',
          needsReview: uncertainFields.size > 0,
          uncertainFields: Array.from(uncertainFields),
        };
      }

      const entries: BuiltEntry[] = [];
      const sections = Array.isArray(raw?.sections) ? raw.sections : [];

      sections.forEach((section, sectionIdx) => {
        const declaredRows: string[] = Array.isArray(section?.rows) ? section.rows.map((r: any) => String(r ?? '')) : [];
        const declaredColumns: string[] = Array.isArray(section?.columns) ? section.columns.map((c: any) => String(c ?? '')) : [];
        const rowByNorm = new Map(declaredRows.map((r) => [normalizeForMatch(r), r]));
        const columnByNorm = new Map(declaredColumns.map((c) => [normalizeForMatch(c), c]));

        // Parse each declared row/column ONCE (not per-cell) so every cell under
        // the same row/column resolves identically — no per-cell drift.
        const rowParseCache = new Map(declaredRows.map((r) => [r, parseRowLabel(r)]));
        const columnParseCache = new Map(declaredColumns.map((c) => [c, parseTimeRangeLabel(c)]));

        const cells = Array.isArray(section?.cells) ? section.cells : [];
        cells.forEach((cell: any) => {
          declaredCellCount += 1;
          const rowRaw = cell?.row !== undefined && cell?.row !== null ? String(cell.row) : '';
          const columnRaw = cell?.column !== undefined && cell?.column !== null ? String(cell.column) : '';
          const rawText = cell?.rawText !== undefined && cell?.rawText !== null ? String(cell.rawText) : '';

          const matchedRow = rowByNorm.get(normalizeForMatch(rowRaw));
          const matchedColumn = columnByNorm.get(normalizeForMatch(columnRaw));

          if (!matchedRow || !matchedColumn) {
            rejected.push({ row: rowRaw, column: columnRaw, rawText, reason: 'row/column not declared in this section (hallucinated coordinate)' });
            return;
          }
          if (!rawText.trim()) {
            rejected.push({ row: rowRaw, column: columnRaw, rawText, reason: 'blank cell' });
            return;
          }

          const cellKey = `${sectionIdx}|${normalizeForMatch(matchedRow)}|${normalizeForMatch(matchedColumn)}`;
          if (seenCellKeys.has(cellKey)) {
            rejected.push({ row: rowRaw, column: columnRaw, rawText, reason: 'duplicate cell (same row+column already used)' });
            return;
          }

          if (!looksLikeScheduleCell(rawText)) {
            rejected.push({ row: rowRaw, column: columnRaw, rawText, reason: 'looks like a note/announcement, not a teacher allocation' });
            return;
          }

          const rowParsed = rowParseCache.get(matchedRow);
          if (!rowParsed) {
            rejected.push({ row: rowRaw, column: columnRaw, rawText, reason: 'row label has no recognizable class number' });
            return;
          }

          seenCellKeys.add(cellKey);
          const entry = buildEntry(entries.length, {
            rowLabel: matchedRow,
            columnLabel: matchedColumn,
            rawText,
            classLevel: rowParsed.classLevel,
            classLevelRaw: matchedRow,
            columnParsed: columnParseCache.get(matchedColumn) || null,
          });

          // Cross-section duplicate guard: two different declared coordinates
          // that still resolve to the exact same real schedule slot.
          const resolvedKey = `${entry.classLevel}|${entry.batch}|${entry.startTimeSlot}|${entry.endTimeSlot}|${entry.teacherId || entry.teacherName}|${entry.roomNumber}`;
          if (seenResolvedKeys.has(resolvedKey)) {
            rejected.push({ row: rowRaw, column: columnRaw, rawText, reason: 'duplicate resolved schedule slot' });
            return;
          }
          seenResolvedKeys.add(resolvedKey);
          entries.push(entry);
        });
      });

      const modelWarnings = Array.isArray(raw?.warnings) ? raw.warnings : [];
      const rejectionSummary =
        rejected.length > 0
          ? [`${rejected.length} extracted cell(s) were rejected (not shown) — see meta.rejected for detail.`]
          : [];

      res.json({
        imageUrl,
        scheduleDate,
        scheduleDateNeedsReview,
        entries,
        warnings: [...modelWarnings, ...rejectionSummary],
        meta: {
          declaredCells: declaredCellCount,
          totalFound: entries.length,
          needsReviewCount: entries.filter((e) => e.needsReview).length,
          rejectedCount: rejected.length,
          rejected,
        },
      });
    } catch (error: any) {
      console.error('[schedule/extract-image] error:', error);
      res.status(500).json({ error: 'Failed to process the uploaded schedule image.' });
    }
  }
);

/** Re-exported shape for the bulk routes; the engine owns the definition. */
type BulkValidationIssue = ValidationIssue;

/**
 * Shared by /bulk/validate (dry-run) and /bulk (commit). This function now only
 * marshals data — every rule, including the institute's combined-batch policy,
 * is evaluated by scheduleValidator against schedulePolicy.
 */
async function validateBulkEntries(
  date: unknown,
  entries: unknown
): Promise<{ valid: boolean; issues: BulkValidationIssue[] }> {
  const issues: BulkValidationIssue[] = [];
  const dateStr = typeof date === 'string' ? date : '';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    issues.push({ severity: 'error', rule: 'dateRequired', message: 'A valid schedule date (YYYY-MM-DD) is required.' });
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    issues.push({ severity: 'error', rule: 'entriesRequired', message: 'At least one schedule entry is required.' });
    return { valid: false, issues };
  }

  const sessions: ScheduleSession[] = (entries as any[]).map((entry) => ({
    tempId: entry?.tempId,
    classLevel: String(entry?.classLevel ?? ''),
    batch: String(entry?.batch ?? ''),
    batches: Array.isArray(entry?.batches) ? entry.batches : undefined,
    startTimeSlot: isValidTimeString(entry?.startTimeSlot) ? entry.startTimeSlot : '',
    endTimeSlot: isValidTimeString(entry?.endTimeSlot) ? entry.endTimeSlot : '',
    roomNumber: clampRoomNumber(entry?.roomNumber),
    teacherId: entry?.teacherId || undefined,
    teacherName: entry?.teacherName || undefined,
    needsReview: !!entry?.needsReview,
  }));

  // Existing CUSTOM schedules for this date, fetched once so every entry is
  // compared against an identical DB snapshot (no mid-batch drift) and so the
  // whole check is one query rather than one per row.
  let existing: ScheduleSession[] = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const existingDocs = await Schedule.find({
      scheduleType: 'custom',
      isActive: true,
      date: dateStr,
    })
      .select(CONFLICT_CANDIDATE_FIELDS)
      .lean();
    existing = existingDocs.map(docToSession);
  }

  issues.push(...validateSessionSet(sessions, existing));

  return { valid: !hasBlockingIssue(issues), issues };
}

// Dry-run validation, called live as the admin edits the review screen. Never writes.
router.post('/bulk/validate', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { date, entries } = req.body || {};
    const result = await validateBulkEntries(date, entries);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Validation failed' });
  }
});

// Confirm & Save Schedule — the only place a bulk import actually writes to Mongo.
router.post('/bulk', authMiddleware, requireRole('admin'), invalidateCacheOn(['schedule']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { date, entries } = req.body || {};

    const validation = await validateBulkEntries(date, entries);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Validation failed', issues: validation.issues });
    }

    const docs = (entries as any[]).map((entry) => {
      const baseSubject =
        (entry.subject && String(entry.subject).trim()) ||
        `Class ${entry.classLevel}${entry.batch ? ' · ' + entry.batch : ''}`;
      const note = entry.note && String(entry.note).trim();
      // Schema has no dedicated notes field (Phase 1 scope) — fold a short
      // extraction note (e.g. "Extra Class") into the subject rather than a
      // schema change; still fully editable by the admin before saving.
      const subject = note && !baseSubject.includes(note) ? `${baseSubject} — ${note}` : baseSubject;
      return {
      scheduleType: 'custom' as const,
      type: 'class' as const,
      date,
      subject,
      classLevel: entry.classLevel,
      batch: entry.batch || '',
      batches: entry.batch ? [entry.batch] : [],
      startTimeSlot: entry.startTimeSlot,
      endTimeSlot: entry.endTimeSlot,
      // Non-null: validateBulkEntries already rejected any entry with an invalid room above.
      roomNumber: clampRoomNumber(entry.roomNumber) as number,
      teacherId: entry.teacherId || undefined,
      teacherName: entry.teacherName || undefined,
      createdBy: user.id,
      isActive: true,
      };
    });

    const created = await Schedule.insertMany(docs);

    // One consolidated push per affected batch, and one per affected teacher — never
    // one per row (a day's import can be 20-30+ rows). Fire-and-forget, same convention
    // as the existing single-entry POST/PUT/DELETE routes above.
    const byBatch = new Map<string, { classLevel: string; batch: string; count: number }>();
    const byTeacher = new Map<string, { teacherName: string; count: number }>();

    for (const doc of created) {
      const batchKey = `${doc.classLevel}|${doc.batch || ''}`;
      const batchGroup = byBatch.get(batchKey);
      if (batchGroup) batchGroup.count += 1;
      else byBatch.set(batchKey, { classLevel: doc.classLevel, batch: doc.batch || '', count: 1 });

      if (doc.teacherId) {
        const teacherGroup = byTeacher.get(doc.teacherId);
        if (teacherGroup) teacherGroup.count += 1;
        else byTeacher.set(doc.teacherId, { teacherName: doc.teacherName || 'Teacher', count: 1 });
      }
    }

    const dateLabel = new Date(date).toLocaleDateString('en-IN');

    byBatch.forEach((group) => {
      notifyScheduleAudienceByBatches(
        'Schedule Updated',
        `${group.count} class${group.count > 1 ? 'es' : ''} scheduled for you on ${dateLabel}.`,
        group.classLevel,
        group.batch ? [group.batch] : []
      ).catch((err) => console.error('Bulk schedule notification failed:', err));
    });
    byTeacher.forEach((info, teacherId) => {
      sendTeacherNotification(
        teacherId,
        'Schedule Updated',
        `You have ${info.count} class${info.count > 1 ? 'es' : ''} on ${dateLabel}.`
      ).catch((err) => console.error('Bulk teacher notification failed:', err));
    });

    res.status(201).json({
      created,
      counts: {
        created: created.length,
        studentsNotified: byBatch.size,
        teachersNotified: byTeacher.size,
      },
    });
  } catch (error: any) {
    console.error('[schedule/bulk] error:', error);
    res.status(500).json({ error: error.message || 'Failed to save schedule' });
  }
});

export default router;
