import { Types } from 'mongoose';
import ClassRequest, {
  CLASS_REQUEST_STATUSES,
  ClassRequestSource,
  ClassRequestStatus,
  IClassRequest,
} from '../models/ClassRequest';
import Batch from '../models/Batch';
import User from '../models/User';
import StudyResource from '../models/StudyResource';
import Question from '../models/Question';
import { getStudentBatchConfigFromDatabase } from './batchConfigService';
import { CURRICULUM_SUBJECTS } from '../config/subjects';
import { buildClassVariants } from '../utils/audienceTargeting';
import { INSTITUTE_ACCOUNT_CLAUSE } from '../utils/instituteAudience';
import * as notificationService from './notificationService';

// ── Class Request service ───────────────────────────────────────────────────
// All business rules for the public submission + admin queue live here; the
// route layer only does auth, shape-checking and HTTP concerns.

/** Thrown for user-correctable input problems — mapped to HTTP 400 by routes. */
export class ClassRequestValidationError extends Error {
  public readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ClassRequestValidationError';
    this.field = field;
  }
}

// Field length caps mirror the schema's maxlength so oversized input is
// rejected with a clear message instead of a Mongoose validation dump.
const LIMITS = {
  name: 120,
  classValue: 20,
  batchName: 80,
  subject: 80,
  preferredTiming: 120,
  reason: 1000,
  remarks: 1000,
} as const;

/**
 * Public classes offered by the request form.
 *
 * `student-batch-config` only covers 7-12 (the registration batch registry),
 * but Class 6 is a real audience with no batch split — the exam Schedule &
 * Publish UI already appends it the same way. Kept consistent here.
 */
const EXTRA_PUBLIC_CLASSES = ['6'];
const NO_BATCH_LABEL = 'No Batch';

/** Collapse whitespace and trim — applied to every free-text field. */
const clean = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/**
 * Strip characters that have no place in a short form field. Keeps letters,
 * digits, spaces and ordinary punctuation; drops control characters and angle
 * brackets so stored values can never carry markup into an admin screen.
 */
const sanitize = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\u0000-\u001F\u007F<>]/g, '').trim();

const requireField = (
  raw: unknown,
  field: string,
  label: string,
  max: number,
): string => {
  const value = sanitize(clean(raw));
  if (!value)
    throw new ClassRequestValidationError(`${label} is required`, field);
  if (value.length > max) {
    throw new ClassRequestValidationError(
      `${label} must be ${max} characters or fewer`,
      field,
    );
  }
  return value;
};

const optionalField = (
  raw: unknown,
  field: string,
  label: string,
  max: number,
): string | undefined => {
  const value = sanitize(clean(raw));
  if (!value) return undefined;
  if (value.length > max) {
    throw new ClassRequestValidationError(
      `${label} must be ${max} characters or fewer`,
      field,
    );
  }
  return value;
};

export interface PublicClassOption {
  classValue: string;
  classLabel: string;
  batches: string[];
  requiresBatch: boolean;
}

export interface PublicClassRequestOptions {
  classes: PublicClassOption[];
  subjects: string[];
}

/**
 * Minimal class/batch/subject data for the PUBLIC form.
 *
 * Deliberately narrow: only what the dropdowns need. No student counts, no
 * teacher/user data, no batch _ids, no admin metadata — this endpoint is
 * unauthenticated.
 */
