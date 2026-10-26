/**
 * The subscription lifecycle — every status change, as one table.
 *
 * Pure: no database, no clock of its own. Every function takes `now`, so the
 * edges (exactly at `trialEndsAt`, exactly at `graceEndsAt`) are testable
 * without waiting for them, and the daily sweep and the request-time check can
 * never disagree about what is due.
 *
 *   trialing ──trial ends, unpaid──▶ past_due (grace) ──grace ends──▶ expired
 *      │                               ▲   │                           │
 *      │ payment / activate            │   │ payment                   │ payment
 *      ▼                               │   ▼                           ▼
 *   active ──period ends, unpaid───────┘ active ◀──────────────────── active
 *      │ └──payment failed──▶ past_due
 *      │
 *   suspend / cancel / expire are staff decisions, each with a reason.
 *
 *   An institute may ask to cancel AT THE END of what it has (cancelAtPeriodEnd):
 *   when the trial or paid period then ends, it goes to `cancelled` instead of
 *   into grace. Paying, activating or starting a trial clears the request.
 *
 * Access follows status (see WRITABLE_STATUSES / READABLE_STATUSES):
 *   trialing, active, past_due     full access — the grace period is full access
 *   suspended, cancelled, expired  read-only: read, export, sign in, renew
 *
 * Nothing in this file deletes or disables data. A status only decides whether
 * the organization may still WRITE; what it already has stays readable.
 */

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'cancelled'
  | 'expired'
  // Legacy value: written by the console before this lifecycle existed. No
  // transition leads to it; it is kept so stored records still validate.
  | 'terminated';

export const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'suspended',
  'cancelled',
  'expired',
  'terminated',
];

/** Statuses under which the organization may still WRITE. */
export const WRITABLE_STATUSES: SubscriptionStatus[] = ['trialing', 'active', 'past_due'];

/** Statuses under which the organization may still READ and EXPORT its data. */
export const READABLE_STATUSES: SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'suspended',
  'cancelled',
  'expired',
];

export type BillingInterval = 'monthly' | 'annual';
export const BILLING_INTERVALS: BillingInterval[] = ['monthly', 'annual'];

export type LifecycleEvent =
  // Staff decisions — each needs a reason, and each is audited.
  | 'start_trial'
  | 'extend_trial'
  | 'activate'
  | 'suspend'
  | 'reactivate'
  | 'cancel'
  | 'expire'
  // Billing facts — recorded by staff (manual) or, later, a verified provider.
  | 'payment_confirmed'
  | 'payment_failed'
  // The clock — applied by the sweep and by the request-time check.
  | 'trial_ended'
  | 'period_ended'
  | 'grace_ended';

export const STAFF_EVENTS: LifecycleEvent[] = [
  'start_trial',
  'extend_trial',
  'activate',
  'suspend',
  'reactivate',
  'cancel',
  'expire',
];

export const CLOCK_EVENTS: LifecycleEvent[] = ['trial_ended', 'period_ended', 'grace_ended'];

/** The lifecycle-relevant part of a Subscription. */
export interface LifecycleState {
  status: SubscriptionStatus;
  billingInterval?: BillingInterval;
  trialEndsAt?: Date | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  graceEndsAt?: Date | null;
  /** The status to return to when a suspension or cancellation is lifted. */
  resumeStatus?: SubscriptionStatus | null;
  cancelledAt?: Date | null;
  expiredAt?: Date | null;
  /**
   * The institute asked to stop when the current trial or paid period ends.
   * The clock then cancels instead of starting grace. Cleared by any event that
   * renews or restarts access (a payment, an activation, a trial).
   */
  cancelAtPeriodEnd?: boolean | null;
}

/**
 * Which statuses each event may start from. `null` is "no subscription yet".
 *
 * The table IS the policy: a transition that is not listed here cannot happen,
 * whoever asks for it.
 */
export const TRANSITIONS: Record<LifecycleEvent, (SubscriptionStatus | null)[]> = {
  start_trial: [null, 'expired', 'cancelled'],
  extend_trial: ['trialing', 'past_due'],
  activate: ['trialing', 'past_due', 'expired', 'cancelled'],
  suspend: ['trialing', 'active', 'past_due', 'expired'],
  reactivate: ['suspended', 'cancelled'],
  cancel: ['trialing', 'active', 'past_due', 'suspended', 'expired'],
  expire: ['trialing', 'active', 'past_due', 'cancelled'],
  // A payment received while suspended is recorded and extends the period, but
  // does not lift the suspension — that is a staff decision (see below).
  // From `null`: a paid order for a plan (an invoice naming it) is how an
  // institute with no subscription buys one without a trial first.
  payment_confirmed: [null, 'trialing', 'active', 'past_due', 'expired', 'cancelled', 'suspended'],
  payment_failed: ['active', 'past_due'],
  trial_ended: ['trialing'],
  period_ended: ['active'],
  grace_ended: ['past_due'],
};

export interface EventInput {
  now: Date;
  /** start_trial / extend_trial: length in days (default TRIAL_DAYS). */
  days?: number;
  /** activate / payment_confirmed: end of the covered period. `null` = open-ended (activate only). */
  periodEnd?: Date | null;
  /** payment_confirmed / activate: interval used when no periodEnd is given. */
  billingInterval?: BillingInterval;
  graceDays?: number;
}

