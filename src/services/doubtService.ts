/**
 * Doubt/chat conversation listing, ordering and authorization.
 *
 * ── Why the ordering lives here and not in each route ────────────────────────
 * Both list endpoints used to `.sort({ createdAt: -1 })` — the timestamp of the
 * ORIGINAL question. A three-month-old thread that receives a reply today keeps
 * its original position, so with `limit` applied it falls off the end of the
 * page entirely. From the user's side that is indistinguishable from "the doubt
 * disappeared", and it is the same defect as "the latest chat is not on top".
 * One ordering rule, defined once, fixes both.
 *
 * ── Why an aggregation and not a plain find().sort() ─────────────────────────
 * Threads written before `lastMessageAt` existed do not carry it, and sorting
 * on a missing field would sink every one of them to the bottom — turning a
 * sorting fix into a much louder disappearance bug. `effectiveLastActivity()`
 * computes the fallback chain at QUERY time, so legacy threads sort correctly
 * with no migration and no write to existing data.
 */

import mongoose, { PipelineStage } from 'mongoose';
import Doubt from '../models/Doubt';
import { tenantScope } from '../core/tenancy/queryScope';

export type DoubtViewerRole = 'student' | 'teacher' | 'admin';

export interface DoubtViewer {
  id: string;
  role: DoubtViewerRole;
}

/**
 * Latest activity, with a fallback for documents predating `lastMessageAt`:
 * the stored field → the newest embedded message → `updatedAt` → `createdAt`.
 * Every branch is a value that already exists on every historical document, so
 * this never evaluates to null.
 */
export function effectiveLastActivity(): Record<string, unknown> {
  return {
    $ifNull: [
      '$lastMessageAt',
      {
        $ifNull: [
          { $max: '$messages.createdAt' },
          { $ifNull: ['$updatedAt', '$createdAt'] },
        ],
      },
    ],
  };
}

/**
 * The filter describing which conversations a viewer may see.
 *
 * Exported because it is the SAME rule the single-doubt authorization check
 * uses: what you can list and what you can open must not diverge, or a
 * notification deep link opens a thread the list never shows (or, worse, one
 * the viewer should not see at all).
 */
export function visibilityFilter(viewer: DoubtViewer): Record<string, unknown> {
  if (viewer.role === 'admin') return {};

  const viewerId = new mongoose.Types.ObjectId(viewer.id);

  if (viewer.role === 'student') {
    return { student: viewerId };
  }

  // Teachers see their own threads, the unassigned pool, and anything they
  // have already replied to (a thread another teacher later claimed).
  return {
    $or: [
      { teacher: viewerId },
      { teacher: { $exists: false } },
      { teacher: null },
      { 'messages.sender': viewerId },
    ],
  };
}

/** Is this viewer allowed to read/write this specific conversation? */
export function canAccessDoubt(
  doubt: {
    student?: unknown;
    teacher?: unknown;
    messages?: { sender?: unknown }[];
  },
  viewer: DoubtViewer,
): boolean {
  if (viewer.role === 'admin') return true;

  const idOf = (value: unknown): string => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    const asDoc = value as { _id?: unknown };
    return String(asDoc._id ?? value);
  };

  if (viewer.role === 'student') {
    return idOf(doubt.student) === viewer.id;
  }

  const teacherId = idOf(doubt.teacher);
  if (!teacherId) return true; // unassigned pool
  if (teacherId === viewer.id) return true;

  return (doubt.messages ?? []).some((m) => idOf(m.sender) === viewer.id);
}

export interface ListDoubtsOptions {
  viewer: DoubtViewer;
  status?: string;
  batch?: string;
  subject?: string;
  page: number;
  limit: number;
}

export interface ListDoubtsResult {
  doubts: Record<string, unknown>[];
  total: number;
  page: number;
  totalPages: number;
  stats: Record<string, number>;
}

/**
 * One conversation list, newest activity first.
 *
 * Sorted by `(effectiveLastActivityAt, _id)`. The `_id` tiebreaker is not
 * decoration: `skip`/`limit` over a non-unique sort key lets documents that
 * tie shuffle between page reads, which drops some conversations and repeats
 * others. A unique final key makes paging stable.
 */
