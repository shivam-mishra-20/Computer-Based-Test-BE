/**
 * Subscriptions — the only code that writes a Subscription.
 *
 * Every change goes through here so that each one is:
 *   validated  against the lifecycle table (lifecycle.ts) — there is no "set
 *              status" back door, whoever asks;
 *   atomic     each write is conditional on the revision it read, so two staff
 *              actions, or a staff action and the clock, cannot both apply;
 *   recorded   an append-only SubscriptionEvent with who, why and what changed;
 *   effective  the entitlement snapshot is re-resolved before returning, so a
 *              suspension is read-only from the next request, not after a
 *              cache expires.
 *
 * Who may call what is decided by the routes (platform capabilities). Nothing
 * here is reachable from a tenant token: an organization can read its own
 * subscription through the org-admin view and can change none of it.
 *
 * Platform-owned organizations (Abhigyan, public learning) are refused every
 * lifecycle change: they are never billed, never suspended, never expired. To
 * treat one as a customer, its platform-owned flag has to be cleared first —
 * deliberately, and audited.
 */

import { withoutTenantScope } from '../tenancy/context';
import { resolveEntitlement } from '../entitlements/resolve';
import { getModule } from '../entitlements/moduleRegistry';
import {
  BILLING_INTERVALS,
  STAFF_EVENTS,
  SUBSCRIPTION_STATUSES,
  advance,
  applyEvent,
  availableStaffEvents,
  dueEvent,
  nextTransitionAt,
  type BillingInterval,
  type LifecycleEvent,
  type LifecycleState,
  type SubscriptionStatus,
} from './lifecycle';
import { LIMIT_KEYS, ensureVersioned, findPlan, getPlanVersion, termsForSubscription } from './catalogue';

export class SubscriptionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

export interface Actor {
  kind: 'platform' | 'system' | 'tenant';
  id?: string;
  email?: string;
  role?: string;
}

export const SYSTEM_ACTOR: Actor = { kind: 'system' };

const LIFECYCLE_FIELDS = [
  'status',
  'billingInterval',
  'trialEndsAt',
  'periodStart',
  'periodEnd',
  'graceEndsAt',
  'resumeStatus',
  'cancelledAt',
  'expiredAt',
  'cancelAtPeriodEnd',
] as const;

const ATTEMPTS = 4;
const CLAIM_MS = 2 * 60 * 1000;

const models = () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Org: require('../../models/Org').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Subscription: require('../../models/Subscription').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SubscriptionEvent: require('../../models/SubscriptionEvent').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Payment: require('../../models/Payment').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Plan: require('../../models/Plan').default,
});

// Models are required lazily (untyped), so rows are plain documents here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unscoped = (label: string, fn: () => any): Promise<any> => withoutTenantScope(`subscriptions:${label}`, fn) as Promise<any>;
const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

type Doc = Record<string, any>;

export function stateOf(sub: Doc): LifecycleState {
  return {
    status: sub.status,
    billingInterval: sub.billingInterval ?? 'monthly',
    trialEndsAt: sub.trialEndsAt ?? null,
    periodStart: sub.periodStart ?? null,
    periodEnd: sub.periodEnd ?? null,
    graceEndsAt: sub.graceEndsAt ?? null,
    resumeStatus: sub.resumeStatus ?? null,
    cancelledAt: sub.cancelledAt ?? null,
    expiredAt: sub.expiredAt ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd ? true : null,
  };
}

const comparable = (v: unknown) => (v instanceof Date ? v.getTime() : v ?? null);

function lifecycleChanges(before: LifecycleState | null, after: LifecycleState) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of LIFECYCLE_FIELDS) {
    const from = before ? (before as unknown as Doc)[field] ?? null : null;
    const to = (after as unknown as Doc)[field] ?? null;
    if (comparable(from) !== comparable(to)) changes[field] = { from, to };
  }
  return changes;
}

/** $set the present lifecycle fields, $unset the cleared ones. */
function lifecycleUpdate(next: LifecycleState): { $set: Doc; $unset: Doc } {
  const $set: Doc = {};
  const $unset: Doc = {};
  for (const field of LIFECYCLE_FIELDS) {
    const value = (next as unknown as Doc)[field];
    if (value === null || value === undefined) $unset[field] = 1;
    else $set[field] = value;
  }
  return { $set, $unset };
}

function revisionFilter(sub: Doc): Doc {
  return sub.revision === undefined || sub.revision === null
    ? { _id: sub._id, revision: { $exists: false } }
    : { _id: sub._id, revision: sub.revision };
}

/** Write conditional on the revision read. Returns the new document, or null if it lost a race. */
async function writeConditional(sub: Doc, update: { $set?: Doc; $unset?: Doc }): Promise<Doc | null> {
  const { Subscription } = models();
  const op: Doc = { $inc: { revision: 1 } };
  if (update.$set && Object.keys(update.$set).length) op.$set = update.$set;
  if (update.$unset && Object.keys(update.$unset).length) op.$unset = update.$unset;
  return unscoped('write', () => Subscription.findOneAndUpdate(revisionFilter(sub), op, { new: true }).lean());
}

/** Append to an organization's subscription history (and tell its admins, where the event has a notice). */
export async function recordSubscriptionEvent(input: Parameters<typeof recordEvent>[0]): Promise<void> {
  return recordEvent(input);
}

async function recordEvent(input: {
  orgId: string;
  subscriptionId?: unknown;
  type: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  actor: Actor;
  reason?: string;
  changes?: Doc;
  metadata?: Doc;
  at?: Date;
  /** The state after the event — what the organization's admins are told (core/billing/notices). */
  after?: Doc;
  planName?: string;
}): Promise<void> {
  const { SubscriptionEvent } = models();
  try {
    await unscoped('record-event', () =>
      SubscriptionEvent.create({
        orgId: input.orgId,
        subscriptionId: input.subscriptionId,
        type: input.type,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus ?? null,
        actor: { kind: input.actor.kind, id: input.actor.id, email: input.actor.email, role: input.actor.role },
        reason: input.reason?.slice(0, 1000),
        changes: input.changes && Object.keys(input.changes).length ? input.changes : undefined,
        metadata: input.metadata,
        at: input.at ?? new Date(),
      }),
    );
  } catch (error) {
    // Same policy as the platform audit: the change happened; a lost history
    // row is logged loudly rather than undoing it.
    console.error(`[subscriptions] FAILED to record "${input.type}" for ${input.orgId}:`, (error as Error).message);
  }
  // Tell the organization's admins, without waiting: the change has happened
  // whether or not a notice can be delivered.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sendEventNotice } = require('../billing/notices');
  void sendEventNotice(input.orgId, input.type, { after: input.after, metadata: input.metadata, planName: input.planName });
}

