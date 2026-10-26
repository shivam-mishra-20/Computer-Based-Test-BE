/**
 * Subscriptions — the lifecycle table, the clock, entitlement resolution and
 * the plan catalogue, as pure logic. No database, no Redis.
 *
 * What matters most here:
 *   - every transition the table allows, and the ones it refuses;
 *   - the clock edges: a trial is over AT trialEndsAt, not a millisecond later,
 *     and grace is seven days from the moment access was due to end;
 *   - an organization the platform created without a subscription gets core
 *     modules only, while one created before subscriptions keeps everything,
 *     and a platform-owned one keeps everything whatever its subscription says;
 *   - the default catalogue sells nothing the code does not have.
 *
 *   npx ts-node --transpile-only scripts/safety/subscriptions.test.ts
 */

import {
  GRACE_DAYS,
  TRIAL_DAYS,
  TRANSITIONS,
  SUBSCRIPTION_STATUSES,
  addInterval,
  addDays,
  advance,
  applyEvent,
  availableStaffEvents,
  dueEvent,
  isReadableStatus,
  isWritableStatus,
  nextTransitionAt,
  type LifecycleEvent,
  type LifecycleState,
  type SubscriptionStatus,
} from '../../src/core/subscriptions/lifecycle';
import { DEFAULT_PLANS, LIMIT_KEYS, normalizeTerms, sameTerms, CatalogueError } from '../../src/core/subscriptions/catalogue';
import { decideEntitlement } from '../../src/core/entitlements/resolve';
import { allModuleKeys, CORE_MODULE_KEYS, getModule, expandDependencies } from '../../src/core/entitlements/moduleRegistry';
import { RESTRICTED_WRITE_ALLOWED } from '../../src/middlewares/requireModule';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);

