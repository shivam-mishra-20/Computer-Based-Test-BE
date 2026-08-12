import { Request, Response } from 'express';
import mongoose from 'mongoose';
import RoomAllocation, {
  ROOMS,
  ROOM_CAPACITY,
  roomCapacity,
  IRoomAssignment,
} from '../models/RoomAllocation';
import TestResult from '../models/TestResult';
import User from '../models/User';
import { createAndSendNotification } from '../services/notificationService';
import { INSTITUTE_ACCOUNT_CLAUSE } from '../utils/instituteAudience';

// ── Roster resolution ─────────────────────────────────────────────────────────
// Seating is allocated per EXAM DATE, not per test. A date can carry multiple
// tests across multiple classes; a student who sits any test that day needs one
// seat. The roster for a date is therefore the deduped UNION of every test's
// eligible students. Students of different classes can share a room.
//
// Per-test eligibility mirrors resolveTestStudentIds() in
// offlineResultsController so the roster always matches who can see the test.

const normalizeClassValue = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/Class\s*/i, '').trim() : '';

const buildClassVariants = (values: unknown): string[] => {
  const list = Array.isArray(values) ? values : [values];
  const variants = new Set<string>();
  list.forEach((value) => {
    if (value === null || value === undefined) return;
    const raw = String(value).trim();
    if (!raw) return;
    const normalized = normalizeClassValue(raw);
    if (normalized) {
      variants.add(normalized);
      variants.add(`Class ${normalized}`);
    }
    variants.add(raw);
  });
  return Array.from(variants);
};

const normalizeBatchList = (values: unknown): string[] => {
  const list = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? values.split(',')
      : [];
  return list.map((v) => String(v || '').trim()).filter(Boolean);
};

const isValidDate = (d: unknown): d is string =>
  typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

interface RosterStudent {
  studentId: string;
  studentName: string;
  empCode: string;
  classLevel: string;
  batch: string;
}

interface DateRosterStudent extends RosterStudent {
  tests: { testName: string; subject: string }[]; // the tests this student sits that day
}

// Eligible students for ONE test, with the fields the allocation table needs.
async function resolveTestRoster(test: any): Promise<RosterStudent[]> {
  const assignmentType = test.assignmentType || 'class';
  const projection = 'name empCode classLevel batch role';
  let students: any[] = [];

  if (assignmentType === 'students') {
    const ids = (test.assignedStudents || [])
      .filter((id: any) => mongoose.Types.ObjectId.isValid(id))
      .map((id: any) => new mongoose.Types.ObjectId(id));
    if (ids.length === 0) return [];
    students = await User.find({ _id: { $in: ids }, role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE })
      .select(projection)
      .lean();
  } else {
    const classSource = test.assignedClasses?.length ? test.assignedClasses : [test.class];
    const classScope = buildClassVariants(classSource);
    if (classScope.length === 0) return [];

    const query: any = { role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE, classLevel: { $in: classScope } };

    const batchScope = normalizeBatchList([...(test.assignedBatches || []), test.batch]).filter(
      (b) => !['all', 'all batches'].includes(b.toLowerCase())
    );
    if (batchScope.length > 0) {
      query.batch = { $in: batchScope };
    }

    students = await User.find(query).select(projection).lean();
  }

  return students.map((s: any) => ({
    studentId: String(s._id),
    studentName: s.name || '',
    empCode: s.empCode || '',
    classLevel: s.classLevel || '',
    batch: s.batch || '',
  }));
}

