import { Router, Request, Response } from 'express';
import Schedule from '../../models/Schedule';
import Batch from '../../models/Batch';
import User from '../../models/User';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { sendScheduleNotification, sendTeacherNotification } from '../../services/notificationService';
import { initFirebaseAdmin } from '../../services/firebaseService';

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

// Default batch configuration
const DEFAULT_BATCHES = [
  { name: 'Basic', classLevels: ['7', '8', '9', '10', '11', '12'], isDefault: true },
  { name: 'Advanced', classLevels: ['7', '8', '9', '10', '11', '12'], isDefault: true },
  { name: 'JEE', classLevels: ['9', '10', '11', '12'], isDefault: true },
  { name: 'NEET', classLevels: ['11', '12'], isDefault: true },
  { name: 'Commerce', classLevels: ['11', '12'], isDefault: true }
];

// Time slots for regular schedule (2:30 PM to 8:30 PM)
const TIME_SLOTS = [
  { start: '14:30', end: '15:30', label: '2:30 - 3:30 PM' },
  { start: '15:30', end: '16:30', label: '3:30 - 4:30 PM' },
  { start: '16:30', end: '17:30', label: '4:30 - 5:30 PM' },
  { start: '17:30', end: '18:30', label: '5:30 - 6:30 PM' },
  { start: '18:30', end: '19:30', label: '6:30 - 7:30 PM' },
  { start: '19:30', end: '20:30', label: '7:30 - 8:30 PM' }
];

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ========================
// UTILITY FUNCTIONS
// ========================