async function loadContext(orgId: string): Promise<{ org: Doc; sub: Doc | null }> {
  const { Org, Subscription } = models();
  const [org, sub] = await unscoped('load', () =>
    Promise.all([
      Org.findById(orgId).select('name slug status isPlatformOwned subscriptionRequired deletion').lean(),
      Subscription.findOne({ orgId }).lean(),
    ]),
  );
  if (!org) throw new SubscriptionError(404, 'ORG_NOT_FOUND', 'Organization not found.');
  if (org.deletion) throw new SubscriptionError(409, 'ORG_DELETING', 'This organization is being deleted.');
  return { org, sub };
}

export function isPlatformOwned(org: Doc | null, sub: Doc | null): boolean {
  return Boolean(org?.isPlatformOwned || sub?.isPlatformOwned);
}

function refusePlatformOwned(): never {
  throw new SubscriptionError(
    409,
    'PLATFORM_OWNED',
    'This organization is platform-owned: it is never billed, suspended or expired. Clear its platform-owned flag first if it should be treated as a customer.',
  );
}

function requireReason(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 3) throw new SubscriptionError(400, 'REASON_REQUIRED', 'Give a reason for this change; it is kept in the subscription history.');
  return text.slice(0, 1000);
}

function intervalOf(value: unknown): BillingInterval | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!(BILLING_INTERVALS as string[]).includes(String(value))) {
    throw new SubscriptionError(400, 'SUBSCRIPTION_INVALID', `Billing interval must be one of: ${BILLING_INTERVALS.join(', ')}.`);
  }
  return value as BillingInterval;
}

function dateOf(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value as string);
  if (Number.isNaN(d.getTime())) throw new SubscriptionError(400, 'SUBSCRIPTION_INVALID', `${field} is not a valid date.`);
  return d;
}

/**
 * The plan fields to write for `planKey` (current version unless one is named).
 * `allowInactive`: the plan was agreed while it was on sale (an invoice names
 * it), so taking it off sale since must not stop the paid order applying.
 */
async function planFields(planKey: string, version: number | undefined, currentPlanKey?: string, allowInactive = false) {
  const plan = await findPlan(planKey);
  if (!plan) throw new SubscriptionError(404, 'PLAN_NOT_FOUND', `Plan "${planKey}" was not found.`);
  if (plan.isActive === false && plan.key !== currentPlanKey && !allowInactive) {
    throw new SubscriptionError(409, 'PLAN_INACTIVE', `Plan "${plan.name}" is not on sale.`);
  }
  const current = await ensureVersioned(plan.key);
  const pinned = version ?? current;
  const exists = await getPlanVersion(plan.key, pinned);
  if (!exists) throw new SubscriptionError(404, 'PLAN_VERSION_NOT_FOUND', `Plan "${plan.key}" has no version ${pinned}.`);
  return {
    fields: { planId: plan._id, planKey: plan.key, planVersion: pinned },
    trialDays: exists.trialDays as number | undefined,
    name: plan.name as string,
  };
}

async function settle(orgId: string, reason: string) {
  return resolveEntitlement(orgId, reason);
}

// ── The clock ──────────────────────────────────────────────────────────────

/**
 * Apply every clock event due at `now`: trial end, period end, grace end.
 * Idempotent — a second call at the same moment finds nothing due.
 */
export async function advanceSubscription(orgId: string, now = new Date()): Promise<{ events: LifecycleEvent[] }> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { Org, Subscription } = models();
    const [org, sub] = await unscoped('advance-load', () =>
      Promise.all([Org.findById(orgId).select('isPlatformOwned').lean(), Subscription.findOne({ orgId }).lean()]),
    );
    // Only a managed subscription has a clock. One from before the lifecycle
    // keeps its dates, if any, without being moved by them — see managedSince.
    if (!sub || !sub.managedSince || isPlatformOwned(org, sub)) return { events: [] };

    const before = stateOf(sub);
    const { state, events } = advance(before, now);
    if (!events.length) return { events: [] };

    const updated = await writeConditional(sub, lifecycleUpdate(state));
    if (!updated) continue; // someone else moved it; look again

    let step = before;
    for (const event of events) {
      const result = applyEvent(step, event, { now });
      if (!result.ok) break;
      await recordEvent({
        orgId,
        subscriptionId: sub._id,
        type: event,
        fromStatus: step.status,
        toStatus: result.next.status,
        actor: SYSTEM_ACTOR,
        changes: lifecycleChanges(step, result.next),
        after: result.next,
      });
      step = result.next;
    }
    await settle(orgId, `subscription:${events.join('+')}`);
    return { events };
  }
  throw new SubscriptionError(409, 'SUBSCRIPTION_CONFLICT', 'The subscription kept changing while the clock was applied.');
}

/**
 * The daily sweep: every subscription with something due. Each organization is
 * advanced on its own, so one failure never stops the rest.
 */
export async function runLifecycleSweep(now = new Date(), limit = 1000) {
  const { Subscription } = models();
  const due = await unscoped('sweep-find', () =>
    Subscription.find({
      isPlatformOwned: { $ne: true },
      managedSince: { $exists: true },
      $or: [
        { status: 'trialing', trialEndsAt: { $lte: now } },
        { status: 'active', periodEnd: { $lte: now } },
        { status: 'past_due', graceEndsAt: { $lte: now } },
      ],
    })
      .select('orgId')
      .limit(limit)
      .lean(),
  );
  const summary = { examined: due.length, advanced: 0, failed: 0, errors: [] as string[] };
  for (const row of due) {
    try {
      const { events } = await advanceSubscription(String(row.orgId), now);
      if (events.length) summary.advanced++;
    } catch (error) {
      summary.failed++;
      summary.errors.push(`${row.orgId}: ${(error as Error).message}`);
    }
  }
  const reminded = await remindTrialsEnding(now);
  // Next periods: renewal invoices, auto-pay charges and reminders (core/billing/renewals).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { runRenewals } = require('../billing/renewals');
  const renewals = await runRenewals(now).catch((error: Error) => ({ errors: [`renewals: ${error.message}`] }));
  return { ...summary, reminded, renewals };
}

const REMIND_DAYS = 3;

/**
 * "Your trial ends in N days" — once per trial end, for managed trials ending
 * within REMIND_DAYS. Run by the daily sweep. Extending a trial gives it a new
 * end, and so one more reminder before that end.
 */
