/**
 * Usage — what counts against a plan's limits, and the one gate that enforces
 * them.
 *
 * ── What counts (the canonical rules; docs/subscriptions-plan.md) ───────────
 *   students         users with role 'student', status 'approved', not a
 *                    PUBLIC_LEARNER, in the organization. Pending and rejected
 *                    accounts hold no seat. An invited account holds one.
 *   teachers         users with role 'teacher', status 'approved'.
 *   admins           users with role 'admin', status 'approved'.
 *   appBuildsMonthly app builds started this calendar month (IST) that are
 *                    live, completed, or reached EAS (an easBuildId). A build
 *                    cancelled or failed before EAS saw it consumed nothing.
 *   aiGenerationsMonthly
 *                    AI generation requests accepted this calendar month (IST),
 *                    minus those that failed or were cancelled — the
 *                    UsageRecord ledger, the only record every AI path shares.
 *
 * Seats and builds are COUNTED FROM THE RECORDS THEMSELVES, not from a running
 * total, so deleting, rejecting, re-approving or moving a user between
 * organizations is reflected the moment it happens, and there is no counter to
 * drift or reconcile.
 *
 * ── Concurrency ─────────────────────────────────────────────────────────────
 * "Count, then create one more" runs under a lease on (organization, resource)
 * — models/UsageLock.ts — so two requests for the last seat are serialized and
 * the second sees the first. Only the count and the write run under it.
 *
 * ── Who is held to limits ───────────────────────────────────────────────────
 * Only an organization whose subscription the lifecycle MANAGES
 * (`entitlement.limitsEnforced`). Platform-owned organizations, organizations
 * without a subscription, and subscriptions from before the lifecycle are not
 * limited. A limit that is absent, or -1, is unlimited.
 *
 * ── Over the limit after a downgrade ────────────────────────────────────────
 * Nothing is deleted, disabled or hidden. Existing students keep signing in,
 * everything stays readable and exportable, and existing records can be edited
 * or removed. Only NEW consumption is refused until usage is under the limit
 * or the limit is raised.
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import type { NextFunction, Request, Response } from 'express';
import { withoutTenantScope } from '../tenancy/context';
import { getEntitlement, type ResolvedEntitlement } from '../entitlements/resolve';

export type SeatResource = 'students' | 'teachers' | 'admins';
export type CountedResource = SeatResource | 'appBuildsMonthly';
export type MeteredResource = 'aiGenerationsMonthly';
export type LimitedResource = CountedResource | MeteredResource;

export const SEAT_RESOURCES: SeatResource[] = ['students', 'teachers', 'admins'];
/** Every resource with a limit that is enforced somewhere. */
export const ENFORCED_RESOURCES: LimitedResource[] = ['students', 'teachers', 'admins', 'appBuildsMonthly', 'aiGenerationsMonthly'];

const setting = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
/** How long a lease is held before it is treated as abandoned. */
const leaseMs = () => setting('USAGE_LOCK_LEASE_MS', 20_000);
/** How long a request waits for the lease before answering USAGE_CHECK_BUSY. */
const waitMs = () => setting('USAGE_LOCK_WAIT_MS', 10_000);
const IST_OFFSET_MS = 330 * 60 * 1000;

const unscoped = <T>(label: string, fn: () => Promise<T>) => withoutTenantScope(`usage:${label}`, fn) as Promise<T>;
const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const models = () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  User: require('../../models/User').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  AppBuildJob: require('../../models/AppBuildJob').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  UsageRecord: require('../../models/UsageRecord').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  UsageLock: require('../../models/UsageLock').default,
});

// ── Errors ─────────────────────────────────────────────────────────────────

const NOUN: Record<LimitedResource, [string, string]> = {
  students: ['active student', 'active students'],
  teachers: ['teacher', 'teachers'],
  admins: ['administrator', 'administrators'],
  appBuildsMonthly: ['app build this month', 'app builds per month'],
  aiGenerationsMonthly: ['AI generation this month', 'AI generations per month'],
};