async function ensureDefaultBatches() {
  for (const batch of DEFAULT_BATCHES) {
    await Batch.findOneAndUpdate(
      { name: batch.name },
      batch,
      { upsert: true, new: true }
    );
  }
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

/**
 * Sync a Firebase teacher to MongoDB Users collection
 * This ensures Firebase teachers can receive notifications
 */
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

// ========================
// BATCH MANAGEMENT
// ========================

// Get all batches
router.get('/batches', authMiddleware, async (req: Request, res: Response) => {
  try {
    await ensureDefaultBatches();
    const { classLevel } = req.query;
    
    const query: any = {};
    if (classLevel) {
      query.classLevels = classLevel;
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
    
    const batch = new Batch(req.body);
    await batch.save();
    res.status(201).json(batch);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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

// Get unique batches from Firebase Users collection
router.get('/firebase/batches', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { classLevel } = req.query;
    const admin = getFirebaseAdmin();
    
    // Start with default batches
    await ensureDefaultBatches();
    const defaultBatches = await Batch.find({}).lean();
    
    if (!admin) {
      // Just return default batches filtered by class level
      const filtered = classLevel 
        ? defaultBatches.filter(b => b.classLevels.includes(classLevel as string))
        : defaultBatches;
      return res.json(filtered);
    }
    
    // Fetch unique batches from Firebase
    const db = admin.firestore();
    const snapshot = await db.collection('Users').get();
    
    const firebaseBatches = new Set<string>();
    snapshot.forEach((doc: any) => {
      const data = doc.data();
      const batch = data.batch || data.attendance?.batch;
      if (batch && typeof batch === 'string' && batch.trim()) {
        firebaseBatches.add(batch.trim());
      }
    });
    
    // Combine with default batches
    const allBatchNames = new Set<string>();
    defaultBatches.forEach(b => allBatchNames.add(b.name));
    firebaseBatches.forEach(b => allBatchNames.add(b));
    
    // Build response
    const result: any[] = [];
    allBatchNames.forEach(name => {
      const dbBatch = defaultBatches.find(b => b.name === name);
      if (dbBatch) {
        if (!classLevel || dbBatch.classLevels.includes(classLevel as string)) {
          result.push(dbBatch);
        }
      } else {
        // Firebase-only batch - include for all class levels by default
        result.push({
          _id: name.toLowerCase().replace(/\s+/g, '-'),
          name: name,
          classLevels: ['7', '8', '9', '10', '11', '12'],
          isDefault: false,
          source: 'firebase'
        });
      }
    });
    
    res.json(result);
  } catch (error: any) {
    console.error('Error fetching Firebase batches:', error);
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
      .select('_id name email')
      .sort({ name: 1 });
    res.json(teachers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get rooms (static list 1-10)
router.get('/rooms', authMiddleware, async (_req: Request, res: Response) => {
  const rooms = Array.from({ length: 10 }, (_, i) => ({
    number: i + 1,
    name: `Room ${i + 1}`
  }));
  res.json(rooms);
});

// Get time slots
router.get('/timeslots', authMiddleware, async (_req: Request, res: Response) => {
  res.json(TIME_SLOTS);
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
    if (batch) query.batch = batch;
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
          batch: schedule.batch,
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

// Get current and next class for a user
router.get('/live', authMiddleware, async (req: Request, res: Response) => {
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
      // Match schedules by classLevel (normalized) OR specific student targeting
      baseQuery.$or = [
        { 
          classLevel: { $in: [userClassLevel, `Class ${userClassLevel}`, user.classLevel] },
          // If user has a batch, match that batch OR 'All Batches' OR 'All'
          // If user has no batch, match ANY batch (logic: empty batch matches all)
          ...(userBatch ? { batch: { $in: [userBatch, 'All Batches', 'All', 'Advanced', 'Basic'] } } : {}) 
        },
        { students: user.id },
        { students: user.firebaseUid }
      ];
    } else if (user.role === 'teacher') {
      baseQuery.$or = [
        { teacherId: user.id },
        { teacherId: user.firebaseUid }
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
  
  return {
    _id: schedule._id,
    title: schedule.title,
    subject: schedule.subject,
    scheduleType: schedule.scheduleType,
    startTimeSlot: startTime,
    endTimeSlot: endTime,
    roomNumber: schedule.roomNumber,
    classLevel: schedule.classLevel,
    batch: schedule.batch,
    teacherName: schedule.teacherName || 'TBA',
    teacherId: schedule.teacherId,
    dayOfWeek: schedule.dayOfWeek,
    date: schedule.date,
    status // 'past', 'ongoing', 'upcoming'
  };
}

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
    if (batch) query.batch = batch;
    
    // Date range for custom schedules
    if (startDate && endDate) {
      query.date = {
        $gte: new Date(startDate as string),
        $lte: new Date(endDate as string)
      };
    }
    
    // Filter for students
    if (user.role === 'student') {
      query.$or = [
        { classLevel: user.classLevel, batch: user.batch },
        { students: user.id }
      ];
    } else if (user.role === 'teacher') {
      query.teacherId = user.id;
    }
    
    const schedules = await Schedule.find(query)
      .populate('teacherId', 'name')
      .sort({ dayOfWeek: 1, startTimeSlot: 1 });
    
    res.json(schedules.map(formatScheduleResponse));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get today's schedule
router.get('/today', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const today = new Date();
    const dayOfWeek = today.getDay();
    
    const baseQuery: any = { isActive: true };
    
    if (user.role === 'student') {
      baseQuery.$or = [
        { classLevel: user.classLevel, batch: user.batch },
        { students: user.id }
      ];
    } else if (user.role === 'teacher') {
      baseQuery.teacherId = user.id;
    }
    
    // Regular schedule for today's day of week
    const regularSchedules = await Schedule.find({
      ...baseQuery,
      scheduleType: 'regular',
      dayOfWeek
    }).sort({ startTimeSlot: 1 });
    
    // Custom schedules for today's date
    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
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

// Create schedule
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { teacherId, ...scheduleData } = req.body;
    
    // Get teacher name for denormalization (try MongoDB first, then Firebase)
    let teacherName = '';
    if (teacherId) {
      // Try MongoDB first (if it's a valid ObjectId)
      try {
        if (isValidObjectId(teacherId)) {
          const teacher = await User.findById(teacherId).select('name');
          teacherName = teacher?.name || '';
        }
      } catch { /* not a MongoDB ObjectId */ }
      
      // Try MongoDB by firebaseUid if not found
      if (!teacherName) {
        const syncedTeacher = await User.findOne({ firebaseUid: teacherId }).select('name');
        if (syncedTeacher) {
          teacherName = syncedTeacher.name || '';
        }
      }
      
      // If still not found, try Firebase and sync to MongoDB
      if (!teacherName) {
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
              await syncFirebaseTeacherToMongo(teacherId, teacherName);
            }
          } catch (fbError) {
            console.error('Firebase teacher lookup failed:', fbError);
          }
        }
      }
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
    
    // Check teacher conflict
    const teacherConflict = await Schedule.findOne({
      ...conflictQuery,
      teacherId
    });
    
    if (teacherConflict) {
      return res.status(400).json({ error: 'Teacher is already assigned to another class at this time' });
    }
    
    const schedule = new Schedule({
      ...scheduleData,
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
    sendScheduleNotification(
      notificationTitle,
      notificationBody,
      schedule.classLevel,
      schedule.batch
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

// Update schedule
router.put('/:scheduleId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { teacherId, ...updateData } = req.body;
    
    // Get teacher name if changed
    if (teacherId) {
      const teacher = await User.findById(teacherId).select('name');
      updateData.teacherName = teacher?.name || '';
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
    sendScheduleNotification(
      `Schedule Updated: ${schedule.subject}`,
      'Class schedule has been updated. Please check the timetable for details.',
      schedule.classLevel,
      schedule.batch
    ).catch(err => console.error('Update notification failed:', err));
    
    res.json(schedule);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete schedule
router.delete('/:scheduleId', authMiddleware, async (req: Request, res: Response) => {
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
    sendScheduleNotification(
      `Class Cancelled: ${schedule.subject}`,
      `The ${schedule.subject} class has been cancelled.`,
      schedule.classLevel,
      schedule.batch
    ).catch(err => console.error('Cancel notification failed:', err));
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