export async function listDoubts(options: ListDoubtsOptions): Promise<ListDoubtsResult> {
  const { viewer, status, batch, subject, page, limit } = options;

  const match: Record<string, unknown> = { ...visibilityFilter(viewer) };
  if (status) match.status = status;
  if (batch) match.batch = batch;
  if (subject) match.subject = subject;

  const skip = Math.max(0, (page - 1) * limit);

  const pipeline: PipelineStage[] = [
    { $match: match },
    { $addFields: { effectiveLastActivityAt: effectiveLastActivity() } },
    { $sort: { effectiveLastActivityAt: -1, _id: -1 } },
    { $skip: skip },
    { $limit: limit },
    // Surfaced to the clients so they can order an optimistic/socket-merged
    // list by exactly the same key the server used.
    { $addFields: { lastMessageAt: '$effectiveLastActivityAt' } },
    { $project: { effectiveLastActivityAt: 0 } },
  ];

  const [rows, total, statsRows] = await Promise.all([
    Doubt.aggregate(pipeline),
    Doubt.countDocuments(match),
    Doubt.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);

  const doubts = await Doubt.populate(rows, [
    { path: 'student', select: 'name email classLevel batch profileImage' },
    { path: 'teacher', select: 'name email profileImage' },
    { path: 'messages.sender', select: 'name email role profileImage' },
  ]);

  return {
    doubts: doubts as unknown as Record<string, unknown>[],
    total,
    page,
    totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
    stats: (statsRows as { _id: string; count: number }[]).reduce(
      (acc, s) => ({ ...acc, [s._id]: s.count }),
      {} as Record<string, number>,
    ),
  };
}

/**
 * Stamp `lastMessageAt` onto a single-conversation payload.
 *
 * Every payload the clients merge into their list — an API response, a socket
 * `doubt_updated` — must carry the same ordering key the list endpoint sorts
 * by. A conversation that arrives over a socket without one would sort to the
 * bottom of the client's list instead of the top, which is the disappearance
 * bug wearing a different hat.
 */
export function withActivityFields<T extends Record<string, unknown>>(doubt: T): T {
  if (!doubt) return doubt;

  const source = doubt as {
    lastMessageAt?: Date | string;
    messages?: { createdAt?: Date | string }[];
    updatedAt?: Date | string;
    createdAt?: Date | string;
  };

  if (!source.lastMessageAt) {
    const newest = source.messages?.length
      ? source.messages[source.messages.length - 1]?.createdAt
      : undefined;
    (doubt as Record<string, unknown>).lastMessageAt =
      newest ?? source.updatedAt ?? source.createdAt ?? new Date();
  }

  return doubt;
}

/**
 * The teachers who should be told about an UNASSIGNED doubt.
 *
 * An unassigned doubt is visible to every teacher (see `visibilityFilter`) but
 * used to notify nobody at all — the route had a bare
 * `// logic for unassigned notification could go here`. A student could ask a
 * question that sat in the pool until a teacher happened to open the screen.
 *
 * ── Scoping ─────────────────────────────────────────────────────────────────
 * `tenantScope()` rather than a bare `{ orgId }`: on a claim-mode deployment
 * it narrows to the caller's organization, so ABC Coaching's teachers can
 * never be paged about Abhigyan's doubt. On today's pre-backfill production it
 * returns `{}` — deliberately, because no user document carries `orgId` yet
 * and an unconditional filter would notify nobody instead of everybody. That
 * is the same trade-off documented in `core/tenancy/queryScope.ts`, and it
 * matches the visibility rule: a teacher is notified about exactly the pool
 * they can already see.
 *
 * `status: 'approved'` mirrors the EOD reminder cron — a pending or rejected
 * staff account is not someone to route student questions to.
 */
export async function eligibleTeacherIdsForUnassigned(): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const User = require('../models/User').default;

  const teachers = await User.find({
    role: 'teacher',
    status: 'approved',
    // Defensive: a self-registered public learner must never be treated as
    // staff, even if a role were mis-set.
    accountType: { $ne: 'PUBLIC_LEARNER' },
    ...tenantScope(),
  })
    .select('_id')
    .lean();

  return (teachers as { _id: unknown }[]).map((t) => String(t._id));
}

/**
 * Unread count for one viewer: messages the OTHER side sent after this
 * viewer's last read receipt. A thread with no receipt yet counts every
 * message from the other side, which is the correct first-time state.
 */
export function unreadCountFor(
  doubt: {
    messages?: { senderRole?: string; createdAt?: Date | string }[];
    studentLastReadAt?: Date | string | null;
    teacherLastReadAt?: Date | string | null;
  },
  role: DoubtViewerRole,
): number {
  const readAt = role === 'student' ? doubt.studentLastReadAt : doubt.teacherLastReadAt;
  const readMs = readAt ? new Date(readAt).getTime() : 0;

  return (doubt.messages ?? []).filter((m) => {
    const fromOtherSide =
      role === 'student' ? m.senderRole !== 'student' : m.senderRole === 'student';
    if (!fromOtherSide) return false;
    return new Date(m.createdAt ?? 0).getTime() > readMs;
  }).length;
}