// Deduped union of all students sitting any test on `date`, each annotated with
// the test(s)/subject(s) they have that day.
async function resolveDateRoster(
  date: string
): Promise<{ students: DateRosterStudent[]; tests: any[] }> {
  const tests = await TestResult.find({ testDate: date }).lean();

  const byStudent = new Map<string, DateRosterStudent>();
  for (const test of tests) {
    const students = await resolveTestRoster(test);
    const testInfo = { testName: (test as any).testName, subject: (test as any).subject };
    for (const s of students) {
      const existing = byStudent.get(s.studentId);
      if (existing) {
        existing.tests.push(testInfo);
      } else {
        byStudent.set(s.studentId, { ...s, tests: [testInfo] });
      }
    }
  }

  const students = [...byStudent.values()].sort(
    (a, b) => a.classLevel.localeCompare(b.classLevel) || a.studentName.localeCompare(b.studentName)
  );

  const testSummary = tests.map((t: any) => ({
    _id: String(t._id),
    testName: t.testName,
    subject: t.subject,
    class: t.class,
    batch: t.batch || '',
  }));

  return { students, tests: testSummary };
}

// Shape the response for the admin UI: date summary + every roster student with
// their assigned room (or null) + a room-wise strength/filled/vacant summary.
function buildRosterResponse(
  date: string,
  roster: { students: DateRosterStudent[]; tests: any[] },
  allocation: any
) {
  const roomByStudent = new Map<string, string>();
  (allocation?.assignments || []).forEach((a: any) => {
    roomByStudent.set(String(a.studentId), a.room);
  });

  const students = roster.students.map((s) => ({
    ...s,
    room: roomByStudent.get(s.studentId) || null,
  }));

  const assignedCount = students.filter((s) => s.room).length;
  const roomSummary = ROOMS.map((room) => {
    const count = students.filter((s) => s.room === room).length;
    const capacity = roomCapacity(room);
    return { room, capacity, count, vacant: Math.max(0, capacity - count) };
  });

  return {
    date,
    tests: roster.tests,
    rooms: ROOMS,
    capacities: ROOM_CAPACITY,
    status: allocation?.status || 'draft',
    publishedAt: allocation?.publishedAt || null,
    totalStudents: students.length,
    assignedCount,
    unassignedCount: students.length - assignedCount,
    roomSummary,
    students,
  };
}

// Count assignments per room and return a human-readable list of rooms that
// exceed their seating strength, e.g. ["Room 10 (12/10)"]. Empty ⇒ all OK.
function findCapacityViolations(assignments: { room: string }[]): string[] {
  const counts: Record<string, number> = {};
  assignments.forEach((a) => {
    counts[a.room] = (counts[a.room] || 0) + 1;
  });
  return Object.keys(counts)
    .filter((room) => counts[room] > roomCapacity(room))
    .map((room) => `${room} (${counts[room]}/${roomCapacity(room)})`);
}

// ── GET /room-allocations/rooms ─────────────────────────────────────────────────
export const getRooms = async (_req: Request, res: Response) => {
  res.json({ rooms: ROOMS, capacities: ROOM_CAPACITY });
};

// ── GET /room-allocations/dates ─────────────────────────────────────────────────
// Every date that has at least one test, with test/class counts and the current
// allocation status — drives the admin date picker.
export const getExamDates = async (_req: Request, res: Response) => {
  try {
    const grouped = await TestResult.aggregate([
      {
        $group: {
          _id: '$testDate',
          testCount: { $sum: 1 },
          classes: { $addToSet: '$class' },
        },
      },
      { $sort: { _id: -1 } },
    ]);

    const dates = grouped.map((g: any) => g._id).filter(Boolean);
    const allocations = await RoomAllocation.find({ date: { $in: dates } })
      .select('date status publishedAt')
      .lean();
    const allocByDate: Record<string, any> = {};
    allocations.forEach((a: any) => {
      allocByDate[a.date] = a;
    });

    res.json(
      grouped.map((g: any) => ({
        date: g._id,
        testCount: g.testCount,
        classes: (g.classes || []).filter(Boolean).sort(),
        status: allocByDate[g._id]?.status || null,
        publishedAt: allocByDate[g._id]?.publishedAt || null,
      }))
    );
  } catch (error: any) {
    console.error('[RoomAllocation] Dates error:', error);
    res.status(500).json({ message: 'Failed to load exam dates', error: error.message });
  }
};