export type Transition =
  | { ok: true; next: LifecycleState; changed: boolean }
  | { ok: false; code: 'INVALID_TRANSITION' | 'INVALID_INPUT'; message: string };

const refuse = (code: 'INVALID_TRANSITION' | 'INVALID_INPUT', message: string): Transition => ({ ok: false, code, message });

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * One billing interval later, in UTC, clamped to the month's last day — so a
 * period starting 31 January ends 28 (or 29) February, not 3 March.
 */
export function addInterval(date: Date, interval: BillingInterval = 'monthly'): Date {
  const months = interval === 'annual' ? 12 : 1;
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

const time = (d?: Date | null) => (d ? new Date(d).getTime() : null);
const later = (a: Date, b?: Date | null) => (b && time(b)! > a.getTime() ? new Date(b) : a);

/**
 * Apply one event to a state. Returns the next state, or why not.
 *
 * `from === null` means the organization has no subscription; only
 * `start_trial` may begin there.
 */
export function applyEvent(state: LifecycleState | null, event: LifecycleEvent, input: EventInput): Transition {
  const from = state?.status ?? null;
  const allowed = TRANSITIONS[event];
  if (!allowed) return refuse('INVALID_INPUT', `Unknown lifecycle event "${event}".`);
  if (!allowed.includes(from)) {
    return refuse(
      'INVALID_TRANSITION',
      from
        ? `A ${from.replace('_', ' ')} subscription cannot ${event.replace('_', ' ')}.`
        : `This organization has no subscription; "${event}" needs one.`,
    );
  }

  const now = input.now;
  const grace = input.graceDays ?? GRACE_DAYS;
  const interval = input.billingInterval ?? state?.billingInterval ?? 'monthly';
  const base: LifecycleState = { ...(state ?? { status: 'trialing' }), billingInterval: interval };
  const next = (patch: Partial<LifecycleState>): Transition => ({ ok: true, next: { ...base, ...patch }, changed: true });

  switch (event) {
    case 'start_trial': {
      const days = input.days ?? TRIAL_DAYS;
      if (!Number.isFinite(days) || days < 1 || days > 365) return refuse('INVALID_INPUT', 'A trial is 1 to 365 days.');
      return next({
        status: 'trialing',
        trialEndsAt: addDays(now, days),
        periodStart: now,
        periodEnd: null,
        graceEndsAt: null,
        resumeStatus: null,
        cancelledAt: null,
        expiredAt: null,
        cancelAtPeriodEnd: null,
      });
    }

    case 'extend_trial': {
      const days = input.days ?? TRIAL_DAYS;
      if (!Number.isFinite(days) || days < 1 || days > 365) return refuse('INVALID_INPUT', 'An extension is 1 to 365 days.');
      // From the later of now and the current end: extending a trial that ended
      // three days ago by seven gives seven days from today, not four.
      const anchor = later(now, state?.trialEndsAt);
      return next({ status: 'trialing', trialEndsAt: addDays(anchor, days), graceEndsAt: null, cancelAtPeriodEnd: null });
    }

    case 'activate': {
      if (input.periodEnd && time(input.periodEnd)! <= now.getTime()) {
        return refuse('INVALID_INPUT', 'The period must end in the future.');
      }
      return next({
        status: 'active',
        periodStart: now,
        periodEnd: input.periodEnd === null ? null : input.periodEnd ?? addInterval(now, interval),
        graceEndsAt: null,
        resumeStatus: null,
        cancelledAt: null,
        expiredAt: null,
        cancelAtPeriodEnd: null,
      });
    }

    case 'payment_confirmed': {
      // The paid period starts where the current entitlement ends, so paying
      // early never costs the customer days they already had.
      let anchor = now;
      if (from === 'active' || (from === 'suspended' && state?.resumeStatus === 'active')) anchor = later(now, state?.periodEnd);
      if (from === 'trialing' || (from === 'suspended' && state?.resumeStatus === 'trialing')) anchor = later(now, state?.trialEndsAt);
      const periodEnd = input.periodEnd ?? addInterval(anchor, interval);
      if (time(periodEnd)! <= now.getTime()) return refuse('INVALID_INPUT', 'A payment must cover a period ending in the future.');
      // Paying is continuing: a cancellation the institute had scheduled is lifted.
      const paid = { periodStart: anchor, periodEnd, graceEndsAt: null, expiredAt: null, cancelledAt: null, cancelAtPeriodEnd: null };
      // A suspension is a staff decision; money does not overrule it. The
      // period is extended, and lifting the suspension resumes as `active`.
      if (from === 'suspended') return next({ ...paid, status: 'suspended', resumeStatus: 'active' });
      return next({ ...paid, status: 'active', resumeStatus: null });
    }

    case 'payment_failed': {
      // A second failure inside the grace period does not restart it.
      if (from === 'past_due') return { ok: true, next: base, changed: false };
      return next({ status: 'past_due', graceEndsAt: addDays(now, grace) });
    }

    case 'trial_ended': {
      if (!state?.trialEndsAt || time(state.trialEndsAt)! > now.getTime()) {
        return refuse('INVALID_TRANSITION', 'The trial has not ended.');
      }
      if (state.cancelAtPeriodEnd) return endAsCancelled(next, new Date(state.trialEndsAt), 'trialing');
      return next({ status: 'past_due', graceEndsAt: addDays(new Date(state.trialEndsAt), grace) });
    }

    case 'period_ended': {
      if (!state?.periodEnd || time(state.periodEnd)! > now.getTime()) {
        return refuse('INVALID_TRANSITION', 'The period has not ended.');
      }
      if (state.cancelAtPeriodEnd) return endAsCancelled(next, new Date(state.periodEnd), 'active');
      return next({ status: 'past_due', graceEndsAt: addDays(new Date(state.periodEnd), grace) });
    }

    case 'grace_ended': {
      if (!state?.graceEndsAt || time(state.graceEndsAt)! > now.getTime()) {
        return refuse('INVALID_TRANSITION', 'The grace period has not ended.');
      }
      return next({ status: 'expired', expiredAt: new Date(state.graceEndsAt) });
    }

    case 'suspend':
      return next({ status: 'suspended', resumeStatus: from as SubscriptionStatus });

    case 'cancel':
      return next({
        status: 'cancelled',
        cancelledAt: now,
        cancelAtPeriodEnd: null,
        // Cancelling a suspended subscription keeps what the suspension would
        // have resumed to, rather than "suspended".
        resumeStatus: from === 'suspended' ? state?.resumeStatus ?? 'active' : (from as SubscriptionStatus),
      });

    case 'expire':
      return next({ status: 'expired', expiredAt: now, graceEndsAt: null, resumeStatus: null, cancelAtPeriodEnd: null });

    case 'reactivate': {
      // Resume where it was, then let the clock catch up: a subscription whose
      // period ran out during a suspension resumes as past_due or expired, not
      // as a free active month.
      const resumed: LifecycleState = {
        ...base,
        status: state?.resumeStatus && state.resumeStatus !== 'suspended' && state.resumeStatus !== 'cancelled'
          ? state.resumeStatus
          : 'active',
        resumeStatus: null,
        cancelledAt: null,
        cancelAtPeriodEnd: null,
      };
      return { ok: true, next: advance(resumed, now).state, changed: true };
    }
  }

  return refuse('INVALID_INPUT', `Unhandled event "${event}".`);
}

/**
 * The end of a trial or paid period the institute chose not to continue past:
 * cancelled at that moment, with no grace. Reactivating resumes where it was
 * and lets the clock catch up, exactly as after a staff cancellation.
 */
function endAsCancelled(
  next: (patch: Partial<LifecycleState>) => Transition,
  endedAt: Date,
  resumeStatus: SubscriptionStatus,
): Transition {
  return next({ status: 'cancelled', cancelledAt: endedAt, graceEndsAt: null, resumeStatus, cancelAtPeriodEnd: null });
}

/** The clock event due for this state at `now`, if any. */
export function dueEvent(state: LifecycleState | null, now: Date): LifecycleEvent | null {
  if (!state) return null;
  const t = now.getTime();
  if (state.status === 'trialing' && state.trialEndsAt && time(state.trialEndsAt)! <= t) return 'trial_ended';
  if (state.status === 'active' && state.periodEnd && time(state.periodEnd)! <= t) return 'period_ended';
  if (state.status === 'past_due' && state.graceEndsAt && time(state.graceEndsAt)! <= t) return 'grace_ended';
  return null;
}

/**
 * Apply every clock event due at `now`, in order. A trial that ended a month
 * ago goes trialing → past_due → expired in one call.
 */
export function advance(state: LifecycleState, now: Date): { state: LifecycleState; events: LifecycleEvent[] } {
  let current = state;
  const events: LifecycleEvent[] = [];
  for (let i = 0; i < 4; i++) {
    const event = dueEvent(current, now);
    if (!event) break;
    const result = applyEvent(current, event, { now });
    if (!result.ok) break;
    current = result.next;
    events.push(event);
  }
  return { state: current, events };
}

/** When this state next changes by itself, or null if it never does. */
export function nextTransitionAt(state: LifecycleState | null): Date | null {
  if (!state) return null;
  if (state.status === 'trialing') return state.trialEndsAt ? new Date(state.trialEndsAt) : null;
  if (state.status === 'active') return state.periodEnd ? new Date(state.periodEnd) : null;
  if (state.status === 'past_due') return state.graceEndsAt ? new Date(state.graceEndsAt) : null;
  return null;
}

export function isWritableStatus(status: string): boolean {
  return (WRITABLE_STATUSES as string[]).includes(status);
}

export function isReadableStatus(status: string): boolean {
  return (READABLE_STATUSES as string[]).includes(status);
}

/** The events staff could apply from this status — what the console offers. */
export function availableStaffEvents(status: SubscriptionStatus | null): LifecycleEvent[] {
  return STAFF_EVENTS.filter((event) => TRANSITIONS[event].includes(status));
}