/** 402 PLAN_LIMIT_REACHED — the caller's own organization's numbers, never anyone else's. */
export class PlanLimitReached extends Error {
  readonly status = 402;
  readonly code = 'PLAN_LIMIT_REACHED';
  constructor(
    readonly resource: LimitedResource,
    readonly limit: number,
    readonly current: number,
    readonly requested = 1,
  ) {
    super(
      `Your plan allows ${limit} ${limit === 1 ? NOUN[resource][0] : NOUN[resource][1]}, and ${current} ${current === 1 ? 'is' : 'are'} in use. ` +
        'Free one up, or ask the platform team to upgrade the plan.',
    );
    this.name = 'PlanLimitReached';
  }

  body() {
    return { message: this.message, code: this.code, resource: this.resource, limit: this.limit, current: this.current, requested: this.requested };
  }
}

/** 503 USAGE_CHECK_BUSY — the lease could not be had in time; nothing was written. */
export class UsageBusy extends Error {
  readonly status = 503;
  readonly code = 'USAGE_CHECK_BUSY';
  constructor(readonly resource: LimitedResource) {
    super('Too many changes are being made at once. Please try again in a moment.');
    this.name = 'UsageBusy';
  }
}

/** Send a limit refusal, or return false if `error` is not one. */
export function sendUsageError(res: Response, error: unknown): boolean {
  if (error instanceof PlanLimitReached) {
    res.status(402).json(error.body());
    return true;
  }
  if (error instanceof UsageBusy) {
    res.setHeader('Retry-After', '1');
    res.status(503).json({ message: error.message, code: error.code, resource: error.resource });
    return true;
  }
  return false;
}

// ── Rules ──────────────────────────────────────────────────────────────────

/** The seat a user occupies, or null (pending, rejected, parent, public learner). */
export function seatOf(user: { role?: string | null; status?: string | null; accountType?: string | null }): SeatResource | null {
  if (user.status !== 'approved') return null;
  if (user.role === 'student') return user.accountType === 'PUBLIC_LEARNER' ? null : 'students';
  if (user.role === 'teacher') return 'teachers';
  if (user.role === 'admin') return 'admins';
  return null;
}

/** The first instant of `now`'s calendar month in India (IST, UTC+05:30), as a UTC Date. */
export function monthStart(now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_OFFSET_MS);
}

/** The enforced limit for `resource`, or null when unlimited or not enforced. */
export function effectiveLimit(entitlement: Pick<ResolvedEntitlement, 'limits' | 'limitsEnforced'>, resource: LimitedResource): number | null {
  if (!entitlement.limitsEnforced) return null;
  const value = entitlement.limits?.[resource];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** Both forms an organization id is stored in: a string on tenant records, an ObjectId on platform ones. */
function orgForms(orgId: string): unknown[] {
  return mongoose.Types.ObjectId.isValid(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
}

function seatFilter(orgId: string, resource: SeatResource): Record<string, unknown> {
  const role = resource === 'students' ? 'student' : resource === 'teachers' ? 'teacher' : 'admin';
  return {
    orgId: { $in: orgForms(orgId) },
    role,
    status: 'approved',
    ...(resource === 'students' ? { accountType: { $ne: 'PUBLIC_LEARNER' } } : {}),
  };
}

function buildFilter(orgId: string, since: Date): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LIVE_BUILD_STATUSES } = require('../../models/AppBuildJob');
  return {
    orgId: { $in: orgForms(orgId) },
    queuedAt: { $gte: since },
    $or: [
      { status: { $in: [...LIVE_BUILD_STATUSES, 'completed'] } },
      { easBuildId: { $exists: true, $nin: [null, ''] } },
    ],
  };
}

/** How much of `resource` the organization is using now. */
export async function currentUsage(orgId: string, resource: LimitedResource, opts: { now?: Date; excludeUserId?: string } = {}): Promise<number> {
  const { User, AppBuildJob, UsageRecord } = models();
  const now = opts.now ?? new Date();
  return unscoped('count', async () => {
    if ((SEAT_RESOURCES as string[]).includes(resource)) {
      const filter = seatFilter(orgId, resource as SeatResource);
      if (opts.excludeUserId && mongoose.Types.ObjectId.isValid(opts.excludeUserId)) {
        filter._id = { $ne: new mongoose.Types.ObjectId(opts.excludeUserId) };
      }
      // The collection, not the model: a count that matches the stored data
      // exactly, with no plugin rewriting the filter.
      return User.collection.countDocuments(filter);
    }
    if (resource === 'appBuildsMonthly') return AppBuildJob.collection.countDocuments(buildFilter(orgId, monthStart(now)));
    const rows = await UsageRecord.collection
      .aggregate([
        { $match: { orgId: { $in: orgForms(orgId) }, meter: resource, periodStart: monthStart(now) } },
        { $group: { _id: null, total: { $sum: '$value' } } },
      ])
      .toArray();
    return Math.max(0, Number(rows[0]?.total ?? 0));
  });
}