export const getPublicOptions =
  async (): Promise<PublicClassRequestOptions> => {
    const config = await getStudentBatchConfigFromDatabase();

    const classes: PublicClassOption[] = config.classes.map((c) => ({
      classValue: c.classValue,
      classLabel: c.classLabel,
      batches: Array.isArray(c.batches) ? c.batches : [],
      requiresBatch: Boolean(c.requiresBatch),
    }));

    EXTRA_PUBLIC_CLASSES.forEach((classValue) => {
      if (classes.some((c) => c.classValue === classValue)) return;
      classes.push({
        classValue,
        classLabel: `Class ${classValue}`,
        batches: [],
        requiresBatch: false,
      });
    });

    classes.sort((a, b) => Number(a.classValue) - Number(b.classValue));

    // Subjects are free-text across the app (no Subject collection). Derive the
    // public list from content that already exists rather than hardcoding one.
    const [resourceSubjects, questionSubjects] = await Promise.all([
      StudyResource.distinct('subject', { status: 'published' }),
      Question.distinct('tags.subject'),
    ]);

    // Canonical curriculum list first, then anything the content library
    // actually uses — so a subject already present in the DB still appears
    // even when it is not in the standard list.
    const subjects = Array.from(
      new Set(
        [...CURRICULUM_SUBJECTS, ...resourceSubjects, ...questionSubjects]
          .map((s) => sanitize(clean(s)))
          .filter((s) => s.length > 0 && s.length <= LIMITS.subject),
      ),
    ).sort((a, b) => a.localeCompare(b));

    return { classes, subjects };
  };

export interface CreateClassRequestInput {
  name?: unknown;
  classValue?: unknown;
  batchName?: unknown;
  /** Teacher flow: several batches at once. */
  batchNames?: unknown;
  /** Teacher flow: specific students instead of a whole batch. */
  studentIds?: unknown;
  subject?: unknown;
  preferredTiming?: unknown;
  /** App flow: ISO instant from the date/time picker. */
  preferredAt?: unknown;
  reason?: unknown;
}

/** Coerce an unknown body value into a string array (tolerates a CSV string). */
const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((v) => String(v ?? ''));
  if (typeof value === 'string') return value.split(',');
  return [];
};

/** Format an instant for the admin queue in the academy's timezone. */
const formatTiming = (date: Date): string =>
  date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Validate + persist a public submission.
 *
 * `source` is passed in by the route (derived from the client), never read
 * from the request body. `status`, `reviewedBy`, `reviewedAt`,
 * `assignedTeacher` and `remarks` are not accepted here at all — the only way
 * to set them is the admin update path, so mass assignment is impossible.
 */