export async function remindTrialsEnding(now = new Date()): Promise<number> {
  const { Subscription, Org } = models();
  const until = new Date(now.getTime() + REMIND_DAYS * 24 * 60 * 60 * 1000);
  const due: Doc[] = await unscoped('remind-find', () =>
    Subscription.find({
      status: 'trialing',
      managedSince: { $exists: true },
      isPlatformOwned: { $ne: true },
      trialEndsAt: { $gt: now, $lte: until },
      // An institute that chose to stop at the trial's end is not reminded to choose a plan.
      cancelAtPeriodEnd: { $ne: true },
    })
      .select('orgId trialEndsAt trialReminderFor')
      .limit(1000)
      .lean(),
  );
  let sent = 0;
  for (const sub of due) {
    if (sub.trialReminderFor && new Date(sub.trialReminderFor).getTime() === new Date(sub.trialEndsAt).getTime()) continue;
    const org = await unscoped('remind-org', () => Org.findById(sub.orgId).select('isPlatformOwned').lean());
    if (org?.isPlatformOwned) continue;
    // Claimed by the write: two sweeps at once send one reminder.
    const claimed = await unscoped('remind-claim', () =>
      Subscription.updateOne(
        { _id: sub._id, trialEndsAt: sub.trialEndsAt, trialReminderFor: { $ne: sub.trialEndsAt } },
        { $set: { trialReminderFor: sub.trialEndsAt } },
      ),
    );
    if (claimed.modifiedCount !== 1) continue;
    const days = Math.max(1, Math.ceil((new Date(sub.trialEndsAt).getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sendEventNotice } = require('../billing/notices');
    await sendEventNotice(String(sub.orgId), 'trial_ending', { after: sub, metadata: { days } });
    sent++;
  }
  return sent;
}

// ── Staff lifecycle actions ────────────────────────────────────────────────

export interface TransitionOptions {
  actor: Actor;
  reason?: string;
  days?: number;
  periodEnd?: Date | string | null;
  billingInterval?: string;
  /** start_trial / activate / payment_confirmed: put the subscription on this plan as part of the change. */
  planKey?: string;
  planVersion?: number;
  /** The plan was agreed while on sale (a paid invoice names it); apply it even if it has since been taken off sale. */
  allowInactivePlan?: boolean;
  metadata?: Doc;
  now?: Date;
}

/**
 * Apply one lifecycle event. Throws SubscriptionError when the table does not
 * allow it from the current status.
 */
export async function transition(orgId: string, event: LifecycleEvent, opts: TransitionOptions) {
  const now = opts.now ?? new Date();
  const reason = (STAFF_EVENTS as string[]).includes(event) ? requireReason(opts.reason) : opts.reason;
  const billingInterval = intervalOf(opts.billingInterval);
  const periodEnd = opts.periodEnd === null ? null : dateOf(opts.periodEnd, 'periodEnd');

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { org, sub } = await loadContext(orgId);
    if (isPlatformOwned(org, sub)) refusePlatformOwned();

    // Let the clock catch up first, so the action applies to where the
    // subscription really is: extending a trial that ended yesterday extends a
    // past_due subscription, not a stale "trialing" one.
    if (sub && sub.managedSince && dueEvent(stateOf(sub), now)) {
      await advanceSubscription(orgId, now);
      continue;
    }

    let plan: Awaited<ReturnType<typeof planFields>> | null = null;
    if (opts.planKey && (event === 'start_trial' || event === 'activate' || event === 'payment_confirmed')) {
      plan = await planFields(String(opts.planKey).toLowerCase(), opts.planVersion, sub?.planKey, opts.allowInactivePlan);
    }
    const days = opts.days ?? (event === 'start_trial' ? plan?.trialDays : undefined);

    const before = sub ? stateOf(sub) : null;
    const result = applyEvent(before, event, { now, days, periodEnd, billingInterval });
    if (result.ok === false) {
      throw new SubscriptionError(result.code === 'INVALID_TRANSITION' ? 409 : 400, result.code, result.message, {
        event,
        from: sub?.status ?? null,
      });
    }
    if (!result.changed) return { subscription: sub, changed: false };

    const changes = lifecycleChanges(before, result.next);
    let saved: Doc | null;
    if (!sub) {
      const { Subscription } = models();
      try {
        saved = (
          await unscoped('create', () =>
            Subscription.create({
              orgId,
              ...lifecycleUpdate(result.next).$set,
              ...(plan?.fields ?? {}),
              revision: 1,
              managedSince: now,
            }),
          )
        ).toObject();
      } catch (error) {
        if (isDuplicateKey(error)) continue; // created concurrently — re-read it
        throw error;
      }
    } else {
      const update = lifecycleUpdate(result.next);
      if (plan) Object.assign(update.$set, plan.fields);
      if (!sub.managedSince) update.$set.managedSince = now;
      // A renewal, a trial or a staff decision supersedes the institute's own
      // request to stop at period end; the record of it goes with the flag.
      if (!result.next.cancelAtPeriodEnd && sub.cancellationRequest) update.$unset.cancellationRequest = 1;
      saved = await writeConditional(sub, update);
      if (!saved) continue;
    }

    await recordEvent({
      orgId,
      subscriptionId: saved!._id,
      type: event,
      fromStatus: sub?.status ?? null,
      toStatus: result.next.status,
      actor: opts.actor,
      reason,
      changes,
      metadata: {
        ...(opts.metadata ?? {}),
        ...(plan ? { planKey: plan.fields.planKey, planVersion: plan.fields.planVersion } : {}),
      },
      at: now,
      after: result.next,
      planName: plan?.name,
    });
    const entitlement = await settle(orgId, `subscription:${event}`);
    return { subscription: saved, changed: true, entitlement };
  }
  throw new SubscriptionError(409, 'SUBSCRIPTION_CONFLICT', 'The subscription changed while this was being applied. Reload and try again.');
}

/** Start a trial, or extend the one running (or just ended, inside its grace period). */
export async function startOrExtendTrial(orgId: string, opts: TransitionOptions) {
  const { sub } = await loadContext(orgId);
  const extend = sub && ['trialing', 'past_due'].includes(sub.status);
  return transition(orgId, extend ? 'extend_trial' : 'start_trial', opts);
}

/** Put an organization's subscription on a plan (and version). Status and dates are unchanged. */
export async function assignPlan(
  orgId: string,
  opts: { planKey: string; planVersion?: number; billingInterval?: string; actor: Actor; reason?: string },
) {
  const billingInterval = intervalOf(opts.billingInterval);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { org, sub } = await loadContext(orgId);
    if (!sub) {
      throw new SubscriptionError(404, 'SUBSCRIPTION_NOT_FOUND', 'This organization has no subscription yet. Start a trial or activate it first.');
    }
    if (isPlatformOwned(org, sub)) refusePlatformOwned();

    const plan = await planFields(String(opts.planKey).toLowerCase(), opts.planVersion, sub.planKey);
    const interval = billingInterval ?? sub.billingInterval ?? 'monthly';
    if (sub.planKey === plan.fields.planKey && sub.planVersion === plan.fields.planVersion && sub.billingInterval === interval) {
      return { subscription: sub, changed: false };
    }

    // Assigning a plan through the lifecycle is what puts its terms — limits
    // included — into force for a subscription from before it.
    const saved = await writeConditional(sub, {
      $set: { ...plan.fields, billingInterval: interval, ...(sub.managedSince ? {} : { managedSince: new Date() }) },
    });
    if (!saved) continue;

    await recordEvent({
      orgId,
      subscriptionId: sub._id,
      type: 'plan_changed',
      fromStatus: sub.status,
      toStatus: sub.status,
      actor: opts.actor,
      reason: opts.reason,
      metadata: {
        from: { planKey: sub.planKey ?? null, planVersion: sub.planVersion ?? null, billingInterval: sub.billingInterval ?? null },
        to: { planKey: plan.fields.planKey, planVersion: plan.fields.planVersion, billingInterval: interval },
      },
      after: saved,
      planName: plan.name,
    });
    const entitlement = await settle(orgId, 'subscription:plan-changed');
    return { subscription: saved, changed: true, entitlement };
  }
  throw new SubscriptionError(409, 'SUBSCRIPTION_CONFLICT', 'The subscription changed while this was being applied. Reload and try again.');
}