async function occupiesSeat(orgId: string, resource: SeatResource, userId: string): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(userId)) return false;
  const { User } = models();
  return unscoped('occupies', async () =>
    Boolean(await User.collection.findOne({ ...seatFilter(orgId, resource), _id: new mongoose.Types.ObjectId(userId) }, { projection: { _id: 1 } })),
  );
}

// ── The lease ──────────────────────────────────────────────────────────────

async function acquire(orgId: string, resource: LimitedResource): Promise<string> {
  const { UsageLock } = models();
  const token = crypto.randomUUID();
  const deadline = Date.now() + waitMs();
  for (;;) {
    const now = new Date();
    try {
      const held = await unscoped('lock', () =>
        UsageLock.findOneAndUpdate(
          { orgId, resource, $or: [{ holder: null }, { expiresAt: { $lte: now } }] },
          { $set: { holder: token, expiresAt: new Date(now.getTime() + leaseMs()) } },
          { upsert: true, new: true },
        ).lean(),
      );
      if ((held as { holder?: string } | null)?.holder === token) return token;
    } catch (error) {
      // Held by someone else: the filter did not match, so the upsert tried to
      // insert a second lease and the unique index refused it.
      if (!isDuplicateKey(error)) throw error;
    }
    if (Date.now() > deadline) throw new UsageBusy(resource);
    await sleep(15 + Math.random() * 45);
  }
}

async function release(orgId: string, resource: LimitedResource, token: string): Promise<void> {
  const { UsageLock } = models();
  try {
    await unscoped('unlock', () => UsageLock.updateOne({ orgId, resource, holder: token }, { $set: { holder: null, expiresAt: new Date(0) } }));
  } catch (error) {
    // The lease expires by itself; a failed release delays, it never deadlocks.
    console.error(`[usage] could not release ${resource} for ${orgId}:`, (error as Error).message);
  }
}

async function limitOf(orgId: string, resource: LimitedResource): Promise<number | null> {
  try {
    return effectiveLimit(await getEntitlement(orgId), resource);
  } catch (error) {
    // Commercial, like the module gate: a resolution failure is not a lockout.
    console.error(`[usage] entitlement unavailable for ${orgId}; ${resource} not limited this time:`, (error as Error).message);
    return null;
  }
}

// ── Seats and builds ───────────────────────────────────────────────────────

export interface CapacityInput<T> {
  orgId: string | null | undefined;
  resource: CountedResource;
  /** The user that would take the seat, when it already exists (approve, role change). */
  subjectId?: string;
  run: () => Promise<T>;
  /** What to do instead of refusing when there is no room (e.g. register as pending). */
  onFull?: (state: { limit: number; current: number }) => Promise<T>;
}

/**
 * Run `run` only if the organization has room for one more `resource`.
 *
 * Re-running for something that already holds its seat (approving an approved
 * user, a retried request) is not a second seat: it runs without counting.
 * Without an organization (the existing /api system) or without an enforced
 * limit, `run` runs as it always did.
 */
export async function withCapacity<T>(input: CapacityInput<T>): Promise<T> {
  const { orgId, resource } = input;
  if (!orgId) return input.run();
  const limit = await limitOf(orgId, resource);
  if (limit === null) return input.run();

  const token = await acquire(orgId, resource);
  try {
    if (input.subjectId && (SEAT_RESOURCES as string[]).includes(resource) && (await occupiesSeat(orgId, resource as SeatResource, input.subjectId))) {
      return await input.run();
    }
    const current = await currentUsage(orgId, resource, { excludeUserId: input.subjectId });
    if (current + 1 > limit) {
      if (input.onFull) return await input.onFull({ limit, current });
      throw new PlanLimitReached(resource, limit, current);
    }
    return await input.run();
  } finally {
    await release(orgId, resource, token);
  }
}