export const createPublicClassRequest = async (
  input: CreateClassRequestInput,
  context: {
    source: ClassRequestSource;
    ip?: string;
    /** Verified session, when one exists. Never taken from the request body. */
    requestedBy?: { id: string; role?: string };
  },
): Promise<IClassRequest> => {
  // ── Who is asking ────────────────────────────────────────────────────────
  // A signed-in submitter's identity comes from their User record, never from
  // the request body: a logged-in student cannot submit under someone else's
  // name, class or batch. Guests (public web form) still supply their own.
  const session = context.requestedBy;
  const sessionUser = session?.id
    ? await User.findById(session.id)
        .select('name role classLevel batch')
        .lean()
    : null;
  const isStudentSubmitter = sessionUser?.role === 'student';
  const isStaffSubmitter =
    sessionUser?.role === 'teacher' || sessionUser?.role === 'admin';

  // Name comes from the session for ANY signed-in submitter — student or
  // teacher. Only the public website form, which has no session, asks the
  // person to type it. (Teachers previously fell through to the typed branch
  // and got a spurious "Name is required" from the app.)
  const name = sessionUser
    ? sanitize(clean(sessionUser.name)) ||
      (isStudentSubmitter ? 'Student' : 'Staff')
    : requireField(input.name, 'name', 'Name', LIMITS.name);

  const subject = requireField(
    input.subject,
    'subject',
    'Subject',
    LIMITS.subject,
  );

  // Timing: the app sends an instant, the public web form sends free text.
  let preferredAt: Date | undefined;
  let preferredTiming: string;
  if (
    input.preferredAt !== undefined &&
    input.preferredAt !== null &&
    input.preferredAt !== ''
  ) {
    const parsed = new Date(String(input.preferredAt));
    if (isNaN(parsed.getTime())) {
      throw new ClassRequestValidationError(
        'Please choose a valid date and time',
        'preferredAt',
      );
    }
    if (parsed.getTime() < Date.now() - 60 * 1000) {
      throw new ClassRequestValidationError(
        'Please choose a date and time in the future',
        'preferredAt',
      );
    }
    preferredAt = parsed;
    preferredTiming = formatTiming(parsed);
  } else {
    preferredTiming = requireField(
      input.preferredTiming,
      'preferredTiming',
      'Preferred timing',
      LIMITS.preferredTiming,
    );
  }

  const reason = optionalField(input.reason, 'reason', 'Reason', LIMITS.reason);

  // Only meaningful for a typed name — a session-derived one is whatever the
  // account holds, and rejecting it would block a user who cannot fix it here.
  if (!sessionUser && name.length < 2) {
    throw new ClassRequestValidationError('Please enter a valid name', 'name');
  }

  // ── Validate class against the canonical registry ────────────────────────
  const options = await getPublicOptions();
  // A student's class is taken from their profile; everyone else picks one.
  const rawClass = isStudentSubmitter
    ? String(sessionUser?.classLevel || '')
    : requireField(input.classValue, 'classValue', 'Class', LIMITS.classValue);
  const classValue = rawClass.replace(/class\s*/i, '').trim();
  const classOption = options.classes.find((c) => c.classValue === classValue);
  if (!classOption) {
    throw new ClassRequestValidationError(
      'Please select a valid class',
      'classValue',
    );
  }

  // ── Teacher audience: multiple batches, or named students ────────────────
  // Only staff may target anyone other than themselves. Everything is checked
  // against the real registry / roster, so a client cannot invent an audience.
  const batchNames: string[] = [];
  const studentIds: Types.ObjectId[] = [];

  if (isStaffSubmitter) {
    for (const raw of toStringArray(input.batchNames)) {
      const value = sanitize(clean(raw));
      if (!value) continue;
      const matched = classOption.batches.find(
        (b) => b.toLowerCase() === value.toLowerCase(),
      );
      if (!matched) {
        throw new ClassRequestValidationError(
          `"${value}" is not a batch of Class ${classValue}`,
          'batchNames',
        );
      }
      if (!batchNames.includes(matched)) batchNames.push(matched);
    }

    const rawStudentIds = toStringArray(input.studentIds)
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (rawStudentIds.length > 0) {
      if (rawStudentIds.some((id) => !Types.ObjectId.isValid(id))) {
        throw new ClassRequestValidationError(
          'Invalid student selection',
          'studentIds',
        );
      }
      // Confirm every id is a real student in the requested class, so a
      // teacher cannot attach arbitrary user ids to a request.
      const found = await User.find({
        _id: { $in: rawStudentIds },
        role: 'student',
        ...INSTITUTE_ACCOUNT_CLAUSE,
        classLevel: { $in: buildClassVariants(classValue) },
      })
        .select('_id')
        .lean();
      if (found.length !== new Set(rawStudentIds).size) {
        throw new ClassRequestValidationError(
          'One or more selected students are not in this class',
          'studentIds',
        );
      }
      found.forEach((s) => studentIds.push(s._id as Types.ObjectId));
    }
  }

  // ── Validate batch against that class's real batches ─────────────────────
  // Student: their own batch, from the profile. Teacher/guest: what they sent.
  // A teacher who picked batches or students has already expressed the
  // audience above, so the single-batch field just summarises it.
  const rawBatch = isStudentSubmitter
    ? sanitize(clean(sessionUser?.batch))
    : batchNames.length > 0
      ? batchNames[0]
      : sanitize(clean(input.batchName));
  let batchName: string;

  if (isStaffSubmitter && studentIds.length > 0 && batchNames.length === 0) {
    // Targeting named students directly — no batch applies.
    batchName = NO_BATCH_LABEL;
  } else if (classOption.batches.length === 0) {
    // Class has no batch split (e.g. Class 6) — accept a blank/"No Batch"
    // value rather than forcing the user to invent one.
    if (
      rawBatch &&
      !new RegExp(`^(${NO_BATCH_LABEL}|none|n/?a)$`, 'i').test(rawBatch)
    ) {
      throw new ClassRequestValidationError(
        `Class ${classValue} does not have batches`,
        'batchName',
      );
    }
    batchName = NO_BATCH_LABEL;
  } else {
    if (!rawBatch) {
      throw new ClassRequestValidationError('Batch is required', 'batchName');
    }
    const matched = classOption.batches.find(
      (b) => b.toLowerCase() === rawBatch.toLowerCase(),
    );
    if (!matched) {
      throw new ClassRequestValidationError(
        'Please select a valid batch',
        'batchName',
      );
    }
    batchName = matched;
  }

  // Resolve the canonical Batch reference where one exists. The name snapshot
  // above is what the admin queue displays, so a missing reference is fine.
  let batchId: Types.ObjectId | undefined;
  if (batchName !== NO_BATCH_LABEL) {
    const batchDoc = await Batch.findOne({
      name: new RegExp(
        `^${batchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        'i',
      ),
    })
      .select('_id')
      .lean();
    if (batchDoc?._id) batchId = batchDoc._id as Types.ObjectId;
  }

  // ── Validate subject ─────────────────────────────────────────────────────
  // Match case-insensitively against the known list, but only when we actually
  // have one — an empty content DB must not block every submission.
  let resolvedSubject = subject;
  if (options.subjects.length > 0) {
    const matchedSubject = options.subjects.find(
      (s) => s.toLowerCase() === subject.toLowerCase(),
    );
    if (!matchedSubject) {
      throw new ClassRequestValidationError(
        'Please select a valid subject',
        'subject',
      );
    }
    resolvedSubject = matchedSubject;
  }

  // ── Duplicate suppression ────────────────────────────────────────────────
  // Guards against double-tap/retry creating two rows. Same person + class +
  // subject inside a short window is treated as the same request; the existing
  // row is returned so the client still sees success.
  const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
  const existing = await ClassRequest.findOne({
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    classValue,
    subject: resolvedSubject,
    createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
  });
  if (existing) return existing;

  const created = await ClassRequest.create({
    name,
    classValue,
    batchId,
    batchName,
    subject: resolvedSubject,
    preferredTiming,
    preferredAt,
    reason,
    batchNames: batchNames.length > 0 ? batchNames : undefined,
    studentIds: studentIds.length > 0 ? studentIds : undefined,
    source: context.source,
    status: 'PENDING',
    isContacted: false,
    submittedIp: context.ip,
    requestedBy: context.requestedBy?.id,
    requestedByRole: context.requestedBy?.role,
  });

  // Best-effort admin fan-out — a notification failure must never fail the
  // submission the user just made.
  void notifyAdminsOfNewRequest(created);

  return created;
};

/**
 * Notify admins that a request landed. Isolated so email/WhatsApp channels can
 * be added here later without touching the submission path.
 */
async function notifyAdminsOfNewRequest(request: IClassRequest): Promise<void> {
  try {
    const admins = await User.find({ role: 'admin' }).select('_id').lean();
    if (admins.length === 0) return;

    await Promise.all(
      admins.map((admin) =>
        notificationService.createAndSendNotification({
          userId: String(admin._id),
          type: 'general',
          title: 'New Class Request',
          body: `${request.name} requested ${request.subject} for Class ${request.classValue}`,
          data: { classRequestId: String(request._id), type: 'class_request' },
        }),
      ),
    );
  } catch (err) {
    console.error('Error sending class request notifications:', err);
  }
}

/**
 * A signed-in user's own requests, for the app's "your requests" list.
 *
 * Scoped to `requestedBy`, and deliberately projected: internal admin fields
 * (remarks, reviewedBy, submittedIp, assignedTeacher) are never exposed to the
 * requester — they only see what they submitted and where it got to.
 */
export const listMyClassRequests = async (userId: string) => {
  if (!Types.ObjectId.isValid(userId)) return [];

  return ClassRequest.find({ requestedBy: userId })
    .select(
      'classValue batchName batchNames subject preferredTiming preferredAt reason status createdAt reviewedAt studentIds',
    )
    .populate('studentIds', 'name')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
};

export interface ListClassRequestsParams {
  status?: string;
  source?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

/** Admin queue: newest first, filterable, paginated, with status counts. */
export const listClassRequests = async (params: ListClassRequestsParams) => {
  const query: Record<string, unknown> = {};

  if (
    params.status &&
    CLASS_REQUEST_STATUSES.includes(params.status as ClassRequestStatus)
  ) {
    query.status = params.status;
  }
  if (params.source === 'APP' || params.source === 'WEB') {
    query.source = params.source;
  }

  const search = sanitize(clean(params.search));
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [
      { name: rx },
      { subject: rx },
      { batchName: rx },
      { classValue: rx },
    ];
  }

  const createdAt: Record<string, Date> = {};
  if (params.from) {
    const d = new Date(params.from);
    if (!isNaN(d.getTime())) createdAt.$gte = d;
  }
  if (params.to) {
    const d = new Date(params.to);
    // Inclusive end-of-day so a single-day filter returns that day's rows.
    if (!isNaN(d.getTime()))
      createdAt.$lte = new Date(d.setHours(23, 59, 59, 999));
  }
  if (Object.keys(createdAt).length > 0) query.createdAt = createdAt;

  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(params.limit) || 25));

  const [items, total, statusCounts] = await Promise.all([
    ClassRequest.find(query)
      .populate('assignedTeacher', 'name email')
      .populate('reviewedBy', 'name email')
      .populate('requestedBy', 'name email role')
      .populate('studentIds', 'name email classLevel batch')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ClassRequest.countDocuments(query),
    ClassRequest.aggregate<{ _id: ClassRequestStatus; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const counts = CLASS_REQUEST_STATUSES.reduce(
    (acc, s) => ({ ...acc, [s]: 0 }),
    {} as Record<ClassRequestStatus, number>,
  );
  statusCounts.forEach((row) => {
    if (row._id in counts) counts[row._id] = row.count;
  });

  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    counts,
    pendingCount: counts.PENDING,
  };
};

/**
 * Hard-delete a request. Admin-only housekeeping for spam/duplicate rows —
 * there is nothing referencing a ClassRequest, so no cascade is needed.
 */
export const deleteClassRequest = async (id: string): Promise<boolean> => {
  if (!Types.ObjectId.isValid(id)) {
    throw new ClassRequestValidationError('Invalid request id', 'id');
  }
  const result = await ClassRequest.findByIdAndDelete(id);
  return Boolean(result);
};

export interface UpdateClassRequestInput {
  status?: unknown;
  remarks?: unknown;
  assignedTeacher?: unknown;
}

/** Admin update: status transition plus optional remarks/teacher assignment. */
export const updateClassRequestStatus = async (
  id: string,
  input: UpdateClassRequestInput,
  reviewerId: string,
) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new ClassRequestValidationError('Invalid request id', 'id');
  }

  const request = await ClassRequest.findById(id);
  if (!request) return null;

  if (input.status !== undefined) {
    const status = String(input.status).toUpperCase() as ClassRequestStatus;
    if (!CLASS_REQUEST_STATUSES.includes(status)) {
      throw new ClassRequestValidationError('Invalid status', 'status');
    }
    request.status = status;
    if (status === 'CONTACTED') request.isContacted = true;
  }

  if (input.remarks !== undefined) {
    request.remarks = optionalField(
      input.remarks,
      'remarks',
      'Remarks',
      LIMITS.remarks,
    );
  }

  if (input.assignedTeacher !== undefined) {
    const raw = input.assignedTeacher;
    if (raw === null || raw === '') {
      request.assignedTeacher = undefined;
    } else {
      const teacherId = String(raw);
      if (!Types.ObjectId.isValid(teacherId)) {
        throw new ClassRequestValidationError(
          'Invalid teacher',
          'assignedTeacher',
        );
      }
      const teacher = await User.findOne({
        _id: teacherId,
        role: { $in: ['teacher', 'admin'] },
      })
        .select('_id')
        .lean();
      if (!teacher) {
        throw new ClassRequestValidationError(
          'Invalid teacher',
          'assignedTeacher',
        );
      }
      request.assignedTeacher = new Types.ObjectId(teacherId);
    }
  }

  // Audit trail — always server-set, never client-supplied.
  request.reviewedAt = new Date();
  request.reviewedBy = new Types.ObjectId(reviewerId);

  await request.save();

  return ClassRequest.findById(request._id)
    .populate('assignedTeacher', 'name email')
    .populate('reviewedBy', 'name email')
    .lean();
};
