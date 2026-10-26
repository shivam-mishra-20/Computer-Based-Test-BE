/**
 * The admin-facing subscription surface, end to end, through the real app on
 * an isolated database:
 *
 *   - the public plan catalogue (registration form) and the org-admin one
 *   - a plan preference on an institute application: validated when saved,
 *     honoured at approval only for a self-serve plan on sale, never over a
 *     staff choice, and never re-applied by a retried approval
 *   - notices to an organization's administrators (lifecycle, invoices,
 *     requests, "trial ends soon" once per trial end)
 *   - the console's dashboard billing counts and the over-limit list
 *
 * Loopback MongoDB only, on a database this suite owns and drops at the end:
 *   SCRATCH_DB_NAME=iso_platform_scratch_subadmin SCRATCH_ALLOW_NEW_DB=true \
 *   E2E_TENANT_ENFORCEMENT=warn|enforce \
 *     npx ts-node --transpile-only scripts/safety/subscription-admin.e2e.test.ts
 */

import { Checks, bootScratchApp, request, type Res } from './e2eHarness';

const c = new Checks();
const brief = (r: Res) => `${r.status} ${r.raw.slice(0, 260)}`;
const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  if (!/^iso_[a-z0-9_]*_scratch_subadmin$/.test(explicit)) {
    throw new Error('Set SCRATCH_DB_NAME to an iso_*_scratch_subadmin database: this suite drops it when it finishes.');
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
  const { remindTrialsEnding } = require('../../src/core/subscriptions/service');
  const { clearHostResolutionCache } = require('../../src/core/tenancy/hostResolution');
  const { clearOrgStateCache } = require('../../src/core/tenancy/orgState');
  /* eslint-enable @typescript-eslint/no-var-requires */
  const unscoped = <T>(fn: () => Promise<T>) => withoutTenantScope('e2e:subadmin', fn) as Promise<T>;
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  const orgForms = (id: string) => ({ $in: [id, oid(id)] });

  const RUN = `zz-sa-${Date.now().toString(36)}`;
  const PASSWORD = `Sa-${process.pid}-Pass!`;
  const call = (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; draftToken?: string } = {}) =>
    request(app.port, method, path, {
      token: opts.token,
      body: opts.body,
      headers: { ...(opts.headers ?? {}), ...(opts.draftToken ? { 'X-Application-Token': opts.draftToken } : {}) },
    });

  /** Notices land asynchronously (fire-and-forget after the change). */
  const noticesFor = async (userId: string, match: RegExp, wantAtLeast = 1) => {
    for (let i = 0; i < 40; i++) {
      const rows = await col('notifications').find({ userId: oid(userId), 'data.type': 'subscription' }).toArray();
      const hits = rows.filter((r: any) => match.test(String(r.title)));
      if (hits.length >= wantAtLeast) return hits;
      await sleep(100);
    }
    return (await col('notifications').find({ userId: oid(userId), 'data.type': 'subscription' }).toArray()).filter((r: any) => match.test(String(r.title)));
  };

  try {
    console.log(`\nSUBSCRIPTION ADMIN — platform runtime, TENANT_ENFORCEMENT=${mode} (db: ${app.dbName})`);

    c.section('fixtures');
    const [owner, billing, support] = await unscoped(() =>
      Promise.all([
        PlatformUser.create({ name: 'SA Owner', email: `${RUN}-owner@platform.test`, password: PASSWORD, role: 'owner' }),
        PlatformUser.create({ name: 'SA Billing', email: `${RUN}-billing@platform.test`, password: PASSWORD, role: 'billing' }),
        PlatformUser.create({ name: 'SA Support', email: `${RUN}-support@platform.test`, password: PASSWORD, role: 'support' }),
      ]),
    );
    const OWNER = signPlatformToken({ id: String(owner._id), role: 'owner', tokenVersion: 0 });
    const BILLING = signPlatformToken({ id: String(billing._id), role: 'billing', tokenVersion: 0 });
    const SUPPORT = signPlatformToken({ id: String(support._id), role: 'support', tokenVersion: 0 });
    const seeded = await call('POST', '/api/platform/plans/seed-defaults', { token: BILLING });
    c.check('the default catalogue is seeded', seeded.status === 200 && seeded.json?.created?.length === 4, brief(seeded));

    // ── The public catalogue ──────────────────────────────────────────────
    c.section('the public plan catalogue');
    const pub = await call('GET', '/api/public/plans');
    const keys = (pub.json?.plans ?? []).map((p: any) => p.key);
    c.check('readable with no account, in order: starter, growth, professional, enterprise',
      pub.status === 200 && JSON.stringify(keys) === '["starter","growth","professional","enterprise"]', brief(pub));
    const starter = pub.json?.plans?.[0];
    c.check('Starter: ₹999/month, 100 students, a 14-day self-serve trial',
      starter?.price?.monthly === 999 && starter.limits?.students === 100 && starter.trialDays === 14 && starter.selfServe === true, JSON.stringify(starter));
    const enterprise = pub.json?.plans?.[3];
    c.check('Enterprise: custom pricing, no price shown, not self-serve',
      enterprise?.customPricing === true && enterprise.price?.monthly === undefined && enterprise.selfServe === false, JSON.stringify(enterprise));
    c.check('modules carry names, not only keys', typeof starter?.modules?.[0]?.name === 'string' && starter.modules[0].name.length > 0);
    c.check('nothing internal leaks (no subscriber counts, ids or versions history)', !/subscribers|_id|createdBy/.test(pub.raw), pub.raw.slice(0, 200));
    await call('PUT', '/api/platform/plans', { token: BILLING, body: { key: 'growth', name: 'Growth', isPublic: false } });
    const unlisted = await call('GET', '/api/public/plans');
    c.check('an unlisted plan is not offered', !(unlisted.json?.plans ?? []).some((p: any) => p.key === 'growth'));
    await call('PUT', '/api/platform/plans', { token: BILLING, body: { key: 'growth', name: 'Growth', isPublic: true } });
    await call('POST', '/api/platform/plans/professional/active', { token: BILLING, body: { active: false } });
    const offSale = await call('GET', '/api/public/plans');
    c.check('a plan off sale is not offered', !(offSale.json?.plans ?? []).some((p: any) => p.key === 'professional'));
    await call('POST', '/api/platform/plans/professional/active', { token: BILLING, body: { active: true } });

    // ── Applications: the preference is validated ─────────────────────────
    c.section('a plan preference on an application');
    const startDraft = async (tag: string) => {
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
      return { id: r.json.draft.id as string, token: r.json.draftToken as string };
    };
    const prefer = (d: { id: string; token: string }, planPreference: unknown) =>
      call('PATCH', `/api/public/organization-applications/${d.id}`, { draftToken: d.token, body: { application: { commercial: { billingEmail: 'x@example.test', planPreference } } } });

    const dA = await startDraft('a');
    const typo = await prefer(dA, 'platinum');
    c.check('a plan that does not exist is refused (400, field commercial.planPreference)',
      typo.status === 400 && Boolean(typo.json?.fields?.['commercial.planPreference']), brief(typo));
    const cased = await prefer(dA, 'Growth');
    c.check('a real plan is stored as its key ("Growth" → "growth")',
      cased.status === 200 && cased.json?.draft?.application?.commercial?.planPreference === 'growth', brief(cased));
    const dCleared = await startDraft('cleared');
    await prefer(dCleared, 'starter');
    const cleared = await prefer(dCleared, '');
    c.check('an empty preference clears it', cleared.status === 200 && cleared.json?.draft?.application?.commercial?.planPreference === undefined, brief(cleared));
    await call('POST', '/api/platform/plans/professional/active', { token: BILLING, body: { active: false } });
    const dOff = await startDraft('offsale');
    const offPref = await prefer(dOff, 'professional');
    c.check('a plan off sale cannot be chosen', offPref.status === 400, brief(offPref));
    await call('POST', '/api/platform/plans/professional/active', { token: BILLING, body: { active: true } });

    // ── Approval: what the preference does ────────────────────────────────
    c.section('approval');
    const approve = (id: string, tag: string, body: Record<string, unknown> = {}) =>
      call('POST', `/api/platform/registrations/${id}/approve`, {
        token: OWNER,
        body: {
          slug: `${RUN}-${tag}`.toLowerCase(),
          admin: { name: `${tag} Admin`, email: `${RUN}-${tag}-admin@example.test`.toLowerCase(), password: PASSWORD },
          ...body,
        },
      });

    const supportApprove = await call('POST', `/api/platform/registrations/${dA.id}/approve`, { token: SUPPORT, body: {} });
    c.check('support cannot approve (and so cannot start a trial)', supportApprove.status === 403, brief(supportApprove));

    const apA = await approve(dA.id, 'a');
    const A = apA.json?.onboarding?.orgId as string;
    const subA = A ? await col('subscriptions').findOne({ orgId: oid(A) }) : null;
    c.check('a self-serve preference (Growth) starts a trial on Growth at approval',
      (apA.status === 200 || apA.status === 207) && apA.json?.plan?.applied === true && subA?.planKey === 'growth' && subA?.status === 'trialing', `${brief(apA)} sub=${JSON.stringify(subA)}`);
    c.check('...for the plan\'s 14 days, managed by the lifecycle',
      Boolean(subA?.managedSince) && Math.abs(new Date(subA?.trialEndsAt).getTime() - Date.now() - 14 * DAY) < 60_000, JSON.stringify(subA?.trialEndsAt));
    c.check('...and says so', /Growth trial started/.test(String(apA.json?.plan?.note)), String(apA.json?.plan?.note));

    // A retry after staff changed the plan must not move it back.
    const toPro = await call('POST', `/api/platform/orgs/${A}/subscription/plan`, { token: OWNER, body: { planKey: 'professional', reason: 'Agreed on the call' } });
    c.check('staff move A to Professional', toPro.status === 200 && toPro.json?.subscription?.planKey === 'professional', brief(toPro));
    const retryA = await approve(dA.id, 'a');
    const subA2 = await col('subscriptions').findOne({ orgId: oid(A) });
    c.check('a retried approval leaves the plan staff chose (Professional), not the preference',
      subA2?.planKey === 'professional' && retryA.json?.plan?.applied === false && /already has a subscription/.test(String(retryA.json?.plan?.note)), `${brief(retryA)} plan=${subA2?.planKey}`);
    c.check('...and the trial clock was not restarted', new Date(subA2?.trialEndsAt).getTime() === new Date(subA?.trialEndsAt).getTime());
    c.check('one subscription for A, however many approvals', (await col('subscriptions').countDocuments({ orgId: oid(A) })) === 1);

    const dE = await startDraft('e');
    await prefer(dE, 'enterprise');
    const apE = await approve(dE.id, 'e');
    const E = apE.json?.onboarding?.orgId as string;
    const subE = E ? await col('subscriptions').findOne({ orgId: oid(E) }) : null;
    c.check('Enterprise (custom pricing) starts no trial: terms are agreed first',
      Boolean(E) && apE.json?.plan?.applied === false && !subE && /agreed with the platform team/.test(String(apE.json?.plan?.note)), `${brief(apE)} sub=${JSON.stringify(subE)}`);
    const entE = await call('GET', `/api/platform/orgs/${E}/subscription`, { token: SUPPORT });
    c.check('...so the new organization has core modules only until staff act',
      entE.status === 200 && entE.json?.subscription === null && entE.json?.organization?.subscriptionRequired === true && entE.json?.entitlement?.modules?.length > 0 &&
        !(entE.json?.entitlement?.modules ?? []).includes('exams'), JSON.stringify(entE.json?.entitlement?.modules));

    const dS = await startDraft('s');
    await prefer(dS, 'starter');
    const apS = await approve(dS.id, 's', { subscription: { planKey: 'growth' } });
    const S = apS.json?.onboarding?.orgId as string;
    const subS = S ? await col('subscriptions').findOne({ orgId: oid(S) }) : null;
    c.check('a reviewer\'s plan wins over the preference (Starter asked, Growth given)',
      subS?.planKey === 'growth' && apS.json?.plan?.applied === false && /reviewer chose/.test(String(apS.json?.plan?.note)), `${brief(apS)} plan=${subS?.planKey}`);

    const dW = await startDraft('w');
    await prefer(dW, 'starter');
    await call('POST', '/api/platform/plans/starter/active', { token: BILLING, body: { active: false } });
    const apW = await approve(dW.id, 'w');
    const W = apW.json?.onboarding?.orgId as string;
    c.check('a preference for a plan taken off sale since is not honoured',
      apW.json?.plan?.applied === false && /no longer offered/.test(String(apW.json?.plan?.note)) && !(await col('subscriptions').findOne({ orgId: oid(W) })), brief(apW));
    await call('POST', '/api/platform/plans/starter/active', { token: BILLING, body: { active: true } });
    clearHostResolutionCache?.();

    const login = async (tag: string, orgId: string) => {
      const r = await call('POST', '/api/auth/login', { body: { email: `${RUN}-${tag}-admin@example.test`.toLowerCase(), password: PASSWORD }, headers: { 'X-Org-Id': orgId } });
      if (!r.json?.token) throw new Error(`login ${tag}: ${brief(r)}`);
      const user = await col('users').findOne({ email: `${RUN}-${tag}-admin@example.test`.toLowerCase() });
      return { token: r.json.token as string, userId: String(user?._id) };
    };
    const adminA = await login('a', A);
    const adminS = await login('s', S);

    // ── The org-admin catalogue ───────────────────────────────────────────
    c.section('the organization admin\'s plans');
    const noAuth = await call('GET', '/api/org-admin/plans');
    c.check('needs a session', noAuth.status === 401 || noAuth.status === 403, brief(noAuth));
    const mine = await call('GET', '/api/org-admin/plans', { token: adminA.token });
    const current = (mine.json?.plans ?? []).filter((p: any) => p.current).map((p: any) => p.key);
    c.check('lists the offered plans, marking A\'s own (Professional) as current',
      mine.status === 200 && JSON.stringify(current) === '["professional"]' && mine.json?.current?.name === 'Professional', brief(mine));
    c.check('...with the server\'s limit keys', Boolean(mine.json?.limitKeys?.students?.enforced));
    const sPlans = await call('GET', '/api/org-admin/plans', { token: adminS.token });
    c.check('S sees its own plan (Growth), not A\'s', (sPlans.json?.plans ?? []).find((p: any) => p.current)?.key === 'growth');
    const writeBack = await call('POST', '/api/org-admin/plans', { token: adminA.token, body: { planKey: 'enterprise' } });
    c.check('there is no way to set one\'s own plan from here', writeBack.status === 404 || writeBack.status === 405, brief(writeBack));

    // ── Notices ───────────────────────────────────────────────────────────
    c.section('notices to the organization\'s administrators');
    const ext = await call('POST', `/api/platform/orgs/${A}/subscription/trial`, { token: OWNER, body: { days: 3, reason: 'Wants more time to evaluate' } });
    c.check('staff extend A\'s trial', ext.status === 200 && ext.json?.subscription?.status === 'trialing', brief(ext));
    const extNotice = await noticesFor(adminA.userId, /trial has been extended/);
    c.check('A\'s admin is told the trial was extended (type general, tagged subscription, event named)',
      extNotice.length === 1 && extNotice[0].type === 'general' && extNotice[0].data?.event === 'extend_trial' && !extNotice[0].data?.screen, JSON.stringify(extNotice[0] ?? null));
    c.check('...in A\'s own tenant', String(extNotice[0]?.orgId) === A);
    c.check('...and S\'s admin is not', (await col('notifications').countDocuments({ userId: oid(adminS.userId), title: /extended/ })) === 0);

    const draftInv = await call('POST', `/api/platform/orgs/${A}/invoices`, { token: BILLING, body: { fromSubscription: true } });
    const issued = await call('POST', `/api/platform/invoices/${draftInv.json?.invoice?.id}/issue`, { token: BILLING });
    c.check('an invoice is issued to A', issued.status === 200 && Boolean(issued.json?.invoice?.number), brief(issued));
    const invNotice = await noticesFor(adminA.userId, /New invoice/);
    c.check('A\'s admin is told about the new invoice, with its number', invNotice.length === 1 && invNotice[0].title.includes(issued.json?.invoice?.number), JSON.stringify(invNotice[0] ?? null));

    const asked = await call('POST', '/api/org-admin/subscription/requests', { token: adminA.token, body: { kind: 'renewal', message: 'Please renew annually' } });
    c.check('A asks for a renewal', asked.status === 201, brief(asked));
    const dash1 = await call('GET', '/api/platform/dashboard', { token: SUPPORT });
    const resolved = await call('POST', `/api/platform/subscription-requests/${asked.json?.request?._id}/resolve`, { token: OWNER, body: { status: 'resolved', note: 'Annual invoice sent' } });
    c.check('staff resolve it', resolved.status === 200, brief(resolved));
    const reqNotice = await noticesFor(adminA.userId, /renewal request was handled/);
    c.check('A\'s admin is told, with the note', reqNotice.length === 1 && /Annual invoice sent/.test(String(reqNotice[0].message)), JSON.stringify(reqNotice[0] ?? null));

    // "Trial ends soon" — once per trial end.
    const subNow = await col('subscriptions').findOne({ orgId: oid(A) });
    const at = new Date(new Date(subNow?.trialEndsAt).getTime() - 2 * DAY);
    const first = await unscoped(() => remindTrialsEnding(at));
    const firstNotice = await noticesFor(adminA.userId, /Your trial ends in/);
    const second = await unscoped(() => remindTrialsEnding(at));
    c.check('the "trial ends in N days" reminder is sent once', first >= 1 && second === 0 && firstNotice.length === 1, `first=${first} second=${second} notices=${firstNotice.length}`);
    c.check('...saying how many days', /ends in 2 days/.test(String(firstNotice[0]?.title)), String(firstNotice[0]?.title));
    await call('POST', `/api/platform/orgs/${A}/subscription/trial`, { token: OWNER, body: { days: 2, reason: 'One more extension' } });
    const subExt = await col('subscriptions').findOne({ orgId: oid(A) });
    const third = await unscoped(() => remindTrialsEnding(new Date(new Date(subExt?.trialEndsAt).getTime() - 2 * DAY)));
    c.check('a new trial end gets one new reminder', third >= 1 && (await noticesFor(adminA.userId, /Your trial ends in/, 2)).length === 2, `third=${third}`);

    const susp = await call('POST', `/api/platform/orgs/${S}/subscription/transition`, { token: OWNER, body: { event: 'suspend', reason: 'Testing notices' } });
    c.check('staff suspend S', susp.status === 200 && susp.json?.subscription?.status === 'suspended', brief(susp));
    c.check('S\'s admin is told it is on hold and read-only', (await noticesFor(adminS.userId, /on hold/)).length === 1);
    const sBilling = await call('PUT', '/api/org-admin/billing/details', { token: adminS.token, body: { legalName: 'S Classes' } });
    const sRequest = await call('POST', '/api/org-admin/subscription/requests', { token: adminS.token, body: { kind: 'renewal' } });
    c.check('while read-only, S can still keep billing details and ask to renew', sBilling.status === 200 && sRequest.status === 201, `${brief(sBilling)} | ${brief(sRequest)}`);
    const sWrite = await call('PUT', '/api/org-admin/profile', { token: adminS.token, body: { profile: { city: 'Nowhere' } } });
    c.check('...but nothing else (423 SUBSCRIPTION_READ_ONLY)', sWrite.status === 423 && sWrite.json?.code === 'SUBSCRIPTION_READ_ONLY', brief(sWrite));

    // ── The console: dashboard counts and the over-limit list ─────────────
    c.section('the console\'s billing overview');
    const shortTrial = await call('POST', `/api/platform/orgs/${E}/subscription/trial`, {
      token: OWNER, body: { days: 3, planKey: 'professional', reason: 'Enterprise evaluation on Professional terms' },
    });
    c.check('staff start a 3-day trial for E', shortTrial.status === 200 && shortTrial.json?.subscription?.status === 'trialing', brief(shortTrial));
    const dash = await call('GET', '/api/platform/dashboard', { token: SUPPORT });
    const b = dash.json?.summary?.billing;
    c.check('the dashboard reports billing counts', dash.status === 200 && typeof b?.overdueInvoices === 'number' && typeof b.openInvoices === 'number' && typeof b.openRequests === 'number' && typeof b.dueWithinWeek === 'number', brief(dash));
    c.check('...one unpaid invoice (A\'s), none overdue yet', b?.openInvoices === 1 && b.overdueInvoices === 0, JSON.stringify(b));
    c.check('...open requests counted (A\'s, before it was resolved; S\'s now)', dash1.json?.summary?.billing?.openRequests === 1 && b?.openRequests === 1, `${JSON.stringify(dash1.json?.summary?.billing)} ${JSON.stringify(b)}`);
    c.check('...E\'s trial, ending within the week, is due (A\'s, weeks away, is not)', b?.dueWithinWeek === 1, JSON.stringify(b));
    await col('invoices').updateOne({ _id: oid(issued.json.invoice.id) }, { $set: { dueAt: new Date(Date.now() - DAY) } });
    c.check('an issued invoice past its due date is counted overdue', (await call('GET', '/api/platform/dashboard', { token: SUPPORT })).json?.summary?.billing?.overdueInvoices === 1);
    const tenantDash = await call('GET', '/api/platform/dashboard', { token: adminA.token });
    c.check('an organization admin cannot read the console dashboard', tenantDash.status === 401 || tenantDash.status === 403, brief(tenantDash));

    // Over a limit: S's Growth allows 500 students; an override of 1 with two
    // students puts it over (as a downgrade would).
    const override = await call('PUT', `/api/platform/orgs/${S}/subscription`, { token: OWNER, body: { overrides: { limits: { students: 1 } } } });
    c.check('staff set S\'s student limit to 1', override.status === 200, brief(override));
    await col('users').insertMany([1, 2].map((i) => ({
      name: `S Student ${i}`, email: `${RUN}-s-student-${i}@example.test`, role: 'student', status: 'approved', orgId: S,
      createdAt: new Date(), updatedAt: new Date(),
    })));
    const over = await call('GET', '/api/platform/subscriptions?overLimit=true', { token: SUPPORT });
    const overOrgs = (over.json?.items ?? []).map((r: any) => String(r.orgId));
    c.check('the over-limit list names S, and only S',
      over.status === 200 && JSON.stringify(overOrgs) === JSON.stringify([S]) && JSON.stringify(over.json.items[0].overLimits) === '["students"]', brief(over));
    c.check('...with its usage (2 of 1)', over.json?.items?.[0]?.usage?.students?.used === 2 && over.json.items[0].usage.students.limit === 1);
    const withUsage = await call('GET', '/api/platform/subscriptions?withUsage=true', { token: SUPPORT });
    c.check('the full list can carry usage too', (withUsage.json?.items ?? []).length >= 2 && (withUsage.json.items as any[]).every((r) => 'usage' in r));
    const sUsers = await col('users').countDocuments({ orgId: orgForms(S), role: 'student' });
    c.check('being over a limit removed nobody', sUsers === 2);
    const due = await call('GET', '/api/platform/subscriptions?dueWithinDays=7', { token: SUPPORT });
    const dueOrgs = (due.json?.items ?? []).map((r: any) => String(r.orgId));
    c.check('the "due within 7 days" list is E alone', JSON.stringify(dueOrgs) === JSON.stringify([E]), brief(due));
  } finally {
    try {
      clearOrgStateCache?.();
      const name = mongoose.connection.db.databaseName;
      if (/^iso_[a-z0-9_]*_scratch_subadmin$/.test(name)) await mongoose.connection.db.dropDatabase();
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