// ── Metered usage (the UsageRecord ledger) ─────────────────────────────────

export interface Reservation {
  id: string;
}

/**
 * Record one unit of a metered resource, refusing if it would exceed the
 * enforced limit. Usage is recorded for every organization (it is what a usage
 * screen and a future bill read); only enforced limits refuse.
 */
export async function reserveMetered(input: {
  orgId: string | null | undefined;
  resource: MeteredResource;
  actor?: { id?: string; role?: string };
  metadata?: Record<string, unknown>;
  now?: Date;
}): Promise<Reservation | null> {
  const { orgId, resource } = input;
  if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) return null;
  const now = input.now ?? new Date();
  const { UsageRecord } = models();
  const write = async () => {
    const doc = await unscoped('reserve', () =>
      UsageRecord.create({
        orgId,
        meter: resource,
        value: 1,
        periodStart: monthStart(now),
        kind: 'reservation',
        actor: input.actor,
        metadata: input.metadata,
      }),
    );
    return { id: String((doc as { _id: unknown })._id) };
  };

  const limit = await limitOf(orgId, resource);
  if (limit === null) return write();

  const token = await acquire(orgId, resource);
  try {
    const current = await currentUsage(orgId, resource, { now });
    if (current + 1 > limit) throw new PlanLimitReached(resource, limit, current);
    return await write();
  } finally {
    await release(orgId, resource, token);
  }
}

/** Cancel a reservation. Idempotent: the second refund of one reservation is refused by the index. */
export async function refundMetered(reservationId: string, reason: string): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(reservationId)) return false;
  const { UsageRecord } = models();
  return unscoped('refund', async () => {
    const reservation = await UsageRecord.findOne({ _id: reservationId, kind: 'reservation' }).lean();
    if (!reservation) return false;
    try {
      await UsageRecord.create({
        orgId: reservation.orgId,
        meter: reservation.meter,
        value: -1,
        // The month the reservation counted against, even if it is now another.
        periodStart: reservation.periodStart,
        kind: 'refund',
        refundOf: reservation._id,
        subject: reservation.subject,
        metadata: { reason: String(reason).slice(0, 300) },
      });
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  });
}

/** Whether a job has already ended without producing anything. */
async function subjectFailed(subject: { type: string; id: string }): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(subject.id)) return false;
  return unscoped('subject-status', async () => {
    if (subject.type === 'ImportBatch') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ImportBatch } = require('../../models/ImportedQuestion');
      return Boolean(await ImportBatch.exists({ _id: subject.id, status: 'failed' }));
    }
    if (subject.type === 'AiGeneration') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const AiGeneration = require('../../models/AiGeneration').default;
      return Boolean(await AiGeneration.exists({ _id: subject.id, status: 'failed' }));
    }
    return false;
  });
}

/**
 * Name what a reservation paid for — the job that will finish (or fail) later.
 *
 * A job can fail before this link is written (an in-process job that fails in
 * its first millisecond), in which case its failure path found no reservation
 * to refund. So the job is checked AFTER linking: already failed means refund
 * now. Either order ends with exactly one refund.
 */
export async function attachSubject(reservationId: string, subject: { type: string; id: string }): Promise<void> {
  if (!mongoose.Types.ObjectId.isValid(reservationId)) return;
  const { UsageRecord } = models();
  await unscoped('attach', () =>
    UsageRecord.updateOne({ _id: reservationId, kind: 'reservation', 'subject.id': { $exists: false } }, { $set: { subject } }),
  );
  if (await subjectFailed(subject)) await refundMetered(reservationId, 'job failed before it was linked');
}

/**
 * Refund the reservation behind a job that failed or was cancelled. Safe to
 * call from every failure path, and more than once: each reservation is
 * refunded at most once, and a job with no reservation is a no-op.
 */
export async function refundForSubject(type: string, id: unknown, reason: string): Promise<number> {
  const { UsageRecord } = models();
  try {
    const rows = await unscoped('subject-find', () =>
      UsageRecord.find({ kind: 'reservation', 'subject.type': type, 'subject.id': String(id) }).select('_id').lean(),
    );
    let refunded = 0;
    for (const row of rows as { _id: unknown }[]) if (await refundMetered(String(row._id), reason)) refunded++;
    return refunded;
  } catch (error) {
    console.error(`[usage] refund for ${type} ${id} failed:`, (error as Error).message);
    return 0;
  }
}