const NOW = new Date('2026-10-17T06:30:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (d?: Date | null) => (d ? new Date(d).toISOString() : String(d));
const state = (s: Partial<LifecycleState> & { status: SubscriptionStatus }): LifecycleState => ({ billingInterval: 'monthly', ...s });
const ok = (r: ReturnType<typeof applyEvent>) => (r.ok ? r.next : null);
const code = (r: ReturnType<typeof applyEvent>) => (r.ok === false ? r.code : null);

function main() {
  console.log('Subscriptions\n');

  // ── The table ────────────────────────────────────────────────────────────
  section('lifecycle table');
  const sample: Record<SubscriptionStatus, LifecycleState> = {
    trialing: state({ status: 'trialing', trialEndsAt: addDays(NOW, 5) }),
    active: state({ status: 'active', periodStart: addDays(NOW, -10), periodEnd: addDays(NOW, 20) }),
    past_due: state({ status: 'past_due', graceEndsAt: addDays(NOW, 3), periodEnd: addDays(NOW, -4) }),
    suspended: state({ status: 'suspended', resumeStatus: 'active', periodEnd: addDays(NOW, 20) }),
    cancelled: state({ status: 'cancelled', resumeStatus: 'active', periodEnd: addDays(NOW, 20), cancelledAt: NOW }),
    expired: state({ status: 'expired', expiredAt: addDays(NOW, -1) }),
    terminated: state({ status: 'terminated' }),
  };
  const staffEvents: LifecycleEvent[] = ['start_trial', 'extend_trial', 'activate', 'suspend', 'reactivate', 'cancel', 'expire', 'payment_confirmed', 'payment_failed'];
  let tableOk = true;
  const mismatches: string[] = [];
  for (const from of SUBSCRIPTION_STATUSES) {
    for (const event of staffEvents) {
      const allowed = TRANSITIONS[event].includes(from);
      const result = applyEvent(sample[from], event, { now: NOW, reason: 'x' } as never);
      if (allowed !== result.ok) {
        tableOk = false;
        mismatches.push(`${from} --${event}--> ${result.ok ? 'allowed' : (result as { code: string }).code}`);
      }
    }
  }
  check('applyEvent allows exactly what TRANSITIONS lists, from every status', tableOk, mismatches.join('; '));
  check('nothing leads to the legacy "terminated" status', staffEvents.every((e) => {
    const r = applyEvent(sample.active, e, { now: NOW });
    return !r.ok || r.next.status !== 'terminated';
  }));
  check('a terminated subscription accepts no event', staffEvents.every((e) => !applyEvent(sample.terminated, e, { now: NOW }).ok));
  check('with no subscription, only a trial or a confirmed payment (a paid order naming its plan) can start one',
    staffEvents.filter((e) => applyEvent(null, e, { now: NOW }).ok).join(',') === 'start_trial,payment_confirmed');
  check('the console is offered start_trial alone for an organization without one',
    availableStaffEvents(null).join(',') === 'start_trial');
  check('an active subscription cannot be reactivated (409 INVALID_TRANSITION)', code(applyEvent(sample.active, 'reactivate', { now: NOW })) === 'INVALID_TRANSITION');
  check('a suspended subscription cannot be suspended again', code(applyEvent(sample.suspended, 'suspend', { now: NOW })) === 'INVALID_TRANSITION');
  check('an unknown event is INVALID_INPUT', code(applyEvent(sample.active, 'banana' as LifecycleEvent, { now: NOW })) === 'INVALID_INPUT');

  // ── Access by status ─────────────────────────────────────────────────────
  section('access by status');
  check('trialing, active and past_due (grace) are writable', ['trialing', 'active', 'past_due'].every(isWritableStatus));
  check('suspended, cancelled and expired are NOT writable', ['suspended', 'cancelled', 'expired'].every((s) => !isWritableStatus(s)));
  check('...but all three stay readable (read and export)', ['suspended', 'cancelled', 'expired'].every(isReadableStatus));

  // ── Trials ───────────────────────────────────────────────────────────────
  section('trials');
  {
    const trial = ok(applyEvent(null, 'start_trial', { now: NOW }))!;
    check(`a trial is ${TRIAL_DAYS} days by default`, at(trial.trialEndsAt) === at(addDays(NOW, 14)), at(trial.trialEndsAt));
    check('a new trial has no paid period and no grace', !trial.periodEnd && !trial.graceEndsAt);
    check('a 30-day trial ends in 30 days', at(ok(applyEvent(null, 'start_trial', { now: NOW, days: 30 }))!.trialEndsAt) === at(addDays(NOW, 30)));
    check('a 0-day or 400-day trial is refused', code(applyEvent(null, 'start_trial', { now: NOW, days: 0 })) === 'INVALID_INPUT' &&
      code(applyEvent(null, 'start_trial', { now: NOW, days: 400 })) === 'INVALID_INPUT');

    const running = state({ status: 'trialing', trialEndsAt: addDays(NOW, 3) });
    check('extending a running trial adds to its end, not to today',
      at(ok(applyEvent(running, 'extend_trial', { now: NOW, days: 7 }))!.trialEndsAt) === at(addDays(NOW, 10)));
    const lapsed = state({ status: 'past_due', trialEndsAt: addDays(NOW, -2), graceEndsAt: addDays(NOW, 5) });
    const extended = ok(applyEvent(lapsed, 'extend_trial', { now: NOW, days: 7 }))!;
    check('extending a trial that ended (now in grace) counts from today and clears grace',
      extended.status === 'trialing' && at(extended.trialEndsAt) === at(addDays(NOW, 7)) && !extended.graceEndsAt, JSON.stringify(extended));
  }

  // ── The clock, at its edges ──────────────────────────────────────────────
  section('the clock');
  {
    const ends = NOW;
    const trial = state({ status: 'trialing', trialEndsAt: ends });
    check('a trial is NOT over 1 ms before trialEndsAt', dueEvent(trial, new Date(ends.getTime() - 1)) === null);
    check('a trial IS over exactly at trialEndsAt', dueEvent(trial, ends) === 'trial_ended');
    const graced = ok(applyEvent(trial, 'trial_ended', { now: ends }))!;
    check(`trial end → past_due with ${GRACE_DAYS} days' grace from the trial end`,
      graced.status === 'past_due' && at(graced.graceEndsAt) === at(addDays(ends, 7)), JSON.stringify(graced));
    check('grace is NOT over 1 ms before graceEndsAt', dueEvent(graced, new Date(addDays(ends, 7).getTime() - 1)) === null);
    check('grace IS over exactly at graceEndsAt → expired', dueEvent(graced, addDays(ends, 7)) === 'grace_ended');
    const expired = ok(applyEvent(graced, 'grace_ended', { now: addDays(ends, 7) }))!;
    check('expired is recorded at the moment grace ended', expired.status === 'expired' && at(expired.expiredAt) === at(addDays(ends, 7)));
    check('trial_ended cannot be applied early', code(applyEvent(state({ status: 'trialing', trialEndsAt: addDays(NOW, 1) }), 'trial_ended', { now: NOW })) === 'INVALID_TRANSITION');

    const longAgo = state({ status: 'trialing', trialEndsAt: addDays(NOW, -30) });
    const caught = advance(longAgo, NOW);
    check('a trial that ended a month ago goes trialing → past_due → expired in one advance',
      caught.events.join('>') === 'trial_ended>grace_ended' && caught.state.status === 'expired', caught.events.join('>'));
    check('advancing again at the same moment does nothing (idempotent)', advance(caught.state, NOW).events.length === 0);

    const period = state({ status: 'active', periodEnd: NOW });
    check('a paid period IS over exactly at periodEnd', dueEvent(period, NOW) === 'period_ended');
    const pd = ok(applyEvent(period, 'period_ended', { now: NOW }))!;
    check('period end → past_due with grace from the period end', pd.status === 'past_due' && at(pd.graceEndsAt) === at(addDays(NOW, 7)));

    const open = state({ status: 'active', periodEnd: null });
    check('an open-ended activation never changes by itself', dueEvent(open, addDays(NOW, 3650)) === null && nextTransitionAt(open) === null);
    const legacyTrial = state({ status: 'trialing', trialEndsAt: null });
    check('a pre-lifecycle trial with no end date never expires by itself', dueEvent(legacyTrial, addDays(NOW, 3650)) === null);

    check('nextTransitionAt: trialing → trialEndsAt, active → periodEnd, past_due → graceEndsAt, else none',
      at(nextTransitionAt(trial)) === at(ends) && at(nextTransitionAt(period)) === at(NOW) &&
        at(nextTransitionAt(graced)) === at(addDays(ends, 7)) && nextTransitionAt(expired) === null);
  }

  // ── Payments ─────────────────────────────────────────────────────────────
  section('payments');
  {
    const active = state({ status: 'active', periodStart: addDays(NOW, -20), periodEnd: addDays(NOW, 10) });
    const renewed = ok(applyEvent(active, 'payment_confirmed', { now: NOW }))!;
    check('paying early extends from the current period end — no days lost',
      at(renewed.periodStart) === at(addDays(NOW, 10)) && at(renewed.periodEnd) === at(addInterval(addDays(NOW, 10))), JSON.stringify(renewed));

    const trial = state({ status: 'trialing', trialEndsAt: addDays(NOW, 4) });
    const converted = ok(applyEvent(trial, 'payment_confirmed', { now: NOW }))!;
    check('paying during a trial starts the paid month when the trial ends', converted.status === 'active' && at(converted.periodStart) === at(addDays(NOW, 4)));

    const expired = state({ status: 'expired', expiredAt: addDays(NOW, -3) });
    const back = ok(applyEvent(expired, 'payment_confirmed', { now: NOW }))!;
    check('paying after expiry restores access from today', back.status === 'active' && at(back.periodStart) === at(NOW) && !back.expiredAt);

    const pastDue = state({ status: 'past_due', graceEndsAt: addDays(NOW, 2), periodEnd: addDays(NOW, -5) });
    const cleared = ok(applyEvent(pastDue, 'payment_confirmed', { now: NOW }))!;
    check('paying during grace clears it', cleared.status === 'active' && !cleared.graceEndsAt);

    const annual = ok(applyEvent(expired, 'payment_confirmed', { now: NOW, billingInterval: 'annual' }))!;
    check('an annual payment covers twelve months', at(annual.periodEnd) === at(addInterval(NOW, 'annual')));

    const explicitEnd = addDays(NOW, 45);
    check('an explicit covered period is honoured', at(ok(applyEvent(expired, 'payment_confirmed', { now: NOW, periodEnd: explicitEnd }))!.periodEnd) === at(explicitEnd));
    check('a payment for a period already over is refused', code(applyEvent(expired, 'payment_confirmed', { now: NOW, periodEnd: addDays(NOW, -1) })) === 'INVALID_INPUT');

    const suspended = state({ status: 'suspended', resumeStatus: 'active', periodEnd: addDays(NOW, 3) });
    const paidWhileSuspended = ok(applyEvent(suspended, 'payment_confirmed', { now: NOW }))!;
    check('money does not lift a suspension: still suspended, period extended, resumes as active',
      paidWhileSuspended.status === 'suspended' && paidWhileSuspended.resumeStatus === 'active' &&
        at(paidWhileSuspended.periodEnd) === at(addInterval(addDays(NOW, 3))), JSON.stringify(paidWhileSuspended));

    const started = ok(applyEvent(null, 'payment_confirmed', { now: NOW }))!;
    check('a paid order with no subscription starts one, active from today for one interval',
      started.status === 'active' && at(started.periodStart) === at(NOW) && at(started.periodEnd) === at(addInterval(NOW)), JSON.stringify(started));

    const failed = ok(applyEvent(active, 'payment_failed', { now: NOW }))!;
    check('a failed payment on an active subscription starts 7 days of grace from now',
      failed.status === 'past_due' && at(failed.graceEndsAt) === at(addDays(NOW, 7)));
    const again = applyEvent(failed, 'payment_failed', { now: addDays(NOW, 3) });
    check('a second failure during grace does not restart the grace period', again.ok === true && again.changed === false && at(again.next.graceEndsAt) === at(addDays(NOW, 7)));
    check('a failed payment during a trial changes nothing in the lifecycle', code(applyEvent(trial, 'payment_failed', { now: NOW })) === 'INVALID_TRANSITION');
  }

  // ── The institute's own cancellation: at period end ──────────────────────
  section('cancel at period end (self-serve)');
  {
    const trialEnd = addDays(NOW, 5);
    const trial = state({ status: 'trialing', trialEndsAt: trialEnd, cancelAtPeriodEnd: true });
    check('nothing changes before the trial ends', dueEvent(trial, addDays(NOW, 4)) === null);
    const ended = advance(trial, addDays(NOW, 40));
    check('at the trial end it is cancelled — no grace, no expiry',
      ended.state.status === 'cancelled' && at(ended.state.cancelledAt) === at(trialEnd) && !ended.state.graceEndsAt &&
        ended.events.join(',') === 'trial_ended' && !ended.state.cancelAtPeriodEnd, JSON.stringify(ended));

    const periodEnd = addDays(NOW, 9);
    const paid = state({ status: 'active', periodEnd, cancelAtPeriodEnd: true });
    const stopped = advance(paid, addDays(NOW, 9));
    check('exactly at the period end a paid subscription is cancelled',
      stopped.state.status === 'cancelled' && at(stopped.state.cancelledAt) === at(periodEnd) && stopped.state.resumeStatus === 'active', JSON.stringify(stopped));
    const still = state({ status: 'active', periodEnd });
    check('without the request the same moment starts grace, as before', advance(still, addDays(NOW, 9)).state.status === 'past_due');

    const renewed = ok(applyEvent(paid, 'payment_confirmed', { now: NOW }))!;
    check('paying again lifts a scheduled cancellation', renewed.status === 'active' && !renewed.cancelAtPeriodEnd);
    check('a new trial or an activation clears it too',
      !ok(applyEvent(state({ status: 'cancelled', cancelAtPeriodEnd: true }), 'start_trial', { now: NOW }))!.cancelAtPeriodEnd &&
        !ok(applyEvent(state({ status: 'expired', cancelAtPeriodEnd: true }), 'activate', { now: NOW }))!.cancelAtPeriodEnd);

    const back = ok(applyEvent(stopped.state, 'reactivate', { now: addDays(NOW, 10) }))!;
    check('reactivating after it ended resumes into grace, not a free period, and does not re-cancel',
      back.status === 'past_due' && !back.cancelAtPeriodEnd, JSON.stringify(back));
    check('a scheduled cancellation is not a transition: the table is unchanged for it',
      TRANSITIONS.cancel.join(',') === 'trialing,active,past_due,suspended,expired');
  }

  // ── Staff decisions ──────────────────────────────────────────────────────
  section('suspend, reactivate, cancel, expire');
  {
    const active = state({ status: 'active', periodEnd: addDays(NOW, 10) });
    const suspended = ok(applyEvent(active, 'suspend', { now: NOW }))!;
    check('suspending remembers what to resume to', suspended.status === 'suspended' && suspended.resumeStatus === 'active');
    const resumed = ok(applyEvent(suspended, 'reactivate', { now: addDays(NOW, 2) }))!;
    check('reactivating inside the period resumes active', resumed.status === 'active' && !resumed.resumeStatus);
    const lateResume = ok(applyEvent(suspended, 'reactivate', { now: addDays(NOW, 12) }))!;
    check('reactivating after the period ran out resumes into grace, not a free month', lateResume.status === 'past_due', lateResume.status);
    const veryLate = ok(applyEvent(suspended, 'reactivate', { now: addDays(NOW, 40) }))!;
    check('...and after grace too, resumes expired', veryLate.status === 'expired', veryLate.status);
    const cancelledFromSuspended = ok(applyEvent(suspended, 'cancel', { now: NOW }))!;
    check('cancelling a suspended subscription keeps what it would resume to', cancelledFromSuspended.resumeStatus === 'active');
    const trialSuspended = ok(applyEvent(state({ status: 'trialing', trialEndsAt: addDays(NOW, 5) }), 'suspend', { now: NOW }))!;
    check('a suspended trial resumes as a trial', ok(applyEvent(trialSuspended, 'reactivate', { now: NOW }))!.status === 'trialing');
    const expiredNow = ok(applyEvent(active, 'expire', { now: NOW }))!;
    check('expire is immediate and read-only', expiredNow.status === 'expired' && !isWritableStatus(expiredNow.status));
    const activated = ok(applyEvent(state({ status: 'trialing', trialEndsAt: addDays(NOW, 3) }), 'activate', { now: NOW }))!;
    check('manual activation gives one billing period by default', at(activated.periodEnd) === at(addInterval(NOW)));
    const openEnded = ok(applyEvent(state({ status: 'trialing' }), 'activate', { now: NOW, periodEnd: null }))!;
    check('manual activation may be explicitly open-ended (e.g. an annual contract invoiced offline)', openEnded.periodEnd === null);
  }

  // ── Calendar arithmetic ──────────────────────────────────────────────────
  section('billing intervals');
  check('31 January + 1 month = 28 February (2027)', at(addInterval(new Date('2027-01-31T00:00:00Z'))) === '2027-02-28T00:00:00.000Z');
  check('31 January + 1 month = 29 February (leap year 2028)', at(addInterval(new Date('2028-01-31T00:00:00Z'))) === '2028-02-29T00:00:00.000Z');
  check('15 March + 1 month = 15 April, time of day kept', at(addInterval(new Date('2027-03-15T10:20:00Z'))) === '2027-04-15T10:20:00.000Z');
  check('29 February + 1 year = 28 February', at(addInterval(new Date('2028-02-29T00:00:00Z'), 'annual')) === '2029-02-28T00:00:00.000Z');

  // ── Entitlement resolution ───────────────────────────────────────────────
  section('entitlement resolution');
  {
    const W = ['trialing', 'active', 'past_due'];
    const starter = DEFAULT_PLANS.find((p) => p.key === 'starter')!;
    const all = allModuleKeys().sort().join(',');

    const unassigned = decideEntitlement({ orgId: 'o', org: { status: 'active', subscriptionRequired: true }, subscription: null, terms: null, writableStatuses: W });
    check('a NEW organization with no subscription gets core modules only', unassigned.modules.sort().join(',') === [...CORE_MODULE_KEYS].sort().join(','), unassigned.modules.join(','));
    check('...status "unassigned", no cbt, no ai, no attendance', unassigned.status === 'unassigned' && !['cbt', 'ai', 'attendance'].some((m) => unassigned.modules.includes(m)));
    check('...and it can still sign in and write its own settings (writable)', unassigned.writable === true);

    const legacy = decideEntitlement({ orgId: 'o', org: { status: 'active' }, subscription: null, terms: null, writableStatuses: W });
    check('an organization from BEFORE subscriptions (no marker) keeps every module', legacy.modules.sort().join(',') === all);

    const ownedExpired = decideEntitlement({
      orgId: 'o', org: { status: 'active', isPlatformOwned: true },
      subscription: { status: 'expired' }, terms: { modules: [] }, writableStatuses: W,
    });
    check('a platform-owned organization keeps everything even with an expired subscription', ownedExpired.modules.sort().join(',') === all && ownedExpired.writable);
    const ownedViaSub = decideEntitlement({
      orgId: 'o', org: { status: 'active', subscriptionRequired: true },
      subscription: { status: 'cancelled', isPlatformOwned: true }, terms: null, writableStatuses: W,
    });
    check('...whether the flag is on the Org or on the Subscription', ownedViaSub.modules.sort().join(',') === all && ownedViaSub.writable);
    const ownedSuspendedOrg = decideEntitlement({ orgId: 'o', org: { status: 'suspended', isPlatformOwned: true }, subscription: null, terms: null, writableStatuses: W });
    check('...but an administrative org suspension still makes it read-only', ownedSuspendedOrg.writable === false);

    const trialing = decideEntitlement({
      orgId: 'o', org: { status: 'active', subscriptionRequired: true },
      subscription: { status: 'trialing', managedSince: NOW }, terms: { modules: starter.modules, limits: starter.limits }, writableStatuses: W,
    });
    check('a Starter trial gets Starter modules (and their dependencies)', starter.modules!.every((m) => trialing.modules.includes(m)) &&
      expandDependencies(starter.modules!).every((m) => trialing.modules.includes(m)));
    check('...and not Growth or Professional ones', !trialing.modules.includes('analytics') && !trialing.modules.includes('ai'));
    check('...with the 100-student limit, enforced (a managed subscription)', trialing.limits.students === 100 && trialing.limitsEnforced === true);

    const expired = decideEntitlement({ orgId: 'o', org: { status: 'active' }, subscription: { status: 'expired', managedSince: NOW }, terms: { modules: starter.modules }, writableStatuses: W });
    check('an expired subscription keeps its modules (reads still work) but is not writable', expired.writable === false && expired.modules.includes('cbt'));

    const orgSuspended = decideEntitlement({ orgId: 'o', org: { status: 'suspended' }, subscription: { status: 'active', managedSince: NOW }, terms: { modules: [] }, writableStatuses: W });
    check('an administratively suspended org is read-only even on an active subscription', orgSuspended.writable === false);

    // A subscription from BEFORE the lifecycle: it keeps the access it had.
    const legacySuspended = decideEntitlement({
      orgId: 'o', org: { status: 'active' },
      subscription: { status: 'suspended' }, terms: { modules: starter.modules, limits: { students: 1 } }, nextTransitionAt: NOW, writableStatuses: W,
    });
    check('a pre-lifecycle "suspended" subscription stays writable — its read-only was never enforced', legacySuspended.writable === true);
    check('...its limits are shown but not enforced', legacySuspended.limits.students === 1 && legacySuspended.limitsEnforced === false);
    check('...and it has no clock', legacySuspended.nextTransitionAt === null);
    check('...but its modules are still what it bought (module gating predates the lifecycle)', !legacySuspended.modules.includes('ai'));
    const legacyOrgSuspended = decideEntitlement({ orgId: 'o', org: { status: 'suspended' }, subscription: { status: 'active' }, terms: null, writableStatuses: W });
    check('...and an administrative org suspension still applies to it', legacyOrgSuspended.writable === false);
    check('platform-owned and unsubscribed organizations have no enforced limits',
      decideEntitlement({ orgId: 'o', org: { isPlatformOwned: true }, subscription: { status: 'active', managedSince: NOW }, terms: { limits: { students: 1 } }, writableStatuses: W }).limitsEnforced !== true &&
        decideEntitlement({ orgId: 'o', org: { subscriptionRequired: true }, subscription: null, terms: null, writableStatuses: W }).limitsEnforced !== true);

    const enterprise = decideEntitlement({
      orgId: 'o', org: { status: 'active' },
      subscription: { status: 'active', overrides: { limits: { students: 4000 }, modules: ['offlineTests'] }, removals: ['ai'] },
      terms: { modules: ['ai', 'exams'], limits: { students: 1500 } }, writableStatuses: W,
    });
    check('a negotiated limit override wins over the plan', enterprise.limits.students === 4000);
    check('removals apply, overrides survive them', !enterprise.modules.includes('ai') && enterprise.modules.includes('offlineTests'));
  }

  // ── The catalogue ────────────────────────────────────────────────────────
  section('default catalogue');
  {
    const byKey = Object.fromEntries(DEFAULT_PLANS.map((p) => [p.key, p]));
    check('Starter ₹999/month, up to 100 active students', byKey.starter.price?.monthly === 999 && byKey.starter.limits?.students === 100);
    check('Growth ₹2,999/month, up to 500 active students', byKey.growth.price?.monthly === 2999 && byKey.growth.limits?.students === 500);
    check('Professional ₹7,999/month, up to 1,500 active students', byKey.professional.price?.monthly === 7999 && byKey.professional.limits?.students === 1500);
    check('Enterprise: custom pricing, no price, never self-served', byKey.enterprise.customPricing === true && byKey.enterprise.price?.monthly === undefined && byKey.enterprise.selfServe === false);
    check('every default module exists in the registry', DEFAULT_PLANS.every((p) => (p.modules ?? []).every((m) => Boolean(getModule(m)))));
    // attendance: recording it (upload, biometric sync) is legacy-owner only, so no other organization could use it.
    const unbacked = ['whiteLabel', 'customDomain', 'apiAccess', 'advancedAnalytics', 'aiAnalysis', 'integrations', 'attendance'];
    check('no plan sells a module no feature backs yet', DEFAULT_PLANS.every((p) => !(p.modules ?? []).some((m) => unbacked.includes(m))));
    check('each tier includes the one below it',
      byKey.starter.modules!.every((m) => byKey.growth.modules!.includes(m)) && byKey.growth.modules!.every((m) => byKey.professional.modules!.includes(m)));
    const enforcedKeys = Object.entries(LIMIT_KEYS).filter(([, v]) => v.enforced).map(([k]) => k);
    check('every plan sets every ENFORCED limit — none is left as "no limit" by omission',
      DEFAULT_PLANS.every((p) => enforcedKeys.every((k) => typeof p.limits?.[k] === 'number')),
      DEFAULT_PLANS.map((p) => `${p.key}: ${enforcedKeys.filter((k) => typeof p.limits?.[k] !== 'number').join(',')}`).join(' | '));
    check('no plan sets a limit nothing measures (storage, exams per month)',
      DEFAULT_PLANS.every((p) => Object.keys(p.limits ?? {}).every((k) => LIMIT_KEYS[k]?.enforced)));
    const tiers = ['starter', 'growth', 'professional', 'enterprise'].map((k) => byKey[k]);
    const asNumber = (v?: number) => (v === undefined ? 0 : v < 0 ? Number.POSITIVE_INFINITY : v);
    check('each tier allows at least as much as the one below it, on every limit',
      enforcedKeys.every((k) => tiers.every((t, i) => i === 0 || asNumber(t.limits?.[k]) >= asNumber(tiers[i - 1].limits?.[k]))));
    check('AI generations: 0 ("not included") without the AI module, a real allowance with it',
      DEFAULT_PLANS.every((p) => ((p.modules ?? []).includes('ai') ? (p.limits?.aiGenerationsMonthly ?? 0) > 0 : p.limits?.aiGenerationsMonthly === 0)));
    check('yearly price is ten months on every priced plan (two months free)',
      DEFAULT_PLANS.filter((p) => !p.customPricing).every((p) => p.price?.annual === (p.price?.monthly ?? 0) * 10));
    check('Enterprise has a base to raise per contract: 5,000 students, unlimited staff',
      byKey.enterprise.limits?.students === 5000 && byKey.enterprise.limits?.teachers === -1 && byKey.enterprise.limits?.admins === -1);
    check('every default plan validates', DEFAULT_PLANS.every((p) => {
      try { normalizeTerms(p); return true; } catch { return false; }
    }));
  }

  section('catalogue validation and versioning');
  {
    const throws = (fn: () => unknown, codeWanted: string) => {
      try { fn(); return false; } catch (e) { return (e as CatalogueError).code === codeWanted; }
    };
    check('an unknown module is refused', throws(() => normalizeTerms({ modules: ['teleport'], price: { monthly: 1, currency: 'INR' } }), 'PLAN_INVALID'));
    check('an unknown limit is refused (a limit nobody enforces is a lie)', throws(() => normalizeTerms({ limits: { warpDrives: 3 }, price: { monthly: 1, currency: 'INR' } }), 'PLAN_INVALID'));
    check('a fractional or < -1 limit is refused', throws(() => normalizeTerms({ limits: { students: 1.5 }, price: { monthly: 1, currency: 'INR' } }), 'PLAN_INVALID') &&
      throws(() => normalizeTerms({ limits: { students: -2 }, price: { monthly: 1, currency: 'INR' } }), 'PLAN_INVALID'));
    check('a plan without a price must be custom-priced', throws(() => normalizeTerms({ modules: [] }), 'PLAN_INVALID') &&
      !throws(() => normalizeTerms({ modules: [], customPricing: true }), 'PLAN_INVALID'));
    const a = normalizeTerms({ modules: ['cbt', 'exams', 'users'], limits: { students: 100 }, price: { monthly: 999, currency: 'inr' } });
    const b = normalizeTerms({ modules: ['exams', 'cbt'], limits: { students: 100 }, price: { monthly: 999, currency: 'INR' } });
    check('the same terms in another order, with core modules listed, are the same terms', sameTerms(a, b));
    check('a changed limit is a change of terms', !sameTerms(a, normalizeTerms({ modules: ['exams', 'cbt'], limits: { students: 120 }, price: { monthly: 999, currency: 'INR' } })));
    check('a setup fee is kept as part of the terms, and changing it is a change of terms',
      normalizeTerms({ modules: [], price: { monthly: 1, setupFee: 2500, currency: 'INR' } }).price.setupFee === 2500 &&
        !sameTerms(a, normalizeTerms({ modules: ['exams', 'cbt'], limits: { students: 100 }, price: { monthly: 999, setupFee: 1, currency: 'INR' } })));
    check('a changed price is a change of terms',!sameTerms(a, normalizeTerms({ modules: ['exams', 'cbt'], limits: { students: 100 }, price: { monthly: 1099, currency: 'INR' } })));
    check('every limit key has a label and says whether it is enforced', Object.values(LIMIT_KEYS).every((l) => l.label && typeof l.enforced === 'boolean'));
  }

  // ── What stays open when read-only ───────────────────────────────────────
  section('read-only allowlist');
  {
    const allowed = (p: string) => RESTRICTED_WRITE_ALLOWED.some((rx) => rx.test(p));
    check('an exam attempt in progress may still submit', allowed('/api/attempts/abc/submit'));
    check('signing out everywhere and changing a password stay open', allowed('/api/auth/logout-all') && allowed('/api/auth/change-password'));
    check('renewal / billing requests stay open', allowed('/api/org-admin/subscription/renewal-request') && allowed('/api/org-admin/billing'));
    check('exports stay open', allowed('/api/papers/temp/export/pdf') && allowed('/api/teacher/ai/history/x/export-pdf') && allowed('/api/materials/x/download'));
    check('profile edits, account deletion and ordinary writes do not', !allowed('/api/auth/profile') && !allowed('/api/auth/account') && !allowed('/api/homework') && !allowed('/api/users'));
    check('a lookalike prefix does not slip through', !allowed('/api/attemptsX/1') && !allowed('/api/org-admin/subscriptions-hack'));
  }

  console.log(`\n  ${checks - failures}/${checks} checks passed.\n`);
  process.exit(failures ? 1 : 0);
}

main();