/**
 * Move every subscription on an older version of a plan to its current
 * version — how new terms (the recommended limits, say) reach existing
 * customers. One `assignPlan` per organization, so each move is atomic,
 * recorded in its history and notified.
 *
 * Skipped, and reported: platform-owned organizations (never limited), and
 * subscriptions from before the lifecycle unless `includeUnmanaged` — moving
 * one of those brings it under management, so its status, dates and limits
 * start being enforced, which deserves a deliberate choice.
 */
export async function movePlanSubscribers(
  planKey: string,
  opts: { actor: Actor; reason?: string; includeUnmanaged?: boolean },
) {
  const reason = requireReason(opts.reason);
  const plan = await findPlan(String(planKey).toLowerCase());
  if (!plan) throw new SubscriptionError(404, 'PLAN_NOT_FOUND', `Plan "${planKey}" was not found.`);
  const current = await ensureVersioned(plan.key);
  const { Subscription, Org } = models();
  const subs: Doc[] = await unscoped('move-find', () =>
    Subscription.find({ planKey: plan.key, $or: [{ planVersion: { $ne: current } }, { planVersion: { $exists: false } }] })
      .select('orgId planVersion managedSince isPlatformOwned billingInterval')
      .lean(),
  );
  const orgs: Doc[] = await unscoped('move-orgs', () =>
    Org.find({ _id: { $in: subs.map((x) => x.orgId) } }).select('name isPlatformOwned').lean(),
  );
  const orgById = new Map(orgs.map((o) => [String(o._id), o]));
  const moved: { orgId: string; name?: string; from: number | null }[] = [];
  const skipped: { orgId: string; name?: string; why: string }[] = [];
  for (const sub of subs) {
    const org = orgById.get(String(sub.orgId));
    const entry = { orgId: String(sub.orgId), name: org?.name as string | undefined };
    if (isPlatformOwned(org ?? null, sub)) {
      skipped.push({ ...entry, why: 'platform-owned' });
      continue;
    }
    if (!sub.managedSince && !opts.includeUnmanaged) {
      skipped.push({ ...entry, why: 'not managed by the lifecycle' });
      continue;
    }
    try {
      await assignPlan(String(sub.orgId), { planKey: plan.key, planVersion: current, actor: opts.actor, reason });
      moved.push({ ...entry, from: sub.planVersion ?? null });
    } catch (error) {
      skipped.push({ ...entry, why: (error as Error).message });
    }
  }
  return { planKey: plan.key, version: current, moved, skipped };
}

/**
 * Bring a subscription from before the lifecycle under it, as it stands: from
 * now on its status is enforced (read-only when not writable), its limits are
 * enforced, and its dates are advanced by the clock.
 *
 * The one deliberate way to start enforcing an EXISTING organization without
 * also changing its plan or status. The response's entitlement says what the
 * organization can now do — staff should read it, because a subscription that
 * was quietly "suspended" for months becomes read-only here.
 */
export async function startManaging(orgId: string, opts: { actor: Actor; reason?: string }) {
  const reason = requireReason(opts.reason);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { org, sub } = await loadContext(orgId);
    if (!sub) throw new SubscriptionError(404, 'SUBSCRIPTION_NOT_FOUND', 'This organization has no subscription to manage.');
    if (isPlatformOwned(org, sub)) refusePlatformOwned();
    if (sub.managedSince) return { subscription: sub, changed: false, entitlement: await settle(orgId, 'subscription:managed') };

    const saved = await writeConditional(sub, { $set: { managedSince: new Date() } });
    if (!saved) continue;
    await recordEvent({
      orgId,
      subscriptionId: sub._id,
      type: 'managed',
      fromStatus: sub.status,
      toStatus: sub.status,
      actor: opts.actor,
      reason,
      metadata: { note: 'Status and limits enforced from now on.' },
    });
    const entitlement = await settle(orgId, 'subscription:managed');
    return { subscription: saved, changed: true, entitlement };
  }
  throw new SubscriptionError(409, 'SUBSCRIPTION_CONFLICT', 'The subscription changed while this was being applied. Reload and try again.');
}

// ── The institute's own cancellation (org-admin, self-serve) ───────────────

/**
 * Stop at the end of what the institute already has — its trial, or the
 * period it paid for. Nothing changes before that date; then the clock
 * cancels instead of starting grace (lifecycle.ts `cancelAtPeriodEnd`).
 *
 * Only for a managed subscription that is trialing or active with an end
 * date. Withdrawn by `withdrawCancellation`; superseded by any renewal.
 */