// ── GET /room-allocations/dates/:date/roster ────────────────────────────────────
export const getDateRoster = async (req: Request, res: Response) => {
  try {
    const { date } = req.params;
    if (!isValidDate(date)) {
      return res.status(400).json({ message: 'Invalid date (expected yyyy-mm-dd)' });
    }

    const [roster, allocation] = await Promise.all([
      resolveDateRoster(date),
      RoomAllocation.findOne({ date }).lean(),
    ]);

    res.json(buildRosterResponse(date, roster, allocation));
  } catch (error: any) {
    console.error('[RoomAllocation] Roster error:', error);
    res.status(500).json({ message: 'Failed to load room roster', error: error.message });
  }
};

// ── PUT /room-allocations/dates/:date ───────────────────────────────────────────
// Save a draft. Any modification AFTER a publish automatically reverts the
// allocation to Draft, forcing a re-publish — exactly as required.
export const saveDraft = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const { date } = req.params;
    const incoming = Array.isArray(req.body?.assignments) ? req.body.assignments : [];

    if (!isValidDate(date)) {
      return res.status(400).json({ message: 'Invalid date (expected yyyy-mm-dd)' });
    }

    const roster = await resolveDateRoster(date);
    const rosterById = new Map(roster.students.map((s) => [s.studentId, s]));

    // Validate + snapshot. Ignore unassigned entries. Reject unknown rooms or
    // students outside the date roster so the data stays consistent.
    const assignments: IRoomAssignment[] = [];
    for (const entry of incoming) {
      const studentId = String(entry?.studentId || '');
      const room = entry?.room ? String(entry.room) : '';
      if (!room) continue;
      if (!ROOMS.includes(room)) {
        return res.status(400).json({ message: `Invalid room: ${room}` });
      }
      const student = rosterById.get(studentId);
      if (!student) {
        return res.status(400).json({ message: 'One or more students are not scheduled on this date.' });
      }
      assignments.push({
        studentId: new mongoose.Types.ObjectId(studentId),
        studentName: student.studentName,
        empCode: student.empCode,
        classLevel: student.classLevel,
        batch: student.batch,
        room,
      });
    }

    // Enforce seating strength — a room may never hold more than its capacity.
    const violations = findCapacityViolations(assignments);
    if (violations.length > 0) {
      return res.status(400).json({
        message: `Room capacity exceeded: ${violations.join(', ')}.`,
        capacityViolations: violations,
      });
    }

    // Upsert the (single) allocation document — atomic at the document level.
    let allocation = await RoomAllocation.findOne({ date });
    if (!allocation) {
      allocation = new RoomAllocation({ date, createdBy: authUser.id });
    }
    allocation.assignments = assignments;
    allocation.status = 'draft'; // editing always (re)enters draft state
    allocation.updatedBy = authUser.id;
    await allocation.save();

    res.json(buildRosterResponse(date, roster, allocation.toObject()));
  } catch (error: any) {
    console.error('[RoomAllocation] Save draft error:', error);
    res.status(500).json({ message: 'Failed to save room allocation', error: error.message });
  }
};