// ── Express glue for metered routes ────────────────────────────────────────

const RESERVATION = Symbol.for('platform.usageReservation');

/**
 * Meter a route: one unit per accepted request. A response of 400 or above is
 * refunded when it is sent; an accepted async job (202) keeps its unit until
 * the job fails, when the job's failure path refunds it (`refundForSubject`).
 * Mount AFTER authentication, permission and module checks, so a refused
 * request never reserves anything.
 */
export function meterRequest(resource: MeteredResource) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { currentTenantOrgId } = require('../tenancy');
    const orgId: string | null = currentTenantOrgId();
    if (!orgId) return next();
    const user = (req as Request & { user?: { id?: string; role?: string } }).user;
    try {
      const reservation = await reserveMetered({
        orgId,
        resource,
        actor: { id: user?.id, role: user?.role },
        metadata: { method: req.method, path: String(req.originalUrl || req.url).split('?')[0] },
      });
      if (reservation) {
        (req as unknown as Record<symbol, string>)[RESERVATION] = reservation.id;
        res.on('finish', () => {
          if (res.statusCode >= 400) {
            refundMetered(reservation.id, `request answered ${res.statusCode}`).catch((error) =>
              console.error('[usage] refund after a failed request did not complete:', (error as Error).message),
            );
          }
        });
      }
      return next();
    } catch (error) {
      if (sendUsageError(res, error)) {
        await auditRefusal(orgId, user?.id, error);
        return undefined;
      }
      console.error(`[usage] metering ${resource} failed for ${orgId}; allowing the request:`, (error as Error).message);
      return next();
    }
  };
}

/** Tie this request's reservation to the job it started. Never throws. */
export async function attachUsageSubject(req: Request, type: string, id: unknown): Promise<void> {
  const reservationId = (req as unknown as Record<symbol, string | undefined>)[RESERVATION];
  if (!reservationId) return;
  try {
    await attachSubject(reservationId, { type, id: String(id) });
  } catch (error) {
    console.error('[usage] could not attach the job to its reservation:', (error as Error).message);
  }
}

/** Release this request's reservation: a metered route that turned out not to call the model. */
export function releaseRequestUsage(req: Request, reason: string): void {
  const reservationId = (req as unknown as Record<symbol, string | undefined>)[RESERVATION];
  if (!reservationId) return;
  refundMetered(reservationId, reason).catch((error) =>
    console.error('[usage] could not release the reservation:', (error as Error).message),
  );
}

/** Record a limit refusal in the organization's own audit log. Never throws. */
export async function auditRefusal(orgId: string | null, actorId: string | undefined, error: unknown): Promise<void> {
  if (!(error instanceof PlanLimitReached)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logAudit } = require('../../utils/logger');
    await logAudit(actorId, 'plan.limit.refused', orgId ?? undefined, {
      resource: error.resource,
      limit: error.limit,
      current: error.current,
    });
  } catch {
    /* best effort */
  }
}

// ── Reading usage ──────────────────────────────────────────────────────────

/**
 * Usage against every limit key, for the organization's own admins and for the
 * console. Resources with no meter report `used: null` rather than a zero that
 * would read as "nothing used".
 */
export async function usageSummary(orgId: string, entitlement?: ResolvedEntitlement) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LIMIT_KEYS } = require('./catalogue');
  const ent = entitlement ?? (await getEntitlement(orgId));
  const out: Record<string, { label: string; used: number | null; limit: number | null; enforced: boolean; metered: boolean; over: boolean }> = {};
  for (const [key, meta] of Object.entries(LIMIT_KEYS as Record<string, { label: string; enforced: boolean }>)) {
    const metered = (ENFORCED_RESOURCES as string[]).includes(key);
    const used = metered ? await currentUsage(orgId, key as LimitedResource) : null;
    const raw = ent.limits?.[key];
    const limit = typeof raw === 'number' && raw >= 0 ? raw : null;
    const enforced = Boolean(metered && ent.limitsEnforced && limit !== null);
    out[key] = { label: meta.label, used, limit, enforced, metered, over: used !== null && limit !== null && used > limit };
  }
  return out;
}