export async function scheduleCancellation(orgId: string, opts: { actor: Actor; reason?: string }) {
  const reason = typeof opts.reason === 'string' ? opts.reason.trim().slice(0, 1000) : '';
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const now = new Date();
    const { org, sub } = await loadContext(orgId);
    if (!sub) throw new SubscriptionError(404, 'SUBSCRIPTION_NOT_FOUND', 'There is no subscription to cancel.');
    if (isPlatformOwned(org, sub)) refusePlatformOwned();
    if (!sub.managedSince) {
      throw new SubscriptionError(409, 'SUBSCRIPTION_UNMANAGED', 'Your subscription is arranged directly with the platform team. Ask them to cancel it.');
    }
    if (dueEvent(stateOf(sub), now)) {
      await advanceSubscription(orgId, now);
      continue;
    }
    const endsAt = sub.status === 'trialing' ? sub.trialEndsAt : sub.status === 'active' ? sub.periodEnd : null;
    if (!endsAt) {
      throw new SubscriptionError(409, 'CANCEL_NOT_SCHEDULABLE', 'This subscription has no end date to cancel at.', { status: sub.status });
    }
    if (sub.cancelAtPeriodEnd) return { subscription: sub, changed: false, endsAt };

    const saved = await writeConditional(sub, {
      $set: {
        cancelAtPeriodEnd: true,
        cancellationRequest: { at: now, by: { id: opts.actor.id, email: opts.actor.email }, ...(reason ? { reason } : {}) },
      },
    });
    if (!saved) continue;
    await recordEvent({
      orgId,
      subscriptionId: sub._id,
      type: 'cancellation_scheduled',
      fromStatus: sub.status,
      toStatus: sub.status,
      actor: opts.actor,
      reason: reason || undefined,
      metadata: { endsAt },
      at: now,
      after: saved,
    });
    return { subscription: saved, changed: true, endsAt };
  }
  throw new SubscriptionError(409, 'SUBSCRIPTION_CONFLICT', 'The subscription changed while this was being applied. Reload and try again.');
}

/** Keep going after all: withdraw a scheduled cancellation before it takes effect. */
export async function withdrawCancellation(orgId: string, opts: { actor: Actor }) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const now = new Date();
    const { org, sub } = await loadContext(orgId);
    if (!sub) throw new SubscriptionError(404, 'SUBSCRIPTION_NOT_FOUND', 'There is no subscription.');
    if (isPlatformOwned(org, sub)) refusePlatformOwned();
    if (sub.managedSince && dueEvent(stateOf(sub), now)) {
      await advanceSubscription(orgId, now);
      continue;
    }
    if (!sub.cancelAtPeriodEnd) return { subscription: sub, changed: false };
    if (!['trialing', 'active'].includes(sub.status)) {
      throw new SubscriptionError(409, 'INVALID_TRANSITION', 'The cancellation has already taken effect.', { from: sub.status });
    }
    const saved = await writeConditional(sub, { $unset: { cancelAtPeriodEnd: 1, cancellationRequest: 1 } });
    if (!saved) continue;
    await recordEvent({
      orgId,
      subscriptionId: sub._id,
      type: 'cancellation_withdrawn',
      fromStatus: sub.status,
      toStatus: sub.status,
      actor: opts.actor,
      at: now,
      after: saved,
    });
    return { subscription: saved, changed: true };
  }
  throw new SubscriptionError(409, 'SUBSCRIPTION_CONFLICT', 'The subscription changed while this was being applied. Reload and try again.');
}

/** Whether this organization has ever had a trial — a self-serve trial is offered once. */
export async function hasHadTrial(orgId: string): Promise<boolean> {
  const { SubscriptionEvent, Subscription } = models();
  const [event, sub] = await unscoped('trial-used', () =>
    Promise.all([
      SubscriptionEvent.exists({ orgId, type: 'start_trial' }),
      Subscription.findOne({ orgId }).select('trialEndsAt').lean(),
    ]),
  );
  return Boolean(event || sub?.trialEndsAt);
}

// ── The subscription editor (modules, overrides, platform-owned) ───────────

export interface ShapeInput {
  planId?: string | null;
  planKey?: string | null;
  addOns?: string[];
  removals?: string[];
  overrides?: { modules?: string[]; limits?: Record<string, number> };
  status?: string;
  isPlatformOwned?: boolean;
  notes?: string;
}

function moduleList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new SubscriptionError(400, 'SUBSCRIPTION_INVALID', `${field} must be a list of module keys.`);
  const keys = [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
  const unknown = keys.filter((k) => !getModule(k));
  if (unknown.length) throw new SubscriptionError(400, 'SUBSCRIPTION_INVALID', `Unknown module(s) in ${field}: ${unknown.join(', ')}.`);
  return keys;
}

function overrideLimits(value: unknown): Record<string, number> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw new SubscriptionError(400, 'SUBSCRIPTION_INVALID', 'overrides.limits must be an object.');
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Doc)) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (!LIMIT_KEYS[key]) throw new SubscriptionError(400, 'SUBSCRIPTION_INVALID', `Unknown limit "${key}".`);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < -1) throw new SubscriptionError(400, 'SUBSCRIPTION_INVALID', `Limit "${key}" must be a whole number, or -1 for unlimited.`);
    out[key] = n;
  }
  return out;
}

/** Which staff event a requested status means, from a given status. */
function eventForStatus(target: string, from: SubscriptionStatus | null): LifecycleEvent | null {
  switch (target) {
    case 'active':
      return from === 'suspended' ? 'reactivate' : 'activate';
    case 'suspended':
      return 'suspend';
    case 'cancelled':
      return 'cancel';
    case 'expired':
      return 'expire';
    case 'trialing':
      return from === 'trialing' || from === 'past_due' ? 'extend_trial' : 'start_trial';
    default:
      return null;
  }
}

/**
 * The console's subscription editor (PUT /orgs/:orgId/subscription) and the
 * onboarding orchestrator's re-run path.
 *
 * Modules, overrides and the platform-owned flag are edited in place. A
 * requested STATUS is not written: it is translated into the lifecycle event
 * it means and goes through the table like any other — so this endpoint cannot
 * jump a subscription to a status the lifecycle would refuse.
 *
 * Creating a subscription here (an organization without one) keeps the
 * pre-lifecycle behaviour exactly: an open-ended record with no trial end, so
 * toggling a module for an existing customer never starts a clock they did not
 * agree to. Dated trials come from the trial action.
 */
