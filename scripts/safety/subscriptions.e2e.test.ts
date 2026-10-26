/**
 * Subscriptions, end to end, through the real app on an isolated database.
 *
 * Platform runtime. Organizations:
 *   LEGACY  inserted directly, as one created before subscriptions — no marker.
 *           Must behave exactly as before: every module, writable.
 *   NEW     onboarded without a subscription — core modules only.
 *   TRIAL   onboarded on a Starter trial; then walked through the clock
 *           (trial end → grace → read-only), payments, failures and staff
 *           decisions.
 *   B       onboarded on a Growth trial — the other tenant, and the plan
 *           versioning subject.
 *   OWNED   platform-owned with an EXPIRED subscription — never downgraded.
 *   SWEPT   for the daily sweep.
 *
 * Time is simulated by moving a subscription's dates (and the snapshot's
 * nextTransitionAt) into the past, exactly as the passage of time would.
 *
 * Loopback MongoDB only, on a database this suite owns and drops at the end:
 *   SCRATCH_DB_NAME=iso_platform_scratch_subs SCRATCH_ALLOW_NEW_DB=true \
 *   E2E_TENANT_ENFORCEMENT=warn|enforce \
 *     npx ts-node --transpile-only scripts/safety/subscriptions.e2e.test.ts
 */

import { Checks, bootScratchApp, request, type Res } from './e2eHarness';

const c = new Checks();
const brief = (r: Res) => `${r.status} ${r.raw.slice(0, 240)}`;
const DAY = 24 * 60 * 60 * 1000;
const near = (a: unknown, b: number, toleranceMs = 5 * 60 * 1000) => Math.abs(new Date(a as string).getTime() - b) <= toleranceMs;

function loopbackOnly(uri: string) {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)\/([^?]*)/);
  const hosts = (m?.[1] ?? '').toLowerCase().split(',');
  if (!hosts.every((h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h))) {
    throw new Error(`Refusing to run: loopback MongoDB only (got ${hosts.join(',')}).`);
  }
}