// ── POST /room-allocations/dates/:date/publish ──────────────────────────────────
// Validate that EVERY roster student has a room, flip to Published, then notify
// only the students whose room changed since the last publish.
export const publishAllocation = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const { date } = req.params;

    if (!isValidDate(date)) {
      return res.status(400).json({ message: 'Invalid date (expected yyyy-mm-dd)' });
    }

    const [roster, allocation] = await Promise.all([
      resolveDateRoster(date),
      RoomAllocation.findOne({ date }),
    ]);

    if (roster.students.length === 0) {
      return res.status(400).json({ message: 'No students are scheduled for any test on this date.' });
    }
    if (!allocation || allocation.assignments.length === 0) {
      return res.status(400).json({ message: 'Assign rooms before publishing.' });
    }

    // Drop any assignment whose student is no longer scheduled on this date
    // (roster drift) so we never publish or notify someone outside the roster.
    const rosterIds = new Set(roster.students.map((s) => s.studentId));
    allocation.assignments = allocation.assignments.filter((a) =>
      rosterIds.has(String(a.studentId))
    );

    // Validation: every student on the date must have a valid room.
    const roomByStudent = new Map<string, string>();
    allocation.assignments.forEach((a) => roomByStudent.set(String(a.studentId), a.room));

    const unassigned = roster.students.filter((s) => !roomByStudent.get(s.studentId));
    if (unassigned.length > 0) {
      const preview = unassigned.slice(0, 5).map((s) => s.studentName).join(', ');
      return res.status(400).json({
        message: `Cannot publish: ${unassigned.length} student(s) are not assigned a room${
          preview ? ` (e.g. ${preview}${unassigned.length > 5 ? '…' : ''})` : ''
        }.`,
        unassignedCount: unassigned.length,
      });
    }

    // Re-check seating strength before going live (defensive against drift).
    const violations = findCapacityViolations(allocation.assignments);
    if (violations.length > 0) {
      return res.status(400).json({
        message: `Cannot publish — room capacity exceeded: ${violations.join(', ')}.`,
        capacityViolations: violations,
      });
    }

    // Notify only students whose room changed since the last publish (first
    // publish ⇒ everyone is "changed").
    const previousRooms = new Map<string, string>();
    (allocation.lastPublishedRooms || []).forEach((p) => previousRooms.set(String(p.studentId), p.room));

    const changed = allocation.assignments.filter(
      (a) => previousRooms.get(String(a.studentId)) !== a.room
    );

    allocation.status = 'published';
    allocation.publishedAt = new Date();
    allocation.publishedBy = authUser.id;
    allocation.lastPublishedRooms = allocation.assignments.map((a) => ({
      studentId: String(a.studentId),
      room: a.room,
    }));
    allocation.updatedBy = authUser.id;
    await allocation.save();

    dispatchRoomNotifications(date, changed).catch((err) =>
      console.error('[RoomAllocation] Notification dispatch error:', err)
    );

    res.json({
      message: 'Room allocation published.',
      status: 'published',
      publishedAt: allocation.publishedAt,
      totalStudents: roster.students.length,
      notifiedCount: changed.length,
    });
  } catch (error: any) {
    console.error('[RoomAllocation] Publish error:', error);
    res.status(500).json({ message: 'Failed to publish room allocation', error: error.message });
  }
};

const formatDate = (date: string): string => {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

// Send each changed student an in-app + push notification with their room and date.
async function dispatchRoomNotifications(date: string, assignments: IRoomAssignment[]): Promise<void> {
  const dateLabel = formatDate(date);
  for (const a of assignments) {
    await createAndSendNotification({
      userId: String(a.studentId),
      type: 'exam',
      title: `Exam Room: ${a.room}`,
      body: `Your exam seating on ${dateLabel} is ${a.room}. Please report to ${a.room}.`,
      data: {
        type: 'room_allocation',
        date,
        room: a.room,
        screen: '/(student)/modules/results',
      },
    }).catch((err) => console.error(`[RoomAllocation] Notify ${a.studentId} failed:`, err));
  }
}

// ── GET /room-allocations/student/:date ─────────────────────────────────────────
// The logged-in student's own room for a PUBLISHED allocation on a date. Used by
// the notification deep-link / admit card. 404 until the room is published.
export const getMyRoom = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const { date } = req.params;

    if (!isValidDate(date)) {
      return res.status(400).json({ message: 'Invalid date (expected yyyy-mm-dd)' });
    }

    const allocation = await RoomAllocation.findOne({ date, status: 'published' }).lean();
    if (!allocation) {
      return res.status(404).json({ message: 'Room not yet published for this date.' });
    }

    const mine = (allocation.assignments || []).find(
      (a: any) => String(a.studentId) === String(authUser.id)
    );
    if (!mine) {
      return res.status(404).json({ message: 'No room allocated for you on this date.' });
    }

    res.json({
      date,
      room: mine.room,
      status: allocation.status,
      publishedAt: allocation.publishedAt || null,
    });
  } catch (error: any) {
    console.error('[RoomAllocation] My room error:', error);
    res.status(500).json({ message: 'Failed to fetch room', error: error.message });
  }
};