export async function updateSubscriptionShape(orgId: string, input: ShapeInput, actor: Actor) {
  const addOns = moduleList(input.addOns, 'addOns');
  const removals = moduleList(input.removals, 'removals');
  const overrideModules = moduleList(input.overrides?.modules, 'overrides.modules');
  const limits = overrideLimits(input.overrides?.limits);
  const requested = input.status === undefined || input.status === null || input.status === '' ? undefined : String(input.status);
  if (requested !== undefined && !(SUBSCRIPTION_STATUSES as string[]).includes(requested) && !['unsubscribed', 'unassigned'].includes(requested)) {
    throw new SubscriptionError(400, 'SUBSCRIPTION_INVALID', `"${requested}" is not a subscription status.`);
  }

  let planKey: string | undefined;
  if (input.planKey) planKey = String(input.planKey).toLowerCase();
  else if (input.planId) {
    const { Plan } = models();
    const plan = await unscoped('plan-by-id', () => Plan.findById(input.planId).select('key').lean());
    if (!plan) throw new SubscriptionError(404, 'PLAN_NOT_FOUND', 'Plan not found.');
    planKey = plan.key;
  }

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { org, sub: found } = await loadContext(orgId);
    let sub = found;

    if (!sub) {
      const initial = requested === 'active' ? 'active' : 'trialing';
      if (requested && !['active', 'trialing', 'unsubscribed', 'unassigned'].includes(requested)) {
        throw new SubscriptionError(409, 'INVALID_TRANSITION', `A new subscription cannot start as "${requested}".`, { from: null });
      }
      const { Subscription } = models();
      try {
        sub = (
          await unscoped('create-open', () => Subscription.create({ orgId, status: initial, revision: 1 }))
        ).toObject();
      } catch (error) {
        if (isDuplicateKey(error)) continue;
        throw error;
      }
      await recordEvent({
        orgId,
        subscriptionId: sub!._id,
        type: 'created',
        fromStatus: null,
        toStatus: initial,
        actor,
        reason: 'Created by the subscription editor (open-ended: no trial or period end).',
      });
    }

    const $set: Doc = {};
    if (addOns) $set.addOns = addOns;
    if (removals) $set.removals = removals;
    if (input.overrides) {
      $set.overrides = {
        modules: overrideModules ?? sub!.overrides?.modules ?? [],
        limits: limits ?? sub!.overrides?.limits ?? {},
      };
    }
    if (input.notes !== undefined) $set.notes = String(input.notes).slice(0, 2000);
    const ownedChange = input.isPlatformOwned !== undefined && Boolean(input.isPlatformOwned) !== Boolean(sub!.isPlatformOwned);
    if (ownedChange) $set.isPlatformOwned = Boolean(input.isPlatformOwned);

    if (Object.keys($set).length) {
      const saved = await writeConditional(sub!, { $set });
      if (!saved) continue;
      const changed = Object.keys($set).filter((k) => k !== 'isPlatformOwned');
      if (changed.length) {
        await recordEvent({
          orgId,
          subscriptionId: sub!._id,
          type: 'entitlements_changed',
          fromStatus: sub!.status,
          toStatus: sub!.status,
          actor,
          metadata: Object.fromEntries(changed.map((k) => [k, { from: sub![k] ?? null, to: $set[k] }])),
        });
      }
      if (ownedChange) {
        await recordEvent({
          orgId,
          subscriptionId: sub!._id,
          type: 'platform_owned_changed',
          fromStatus: sub!.status,
          toStatus: sub!.status,
          actor,
          metadata: { from: Boolean(sub!.isPlatformOwned), to: Boolean(input.isPlatformOwned) },
        });
      }
      sub = saved;
    }

    if (planKey) await assignPlan(orgId, { planKey, actor, reason: 'Set through the subscription editor.' });

    if (requested && requested !== sub!.status && !['unsubscribed', 'unassigned'].includes(requested)) {
      if (isPlatformOwned(org, sub)) refusePlatformOwned();
      const event = eventForStatus(requested, sub!.status);
      if (!event) {
        throw new SubscriptionError(409, 'INVALID_TRANSITION', `"${requested}" is set by the billing clock, not by hand.`, { from: sub!.status });
      }
      await transition(orgId, event, { actor, reason: 'Set through the subscription editor.' });
    }

    return settle(orgId, 'subscription-changed');
  }
  throw new SubscriptionError(409, 'SUBSCRIPTION_CONFLICT', 'The subscription changed while this was being applied. Reload and try again.');
}

// ── Payments (manual; provider-neutral record) ─────────────────────────────

export interface ManualPaymentInput {
  amount: number | string;
  currency?: string;
  method: string;
  reference: string;
  receivedAt?: string | Date;
  periodEnd?: string | Date;
  billingInterval?: string;
  notes?: string;
}

function paymentFields(input: ManualPaymentInput, now: Date, opts: { amountRequired: boolean } = { amountRequired: true }) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PAYMENT_METHODS } = require('../../models/Payment');
  const reference = String(input.reference ?? '').trim();
  if (reference.length < 3 || reference.length > 120) {
    throw new SubscriptionError(400, 'PAYMENT_INVALID', 'A payment reference (UTR, cheque or transaction number) of 3–120 characters is required.');
  }
  if (!PAYMENT_METHODS.includes(input.method)) {
    throw new SubscriptionError(400, 'PAYMENT_INVALID', `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}.`);
  }
  const omitted = input.amount === undefined || input.amount === null || input.amount === '';
  const amount = omitted && !opts.amountRequired ? 0 : Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0 || (opts.amountRequired && amount <= 0) || amount > 10_000_000) {
    throw new SubscriptionError(400, 'PAYMENT_INVALID', 'The amount must be more than zero.');
  }
  const receivedAt = dateOf(input.receivedAt, 'receivedAt') ?? now;
  if (receivedAt.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    throw new SubscriptionError(400, 'PAYMENT_INVALID', 'A payment cannot be received in the future.');
  }
  return {
    reference,
    method: input.method,
    amountMinor: Math.round(amount * 100),
    currency: String(input.currency || 'INR').toUpperCase(),
    receivedAt,
    notes: input.notes ? String(input.notes).slice(0, 1000) : undefined,
  };
}

/**
 * Record a payment staff have confirmed, and apply it: the subscription becomes
 * (or stays) active for the period it covers.
 *
 * Idempotent on (organization, reference): the same reference twice is one
 * payment and one period, whether it is a double click or two people.
 */
export interface PaymentOptions {
  /** Who evidenced the payment: 'manual' (staff) or a registered provider (core/billing/provider). */
  provider?: string;
  /** The invoice this payment settles in full (core/billing/invoices). */
  invoiceId?: string;
  /**
   * The plan the settled invoice was for. Applied with the payment, in the same
   * write — this is how an institute's own order (core/billing/selfServe) moves
   * it to the plan it paid for, or starts a subscription it did not have.
   */
  plan?: { planKey: string; planVersion?: number };
}