async function main() {
  loopbackOnly(process.env.MONGO_URI || '');
  const explicit = (process.env.SCRATCH_DB_NAME || '').trim();
  if (!/^iso_[a-z0-9_]*_scratch_subs$/.test(explicit)) {
    throw new Error('Set SCRATCH_DB_NAME to an iso_*_scratch_subs database: this suite drops it when it finishes.');
  }

  const mode = process.env.E2E_TENANT_ENFORCEMENT || 'warn';
  const app = await bootScratchApp();
  const mongoose = app.mongoose;
  const db = mongoose.connection.db;
  const col = (name: string) => db.collection(name);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { withoutTenantScope, runWithTenant } = require('../../src/core/tenancy/context');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { signPlatformToken } = require('../../src/core/auth/tokens');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformUser = require('../../src/models/PlatformUser').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const User = require('../../src/models/User').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { runLifecycleSweep } = require('../../src/core/subscriptions/service');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { clearOrgStateCache } = require('../../src/core/tenancy/orgState');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { clearHostResolutionCache } = require('../../src/core/tenancy/hostResolution');
  const unscoped = <T>(fn: () => Promise<T>) => withoutTenantScope('e2e:subscriptions', fn) as Promise<T>;

  const RUN = `zz-sub-${Date.now().toString(36)}`;
  const PASSWORD = `Sub-${process.pid}-Pass!`;
  const call = (method: string, path: string, opts: { token?: string; body?: unknown; org?: string } = {}) =>
    request(app.port, method, path, { token: opts.token, body: opts.body, headers: opts.org ? { 'X-Org-Id': opts.org } : undefined });

  try {
    console.log(`\nSUBSCRIPTIONS — platform runtime, TENANT_ENFORCEMENT=${mode} (db: ${app.dbName})`);

    // ── Staff ──────────────────────────────────────────────────────────────
    c.section('platform staff and capabilities');
    const [owner, billing, support] = await unscoped(() =>
      Promise.all([
        PlatformUser.create({ name: 'Sub Owner', email: `${RUN}-owner@platform.test`, password: PASSWORD, role: 'owner' }),
        PlatformUser.create({ name: 'Sub Billing', email: `${RUN}-billing@platform.test`, password: PASSWORD, role: 'billing' }),
        PlatformUser.create({ name: 'Sub Support', email: `${RUN}-support@platform.test`, password: PASSWORD, role: 'support' }),
      ]),
    );
    const OWNER = signPlatformToken({ id: String(owner._id), role: 'owner', tokenVersion: 0 });
    const BILLING = signPlatformToken({ id: String(billing._id), role: 'billing', tokenVersion: 0 });
    const SUPPORT = signPlatformToken({ id: String(support._id), role: 'support', tokenVersion: 0 });

    const supportSeed = await call('POST', '/api/platform/plans/seed-defaults', { token: SUPPORT });
    c.check('support CANNOT seed the catalogue (needs plan.manage)', supportSeed.status === 403, brief(supportSeed));
    const seed = await call('POST', '/api/platform/plans/seed-defaults', { token: BILLING });
    c.check('billing seeds the default catalogue: starter, growth, professional, enterprise',
      seed.status === 200 && ['starter', 'growth', 'professional', 'enterprise'].every((k) => seed.json?.created?.includes(k)), brief(seed));
    const reseed = await call('POST', '/api/platform/plans/seed-defaults', { token: BILLING });
    c.check('seeding again creates nothing and overwrites nothing', reseed.json?.created?.length === 0 && reseed.json?.skipped?.length === 4, brief(reseed));
    const plans = await call('GET', '/api/platform/plans', { token: SUPPORT });
    const byKey = Object.fromEntries((plans.json?.plans ?? []).map((p: any) => [p.key, p]));
    c.check('support can READ the catalogue', plans.status === 200 && Boolean(byKey.starter));
    c.check('Starter ₹999 / 100 students, Growth ₹2,999 / 500, Professional ₹7,999 / 1,500, all at version 1',
      byKey.starter?.price?.monthly === 999 && byKey.starter?.limits?.students === 100 &&
        byKey.growth?.price?.monthly === 2999 && byKey.growth?.limits?.students === 500 &&
        byKey.professional?.price?.monthly === 7999 && byKey.professional?.limits?.students === 1500 &&
        ['starter', 'growth', 'professional', 'enterprise'].every((k) => byKey[k]?.currentVersion === 1));
    c.check('Enterprise is custom-priced and not self-served', byKey.enterprise?.customPricing === true && byKey.enterprise?.selfServe === false);

    // ── Organizations ──────────────────────────────────────────────────────
    c.section('organizations');
    const onboard = async (key: string, subscription?: Record<string, unknown>) => {
      const body: Record<string, unknown> = {
        organization: { name: `${RUN} ${key}`, slug: `${RUN}-${key}`.toLowerCase() },
        admin: { name: `${key} Admin`, email: `${RUN}-${key}-admin@example.test`.toLowerCase(), password: PASSWORD },
        ...(subscription ? { subscription } : {}),
      };
      const r = await call('POST', '/api/platform/orgs/onboard', { token: OWNER, body });
      if (!r.json?.orgId) throw new Error(`onboard ${key} failed: ${brief(r)}`);
      return { orgId: r.json.orgId as string, response: r, body };
    };
    const NEW = await onboard('new');
    const TRIAL = await onboard('trial', { planKey: 'starter' });
    const B = await onboard('b', { planKey: 'growth' });
    const SWEPT = await onboard('swept', { planKey: 'starter' });
    c.check('onboarding with a Starter trial completes every step', TRIAL.response.status === 201, JSON.stringify(TRIAL.response.json?.steps));

    const now = new Date();
    const insertOrg = async (key: string, extra: Record<string, unknown> = {}) => {
      const _id = new mongoose.Types.ObjectId();
      await col('orgs').insertOne({ _id, name: `${RUN} ${key}`, slug: `${RUN}-${key}`, status: 'active', createdAt: now, updatedAt: now, ...extra });
      return String(_id);
    };
    const LEGACY = await insertOrg('legacy');
    const OWNED = await insertOrg('owned', { isPlatformOwned: true });
    await col('subscriptions').insertOne({ orgId: new mongoose.Types.ObjectId(OWNED), status: 'expired', isPlatformOwned: false, addOns: [], removals: [], createdAt: now, updatedAt: now });
    clearHostResolutionCache?.();
    for (const [key, orgId] of [['legacy', LEGACY], ['owned', OWNED]] as const) {
      await unscoped(() =>
        User.create({ name: `${key} Admin`, email: `${RUN}-${key}-admin@example.test`, password: PASSWORD, role: 'admin', status: 'approved', orgId }),
      );
    }
    const student = await runWithTenant({ orgId: TRIAL.orgId, source: 'script' }, () =>
      User.create({ name: 'Trial Student', email: `${RUN}-trial-student@example.test`, password: PASSWORD, role: 'student', status: 'approved', classLevel: '11' }),
    );
    c.check('fixtures: 6 organizations, staff, admins and a student', Boolean(student?._id));

    const login = async (who: string, orgId: string) => {
      const r = await call('POST', '/api/auth/login', { body: { email: `${RUN}-${who}@example.test`, password: PASSWORD }, org: orgId });
      if (!r.json?.token) throw new Error(`login ${who} failed: ${brief(r)}`);
      return r.json.token as string;
    };
    const tok = {
      new: await login('new-admin', NEW.orgId),
      trial: await login('trial-admin', TRIAL.orgId),
      b: await login('b-admin', B.orgId),
      legacy: await login('legacy-admin', LEGACY),
      owned: await login('owned-admin', OWNED),
      student: await login('trial-student', TRIAL.orgId),
    };
    const ent = async (orgId: string) => (await call('GET', `/api/platform/orgs/${orgId}/entitlement`, { token: SUPPORT })).json?.entitlement;
    const sub = async (orgId: string) => (await call('GET', `/api/platform/orgs/${orgId}/subscription`, { token: SUPPORT })).json;
    const write = (token: string, name = `${RUN} renamed`) => call('PATCH', '/api/auth/profile', { token, body: { name } });

    // ── No subscription ────────────────────────────────────────────────────
    c.section('organizations without a subscription');
    const legacyEnt = await ent(LEGACY);
    c.check('LEGACY (created before subscriptions) still resolves to every module', legacyEnt?.modules?.includes('ai') && legacyEnt?.modules?.includes('cbt'), JSON.stringify(legacyEnt));
    c.check('LEGACY writes still work', (await write(tok.legacy)).status === 200);
    const legacyHw = await call('GET', '/api/homework', { token: tok.legacy });
    c.check('LEGACY reaches a gated module (homework) as before', legacyHw.json?.code !== 'MODULE_NOT_ENABLED', brief(legacyHw));

    const newEnt = await ent(NEW.orgId);
    c.check('NEW (platform-created, no subscription) is "unassigned" with core modules only',
      newEnt?.status === 'unassigned' && !newEnt.modules.includes('homework') && !newEnt.modules.includes('cbt') && newEnt.modules.includes('users'), JSON.stringify(newEnt));
    const newHw = await call('GET', '/api/homework', { token: tok.new });
    c.check('NEW is refused a paid module: 403 MODULE_NOT_ENABLED (homework)', newHw.status === 403 && newHw.json?.code === 'MODULE_NOT_ENABLED', brief(newHw));
    c.check('NEW can still sign in and write its own profile', (await write(tok.new)).status === 200);
    const newOrgDoc = await col('orgs').findOne({ _id: new mongoose.Types.ObjectId(NEW.orgId) });
    c.check('the marker is on the organization document itself (same insert)', newOrgDoc?.subscriptionRequired === true);

    // ── Trials ─────────────────────────────────────────────────────────────
    c.section('trials');
    const trial = await sub(TRIAL.orgId);
    c.check('TRIAL is trialing on starter v1', trial?.subscription?.status === 'trialing' && trial.subscription.planKey === 'starter' && trial.subscription.planVersion === 1, JSON.stringify(trial?.subscription));
    c.check('...for 14 days', near(trial?.subscription?.trialEndsAt, Date.now() + 14 * DAY));
    const trialEnt = await ent(TRIAL.orgId);
    c.check('...with Starter modules and the 100-student limit', trialEnt?.modules?.includes('homework') && !trialEnt.modules.includes('ai') && trialEnt.limits?.students === 100, JSON.stringify(trialEnt));
    const trialAi = await call('GET', '/api/ai/guidance', { token: tok.trial });
    c.check('a Starter trial is refused AI (Professional): 403 MODULE_NOT_ENABLED', trialAi.status === 403 && trialAi.json?.code === 'MODULE_NOT_ENABLED', brief(trialAi));
    c.check('the history records who started the trial and why',
      (trial?.events ?? []).some((e: any) => e.type === 'start_trial' && e.actor?.kind === 'platform' && e.actor?.id === String(owner._id) && /onboarding/i.test(e.reason)));

    const noReason = await call('POST', `/api/platform/orgs/${NEW.orgId}/subscription/trial`, { token: BILLING, body: { planKey: 'starter' } });
    c.check('starting a trial without a reason: 400 REASON_REQUIRED', noReason.status === 400 && noReason.json?.code === 'REASON_REQUIRED', brief(noReason));
    const supportTrial = await call('POST', `/api/platform/orgs/${NEW.orgId}/subscription/trial`, { token: SUPPORT, body: { planKey: 'starter', reason: 'try' } });
    c.check('support CANNOT start a trial', supportTrial.status === 403, brief(supportTrial));
    const tenantTrial = await call('POST', `/api/platform/orgs/${NEW.orgId}/subscription/trial`, { token: tok.new, body: { planKey: 'starter', reason: 'give me a trial' } });
    c.check('an organization admin CANNOT start or extend its own trial (tenant token refused by the platform surface)',
      tenantTrial.status === 401 || tenantTrial.status === 403, brief(tenantTrial));

    // Deactivated plans are not assignable; existing subscribers keep them.
    const off = await call('POST', '/api/platform/plans/starter/active', { token: BILLING, body: { active: false } });
    c.check('billing can take Starter off sale', off.status === 200 && off.json?.plan?.isActive === false, brief(off));
    const inactive = await call('POST', `/api/platform/orgs/${NEW.orgId}/subscription/trial`, { token: BILLING, body: { planKey: 'starter', reason: 'pilot' } });
    c.check('a plan off sale cannot be assigned: 409 PLAN_INACTIVE', inactive.status === 409 && inactive.json?.code === 'PLAN_INACTIVE', brief(inactive));
    c.check('...while an organization already on it keeps it', (await ent(TRIAL.orgId))?.modules?.includes('homework'));
    await call('POST', '/api/platform/plans/starter/active', { token: BILLING, body: { active: true } });

    const started = await call('POST', `/api/platform/orgs/${NEW.orgId}/subscription/trial`, { token: BILLING, body: { planKey: 'starter', days: 10, reason: 'Pilot agreed on the call' } });
    c.check('billing starts a 10-day Starter trial for NEW', started.status === 200 && started.json?.subscription?.status === 'trialing' && near(started.json.subscription.trialEndsAt, Date.now() + 10 * DAY), brief(started));
    const newHw2 = await call('GET', '/api/homework', { token: tok.new });
    c.check('NEW now reaches homework — the trial granted it, from the next request', newHw2.json?.code !== 'MODULE_NOT_ENABLED', brief(newHw2));
    const extended = await call('POST', `/api/platform/orgs/${NEW.orgId}/subscription/trial`, { token: BILLING, body: { days: 5, reason: 'Exam season' } });
    c.check('extending adds 5 days to the end, not to today', extended.status === 200 && near(extended.json?.subscription?.trialEndsAt, Date.now() + 15 * DAY), brief(extended));

    // ── The clock: trial end → grace → read-only ──────────────────────────
    c.section('trial end, grace, read-only');
    const trialOid = new mongoose.Types.ObjectId(TRIAL.orgId);
    const moveDates = async (orgId: mongoose.Types.ObjectId, set: Record<string, Date>, next: Date) => {
      await col('subscriptions').updateOne({ orgId }, { $set: set });
      await col('entitlements').updateOne({ orgId }, { $set: { nextTransitionAt: next } });
    };
    const trialEnded = new Date(Date.now() - 60 * 60 * 1000);
    await moveDates(trialOid, { trialEndsAt: trialEnded }, trialEnded);
    const inGrace = await write(tok.trial);
    c.check('the first write after the trial ended still succeeds — grace is full access', inGrace.status === 200, brief(inGrace));
    let s = (await sub(TRIAL.orgId))?.subscription;
    c.check('...and the request moved it to past_due, grace = trial end + 7 days', s?.status === 'past_due' && near(s.graceEndsAt, trialEnded.getTime() + 7 * DAY, 1000), JSON.stringify(s));
    const sysEvent = (await sub(TRIAL.orgId))?.events?.find((e: any) => e.type === 'trial_ended');
    c.check('the trial end is in the history as a system event', sysEvent?.actor?.kind === 'system' && sysEvent.fromStatus === 'trialing' && sysEvent.toStatus === 'past_due');

    const graceEnded = new Date(Date.now() - 60 * 1000);
    await moveDates(trialOid, { graceEndsAt: graceEnded }, graceEnded);
    const blocked = await write(tok.trial);
    c.check('after grace, writes are refused: 423 SUBSCRIPTION_READ_ONLY (status expired)',
      blocked.status === 423 && blocked.json?.code === 'SUBSCRIPTION_READ_ONLY' && blocked.json?.subscriptionStatus === 'expired', brief(blocked));
    c.check('reads still work (GET /api/auth/me)', (await call('GET', '/api/auth/me', { token: tok.trial })).status === 200);
    const plan = await call('GET', '/api/org-admin/plan', { token: tok.trial });
    c.check('the admin can see why: /org-admin/plan says expired, not writable, on Starter',
      plan.status === 200 && plan.json?.billing?.status === 'expired' && plan.json?.writable === false && plan.json?.subscription?.plan === 'Starter', brief(plan));
    const relogin = await call('POST', '/api/auth/login', { body: { email: `${RUN}-trial-admin@example.test`, password: PASSWORD }, org: TRIAL.orgId });
    c.check('signing in still works while read-only', relogin.status === 200 && Boolean(relogin.json?.token));
    const attempt = await call('POST', `/api/attempts/${new mongoose.Types.ObjectId()}/submit`, { token: tok.student, body: {} });
    c.check('an exam attempt in progress is never refused by the read-only gate', attempt.json?.code !== 'SUBSCRIPTION_READ_ONLY' && attempt.status !== 423, brief(attempt));
    const homeworkWrite = await call('POST', '/api/homework', { token: tok.trial, body: { title: 'x' } });
    c.check('a module write is refused too (POST /api/homework → 423)', homeworkWrite.status === 423, brief(homeworkWrite));

    // ── Payments ───────────────────────────────────────────────────────────
    c.section('manual payments');
    const tenantPay = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/payments`, { token: tok.trial, body: { amount: 999, method: 'upi', reference: `${RUN}-SELF` } });
    c.check('an organization cannot mark itself paid (tenant token refused)', tenantPay.status === 401 || tenantPay.status === 403, brief(tenantPay));
    const tenantPaySurface = await call('POST', '/api/org-admin/billing/payments', { token: tok.trial, body: { amount: 999, status: 'paid' } });
    c.check('...and there is no tenant route that records a payment (404)', tenantPaySurface.status === 404, brief(tenantPaySurface));
    const supportPay = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/payments`, { token: SUPPORT, body: { amount: 999, method: 'upi', reference: `${RUN}-SUP` } });
    c.check('support cannot record payments (needs billing.manage)', supportPay.status === 403, brief(supportPay));
    const badPay = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/payments`, { token: BILLING, body: { amount: -5, method: 'upi', reference: `${RUN}-NEG` } });
    c.check('a non-positive amount is refused: 400 PAYMENT_INVALID', badPay.status === 400 && badPay.json?.code === 'PAYMENT_INVALID', brief(badPay));

    const R1 = `UTR-${RUN}-1`;
    const paid = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/payments`, { token: BILLING, body: { amount: 999, method: 'upi', reference: R1 } });
    s = (await sub(TRIAL.orgId))?.subscription;
    c.check('a confirmed payment reactivates an expired subscription', paid.status === 201 && paid.json?.applied === true && s?.status === 'active', brief(paid));
    c.check('...for one month from today', near(s?.periodEnd, new Date(new Date().setUTCMonth(new Date().getUTCMonth() + 1)).getTime(), 2 * DAY));
    c.check('...and writes work again immediately', (await write(tok.trial)).status === 200);
    const periodAfterR1 = new Date(s.periodEnd).getTime();
    const replay = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/payments`, { token: BILLING, body: { amount: 999, method: 'upi', reference: R1 } });
    s = (await sub(TRIAL.orgId))?.subscription;
    c.check('the same reference again is the same payment (200, duplicate) and does not extend the period',
      replay.status === 200 && replay.json?.duplicate === true && new Date(s.periodEnd).getTime() === periodAfterR1, brief(replay));
    const conflicting = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/payments`, { token: BILLING, body: { amount: 1999, method: 'upi', reference: R1 } });
    c.check('the same reference with a different amount: 409 PAYMENT_DUPLICATE', conflicting.status === 409 && conflicting.json?.code === 'PAYMENT_DUPLICATE', brief(conflicting));

    const R2 = `UTR-${RUN}-2`;
    const burst = await Promise.all(
      Array.from({ length: 6 }, () => call('POST', `/api/platform/orgs/${TRIAL.orgId}/payments`, { token: BILLING, body: { amount: 999, method: 'bank_transfer', reference: R2 } })),
    );
    const created = burst.filter((r) => r.status === 201).length;
    const rows = await col('payments').countDocuments({ orgId: trialOid, reference: R2 });
    s = (await sub(TRIAL.orgId))?.subscription;
    const expectedEnd = (() => {
      const d = new Date(periodAfterR1);
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 1);
      d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
      return d.getTime();
    })();
    c.check('six simultaneous submissions of one reference: one payment row, one 201',
      rows === 1 && created === 1, `rows=${rows} statuses=${burst.map((r) => r.status).join(',')}`);
    c.check('...and the period is extended exactly once (early renewal extends from the current end)',
      new Date(s.periodEnd).getTime() === expectedEnd, `${new Date(s.periodEnd).toISOString()} vs ${new Date(expectedEnd).toISOString()}`);
    const confirmEvents = ((await sub(TRIAL.orgId))?.events ?? []).filter((e: any) => e.type === 'payment_confirmed' && e.metadata?.reference === R2);
    c.check('...and recorded once in the history', confirmEvents.length === 1, String(confirmEvents.length));

    const failed = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/payments/failed`, {
      token: BILLING,
      body: { reference: `CHQ-${RUN}-9`, method: 'cheque', amount: 999, reason: 'Cheque returned unpaid' },
    });
    s = (await sub(TRIAL.orgId))?.subscription;
    c.check('a failed payment on an active subscription starts 7 days of grace', failed.status === 201 && failed.json?.lifecycle === 'grace-started' && s?.status === 'past_due' && near(s.graceEndsAt, Date.now() + 7 * DAY), brief(failed));
    c.check('...during which writes still work', (await write(tok.trial)).status === 200);
    const failedAgain = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/payments/failed`, {
      token: BILLING,
      body: { reference: `CHQ-${RUN}-9`, method: 'cheque', amount: 999, reason: 'Cheque returned unpaid' },
    });
    c.check('recording the same failure twice is idempotent', failedAgain.status === 200 && failedAgain.json?.duplicate === true, brief(failedAgain));

    // ── Staff decisions ────────────────────────────────────────────────────
    c.section('suspend, reactivate, cancel');
    const noReasonSuspend = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/subscription/transition`, { token: BILLING, body: { event: 'suspend' } });
    c.check('suspending without a reason: 400 REASON_REQUIRED', noReasonSuspend.status === 400 && noReasonSuspend.json?.code === 'REASON_REQUIRED');
    const badEvent = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/subscription/transition`, { token: BILLING, body: { event: 'trial_ended', reason: 'skip ahead' } });
    c.check('clock events cannot be requested by hand: 400', badEvent.status === 400, brief(badEvent));
    const suspends = await Promise.all(
      [0, 1].map(() => call('POST', `/api/platform/orgs/${TRIAL.orgId}/subscription/transition`, { token: BILLING, body: { event: 'suspend', reason: 'Disputed invoice' } })),
    );
    const suspendEvents = ((await sub(TRIAL.orgId))?.events ?? []).filter((e: any) => e.type === 'suspend');
    c.check('two simultaneous suspends: exactly one applies, the other is refused (409)',
      suspends.filter((r) => r.status === 200).length === 1 && suspends.filter((r) => r.status === 409).length === 1 && suspendEvents.length === 1,
      suspends.map(brief).join(' | '));
    c.check('suspended → writes refused (423)', (await write(tok.trial)).status === 423);
    const again = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/subscription/transition`, { token: BILLING, body: { event: 'suspend', reason: 'again' } });
    c.check('an invalid transition says from where: 409 INVALID_TRANSITION, from suspended',
      again.status === 409 && again.json?.code === 'INVALID_TRANSITION' && again.json?.from === 'suspended', brief(again));
    const reactivated = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/subscription/transition`, { token: BILLING, body: { event: 'reactivate', reason: 'Dispute resolved' } });
    c.check('reactivating resumes where it was (past_due, grace still running)', reactivated.status === 200 && reactivated.json?.subscription?.status === 'past_due', brief(reactivated));
    c.check('...and writes work again', (await write(tok.trial)).status === 200);
    const cancelled = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/subscription/transition`, { token: BILLING, body: { event: 'cancel', reason: 'Customer asked to cancel' } });
    c.check('cancelled → read-only, data still readable', cancelled.status === 200 && (await write(tok.trial)).status === 423 && (await call('GET', '/api/auth/me', { token: tok.trial })).status === 200);
    const restarted = await call('POST', `/api/platform/orgs/${TRIAL.orgId}/subscription/trial`, { token: BILLING, body: { days: 7, reason: 'Win-back offer' } });
    c.check('a cancelled organization can be given a new trial (staff, with a reason)', restarted.status === 200 && restarted.json?.subscription?.status === 'trialing', brief(restarted));

    // ── The subscription editor (legacy PUT) ───────────────────────────────
    c.section('the subscription editor cannot bypass the lifecycle');
    const putActive = await call('PUT', `/api/platform/orgs/${NEW.orgId}/subscription`, { token: BILLING, body: { status: 'active' } });
    s = (await sub(NEW.orgId))?.subscription;
    c.check('PUT {status: active} on a trial is applied as the "activate" event', putActive.status === 200 && s?.status === 'active' && Boolean(s.periodEnd), brief(putActive));
    const putPastDue = await call('PUT', `/api/platform/orgs/${NEW.orgId}/subscription`, { token: BILLING, body: { status: 'past_due' } });
    c.check('PUT {status: past_due} is refused — the clock sets it: 409 INVALID_TRANSITION', putPastDue.status === 409 && putPastDue.json?.code === 'INVALID_TRANSITION', brief(putPastDue));
    const putBanana = await call('PUT', `/api/platform/orgs/${NEW.orgId}/subscription`, { token: BILLING, body: { status: 'banana' } });
    c.check('PUT with an unknown status: 400', putBanana.status === 400, brief(putBanana));
    const putUnknownModule = await call('PUT', `/api/platform/orgs/${NEW.orgId}/subscription`, { token: BILLING, body: { addOns: ['teleport'] } });
    c.check('PUT with an unknown module: 400', putUnknownModule.status === 400, brief(putUnknownModule));
    const putSame = await call('PUT', `/api/platform/orgs/${NEW.orgId}/subscription`, { token: BILLING, body: { status: 'active', addOns: ['ai'] } });
    c.check('PUT {status: <current>, addOns} edits modules and leaves the status alone', putSame.status === 200 && putSame.json?.entitlement?.modules?.includes('ai') && putSame.json?.entitlement?.status === 'active', brief(putSame));
    const putSupport = await call('PUT', `/api/platform/orgs/${NEW.orgId}/subscription`, { token: SUPPORT, body: { addOns: [] } });
    c.check('support cannot use the editor either', putSupport.status === 403);

    // ── Plan versioning ────────────────────────────────────────────────────
    c.section('plan versioning');
    const growthBefore = await ent(B.orgId);
    c.check('B is on Growth with 500 students', growthBefore?.limits?.students === 500, JSON.stringify(growthBefore?.limits));
    const growth = byKey.growth;
    const edit = await call('PUT', '/api/platform/plans', {
      token: BILLING,
      body: { key: 'growth', name: 'Growth', modules: growth.modules, price: growth.price, limits: { students: 600 }, changeNote: 'More students' },
    });
    c.check('editing Growth\'s limit writes version 2', edit.status === 200 && edit.json?.newVersion === true && edit.json?.version === 2, brief(edit));
    c.check('B — already on Growth — keeps the terms it was sold (500)', (await ent(B.orgId))?.limits?.students === 500);
    const rename = await call('PUT', '/api/platform/plans', { token: BILLING, body: { key: 'growth', name: 'Growth', description: 'Now with more' } });
    c.check('a description-only edit does not create a version', rename.status === 200 && rename.json?.newVersion === false && rename.json?.version === 2, brief(rename));
    const versions = await call('GET', '/api/platform/plans/growth/versions', { token: SUPPORT });
    c.check('both versions are kept', versions.json?.versions?.length === 2 && versions.json.versions.some((v: any) => v.version === 1 && v.limits?.students === 500));
    const planList = await call('GET', '/api/platform/plans', { token: SUPPORT });
    const growthRow = (planList.json?.plans ?? []).find((p: any) => p.key === 'growth');
    c.check('the catalogue shows how many organizations sit on each version', growthRow?.subscribers?.['1'] >= 1, JSON.stringify(growthRow?.subscribers));
    const badPlan = await call('PUT', '/api/platform/plans', { token: BILLING, body: { key: 'growth', name: 'Growth', limits: { warpDrives: 1 } } });
    c.check('an unknown limit is refused: 400 PLAN_INVALID', badPlan.status === 400 && badPlan.json?.code === 'PLAN_INVALID', brief(badPlan));
    const moveB = await call('POST', `/api/platform/orgs/${B.orgId}/subscription/plan`, { token: BILLING, body: { planKey: 'growth', reason: 'Moved onto the new terms with consent' } });
    c.check('moving B onto the new terms is explicit: v2, 600 students', moveB.status === 200 && moveB.json?.subscription?.planVersion === 2 && (await ent(B.orgId))?.limits?.students === 600, brief(moveB));
    const bEvents = (await sub(B.orgId))?.events ?? [];
    c.check('...and recorded as plan_changed, v1 → v2', bEvents.some((e: any) => e.type === 'plan_changed' && e.metadata?.from?.planVersion === 1 && e.metadata?.to?.planVersion === 2));
    const upgrade = await call('POST', `/api/platform/orgs/${B.orgId}/subscription/plan`, { token: BILLING, body: { planKey: 'professional', reason: 'Upgrade' } });
    c.check('upgrading B to Professional grants AI from the next request', upgrade.status === 200 && (await call('GET', '/api/ai/guidance', { token: tok.b })).json?.code !== 'MODULE_NOT_ENABLED', brief(upgrade));
    const downgrade = await call('POST', `/api/platform/orgs/${B.orgId}/subscription/plan`, { token: BILLING, body: { planKey: 'starter', reason: 'Downgrade' } });
    const aiAfter = await call('GET', '/api/ai/guidance', { token: tok.b });
    const bUsers = await col('users').countDocuments({ orgId: { $in: [B.orgId, new mongoose.Types.ObjectId(B.orgId)] } });
    c.check('downgrading to Starter removes AI access', downgrade.status === 200 && aiAfter.json?.code === 'MODULE_NOT_ENABLED', `${brief(downgrade)} | ${brief(aiAfter)}`);
    c.check('...and deletes nothing (B still has its accounts)', bUsers >= 1, String(bUsers));

    // ── Platform-owned ─────────────────────────────────────────────────────
    c.section('platform-owned organizations');
    const ownedEnt = await ent(OWNED);
    c.check('OWNED keeps every module and stays writable despite an EXPIRED subscription', ownedEnt?.writable === true && ownedEnt?.modules?.includes('ai'), JSON.stringify(ownedEnt));
    c.check('OWNED writes work', (await write(tok.owned)).status === 200);
    const ownedSuspend = await call('POST', `/api/platform/orgs/${OWNED}/subscription/transition`, { token: BILLING, body: { event: 'suspend', reason: 'test' } });
    c.check('staff cannot suspend a platform-owned organization: 409 PLATFORM_OWNED', ownedSuspend.status === 409 && ownedSuspend.json?.code === 'PLATFORM_OWNED', brief(ownedSuspend));
    const ownedPay = await call('POST', `/api/platform/orgs/${OWNED}/payments`, { token: BILLING, body: { amount: 1, method: 'cash', reference: `${RUN}-OWN` } });
    c.check('...nor bill one', ownedPay.status === 409 && ownedPay.json?.code === 'PLATFORM_OWNED', brief(ownedPay));

    // ── The daily sweep ────────────────────────────────────────────────────
    c.section('the daily sweep');
    const sweptOid = new mongoose.Types.ObjectId(SWEPT.orgId);
    await col('subscriptions').updateOne({ orgId: sweptOid }, { $set: { trialEndsAt: new Date(Date.now() - 30 * DAY) } });
    const ownedOid = new mongoose.Types.ObjectId(OWNED);
    await col('subscriptions').updateOne({ orgId: ownedOid }, { $set: { status: 'trialing', trialEndsAt: new Date(Date.now() - 30 * DAY) } });
    const sweep1 = await runLifecycleSweep(new Date());
    const swept = await col('subscriptions').findOne({ orgId: sweptOid });
    c.check('a trial that ended a month ago is expired by the sweep (trial end, then grace end)', swept?.status === 'expired', `${swept?.status} ${JSON.stringify(sweep1)}`);
    const sweptEvents = await col('subscriptionevents').find({ orgId: sweptOid, 'actor.kind': 'system' }).toArray();
    c.check('...both steps recorded', sweptEvents.map((e: any) => e.type).sort().join(',') === 'grace_ended,trial_ended', sweptEvents.map((e: any) => e.type).join(','));
    const sweep2 = await runLifecycleSweep(new Date());
    c.check('a second sweep finds nothing left for it', (await col('subscriptionevents').countDocuments({ orgId: sweptOid, 'actor.kind': 'system' })) === 2, JSON.stringify(sweep2));
    c.check('the sweep never touches a platform-owned subscription', (await col('subscriptions').findOne({ orgId: ownedOid }))?.status === 'trialing');

    // ── Onboarding retries ─────────────────────────────────────────────────
    c.section('onboarding retries');
    const bSubBefore = await col('subscriptions').findOne({ orgId: new mongoose.Types.ObjectId(B.orgId) });
    const retry = await call('POST', '/api/platform/orgs/onboard', { token: OWNER, body: B.body });
    const bSubs = await col('subscriptions').find({ orgId: new mongoose.Types.ObjectId(B.orgId) }).toArray();
    c.check('re-running onboarding resumes the same organization', retry.json?.orgId === B.orgId, brief(retry));
    c.check('...with still exactly one subscription', bSubs.length === 1);
    c.check('...whose trial clock was not restarted', String(bSubs[0]?.trialEndsAt) === String(bSubBefore?.trialEndsAt));
    c.check('...and whose status was not reset', bSubs[0]?.status === bSubBefore?.status);

    // ── Tenant isolation ───────────────────────────────────────────────────
    c.section('tenant isolation');
    await call('POST', `/api/platform/orgs/${B.orgId}/payments`, { token: BILLING, body: { amount: 2999, method: 'bank_transfer', reference: `B-${RUN}-1` } });
    const trialView = (await call('GET', '/api/org-admin/plan', { token: tok.trial })).json?.billing;
    const bView = (await call('GET', '/api/org-admin/plan', { token: tok.b })).json?.billing;
    c.check("TRIAL's admin sees only TRIAL's payments", (trialView?.payments ?? []).length >= 2 && trialView.payments.every((p: any) => !String(p.reference).startsWith('B-')));
    c.check("B's admin sees only B's payments", (bView?.payments ?? []).length === 1 && bView.payments[0].reference === `B-${RUN}-1`, JSON.stringify(bView?.payments));
    const crossRead = await call('GET', `/api/platform/orgs/${B.orgId}/subscription`, { token: tok.trial });
    c.check('a tenant token cannot read another organization\'s subscription (platform surface refuses it)', crossRead.status === 401 || crossRead.status === 403, brief(crossRead));
    const headerHop = await call('GET', '/api/org-admin/plan', { token: tok.trial, org: B.orgId });
    c.check('naming another organization in X-Org-Id is refused (TENANT_MISMATCH), never answered with its plan',
      headerHop.status >= 400 && headerHop.status < 500 && !JSON.stringify(headerHop.json ?? {}).includes(`B-${RUN}`), brief(headerHop));

    // ── Audit ──────────────────────────────────────────────────────────────
    c.section('audit');
    const audits = await col('platformaudits').find({ actorId: { $in: [String(billing._id), billing._id] } }).toArray();
    const actions = new Set(audits.map((a: any) => a.action));
    c.check('staff actions are in the platform audit with the actor',
      ['org.subscription.trial', 'org.payment.record', 'org.payment.failed', 'org.subscription.suspend', 'org.subscription.plan', 'plan.version'].every((a) => actions.has(a)),
      [...actions].join(','));
    const trialHistory = (await sub(TRIAL.orgId))?.events ?? [];
    c.check('every staff event in the history carries a reason',
      trialHistory.filter((e: any) => ['suspend', 'reactivate', 'cancel', 'start_trial', 'extend_trial', 'activate', 'expire'].includes(e.type)).every((e: any) => (e.reason ?? '').length >= 3));
  } finally {
    // This suite owns its database: drop it, on loopback only.
    try {
      clearOrgStateCache?.();
      const name = mongoose.connection.db.databaseName;
      if (/^iso_[a-z0-9_]*_scratch_subs$/.test(name)) await mongoose.connection.db.dropDatabase();
    } catch (error) {
      console.error('cleanup failed:', (error as Error).message);
    }
    await app.close();
  }
  c.report();
}


main().catch((error) => {
  console.error(error);
  process.exit(1);
});
