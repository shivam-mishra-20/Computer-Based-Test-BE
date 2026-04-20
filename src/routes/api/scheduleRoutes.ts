import { Router, Request, Response } from 'express';
import Schedule from '../../models/Schedule';
import Batch from '../../models/Batch';
import User from '../../models/User';
import Leave from '../../models/Leave';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { sendScheduleNotification, sendTeacherNotification } from '../../services/notificationService';
import { initFirebaseAdmin } from '../../services/firebaseService';
import { cacheMiddleware, invalidateCacheOn } from '../../utils/cacheHelpers';
import { normalizeClassValue } from '../../config/studentBatchConfig';
import { mergeAdvancedBasicBatchValues } from '../../services/batchConfigService';

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

const MORNING_TIME_SLOTS = [
  { start: '10:30', end: '11:30', label: '10:30 AM - 11:30 AM' },
  { start: '11:30', end: '12:30', label: '11:30 AM - 12:30 PM' },
  { start: '12:30', end: '13:30', label: '12:30 PM - 1:30 PM' },
  { start: '13:30', end: '14:30', label: '1:30 PM - 2:30 PM' },
  { start: '14:30', end: '15:30', label: '2:30 PM - 3:30 PM' },
];

const EVENING_TIME_SLOTS = [
  { start: '15:30', end: '16:30', label: '3:30 PM - 4:30 PM' },
  { start: '16:30', end: '17:30', label: '4:30 PM - 5:30 PM' },
  { start: '17:30', end: '18:30', label: '5:30 PM - 6:30 PM' },
  { start: '18:30', end: '19:30', label: '6:30 PM - 7:30 PM' },
  { start: '19:30', end: '20:30', label: '7:30 PM - 8:30 PM' },
  { start: '20:30', end: '21:30', label: '8:30 PM - 9:30 PM' },
  { start: '21:30', end: '22:30', label: '9:30 PM - 10:30 PM' },
];

// All regular slots are used for live schedule, timetable grid defaults, and labels.
const TIME_SLOTS = [...MORNING_TIME_SLOTS, ...EVENING_TIME_SLOTS];

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ========================
// UTILITY FUNCTIONS
// ========================

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
      const mongoQuery: any = { role: 'student' };
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
    const mongoQuery: any = { role: 'student', status: 'approved' };
    
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
router.get('/timeslots', authMiddleware, async (_req: Request, res: Response) => {
  res.json(EVENING_TIME_SLOTS);
});

// ========================
// TIMETABLE GRID
// ========================