export async function recordManualPayment(orgId: string, input: ManualPaymentInput, actor: Actor, opts: PaymentOptions = {}) {
  const now = new Date();
  const provider = opts.provider || 'manual';
  const fields = paymentFields(input, now);
  const periodEnd = dateOf(input.periodEnd, 'periodEnd');
  const billingInterval = intervalOf(input.billingInterval);
  const { Payment, SubscriptionEvent } = models();

  const { org, sub } = await loadContext(orgId);
  if (isPlatformOwned(org, sub)) refusePlatformOwned();
  // Without a subscription a payment can only start one when it names the plan
  // it pays for (an invoice for an order). A bare staff payment still cannot.
  if (!sub && !opts.plan?.planKey) {
    throw new SubscriptionError(404, 'SUBSCRIPTION_NOT_FOUND', 'This organization has no subscription to pay for. Start a trial or activate it first.');
  }

  let payment: Doc | null = null;
  let duplicate = false;
  try {
    payment = (
      await unscoped('payment-create', () =>
        Payment.create({
          orgId,
          ...(sub ? { subscriptionId: sub._id } : {}),
          ...(opts.invoiceId ? { invoiceId: opts.invoiceId } : {}),
          provider,
          status: 'confirmed',
          applied: false,
          recordedBy: { id: actor.id, email: actor.email, role: actor.role },
          ...fields,
        }),
      )
    ).toObject();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    duplicate = true;
  }

  if (duplicate) {
    payment = await unscoped('payment-existing', () => Payment.findOne({ provider, orgId, reference: fields.reference }).lean());
    // No payment with this reference: the unique index that fired is the one
    // allowing a single settling payment per invoice.
    if (!payment && opts.invoiceId) {
      throw new SubscriptionError(409, 'INVOICE_ALREADY_PAID', 'This invoice has already been settled by another payment.');
    }
    if (!payment) throw new SubscriptionError(409, 'SUBSCRIPTION_CONFLICT', 'Reload and try again.');
    if (
      payment.status !== 'confirmed' ||
      payment.amountMinor !== fields.amountMinor ||
      String(payment.invoiceId ?? '') !== String(opts.invoiceId ?? '')
    ) {
      throw new SubscriptionError(409, 'PAYMENT_DUPLICATE', 'This reference is already recorded with a different amount or outcome.', {
        paymentId: String(payment._id),
      });
    }
    if (payment.applied) return { payment, duplicate: true, applied: true };
  }

  // Claim the payment for applying. Only one request holds the claim.
  const claimed = await unscoped('payment-claim', () =>
    Payment.findOneAndUpdate(
      {
        _id: payment!._id,
        applied: false,
        $or: [{ applyingAt: null }, { applyingAt: { $exists: false } }, { applyingAt: { $lt: new Date(now.getTime() - CLAIM_MS) } }],
      },
      { $set: { applyingAt: now } },
      { new: true },
    ).lean(),
  );
  if (!claimed) {
    return { payment, duplicate: true, applied: false, pending: true };
  }

  // A crash between extending the period and marking the payment applied must
  // not let a retry extend it twice: the history says whether it was applied.
  const alreadyApplied = await unscoped('payment-history', () =>
    SubscriptionEvent.exists({ orgId, type: 'payment_confirmed', 'metadata.paymentId': String(payment!._id) }),
  );

  try {
    let result: Doc | null = null;
    if (!alreadyApplied) {
      result = await transition(orgId, 'payment_confirmed', {
        actor,
        reason: `Payment ${fields.reference} (${fields.method})`,
        periodEnd: periodEnd ?? undefined,
        billingInterval,
        ...(opts.plan?.planKey
          ? { planKey: opts.plan.planKey, planVersion: opts.plan.planVersion, allowInactivePlan: true }
          : {}),
        metadata: { paymentId: String(payment!._id), reference: fields.reference, amountMinor: fields.amountMinor, currency: fields.currency },
      });
    }
    const latest = await unscoped('payment-sub', () => models().Subscription.findOne({ orgId }).lean());
    const saved = await unscoped('payment-applied', () =>
      Payment.findOneAndUpdate(
        { _id: payment!._id },
        {
          $set: {
            applied: true,
            appliedAt: new Date(),
            periodStart: latest?.periodStart,
            periodEnd: latest?.periodEnd,
            applyingAt: null,
            // The payment that started the subscription is linked to it once it exists.
            ...(latest?._id && !payment!.subscriptionId ? { subscriptionId: latest._id } : {}),
          },
          $unset: { applyError: 1 },
        },
        { new: true },
      ).lean(),
    );
    return { payment: saved, duplicate, applied: true, subscription: result?.subscription ?? latest };
  } catch (error) {
    await unscoped('payment-apply-failed', () =>
      Payment.updateOne({ _id: payment!._id }, { $set: { applyingAt: null, applyError: (error as Error).message } }),
    );
    if (error instanceof SubscriptionError) {
      throw new SubscriptionError(error.status, error.code, `The payment was recorded but not applied: ${error.message}`, {
        ...error.details,
        paymentId: String(payment!._id),
      });
    }
    throw error;
  }
}

/**
 * Record a failed payment (a bounced cheque, a reversed transfer). An ACTIVE
 * subscription enters its grace period; during a trial it is only recorded.
 */
