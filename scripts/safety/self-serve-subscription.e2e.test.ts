/**
 * An institute buying, changing and cancelling its own plan from its admin
 * panel (core/billing/selfServe), end to end through the real app on an
 * isolated database:
 *
 *   - a free trial, once, only with no subscription; never on custom pricing
 *   - switching plan during the trial (no charge, same trial end)
 *   - an ORDER is an invoice; nothing changes until it is paid; paying applies
 *     the plan it names (upgrade), or starts a subscription that did not exist
 *   - one open order; withdrawing it (draft deleted / issued voided)
 *   - auto-issue only when the seller profile says whom to pay and how
 *   - cancelling at period end, withdrawing that, and the clock honouring it
 *   - cancelling now while overdue; renewing while read-only
 *   - another organization's order is unreachable
 *   - the console: orders listed (and counted), accepted by recording the
 *     payment (a draft is issued first), the plan applied before payment,
 *     declined with a reason the institute sees; support may only read
 *
 * Loopback MongoDB only, on a database this suite owns and drops at the end:
 *   SCRATCH_DB_NAME=iso_platform_scratch_selfserve SCRATCH_ALLOW_NEW_DB=true \
 *   E2E_TENANT_ENFORCEMENT=warn|enforce \
 *     npx ts-node --transpile-only scripts/safety/self-serve-subscription.e2e.test.ts
 */

import { Checks, bootScratchApp, request, type Res } from './e2eHarness';