// Get timetable grid for a class/batch
router.get('/timetable', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { classLevel, batch, dayOfWeek } = req.query;
    
    const query: any = { scheduleType: 'regular', isActive: true };
    if (classLevel) query.classLevel = classLevel;
    applyBatchFilter(query, batch);
    if (dayOfWeek !== undefined) query.dayOfWeek = Number(dayOfWeek);
    
    const schedules = await Schedule.find(query)
      .populate('teacherId', 'name')
      .sort({ dayOfWeek: 1, startTimeSlot: 1 });
    
    // Build grid structure
    const grid: any = {};
    
    DAYS_OF_WEEK.forEach((day, index) => {
      grid[index] = {};
      TIME_SLOTS.forEach(slot => {
        grid[index][slot.start] = null;
      });
    });
    
    schedules.forEach(schedule => {
      if (schedule.dayOfWeek !== undefined) {
        grid[schedule.dayOfWeek][schedule.startTimeSlot] = {
          _id: schedule._id,
          title: schedule.title,
          subject: schedule.subject,
          roomNumber: schedule.roomNumber,
          teacherName: schedule.teacherName || (schedule.teacherId as any)?.name,
          batch: normalizeBatchName((schedule as any).batch),
          batches: getScheduleBatches(schedule),
          classLevel: schedule.classLevel
        };
      }
    });
    
    res.json({
      grid,
      timeSlots: TIME_SLOTS,
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

// Get current and next class for a user - Cached per user for 1 hour
router.get('/live', authMiddleware, cacheMiddleware({ ttl: 3600, keyFn: (req) => `schedule-live:user:${(req as any).user.id}` }), async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    // Fetch full user details from DB to get classLevel and batch
    const user = await User.findById(authUser.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const today = new Date();
    const dayOfWeek = today.getDay();
    const { currentSlot, nextSlot } = getCurrentTimeSlot();
    
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
    
    // FALLBACK: If strict match returns nothing, try ignoring batch if user is student
    if (todayRegular.length === 0 && user.role === 'student') {
      console.log('[Schedule Live] Strict match failed, trying loose batch match...');
      const looseQuery = { isActive: true };
      const classLevelQuery = { 
        classLevel: { $in: [userClassLevel, `Class ${userClassLevel}`, user.classLevel] } 
      };
      
      // OR specific student targeting (always allowed)
      (looseQuery as any).$or = [
        classLevelQuery,
        { students: user.id },
        { students: user.firebaseUid }
      ];
      
      todayRegular = await Schedule.find({
        ...looseQuery,
        scheduleType: 'regular',
        dayOfWeek
      }).lean();
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
    
    // FALLBACK for students: If strict match returns nothing, try without batch restriction
    if (regularSchedules.length === 0 && user.role === 'student' && userBatch) {
      console.log('[Day View] Strict match failed, trying loose batch match...');
      const looseQuery: any = { 
        isActive: true,
        $or: [
          { classLevel: { $in: [userClassLevel, `Class ${userClassLevel}`, user.classLevel] } },
          { students: user.id },
          { students: user.firebaseUid }
        ]
      };
      
      regularSchedules = await Schedule.find({
        ...looseQuery,
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
    if (classLevel) query.classLevel = classLevel;
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
    
    // Check for conflicts
    const conflictQuery: any = {
      isActive: true,
      startTimeSlot: scheduleData.startTimeSlot
    };
    
    if (scheduleData.scheduleType === 'regular') {
      conflictQuery.scheduleType = 'regular';
      conflictQuery.dayOfWeek = scheduleData.dayOfWeek;
    } else {
      conflictQuery.scheduleType = 'custom';
      conflictQuery.date = scheduleData.date;
    }
    
    // Check room conflict
    const roomConflict = await Schedule.findOne({
      ...conflictQuery,
      roomNumber: scheduleData.roomNumber
    });
    
    if (roomConflict) {
      return res.status(400).json({ error: `Room ${scheduleData.roomNumber} is already booked for this time slot` });
    }
    
    // Check teacher conflict only when a teacher is explicitly selected
    if (teacherId && String(teacherId).trim()) {
      const teacherConflict = await Schedule.findOne({
        ...conflictQuery,
        teacherId
      });
      
      if (teacherConflict) {
        return res.status(400).json({ error: 'Teacher is already assigned to another class at this time' });
      }
    }
    
    // Check if teacher is on leave for the scheduled date
    if (teacherId && scheduleData.scheduleType === 'custom' && scheduleData.date) {
      const scheduleDate = new Date(scheduleData.date);
      const teacherLeave = await Leave.findOne({
        teacherId,
        status: 'approved',
        leaveType: { $ne: 'half_day' },
        startDate: { $lte: scheduleDate },
        endDate: { $gte: scheduleDate }
      });
      
      if (teacherLeave) {
        return res.status(400).json({ 
          error: `${teacherName} is on approved leave on ${scheduleDate.toLocaleDateString()}`,
          leaveDetails: {
            startDate: teacherLeave.startDate,
            endDate: teacherLeave.endDate,
            leaveType: teacherLeave.leaveType
          }
        });
      }
    }
    
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
    if (teacherId) {
      const name = await resolveTeacherNameAndSync(teacherId);
      updateData.teacherName = name || '';
      updateData.teacherId = teacherId;
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
    const mongoQuery: any = { role: 'student' };
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
    
    await Schedule.findByIdAndDelete(req.params.scheduleId);
    
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

export default router;