export async function recordPaymentFailure(
  orgId: string,
  input: { reference: string; method?: string; amount?: number | string; reason: string; receivedAt?: string | Date },
  actor: Actor,
  opts: PaymentOptions = {},
) {
  const provider = opts.provider || 'manual';
  const now = new Date();
  const reason = requireReason(input.reason);
  const fields = paymentFields(
    { amount: input.amount as number, method: input.method ?? 'other', reference: input.reference, receivedAt: input.receivedAt },
    now,
    { amountRequired: false },
  );
  const { Payment } = models();

  const { org, sub } = await loadContext(orgId);
  if (isPlatformOwned(org, sub)) refusePlatformOwned();
  if (!sub) throw new SubscriptionError(404, 'SUBSCRIPTION_NOT_FOUND', 'This organization has no subscription.');

  let payment: Doc;
  try {
    payment = (
      await unscoped('payment-failed-create', () =>
        Payment.create({
          orgId,
          subscriptionId: sub._id,
          provider,
          status: 'failed',
          failureReason: reason,
          applied: false,
          recordedBy: { id: actor.id, email: actor.email, role: actor.role },
          ...fields,
        }),
      )
    ).toObject();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const existing = await unscoped('payment-failed-existing', () => Payment.findOne({ provider, orgId, reference: fields.reference }).lean());
    if (existing?.status === 'failed') return { payment: existing, duplicate: true, lifecycle: 'unchanged' };
    throw new SubscriptionError(409, 'PAYMENT_DUPLICATE', 'This reference is already recorded as a confirmed payment.', {
      paymentId: existing ? String(existing._id) : undefined,
    });
  }

  let lifecycle = 'unchanged';
  if (['active', 'past_due'].includes(sub.status)) {
    const result = await transition(orgId, 'payment_failed', {
      actor,
      reason: `Payment ${fields.reference} failed: ${reason}`,
      metadata: { paymentId: String(payment._id), reference: fields.reference },
    });
    lifecycle = result.changed ? 'grace-started' : 'unchanged';
  }
  await unscoped('payment-failed-mark', () => Payment.updateOne({ _id: payment._id }, { $set: { applied: true, appliedAt: new Date() } }));
  return { payment, duplicate: false, lifecycle };
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** Everything the console shows for one organization's subscription. */
export async function getSubscriptionDetail(orgId: string) {
  const { org, sub } = await loadContext(orgId);
  const { SubscriptionEvent, Payment } = models();
  const [terms, events, payments] = await Promise.all([
    sub ? termsForSubscription(sub) : Promise.resolve(null),
    unscoped('events', () => SubscriptionEvent.find({ orgId }).sort({ at: -1 }).limit(200).lean()),
    unscoped('payments', () => Payment.find({ orgId }).sort({ receivedAt: -1 }).limit(100).lean()),
  ]);
  const platformOwned = isPlatformOwned(org, sub);
  return {
    organization: { id: String(org._id), name: org.name, slug: org.slug, status: org.status, subscriptionRequired: Boolean(org.subscriptionRequired) },
    platformOwned,
    // False for a subscription from before the lifecycle: its status and limits
    // are shown but not enforced until staff act on it.
    managed: Boolean(sub?.managedSince),
    subscription: sub,
    terms,
    nextTransitionAt: sub?.managedSince && !platformOwned ? nextTransitionAt(stateOf(sub)) : null,
    availableEvents: platformOwned ? [] : availableStaffEvents(sub ? sub.status : null),
    events,
    payments,
  };
}

/**
 * Subscriptions for the console list: by status, and those with something due
 * within `dueWithinDays` (trial end, renewal, grace end).
 */
export async function listSubscriptions(
  query: { status?: string; dueWithinDays?: number; limit?: number; withUsage?: boolean; overLimit?: boolean } = {},
) {
  const { Subscription, Org } = models();
  const filter: Doc = {};
  if (query.status) filter.status = query.status;
  if (query.dueWithinDays !== undefined) {
    const until = new Date(Date.now() + Math.max(0, query.dueWithinDays) * 24 * 60 * 60 * 1000);
    filter.isPlatformOwned = { $ne: true };
    filter.$or = [
      { status: 'trialing', trialEndsAt: { $lte: until } },
      { status: 'active', periodEnd: { $lte: until } },
      { status: 'past_due', graceEndsAt: { $lte: until } },
    ];
  }
  const rows: Doc[] = await unscoped('list', () =>
    Subscription.find(filter).sort({ updatedAt: -1 }).limit(Math.min(query.limit ?? 100, 500)).lean(),
  );
  const orgs: Doc[] = await unscoped('list-orgs', () =>
    Org.find({ _id: { $in: rows.map((r) => r.orgId) } }).select('name slug status isPlatformOwned').lean(),
  );
  const byId = new Map(orgs.map((o) => [String(o._id), o]));
  const out: Doc[] = rows.map((row) => ({
    ...row,
    organization: byId.get(String(row.orgId)) ?? null,
    managed: Boolean(row.managedSince),
    nextTransitionAt:
      !row.managedSince || row.isPlatformOwned || byId.get(String(row.orgId))?.isPlatformOwned ? null : nextTransitionAt(stateOf(row)),
  }));
  if (!query.withUsage && !query.overLimit) return out;

  // Usage against limits, per organization — what "over its limits" means for
  // the console's list. Platform-owned organizations are never limited.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { usageSummary } = require('./usage');
  for (const row of out) {
    if (row.isPlatformOwned || row.organization?.isPlatformOwned) {
      row.usage = null;
      row.overLimits = [];
      continue;
    }
    try {
      const usage = await usageSummary(String(row.orgId));
      row.usage = usage;
      row.overLimits = Object.entries(usage as Record<string, { over: boolean }>).filter(([, u]) => u.over).map(([k]) => k);
    } catch (error) {
      row.usage = null;
      row.overLimits = [];
      console.error(`[subscriptions] usage for ${row.orgId} unavailable:`, (error as Error).message);
    }
  }
  return query.overLimit ? out.filter((row) => row.overLimits.length > 0) : out;
}

/**
 * What an organization's own admins see: their plan, status, dates and payment
 * history. Read-only, and limited to their organization by the caller (the
 * org-admin router passes the principal's orgId — never a parameter).
 */
export async function tenantSubscriptionView(orgId: string) {
  const { Subscription, Payment, Org } = models();
  const [org, sub, payments] = await unscoped('tenant-view', () =>
    Promise.all([
      Org.findById(orgId).select('isPlatformOwned subscriptionRequired').lean(),
      Subscription.findOne({ orgId }).lean(),
      Payment.find({ orgId }).sort({ receivedAt: -1 }).limit(50).select('reference method status amountMinor currency receivedAt periodStart periodEnd failureReason').lean(),
    ]),
  );
  const terms = sub ? await termsForSubscription(sub) : null;
  const platformOwned = isPlatformOwned(org, sub);
  return {
    platformOwned,
    managed: Boolean(sub?.managedSince),
    plan: terms ? { key: terms.planKey ?? null, name: terms.name ?? null, version: terms.planVersion ?? null } : null,
    status: sub?.status ?? null,
    billingInterval: sub?.billingInterval ?? null,
    trialEndsAt: sub?.trialEndsAt ?? null,
    periodStart: sub?.periodStart ?? null,
    periodEnd: sub?.periodEnd ?? null,
    graceEndsAt: sub?.graceEndsAt ?? null,
    cancelledAt: sub?.cancelledAt ?? null,
    /** The institute chose to stop when the current trial or period ends. */
    cancelAtPeriodEnd: Boolean(sub?.cancelAtPeriodEnd),
    cancellationRequestedAt: sub?.cancelAtPeriodEnd ? sub?.cancellationRequest?.at ?? null : null,
    nextTransitionAt: sub?.managedSince && !platformOwned ? nextTransitionAt(stateOf(sub)) : null,
    payments: payments.map((p: Doc) => ({
      id: String(p._id),
      reference: p.reference,
      method: p.method,
      status: p.status,
      amount: (p.amountMinor ?? 0) / 100,
      currency: p.currency,
      receivedAt: p.receivedAt,
      periodStart: p.periodStart ?? null,
      periodEnd: p.periodEnd ?? null,
      failureReason: p.failureReason ?? null,
    })),
  };
}