const c = new Checks();
const brief = (r: Res) => `${r.status} ${r.raw.slice(0, 300)}`;
const DAY = 24 * 60 * 60 * 1000;

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
  if (!/^iso_[a-z0-9_]*_scratch_selfserve$/.test(explicit)) {
    throw new Error('Set SCRATCH_DB_NAME to an iso_*_scratch_selfserve database: this suite drops it when it finishes.');
  }
  const mode = process.env.E2E_TENANT_ENFORCEMENT || 'warn';
  const app = await bootScratchApp();
  const mongoose = app.mongoose;
  const db = mongoose.connection.db;
  const col = (name: string) => db.collection(name);
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  const { signPlatformToken } = require('../../src/core/auth/tokens');
  const PlatformUser = require('../../src/models/PlatformUser').default;
  const { advanceSubscription } = require('../../src/core/subscriptions/service');
  const { clearHostResolutionCache } = require('../../src/core/tenancy/hostResolution');
  const { clearOrgStateCache } = require('../../src/core/tenancy/orgState');
  /* eslint-enable @typescript-eslint/no-var-requires */
  const unscoped = <T>(fn: () => Promise<T>) => withoutTenantScope('e2e:selfserve', fn) as Promise<T>;
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  const subOf = (orgId: string) => col('subscriptions').findOne({ orgId: oid(orgId) });

  const RUN = `zz-ss-${Date.now().toString(36)}`;
  const PASSWORD = `Ss-${process.pid}-Pass!`;
  const call = (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    request(app.port, method, path, { token: opts.token, body: opts.body, headers: opts.headers ?? {} });

  try {
    console.log(`\nSELF-SERVE SUBSCRIPTION — platform runtime, TENANT_ENFORCEMENT=${mode} (db: ${app.dbName})`);

    c.section('fixtures');
    const [owner, billing, support] = await unscoped(() =>
      Promise.all([
        PlatformUser.create({ name: 'SS Owner', email: `${RUN}-owner@platform.test`, password: PASSWORD, role: 'owner' }),
        PlatformUser.create({ name: 'SS Billing', email: `${RUN}-billing@platform.test`, password: PASSWORD, role: 'billing' }),
        PlatformUser.create({ name: 'SS Support', email: `${RUN}-support@platform.test`, password: PASSWORD, role: 'support' }),
      ]),
    );
    const OWNER = signPlatformToken({ id: String(owner._id), role: 'owner', tokenVersion: 0 });
    const BILLING = signPlatformToken({ id: String(billing._id), role: 'billing', tokenVersion: 0 });
    const SUPPORT = signPlatformToken({ id: String(support._id), role: 'support', tokenVersion: 0 });
    const seeded = await call('POST', '/api/platform/plans/seed-defaults', { token: BILLING });
    c.check('the default catalogue is seeded', seeded.status === 200, brief(seeded));
    // A seller who can be paid: whom, and how. No GST details — none are invented.
    const profile = await call('PUT', '/api/platform/billing/profile', {
      token: BILLING,
      body: { legalName: 'Platform Test Pvt Ltd', paymentInstructions: 'UPI test@bank · quote the invoice number' },
    });
    c.check('the seller profile names a payee and payment instructions', profile.status === 200, brief(profile));

    const draftOrg = async (tag: string) => {
      const r = await call('POST', '/api/public/organization-applications', {
        body: {
          organizationName: `${RUN} ${tag} Academy`,
          organizationType: 'COACHING_INSTITUTE',
          contactName: `${tag} Contact`,
          designation: 'Director',
          email: `${RUN}-${tag}-contact@example.test`.toLowerCase(),
          phone: '+91 98765 12345',
          city: 'Pune',
          state: 'Maharashtra',
        },
      });
      if (!r.json?.draftToken) throw new Error(`draft ${tag}: ${brief(r)}`);
      const ap = await call('POST', `/api/platform/registrations/${r.json.draft.id}/approve`, {
        token: OWNER,
        body: {
          slug: `${RUN}-${tag}`.toLowerCase(),
          admin: { name: `${tag} Admin`, email: `${RUN}-${tag}-admin@example.test`.toLowerCase(), password: PASSWORD },
        },
      });
      const orgId = ap.json?.onboarding?.orgId as string;
      if (!orgId) throw new Error(`approve ${tag}: ${brief(ap)}`);
      clearHostResolutionCache?.();
      const login = await call('POST', '/api/auth/login', {
        body: { email: `${RUN}-${tag}-admin@example.test`.toLowerCase(), password: PASSWORD },
        headers: { 'X-Org-Id': orgId },
      });
      if (!login.json?.token) throw new Error(`login ${tag}: ${brief(login)}`);
      return { orgId, token: login.json.token as string };
    };
    const T = await draftOrg('trial');
    const N = await draftOrg('new');
    const P = await draftOrg('overdue');
    const Q = await draftOrg('console');
    c.check('three institutes approved with no plan, so no subscription', !(await subOf(T.orgId)) && !(await subOf(N.orgId)));

    const state = (o: { token: string }) => call('GET', '/api/org-admin/subscription', { token: o.token });
    const settle = (invoiceId: string, amount: number, reference: string) =>
      call('POST', `/api/platform/invoices/${invoiceId}/payments`, { token: BILLING, body: { amount, method: 'upi', reference } });

    // ── A trial ──────────────────────────────────────────────────────────
    c.section('a free trial, chosen by the institute');
    const noAuth = await call('GET', '/api/org-admin/subscription');
    c.check('the self-serve view needs a session', noAuth.status === 401, brief(noAuth));
    const s0 = await state(T);
    c.check('with no subscription: a trial and an order are offered, nothing else',
      s0.status === 200 && s0.json?.actions?.startTrial === true && s0.json.actions.order === true &&
        !s0.json.actions.cancelAtPeriodEnd && !s0.json.actions.switchTrialPlan && s0.json.autoInvoice === true, brief(s0));
    const entTrial = await call('POST', '/api/org-admin/subscription/trial', { token: T.token, body: { planKey: 'enterprise' } });
    c.check('no trial on a custom-priced plan (409 CUSTOM_PRICING)', entTrial.status === 409 && entTrial.json?.code === 'CUSTOM_PRICING', brief(entTrial));
    const trial = await call('POST', '/api/org-admin/subscription/trial', { token: T.token, body: { planKey: 'starter' } });
    const subT = await subOf(T.orgId);
    c.check('a Starter trial starts at once: trialing, managed, 14 days',
      trial.status === 201 && subT?.status === 'trialing' && subT?.planKey === 'starter' && Boolean(subT?.managedSince) &&
        Math.abs(new Date(subT?.trialEndsAt).getTime() - Date.now() - 14 * DAY) < 60_000, `${brief(trial)} ${JSON.stringify(subT)}`);
    const again = await call('POST', '/api/org-admin/subscription/trial', { token: T.token, body: { planKey: 'growth' } });
    c.check('a second trial is refused (409)', again.status === 409 && ['TRIAL_UNAVAILABLE', 'TRIAL_USED'].includes(again.json?.code), brief(again));
    const history = await col('subscriptionevents').findOne({ orgId: oid(T.orgId), type: 'start_trial' });
    c.check('the history says the institute started it', history?.actor?.kind === 'tenant', JSON.stringify(history?.actor));

    c.section('switching plan during the trial');
    const sw = await call('POST', '/api/org-admin/subscription/switch-plan', { token: T.token, body: { planKey: 'growth' } });
    const subT2 = await subOf(T.orgId);
    c.check('Growth now, at no charge, with the same trial end',
      sw.status === 200 && subT2?.planKey === 'growth' && subT2?.status === 'trialing' &&
        new Date(subT2?.trialEndsAt).getTime() === new Date(subT?.trialEndsAt).getTime(), `${brief(sw)} plan=${subT2?.planKey}`);
    const swEnt = await call('POST', '/api/org-admin/subscription/switch-plan', { token: T.token, body: { planKey: 'enterprise' } });
    c.check('...but never to a custom-priced plan', swEnt.status === 409, brief(swEnt));
    const swN = await call('POST', '/api/org-admin/subscription/switch-plan', { token: N.token, body: { planKey: 'growth' } });
    c.check('...and only during a trial (409 NOT_IN_TRIAL)', swN.status === 409 && swN.json?.code === 'NOT_IN_TRIAL', brief(swN));

    // ── An upgrade order ─────────────────────────────────────────────────
    c.section('an order is an invoice; paying it applies the plan');
    const ent = await call('POST', '/api/org-admin/subscription/orders', { token: T.token, body: { planKey: 'enterprise', billingInterval: 'monthly' } });
    c.check('Enterprise cannot be ordered directly (409 CUSTOM_PRICING), nothing created',
      ent.status === 409 && ent.json?.code === 'CUSTOM_PRICING' && (await col('invoices').countDocuments({ orgId: oid(T.orgId) })) === 0, brief(ent));
    const annual = await call('POST', '/api/org-admin/subscription/orders', { token: T.token, body: { planKey: 'professional', billingInterval: 'annual' } });
    const yearMs = new Date(annual.json?.order?.periodEnd).getTime() - new Date(annual.json?.order?.periodStart).getTime();
    c.check('a yearly order is ten months of price (₹79,990) for a year', annual.status === 201 && annual.json?.order?.totalMinor === 7999000 &&
      yearMs >= 365 * DAY && yearMs <= 366 * DAY, brief(annual));
    await call('POST', `/api/org-admin/subscription/orders/${annual.json?.order?.id}/withdraw`, { token: T.token });
    const order = await call('POST', '/api/org-admin/subscription/orders', { token: T.token, body: { planKey: 'professional', billingInterval: 'monthly' } });
    const inv = order.json?.order;
    c.check('Professional monthly: an issued invoice at once, ₹7,999, numbered',
      order.status === 201 && order.json?.issued === true && inv?.status === 'issued' && inv?.totalMinor === 799900 && /^INV\//.test(String(inv?.number)), brief(order));
    c.check('...for the month after the trial ends (no days lost)',
      new Date(inv?.periodStart).getTime() === new Date(subT2?.trialEndsAt).getTime(), `${inv?.periodStart} vs ${subT2?.trialEndsAt}`);
    c.check('...carrying how to pay', /UPI test@bank/.test(String(inv?.paymentInstructions)), String(inv?.paymentInstructions));
    const subT3 = await subOf(T.orgId);
    c.check('ordering changed nothing yet: still Growth, still trialing', subT3?.planKey === 'growth' && subT3?.status === 'trialing');
    const dup = await call('POST', '/api/org-admin/subscription/orders', { token: T.token, body: { planKey: 'starter', billingInterval: 'monthly' } });
    c.check('one open order at a time (409 ORDER_OPEN, with the open order)', dup.status === 409 && dup.json?.code === 'ORDER_OPEN' && dup.json?.order?.id === inv?.id, brief(dup));
    const listed = await call('GET', '/api/org-admin/billing/invoices', { token: T.token });
    c.check('the institute sees the invoice under Billing', (listed.json?.invoices ?? []).some((i: any) => String(i._id ?? i.id) === inv?.id), brief(listed));
    const sView = await state(T);
    c.check('the self-serve view shows the open order and offers withdrawing it, not another order',
      sView.json?.openOrder?.id === inv?.id && sView.json?.actions?.withdrawOrder === true && sView.json?.actions?.order === false, brief(sView));

    const cross = await call('POST', `/api/org-admin/subscription/orders/${inv?.id}/withdraw`, { token: N.token });
    c.check("another institute cannot touch this order (404)", cross.status === 404, brief(cross));

    const short = await settle(inv?.id, 999, `${RUN}-short`);
    c.check('a short payment is refused and applies nothing', short.status === 400 && (await subOf(T.orgId))?.planKey === 'growth', brief(short));
    const paid = await settle(inv?.id, 7999, `${RUN}-pay-1`);
    const subT4 = await subOf(T.orgId);
    c.check('paid → Professional, active, paid from the trial end for one month',
      [200, 201].includes(paid.status) && subT4?.planKey === 'professional' && subT4?.status === 'active' &&
        new Date(subT4?.periodStart).getTime() === new Date(subT2?.trialEndsAt).getTime() &&
        new Date(subT4?.periodEnd).getTime() === new Date(inv?.periodEnd).getTime(), `${brief(paid)} ${JSON.stringify(subT4)}`);
    const replay = await settle(inv?.id, 7999, `${RUN}-pay-1`);
    const subT5 = await subOf(T.orgId);
    c.check('the same payment again is the same payment: no second period',
      replay.status === 200 && new Date(subT5?.periodEnd).getTime() === new Date(subT4?.periodEnd).getTime(), brief(replay));
    const after = await state(T);
    c.check('no open order any more; ordering is offered again', after.json?.openOrder === null && after.json?.actions?.order === true, brief(after));

    // ── Cancel at period end ─────────────────────────────────────────────
    c.section('cancelling at the end of the paid period');
    const cancel = await call('POST', '/api/org-admin/subscription/cancel', { token: T.token, body: { reason: 'Moving to another system' } });
    const subT6 = await subOf(T.orgId);
    c.check('scheduled, not immediate: still active, ends at the period end',
      cancel.status === 200 && cancel.json?.when === 'period-end' && subT6?.status === 'active' && subT6?.cancelAtPeriodEnd === true &&
        new Date(cancel.json?.endsAt).getTime() === new Date(subT6?.periodEnd).getTime(), brief(cancel));
    const writeWhileScheduled = await call('PUT', '/api/org-admin/profile', { token: T.token, body: { profile: { city: 'Pune' } } });
    c.check('everything keeps working until then', writeWhileScheduled.status === 200, brief(writeWhileScheduled));
    const resume = await call('POST', '/api/org-admin/subscription/resume', { token: T.token });
    c.check('withdrawing it keeps the subscription', resume.status === 200 && !(await subOf(T.orgId))?.cancelAtPeriodEnd, brief(resume));
    await call('POST', '/api/org-admin/subscription/cancel', { token: T.token, body: {} });
    const end = new Date((await subOf(T.orgId))?.periodEnd);
    const clock = await advanceSubscription(T.orgId, new Date(end.getTime() + DAY));
    const subT7 = await subOf(T.orgId);
    c.check('at the period end the clock cancels — no grace period',
      subT7?.status === 'cancelled' && !subT7?.graceEndsAt && new Date(subT7?.cancelledAt).getTime() === end.getTime() &&
        JSON.stringify(clock.events) === '["period_ended"]', JSON.stringify(subT7));
    clearOrgStateCache?.();
    const readOnly = await call('PUT', '/api/org-admin/profile', { token: T.token, body: { profile: { city: 'Mumbai' } } });
    c.check('after it ends, ordinary writes are refused (423)', readOnly.status === 423, brief(readOnly));
    const renew = await call('POST', '/api/org-admin/subscription/orders', { token: T.token, body: { planKey: 'starter', billingInterval: 'monthly' } });
    c.check('...but ordering a plan stays open, so the institute can come back', renew.status === 201 && renew.json?.kind === 'downgrade', brief(renew));
    const back = await settle(renew.json?.order?.id, 999, `${RUN}-pay-back`);
    const subT8 = await subOf(T.orgId);
    c.check('paying it brings the institute back: active on Starter', [200, 201].includes(back.status) && subT8?.status === 'active' && subT8?.planKey === 'starter', `${brief(back)} ${JSON.stringify(subT8)}`);

    // ── Buying without a trial ───────────────────────────────────────────
    c.section('buying with no subscription at all');
    const nOrder = await call('POST', '/api/org-admin/subscription/orders', { token: N.token, body: { planKey: 'growth', billingInterval: 'monthly' } });
    c.check('an order with no subscription is a "new" order', nOrder.status === 201 && nOrder.json?.kind === 'new', brief(nOrder));
    c.check('...and creates no subscription by itself', !(await subOf(N.orgId)));
    const nPaid = await settle(nOrder.json?.order?.id, 2999, `${RUN}-pay-n`);
    const subN = await subOf(N.orgId);
    c.check('paying it starts the subscription: active on Growth, managed, one month from today',
      [200, 201].includes(nPaid.status) && subN?.status === 'active' && subN?.planKey === 'growth' && Boolean(subN?.managedSince) &&
        Math.abs(new Date(subN?.periodStart).getTime() - Date.now()) < 5 * 60_000, `${brief(nPaid)} ${JSON.stringify(subN)}`);
    const payN = await col('payments').findOne({ orgId: oid(N.orgId), reference: `${RUN}-pay-n` });
    c.check('...and the payment is linked to it', String(payN?.subscriptionId) === String(subN?._id), JSON.stringify(payN?.subscriptionId));
    const nTrial = await call('POST', '/api/org-admin/subscription/trial', { token: N.token, body: { planKey: 'starter' } });
    c.check('a paying institute is not offered a trial afterwards', nTrial.status === 409, brief(nTrial));

    c.section('withdrawing an order');
    const up = await call('POST', '/api/org-admin/subscription/orders', { token: N.token, body: { planKey: 'professional', billingInterval: 'monthly' } });
    c.check('an upgrade order is an "upgrade"', up.status === 201 && up.json?.kind === 'upgrade', brief(up));
    const wd = await call('POST', `/api/org-admin/subscription/orders/${up.json?.order?.id}/withdraw`, { token: N.token });
    const voided = await col('invoices').findOne({ _id: oid(up.json?.order?.id) });
    c.check('withdrawing an issued order voids its invoice; the plan is unchanged',
      wd.status === 200 && voided?.status === 'void' && (await subOf(N.orgId))?.planKey === 'growth', `${brief(wd)} ${voided?.status}`);
    const payVoid = await settle(up.json?.order?.id, 7999, `${RUN}-pay-void`);
    c.check('a withdrawn order cannot be paid', payVoid.status === 409, brief(payVoid));

    c.section('when the seller cannot be paid yet, an order waits for review');
    await call('PUT', '/api/platform/billing/profile', { token: BILLING, body: { paymentInstructions: '' } });
    const waits = await call('POST', '/api/org-admin/subscription/orders', { token: N.token, body: { planKey: 'growth', billingInterval: 'monthly' } });
    c.check('without payment instructions the order is a draft, not an issued invoice',
      waits.status === 201 && waits.json?.issued === false && waits.json?.order?.status === 'draft' && !waits.json?.order?.number, brief(waits));
    const nList = await call('GET', '/api/org-admin/billing/invoices', { token: N.token });
    c.check('...which the institute does not see as an invoice', !(nList.json?.invoices ?? []).some((i: any) => String(i._id ?? i.id) === waits.json?.order?.id));
    const sN = await state(N);
    c.check('...but sees as its pending order', sN.json?.openOrder?.status === 'draft' && sN.json?.autoInvoice === false, brief(sN));
    const wdDraft = await call('POST', `/api/org-admin/subscription/orders/${waits.json?.order?.id}/withdraw`, { token: N.token });
    c.check('withdrawing a draft order deletes it', wdDraft.status === 200 && !(await col('invoices').findOne({ _id: oid(waits.json?.order?.id) })), brief(wdDraft));
    await call('PUT', '/api/platform/billing/profile', { token: BILLING, body: { paymentInstructions: 'UPI test@bank · quote the invoice number' } });

    // ── Overdue: cancel now ──────────────────────────────────────────────
    c.section('cancelling while overdue');
    const staffTrial = await call('POST', `/api/platform/orgs/${P.orgId}/subscription/trial`, { token: OWNER, body: { reason: 'Pilot', planKey: 'starter' } });
    c.check('staff start a trial for P', staffTrial.status === 200 || staffTrial.status === 201, brief(staffTrial));
    const pEnd = new Date((await subOf(P.orgId))?.trialEndsAt);
    await advanceSubscription(P.orgId, new Date(pEnd.getTime() + DAY));
    c.check('P is overdue (in grace)', (await subOf(P.orgId))?.status === 'past_due');
    const pOrder = await call('POST', '/api/org-admin/subscription/orders', { token: P.token, body: { planKey: 'starter', billingInterval: 'monthly' } });
    const pCancel = await call('POST', '/api/org-admin/subscription/cancel', { token: P.token, body: { reason: 'Not continuing' } });
    const subP = await subOf(P.orgId);
    c.check('cancelling while overdue takes effect now', pCancel.status === 200 && pCancel.json?.when === 'now' && subP?.status === 'cancelled', brief(pCancel));
    const pInv = await col('invoices').findOne({ _id: oid(pOrder.json?.order?.id) });
    c.check('...and its unpaid order is withdrawn with it', pInv?.status === 'void', pInv?.status);
    const pResume = await call('POST', '/api/org-admin/subscription/resume', { token: P.token });
    c.check('nothing to resume once it has ended (no change)', pResume.status === 200 && pResume.json?.changed === false && (await subOf(P.orgId))?.status === 'cancelled', brief(pResume));

    // ── The console sees it ──────────────────────────────────────────────
    // ── The console's side of an order ───────────────────────────────────
    c.section('the console: orders waiting for the platform');
    await call('PUT', '/api/platform/billing/profile', { token: BILLING, body: { paymentInstructions: '' } });
    const qTrial = await call('POST', '/api/org-admin/subscription/trial', { token: Q.token, body: { planKey: 'starter' } });
    c.check('Q starts a Starter trial', qTrial.status === 201, brief(qTrial));
    const qOrder = await call('POST', '/api/org-admin/subscription/orders', { token: Q.token, body: { planKey: 'growth', billingInterval: 'monthly' } });
    const qId = qOrder.json?.order?.id;
    c.check('Q orders Growth; with no payment instructions it waits as a draft', qOrder.status === 201 && qOrder.json?.order?.status === 'draft', brief(qOrder));
    const listed2 = await call('GET', '/api/platform/orders', { token: SUPPORT });
    const row = (listed2.json?.orders ?? []).find((o: any) => o.id === qId);
    c.check('staff see it under Orders: institute, plan name, kind, amount, who ordered, current subscription',
      listed2.status === 200 && row?.organization?.name?.includes('console') && row?.planName === 'Growth' && row?.kind === 'new' &&
        row?.totalMinor === 299900 && /console-admin/.test(String(row?.orderedBy)) && row?.subscription?.status === 'trialing', JSON.stringify(row));
    const onlyQ = await call('GET', `/api/platform/orders?orgId=${Q.orgId}`, { token: SUPPORT });
    c.check('...and filtered to one institute', (onlyQ.json?.orders ?? []).length === 1 && onlyQ.json.orders[0].id === qId, brief(onlyQ));
    const dash = await call('GET', '/api/platform/dashboard', { token: SUPPORT });
    c.check('the dashboard counts open institute orders', (dash.json?.summary?.billing?.openOrders ?? 0) >= 1, JSON.stringify(dash.json?.summary?.billing));

    const supportAccept = await call('POST', `/api/platform/orders/${qId}/accept`, { token: SUPPORT, body: { method: 'upi', reference: `${RUN}-q-1` } });
    const supportDecline = await call('POST', `/api/platform/orders/${qId}/decline`, { token: SUPPORT, body: { reason: 'Not allowed' } });
    c.check('support can read but not accept or decline (403)', supportAccept.status === 403 && supportDecline.status === 403, `${supportAccept.status} ${supportDecline.status}`);

    const applied = await call('POST', `/api/platform/orders/${qId}/apply-plan`, { token: OWNER, body: { reason: 'Agreed on the phone; paying next week' } });
    const subQ = await subOf(Q.orgId);
    c.check('applying the plan before payment: Q is on Growth now, still in its trial', applied.status === 200 && subQ?.planKey === 'growth' && subQ?.status === 'trialing', `${brief(applied)} ${subQ?.planKey}`);
    const qState = await state(Q);
    c.check('...the order stays open, marked as applied, for the institute to pay', qState.json?.openOrder?.id === qId && qState.json?.openOrder?.planApplied === true, brief(qState));

    const noRef = await call('POST', `/api/platform/orders/${qId}/accept`, { token: BILLING, body: { method: 'upi' } });
    c.check('accepting needs a payment reference (400), and changes nothing', noRef.status === 400 && (await col('invoices').findOne({ _id: oid(qId) }))?.status === 'draft', brief(noRef));
    const accepted = await call('POST', `/api/platform/orders/${qId}/accept`, { token: BILLING, body: { method: 'bank_transfer', reference: `${RUN}-q-1` } });
    const qInv = await col('invoices').findOne({ _id: oid(qId) });
    const subQ2 = await subOf(Q.orgId);
    c.check('accepting a draft order issues it, records the payment, and marks it paid', [200, 201].includes(accepted.status) && accepted.json?.issuedNow === true && qInv?.status === 'paid' && /^INV\//.test(String(qInv?.number)), `${brief(accepted)} ${qInv?.status}`);
    c.check('...and Q is active on Growth from its trial end', subQ2?.status === 'active' && subQ2?.planKey === 'growth' &&
      new Date(subQ2?.periodStart).getTime() === new Date(subQ?.trialEndsAt).getTime(), JSON.stringify(subQ2));
    const again2 = await call('POST', `/api/platform/orders/${qId}/accept`, { token: BILLING, body: { method: 'bank_transfer', reference: `${RUN}-q-1` } });
    c.check('accepting a paid order again is refused (409), nothing doubles', again2.status === 409 && new Date((await subOf(Q.orgId))?.periodEnd).getTime() === new Date(subQ2?.periodEnd).getTime(), brief(again2));
    const gone = await call('GET', `/api/platform/orders?orgId=${Q.orgId}`, { token: SUPPORT });
    const all = await call('GET', `/api/platform/orders?orgId=${Q.orgId}&status=all`, { token: SUPPORT });
    c.check('a paid order leaves the open list but stays in "all"', (gone.json?.orders ?? []).length === 0 && (all.json?.orders ?? [])[0]?.status === 'paid', `${brief(gone)} ${brief(all)}`);

    c.section('the console: declining an order');
    await call('PUT', '/api/platform/billing/profile', { token: BILLING, body: { paymentInstructions: 'UPI test@bank · quote the invoice number' } });
    const qUp = await call('POST', '/api/org-admin/subscription/orders', { token: Q.token, body: { planKey: 'professional', billingInterval: 'monthly' } });
    const upId = qUp.json?.order?.id;
    c.check('Q orders an upgrade to Professional (issued)', qUp.status === 201 && qUp.json?.order?.status === 'issued' && qUp.json?.kind === 'upgrade', brief(qUp));
    const shortReason = await call('POST', `/api/platform/orders/${upId}/decline`, { token: BILLING, body: { reason: 'no' } });
    c.check('declining needs a reason (400)', shortReason.status === 400, brief(shortReason));
    const declined = await call('POST', `/api/platform/orders/${upId}/decline`, { token: BILLING, body: { reason: 'Professional needs a signed agreement first' } });
    const upInv = await col('invoices').findOne({ _id: oid(upId) });
    c.check('declined: the invoice is void with the reason; the plan is unchanged', declined.status === 200 && upInv?.status === 'void' && /signed agreement/.test(String(upInv?.voidReason)) && (await subOf(Q.orgId))?.planKey === 'growth', `${brief(declined)} ${upInv?.status}`);
    const qState2 = await state(Q);
    c.check('the institute sees why, and may order again', qState2.json?.openOrder === null && /signed agreement/.test(String(qState2.json?.lastDecline?.reason)) && qState2.json?.actions?.order === true, brief(qState2));
    const declineAgain = await call('POST', `/api/platform/orders/${upId}/decline`, { token: BILLING, body: { reason: 'twice' } });
    c.check('a closed order cannot be declined again (409)', declineAgain.status === 409, brief(declineAgain));
    const crossOrder = await call('POST', `/api/platform/orders/${String(new mongoose.Types.ObjectId())}/accept`, { token: BILLING, body: { method: 'upi', reference: 'x-1' } });
    c.check('an id that is not an institute order is a 404', crossOrder.status === 404, brief(crossOrder));
    const qNext = await call('POST', '/api/org-admin/subscription/orders', { token: Q.token, body: { planKey: 'starter', billingInterval: 'monthly' } });
    const qState3 = await state(Q);
    c.check('a new order hides the old decline', qNext.status === 201 && qState3.json?.lastDecline === null, brief(qState3));
    await call('POST', `/api/org-admin/subscription/orders/${qNext.json?.order?.id}/withdraw`, { token: Q.token });

    // ── Plan terms: the recommended catalogue, and moving subscribers ────────
    c.section('recommended terms and moving subscribers to a new version');
    const rec = await call('GET', '/api/platform/plans/recommended', { token: SUPPORT });
    const recByKey = Object.fromEntries((rec.json?.plans ?? []).map((p: any) => [p.key, p]));
    c.check('freshly seeded plans already carry the recommended terms (nothing to change)',
      rec.status === 200 && (rec.json?.plans ?? []).length === 4 && (rec.json.plans as any[]).every((p) => p.changes === false), brief(rec));
    c.check('...every enforced limit is set: Growth = 500 students, 40 teachers, 5 admins, AI 0, 2 builds',
      JSON.stringify(recByKey.growth?.current?.limits) === JSON.stringify({ admins: 5, aiGenerationsMonthly: 0, appBuildsMonthly: 2, students: 500, teachers: 40 }) ||
        (recByKey.growth?.current?.limits?.teachers === 40 && recByKey.growth?.current?.limits?.admins === 5 && recByKey.growth?.current?.limits?.aiGenerationsMonthly === 0),
      JSON.stringify(recByKey.growth?.current?.limits));
    const supportApply = await call('POST', '/api/platform/plans/apply-recommended', { token: SUPPORT });
    c.check('support cannot change the catalogue (403)', supportApply.status === 403, brief(supportApply));
    const growthBefore = (await col('plans').findOne({ key: 'growth' }))?.currentVersion;
    const v2 = await call('PUT', '/api/platform/plans', {
      token: OWNER,
      body: { key: 'growth', name: 'Growth', limits: { students: 500, teachers: 45, admins: 5, aiGenerationsMonthly: 0, appBuildsMonthly: 2 }, changeNote: 'e2e: one more teacher tier' },
    });
    c.check('a terms change writes a new Growth version', v2.status === 200 && v2.json?.version === growthBefore + 1, brief(v2));
    const onOld = await col('subscriptions').countDocuments({ planKey: 'growth', planVersion: growthBefore });
    c.check('existing Growth subscribers stay on the version they were sold', onOld >= 1, String(onOld));
    const noReason = await call('POST', '/api/platform/plans/growth/move-subscribers', { token: OWNER, body: {} });
    c.check('moving subscribers needs a reason (400)', noReason.status === 400, brief(noReason));
    const moved = await call('POST', '/api/platform/plans/growth/move-subscribers', { token: OWNER, body: { reason: 'Adopt the new teacher allowance' } });
    c.check('moving: every managed Growth subscriber is now on the new version',
      moved.status === 200 && moved.json?.moved?.length === onOld && (await col('subscriptions').countDocuments({ planKey: 'growth', planVersion: growthBefore })) === 0,
      brief(moved));
    const nAfter = await call('GET', '/api/org-admin/plan', { token: N.token });
    c.check('...and the institute sees the new allowance (45 teachers)', nAfter.json?.usage?.resources?.teachers?.limit === 45, JSON.stringify(nAfter.json?.usage?.resources?.teachers));
    const diff2 = await call('GET', '/api/platform/plans/recommended', { token: SUPPORT });
    c.check('the recommended view now flags Growth as different', (diff2.json?.plans ?? []).find((p: any) => p.key === 'growth')?.changes === true);
    const applied2 = await call('POST', '/api/platform/plans/apply-recommended', { token: OWNER });
    const g = (applied2.json?.results ?? []).find((r: any) => r.key === 'growth');
    const others = (applied2.json?.results ?? []).filter((r: any) => r.key !== 'growth');
    c.check('applying the recommended terms writes a new Growth version and leaves the others alone',
      applied2.status === 200 && g?.newVersion === true && g?.version === growthBefore + 2 && others.every((r: any) => r.newVersion === false), brief(applied2));
    c.check('...without moving anyone: subscribers stay until moved', (await col('subscriptions').countDocuments({ planKey: 'growth', planVersion: growthBefore + 1 })) === onOld);

    c.section('the platform team sees what the institute did');
    const detail = await call('GET', `/api/platform/orgs/${T.orgId}/subscription`, { token: OWNER });
    c.check('the console detail is readable and the history names the institute',
      detail.status === 200 && JSON.stringify(detail.json ?? {}).includes('order_placed'), brief(detail));
  } finally {
    try {
      clearOrgStateCache?.();
      const name = mongoose.connection.db.databaseName;
      if (/^iso_[a-z0-9_]*_scratch_selfserve$/.test(name)) await mongoose.connection.db.dropDatabase();
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
