/**
 * Invoices, billing details, subscription requests and the payment-provider
 * seam, end to end, through the real app on an isolated database.
 *
 * Organizations: A (Starter trial, billed from Maharashtra), B (Growth trial,
 * billed from Gujarat — the same state as the seller once GST is configured),
 * N (no billing state), OWNED (platform-owned).
 *
 * The provider section registers a TEST-ONLY provider ("testpay", HMAC-signed)
 * in this process to prove signature checks, replay protection, idempotency and
 * reconciliation. No such provider exists in the application.
 *
 * Loopback MongoDB only, on a database this suite owns and drops at the end:
 *   SCRATCH_DB_NAME=iso_platform_scratch_billing SCRATCH_ALLOW_NEW_DB=true \
 *   E2E_TENANT_ENFORCEMENT=warn|enforce \
 *     npx ts-node --transpile-only scripts/safety/invoices.e2e.test.ts
 */

import crypto from 'crypto';
import { Checks, bootScratchApp, request, type Res } from './e2eHarness';

const c = new Checks();
const brief = (r: Res) => `${r.status} ${r.raw.slice(0, 260)}`;
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
  if (!/^iso_[a-z0-9_]*_scratch_billing$/.test(explicit)) {
    throw new Error('Set SCRATCH_DB_NAME to an iso_*_scratch_billing database: this suite drops it when it finishes.');
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
  const User = require('../../src/models/User').default;
  const provider = require('../../src/core/billing/provider');
  const { clearHostResolutionCache } = require('../../src/core/tenancy/hostResolution');
  const { clearOrgStateCache } = require('../../src/core/tenancy/orgState');
  /* eslint-enable @typescript-eslint/no-var-requires */
  const unscoped = <T>(fn: () => Promise<T>) => withoutTenantScope('e2e:billing', fn) as Promise<T>;
  const oid = (id: string) => new mongoose.Types.ObjectId(id);

  const RUN = `zz-bill-${Date.now().toString(36)}`;
  const PASSWORD = `Bill-${process.pid}-Pass!`;
  const call = (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    request(app.port, method, path, opts);

  try {
    console.log(`\nINVOICES — platform runtime, TENANT_ENFORCEMENT=${mode} (db: ${app.dbName})`);

    c.section('fixtures');
    const [owner, billing, support] = await unscoped(() =>
      Promise.all([
        PlatformUser.create({ name: 'B Owner', email: `${RUN}-owner@platform.test`, password: PASSWORD, role: 'owner' }),
        PlatformUser.create({ name: 'B Billing', email: `${RUN}-billing@platform.test`, password: PASSWORD, role: 'billing' }),
        PlatformUser.create({ name: 'B Support', email: `${RUN}-support@platform.test`, password: PASSWORD, role: 'support' }),
      ]),
    );
    const OWNER = signPlatformToken({ id: String(owner._id), role: 'owner', tokenVersion: 0 });
    const BILLING = signPlatformToken({ id: String(billing._id), role: 'billing', tokenVersion: 0 });
    const SUPPORT = signPlatformToken({ id: String(support._id), role: 'support', tokenVersion: 0 });
    await call('POST', '/api/platform/plans/seed-defaults', { token: BILLING });
    const onboard = async (key: string, planKey?: string) => {
      const r = await call('POST', '/api/platform/orgs/onboard', {
        token: OWNER,
        body: {
          organization: { name: `${RUN} ${key}`, slug: `${RUN}-${key}`.toLowerCase() },
          admin: { name: `${key} Admin`, email: `${RUN}-${key}-admin@example.test`.toLowerCase(), password: PASSWORD },
          ...(planKey ? { subscription: { planKey } } : {}),
        },
      });
      if (!r.json?.orgId) throw new Error(`onboard ${key}: ${brief(r)}`);
      return r.json.orgId as string;
    };
    const A = await onboard('a', 'starter');
    const B = await onboard('b', 'growth');
    const N = await onboard('n', 'starter');
    const OWNED = String(new mongoose.Types.ObjectId());
    await col('orgs').insertOne({ _id: oid(OWNED), name: `${RUN} owned`, slug: `${RUN}-owned`, status: 'active', isPlatformOwned: true, createdAt: new Date(), updatedAt: new Date() });
    clearHostResolutionCache?.();
    const login = async (who: string, orgId: string) => {
      const r = await call('POST', '/api/auth/login', { body: { email: `${RUN}-${who}-admin@example.test`, password: PASSWORD }, headers: { 'X-Org-Id': orgId } });
      if (!r.json?.token) throw new Error(`login ${who}: ${brief(r)}`);
      return r.json.token as string;
    };
    const adminA = await login('a', A);
    const adminB = await login('b', B);
    c.check('fixtures: staff, three organizations on trials and a platform-owned one', true);

    // ── The seller profile ────────────────────────────────────────────────
    c.section('the platform billing profile');
    const empty = await call('GET', '/api/platform/billing/profile', { token: SUPPORT });
    c.check('empty by default: no GST, and it says what is missing', empty.status === 200 && empty.json?.gst?.gst === false && empty.json.gst.missing.includes('GSTIN'), brief(empty));
    c.check('...only the manual provider is registered', JSON.stringify(empty.json?.providers?.map((p: any) => p.key)) === '["manual"]');
    c.check('support cannot edit it', (await call('PUT', '/api/platform/billing/profile', { token: SUPPORT, body: { legalName: 'x' } })).status === 403);
    const badGstin = await call('PUT', '/api/platform/billing/profile', { token: BILLING, body: { gstin: '24AAACC1206D1ZX' } });
    c.check('a GSTIN with the wrong check character is refused (400, field gstin)', badGstin.status === 400 && badGstin.json?.field === 'gstin', brief(badGstin));
    const mismatch = await call('PUT', '/api/platform/billing/profile', { token: BILLING, body: { gstin: '24AAACC1206D1ZM', stateCode: '27' } });
    c.check('a GSTIN from another state than the profile\'s is refused', mismatch.status === 400, brief(mismatch));
    const basic = await call('PUT', '/api/platform/billing/profile', {
      token: BILLING,
      body: { legalName: 'Test Platform Pvt Ltd', address: '1 Test Road', city: 'Ahmedabad', pincode: '380001', stateCode: '24', email: 'billing@platform.test', paymentInstructions: 'Bank transfer to the account on file.' },
    });
    c.check('billing sets the legal name and address, without GST yet', basic.status === 200 && basic.json?.gst?.gst === false, brief(basic));

    // ── Buyer details ─────────────────────────────────────────────────────
    c.section('the organization\'s billing details');
    const badBuyer = await call('PUT', '/api/org-admin/billing/details', { token: adminA, body: { gstin: '27AAPFU0939F1ZX' } });
    c.check('an organization admin\'s bad GSTIN is refused', badBuyer.status === 400 && badBuyer.json?.code === 'BILLING_INVALID', brief(badBuyer));
    const buyerA = await call('PUT', '/api/org-admin/billing/details', { token: adminA, body: { legalName: 'A Coaching LLP', gstin: '27AAPFU0939F1ZV', address: 'Pune' } });
    c.check('A sets its own GSTIN; the state (27, Maharashtra) is taken from it', buyerA.status === 200 && buyerA.json?.billing?.stateCode === '27', brief(buyerA));
    await call('PUT', `/api/platform/orgs/${B}/billing-details`, { token: BILLING, body: { legalName: 'B Classes', stateCode: '24' } });
    c.check('staff set B\'s billing state (24, Gujarat — the seller\'s state)', (await call('GET', `/api/platform/orgs/${B}/billing-details`, { token: SUPPORT })).json?.billing?.stateCode === '24');
    const bReadsA = await call('GET', '/api/org-admin/billing/details', { token: adminB, headers: { 'X-Org-Id': A } });
    c.check('B cannot read A\'s billing details by naming A', bReadsA.status >= 400 && !JSON.stringify(bReadsA.json ?? {}).includes('A Coaching'), brief(bReadsA));

    // ── Drafts ────────────────────────────────────────────────────────────
    c.section('drafts');
    const tenantDraft = await call('POST', `/api/platform/orgs/${A}/invoices`, { token: adminA, body: { fromSubscription: true } });
    c.check('an organization cannot invoice itself (tenant token refused)', tenantDraft.status === 401 || tenantDraft.status === 403);
    c.check('support cannot draft invoices', (await call('POST', `/api/platform/orgs/${A}/invoices`, { token: SUPPORT, body: { fromSubscription: true } })).status === 403);
    const draft = await call('POST', `/api/platform/orgs/${A}/invoices`, { token: BILLING, body: { fromSubscription: true } });
    const subA = await col('subscriptions').findOne({ orgId: oid(A) });
    c.check('a draft from the subscription bills Starter, ₹999, for the month after the trial',
      draft.status === 201 && draft.json?.invoice?.status === 'draft' && draft.json.invoice.totalMinor === 99900 && /Starter plan, monthly/.test(draft.json.invoice.lines?.[0]?.description) &&
        new Date(draft.json.invoice.periodStart).getTime() === new Date(subA?.trialEndsAt).getTime(), brief(draft));
    c.check('...with no number yet', !draft.json?.invoice?.number);
    const draftId = draft.json.invoice.id;
    const edited = await call('PATCH', `/api/platform/invoices/${draftId}`, { token: BILLING, body: { lines: [{ description: 'Starter plan, monthly', unitPrice: 999 }, { description: 'Onboarding session', quantity: 2, unitPrice: 500 }] } });
    c.check('a draft can be edited, and totals follow (₹999 + 2 × ₹500)', edited.status === 200 && edited.json?.invoice?.totalMinor === 199900, brief(edited));
    const badLine = await call('PATCH', `/api/platform/invoices/${draftId}`, { token: BILLING, body: { lines: [{ description: '', unitPrice: 5 }] } });
    c.check('a line without a description is refused', badLine.status === 400);
    const scratch = await call('POST', `/api/platform/orgs/${A}/invoices`, { token: BILLING, body: { lines: [{ description: 'Scrap', unitPrice: 1 }] } });
    c.check('a draft can be deleted', (await call('DELETE', `/api/platform/invoices/${scratch.json?.invoice?.id}`, { token: BILLING })).status === 200);
    const owned = await call('POST', `/api/platform/orgs/${OWNED}/invoices`, { token: BILLING, body: { lines: [{ description: 'x', unitPrice: 1 }] } });
    c.check('a platform-owned organization is never invoiced (409 PLATFORM_OWNED)', owned.status === 409 && owned.json?.code === 'PLATFORM_OWNED', brief(owned));

    // ── Issue without GST ─────────────────────────────────────────────────
    c.section('issuing without GST');
    const issued = await call('POST', `/api/platform/invoices/${draftId}/issue`, { token: BILLING });
    const inv1 = issued.json?.invoice;
    c.check('issued as INV/26-27/0001 (Indian financial year)', issued.status === 200 && inv1?.status === 'issued' && inv1.number === 'INV/26-27/0001', brief(issued));
    c.check('...not a tax invoice: no GST without a seller GSTIN and rate', inv1?.taxInvoice === false && inv1.tax?.regime === 'none' && inv1.totalMinor === 199900);
    c.check('...seller and buyer copied onto it', inv1?.seller?.legalName === 'Test Platform Pvt Ltd' && inv1.buyer?.legalName === 'A Coaching LLP' && inv1.buyer?.gstin === '27AAPFU0939F1ZV');
    c.check('...due in the profile\'s 7 days', Math.abs(new Date(inv1?.dueAt).getTime() - new Date(inv1?.issuedAt).getTime() - 7 * DAY) < 1000);
    c.check('an issued invoice cannot be edited', (await call('PATCH', `/api/platform/invoices/${draftId}`, { token: BILLING, body: { notes: 'x' } })).json?.code === 'INVOICE_NOT_DRAFT');
    c.check('...or deleted', (await call('DELETE', `/api/platform/invoices/${draftId}`, { token: BILLING })).json?.code === 'INVOICE_NOT_DRAFT');
    const doc = await call('GET', `/api/platform/invoices/${draftId}/document`, { token: SUPPORT });
    c.check('its document says it is not a tax invoice, and is served inert (CSP default-src none)',
      doc.status === 200 && /not a GST tax invoice/.test(doc.raw) && /INV\/26-27\/0001/.test(doc.raw), doc.raw.slice(0, 200));
    const headers = await new Promise<Record<string, unknown>>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const http = require('http');
      http.get({ host: '127.0.0.1', port: app.port, path: `/api/platform/invoices/${draftId}/document`, headers: { Authorization: `Bearer ${SUPPORT}` } }, (r: any) => { r.resume(); resolve(r.headers); }).on('error', reject);
    });
    c.check('...with Content-Security-Policy default-src \'none\'', /default-src 'none'/.test(String(headers['content-security-policy'])), String(headers['content-security-policy']));
    await call('PUT', '/api/platform/billing/profile', { token: BILLING, body: { legalName: 'Renamed Platform Pvt Ltd' } });
    c.check('editing the profile later does not rewrite an issued invoice', (await call('GET', `/api/platform/invoices/${draftId}`, { token: SUPPORT })).json?.invoice?.seller?.legalName === 'Test Platform Pvt Ltd');

    c.section('numbering under concurrency');
    const drafts = await Promise.all([1, 2, 3, 4, 5].map((i) => call('POST', `/api/platform/orgs/${A}/invoices`, { token: BILLING, body: { lines: [{ description: `Item ${i}`, unitPrice: 10 * i }] } })));
    const issuedAll = await Promise.all(drafts.map((d) => call('POST', `/api/platform/invoices/${d.json.invoice.id}/issue`, { token: BILLING })));
    const numbers = issuedAll.map((r) => r.json?.invoice?.number).sort();
    c.check('five simultaneous issues get five consecutive numbers, none repeated',
      JSON.stringify(numbers) === JSON.stringify(['INV/26-27/0002', 'INV/26-27/0003', 'INV/26-27/0004', 'INV/26-27/0005', 'INV/26-27/0006']), numbers.join(','));
    const twice = await call('POST', `/api/platform/orgs/${A}/invoices`, { token: BILLING, body: { lines: [{ description: 'Once', unitPrice: 5 }] } });
    const race = await Promise.all([0, 1].map(() => call('POST', `/api/platform/invoices/${twice.json.invoice.id}/issue`, { token: BILLING })));
    c.check('one draft issued twice at once: one succeeds, one is refused (409)',
      race.filter((r) => r.status === 200).length === 1 && race.filter((r) => r.status === 409).length === 1, race.map(brief).join(' | '));
    const counter = await col('invoicecounters').findOne({ prefix: 'INV', financialYear: '2026-27' });
    c.check('...and only one number was used for it (counter at 7)', counter?.seq === 7, JSON.stringify(counter));

    // ── GST ───────────────────────────────────────────────────────────────
    c.section('issuing with GST (once the platform supplies it)');
    const gstOn = await call('PUT', '/api/platform/billing/profile', { token: BILLING, body: { gstin: '24AAACC1206D1ZM', pan: 'AAACC1206D', gstRatePercent: 18, sacCode: '998431' } });
    c.check('with a GSTIN, state, rate and SAC the profile reports GST on', gstOn.status === 200 && gstOn.json?.gst?.gst === true && gstOn.json.gst.missing.length === 0, brief(gstOn));
    const aGst = await call('POST', `/api/platform/orgs/${A}/invoices`, { token: BILLING, body: { fromSubscription: true } });
    const aIssued = (await call('POST', `/api/platform/invoices/${aGst.json.invoice.id}/issue`, { token: BILLING })).json?.invoice;
    c.check('A (Maharashtra) from a Gujarat seller: IGST 18% = ₹179.82, total ₹1,178.82',
      aIssued?.taxInvoice === true && aIssued.tax.igstMinor === 17982 && aIssued.tax.cgstMinor === 0 && aIssued.totalMinor === 117882 && aIssued.tax.placeOfSupply === '27', JSON.stringify(aIssued?.tax));
    c.check('...the SAC code is on the line', aIssued?.lines?.[0]?.sacCode === '998431');
    const bGst = await call('POST', `/api/platform/orgs/${B}/invoices`, { token: BILLING, body: { fromSubscription: true } });
    const bIssued = (await call('POST', `/api/platform/invoices/${bGst.json.invoice.id}/issue`, { token: BILLING })).json?.invoice;
    c.check('B (Gujarat, same state): CGST 9% + SGST 9% on ₹2,999',
      bIssued?.tax?.cgstMinor === 26991 && bIssued.tax.sgstMinor === 26991 && bIssued.tax.igstMinor === 0 && bIssued.totalMinor === 353882, JSON.stringify(bIssued?.tax));
    const bDoc = await call('GET', `/api/platform/invoices/${bGst.json.invoice.id}/document`, { token: SUPPORT });
    c.check('...its document is a "Tax invoice" with CGST and SGST rows', /Tax invoice/.test(bDoc.raw) && /CGST 9%/.test(bDoc.raw) && /SGST 9%/.test(bDoc.raw));
    const nDraft = await call('POST', `/api/platform/orgs/${N}/invoices`, { token: BILLING, body: { fromSubscription: true } });
    const nIssue = await call('POST', `/api/platform/invoices/${nDraft.json.invoice.id}/issue`, { token: BILLING });
    c.check('an organization without a billing state cannot be issued a GST invoice (400 BILLING_DETAILS_REQUIRED)', nIssue.status === 400 && nIssue.json?.code === 'BILLING_DETAILS_REQUIRED', brief(nIssue));
    c.check('...and no number was taken for it', (await col('invoicecounters').findOne({ prefix: 'INV', financialYear: '2026-27' }))?.seq === 9);

    // ── Settlement ────────────────────────────────────────────────────────
    c.section('settling an invoice');
    const aInvId = aGst.json.invoice.id;
    const short = await call('POST', `/api/platform/invoices/${aInvId}/payments`, { token: BILLING, body: { amount: 999, method: 'upi', reference: `${RUN}-UTR1` } });
    c.check('a payment for less than the balance is refused, naming the amount due', short.status === 400 && short.json?.code === 'PAYMENT_AMOUNT_MISMATCH' && short.json?.expected === 1178.82, brief(short));
    c.check('support cannot record a payment', (await call('POST', `/api/platform/invoices/${aInvId}/payments`, { token: SUPPORT, body: { amount: 1178.82, method: 'upi', reference: `${RUN}-S` } })).status === 403);
    const settled = await call('POST', `/api/platform/invoices/${aInvId}/payments`, { token: BILLING, body: { amount: 1178.82, method: 'upi', reference: `${RUN}-UTR1` } });
    const subAfter = await col('subscriptions').findOne({ orgId: oid(A) });
    c.check('settling in full: the invoice is paid and the payment names it', settled.status === 201 && settled.json?.invoice?.status === 'paid' && String(settled.json?.payment?.invoiceId) === aInvId, brief(settled));
    c.check('...and the subscription is active through the invoice\'s period', subAfter?.status === 'active' && new Date(subAfter.periodEnd).getTime() === new Date(aIssued.periodEnd).getTime(), `${subAfter?.status} ${subAfter?.periodEnd} vs ${aIssued?.periodEnd}`);
    const replay = await call('POST', `/api/platform/invoices/${aInvId}/payments`, { token: BILLING, body: { amount: 1178.82, method: 'upi', reference: `${RUN}-UTR1` } });
    c.check('the same payment again is the same payment (200, duplicate)', replay.status === 200 && replay.json?.duplicate === true, brief(replay));
    const second = await call('POST', `/api/platform/invoices/${aInvId}/payments`, { token: BILLING, body: { amount: 1178.82, method: 'upi', reference: `${RUN}-UTR2` } });
    c.check('a second, different payment for a paid invoice is refused (409 INVOICE_ALREADY_PAID)', second.status === 409 && second.json?.code === 'INVOICE_ALREADY_PAID', brief(second));
    const bInvId = bGst.json.invoice.id;
    const bRace = await Promise.all(['R1', 'R2', 'R3'].map((r) => call('POST', `/api/platform/invoices/${bInvId}/payments`, { token: BILLING, body: { amount: 3538.82, method: 'bank_transfer', reference: `${RUN}-${r}` } })));
    const bPayments = await col('payments').countDocuments({ invoiceId: oid(bInvId), status: 'confirmed' });
    c.check('three different payments for one invoice at once: exactly one settles it', bRace.filter((r) => r.status === 201).length === 1 && bPayments === 1, bRace.map((r) => r.status).join(','));
    const periodsB = await col('subscriptionevents').countDocuments({ orgId: oid(B), type: 'payment_confirmed' });
    c.check('...and the subscription period was extended once', periodsB === 1, String(periodsB));

    c.section('voiding');
    const toVoid = issuedAll[0].json.invoice.id;
    c.check('voiding needs a reason', (await call('POST', `/api/platform/invoices/${toVoid}/void`, { token: BILLING, body: {} })).json?.code === 'REASON_REQUIRED');
    const voided = await call('POST', `/api/platform/invoices/${toVoid}/void`, { token: BILLING, body: { reason: 'Issued in error' } });
    c.check('an unpaid invoice is voided, keeping its number', voided.status === 200 && voided.json?.invoice?.status === 'void' && Boolean(voided.json.invoice.number), brief(voided));
    c.check('a voided invoice cannot be paid (409 INVOICE_VOID)', (await call('POST', `/api/platform/invoices/${toVoid}/payments`, { token: BILLING, body: { amount: 0.1, method: 'cash', reference: `${RUN}-V` } })).json?.code === 'INVOICE_VOID');
    c.check('a paid invoice cannot be voided (409 INVOICE_PAID)', (await call('POST', `/api/platform/invoices/${aInvId}/void`, { token: BILLING, body: { reason: 'Changed my mind' } })).json?.code === 'INVOICE_PAID');
    c.check('a draft is deleted, not voided', (await call('POST', `/api/platform/invoices/${nDraft.json.invoice.id}/void`, { token: BILLING, body: { reason: 'x y z' } })).json?.code === 'INVOICE_NOT_ISSUED');

    c.section('overdue and lists');
    const overdueId = issuedAll[1].json.invoice.id;
    await col('invoices').updateOne({ _id: oid(overdueId) }, { $set: { dueAt: new Date(Date.now() - DAY) } });
    const overdue = await call('GET', '/api/platform/invoices?overdue=true', { token: SUPPORT });
    c.check('an issued invoice past its due date is listed as overdue', overdue.status === 200 && overdue.json?.invoices?.some((i: any) => i.id === overdueId && i.overdue === true), brief(overdue));
    c.check('...and a paid one is not', !overdue.json?.invoices?.some((i: any) => i.id === aInvId));

    // ── The organization's view ───────────────────────────────────────────
    c.section('what an organization sees');
    const own = await call('GET', '/api/org-admin/billing/invoices', { token: adminA });
    c.check('A sees its issued, paid and void invoices — never a draft', own.status === 200 && own.json?.invoices?.length >= 7 && own.json.invoices.every((i: any) => i.status !== 'draft'), brief(own));
    c.check('...and only its own', own.json?.invoices?.every((i: any) => String(i.orgId) === A));
    c.check('A can open its own invoice document', /INV\/26-27/.test((await call('GET', `/api/org-admin/billing/invoices/${aInvId}/document`, { token: adminA })).raw));
    const crossDoc = await call('GET', `/api/org-admin/billing/invoices/${bInvId}/document`, { token: adminA });
    c.check('A cannot open B\'s invoice: 404, as if it did not exist', crossDoc.status === 404 && crossDoc.json?.code === 'INVOICE_NOT_FOUND', brief(crossDoc));
    const aDraft = await call('POST', `/api/platform/orgs/${A}/invoices`, { token: BILLING, body: { lines: [{ description: 'Not sent yet', unitPrice: 1 }] } });
    c.check('A cannot see its own draft (404) until it is issued', (await call('GET', `/api/org-admin/billing/invoices/${aDraft.json?.invoice?.id}`, { token: adminA })).status === 404);
    const pdf = await call('GET', `/api/org-admin/billing/invoices/${aInvId}/document?format=pdf`, { token: adminA });
    c.check('a PDF is produced, or the server says plainly it cannot (503 PDF_UNAVAILABLE)',
      (pdf.status === 200 && pdf.raw.startsWith('%PDF')) || (pdf.status === 503 && pdf.json?.code === 'PDF_UNAVAILABLE'), `${pdf.status} ${pdf.raw.slice(0, 40)}`);
    console.log(`      (PDF: ${pdf.status === 200 ? 'rendered' : 'no Chromium on this host'})`);

    c.section('requests');
    const noPlan = await call('POST', '/api/org-admin/subscription/requests', { token: adminA, body: { kind: 'upgrade' } });
    c.check('an upgrade request must name a plan', noPlan.status === 400 && noPlan.json?.code === 'REQUEST_INVALID', brief(noPlan));
    const asked = await call('POST', '/api/org-admin/subscription/requests', { token: adminA, body: { kind: 'upgrade', planKey: 'professional', message: 'We need AI' } });
    c.check('A asks to upgrade to Professional (201)', asked.status === 201 && asked.json?.request?.status === 'open', brief(asked));
    const askedAgain = await call('POST', '/api/org-admin/subscription/requests', { token: adminA, body: { kind: 'upgrade', planKey: 'professional' } });
    c.check('asking again returns the open request (200, duplicate)', askedAgain.status === 200 && askedAgain.json?.duplicate === true && askedAgain.json.request?._id === asked.json.request._id);
    c.check('...and changes nothing: A is still on Starter', (await col('subscriptions').findOne({ orgId: oid(A) }))?.planKey === 'starter');
    const open = await call('GET', '/api/platform/subscription-requests?status=open', { token: SUPPORT });
    c.check('staff see it, with the organization', open.json?.requests?.some((r: any) => r._id === asked.json.request._id && r.organization?.name === `${RUN} a`));
    c.check('support cannot resolve requests', (await call('POST', `/api/platform/subscription-requests/${asked.json.request._id}/resolve`, { token: SUPPORT, body: { status: 'resolved', note: 'ok ok' } })).status === 403);
    c.check('resolving needs a note', (await call('POST', `/api/platform/subscription-requests/${asked.json.request._id}/resolve`, { token: BILLING, body: { status: 'resolved' } })).json?.code === 'REASON_REQUIRED');
    const resolved = await call('POST', `/api/platform/subscription-requests/${asked.json.request._id}/resolve`, { token: BILLING, body: { status: 'declined', note: 'Discussed on a call; staying on Starter' } });
    c.check('billing resolves it', resolved.status === 200 && resolved.json?.request?.status === 'declined', brief(resolved));
    c.check('...once (409 REQUEST_CLOSED)', (await call('POST', `/api/platform/subscription-requests/${asked.json.request._id}/resolve`, { token: BILLING, body: { status: 'resolved', note: 'again' } })).json?.code === 'REQUEST_CLOSED');
    c.check('A sees its request history', (await call('GET', '/api/org-admin/subscription/requests', { token: adminA })).json?.requests?.[0]?.status === 'declined');

    c.section('billing stays open while read-only');
    await call('POST', `/api/platform/orgs/${N}/subscription/transition`, { token: BILLING, body: { event: 'suspend', reason: 'Testing read-only billing' } });
    clearOrgStateCache?.();
    const adminN = await login('n', N);
    c.check('a suspended organization cannot change its profile (423)', (await call('PATCH', '/api/auth/profile', { token: adminN, body: { name: 'x' } })).status === 423);
    c.check('...but can update its billing details', (await call('PUT', '/api/org-admin/billing/details', { token: adminN, body: { stateCode: '07' } })).status === 200);
    c.check('...read its invoices', (await call('GET', '/api/org-admin/billing/invoices', { token: adminN })).status === 200);
    c.check('...and ask to renew', (await call('POST', '/api/org-admin/subscription/requests', { token: adminN, body: { kind: 'renewal', message: 'Please reactivate' } })).status === 201);

    // ── The provider seam ─────────────────────────────────────────────────
    c.section('the provider seam (test-only provider)');
    const SECRET = crypto.randomBytes(16).toString('hex');
    provider.registerProvider({
      key: 'testpay',
      displayName: 'Test provider (this suite only)',
      supportsWebhooks: true,
      verify(raw: Buffer, h: Record<string, string | undefined>) {
        const [ts, sig] = String(h['x-test-signature'] ?? '').split(',');
        const expected = crypto.createHmac('sha256', SECRET).update(`${ts}.${raw.toString('utf8')}`).digest('hex');
        if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error('bad signature');
        const body = JSON.parse(raw.toString('utf8'));
        return { eventId: body.id, type: body.type, occurredAt: new Date(Number(ts)), invoiceId: body.invoiceId, orgId: body.orgId, reference: body.paymentId, amountMinor: body.amount, method: 'card', failureReason: body.reason };
      },
    });
    const deliver = (body: Record<string, unknown>, opts: { ts?: number; tamper?: boolean } = {}) => {
      const raw = Buffer.from(JSON.stringify(body));
      const ts = String(opts.ts ?? Date.now());
      const sig = crypto.createHmac('sha256', SECRET).update(`${ts}.${raw.toString('utf8')}`).digest('hex');
      return provider.handleProviderWebhook('testpay', opts.tamper ? Buffer.from(JSON.stringify({ ...body, amount: 1 })) : raw, { 'x-test-signature': `${ts},${sig}` });
    };
    const target = issuedAll[2].json.invoice;
    const expectErr = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { code?: string }).code; } };
    c.check('a tampered body fails the signature (SIGNATURE_INVALID) and nothing is stored',
      (await expectErr(deliver({ id: 'evt-1', type: 'payment.succeeded', invoiceId: target.id, paymentId: 'pay-1', amount: target.totalMinor }, { tamper: true }))) === 'SIGNATURE_INVALID' &&
        (await col('providerevents').countDocuments({})) === 0);
    c.check('an event outside the time window is refused as a possible replay (EVENT_STALE)',
      (await expectErr(deliver({ id: 'evt-old', type: 'payment.succeeded', invoiceId: target.id, paymentId: 'pay-old', amount: target.totalMinor }, { ts: Date.now() - 10 * 60 * 1000 }))) === 'EVENT_STALE');
    c.check('an unknown provider, or the manual one (no webhooks), is refused',
      (await expectErr(provider.handleProviderWebhook('nopay', Buffer.from('{}'), {}))) === 'PROVIDER_UNKNOWN' && (await expectErr(provider.handleProviderWebhook('manual', Buffer.from('{}'), {}))) === 'PROVIDER_UNKNOWN');
    const ok1 = await deliver({ id: 'evt-1', type: 'payment.succeeded', invoiceId: target.id, orgId: A, paymentId: 'pay-1', amount: target.totalMinor });
    const paidTarget = await col('invoices').findOne({ _id: oid(target.id) });
    const providerPayment = await col('payments').findOne({ provider: 'testpay', reference: 'pay-1' });
    c.check('a verified payment event settles the invoice through the same path as staff', ok1?.event?.status === 'processed' && paidTarget?.status === 'paid' && Boolean(providerPayment), JSON.stringify(ok1?.event));
    const dup = await deliver({ id: 'evt-1', type: 'payment.succeeded', invoiceId: target.id, orgId: A, paymentId: 'pay-1', amount: target.totalMinor });
    c.check('the same event delivered again is a no-op (one payment)', dup?.duplicate === true && (await col('payments').countDocuments({ provider: 'testpay', reference: 'pay-1' })) === 1);
    const wrong = issuedAll[3].json.invoice;
    const wrongAmt = await deliver({ id: 'evt-2', type: 'payment.succeeded', invoiceId: wrong.id, orgId: A, paymentId: 'pay-2', amount: wrong.totalMinor - 1 });
    c.check('a payment event for the wrong amount is rejected and recorded; the invoice stays unpaid',
      wrongAmt?.event?.status === 'rejected' && (await col('invoices').findOne({ _id: oid(wrong.id) }))?.status === 'issued' && !(await col('payments').findOne({ reference: 'pay-2' })), JSON.stringify(wrongAmt?.event));
    const failed = await deliver({ id: 'evt-3', type: 'payment.failed', orgId: A, paymentId: 'pay-3', amount: 117882, reason: 'Card declined' });
    c.check('a failed-payment event puts an active subscription into grace', failed?.event?.status === 'processed' && (await col('subscriptions').findOne({ orgId: oid(A) }))?.status === 'past_due', JSON.stringify(failed?.event));
    const recon = await provider.reconcileProvider('testpay', [
      { reference: 'pay-1', amountMinor: target.totalMinor },
      { reference: 'pay-x', amountMinor: 500 },
    ], new Date(Date.now() - DAY));
    c.check('reconciliation: pay-1 matches, pay-x is missing here, nothing silently fixed',
      recon.matched === 1 && recon.missingHere.length === 1 && recon.missingHere[0].reference === 'pay-x' && recon.clean === false, JSON.stringify(recon));
    provider.unregisterProvider('testpay');

    c.section('audit');
    const actions = new Set((await col('platformaudits').find({ actorId: { $in: [String(billing._id), billing._id] } }).toArray()).map((a: any) => a.action));
    c.check('staff billing actions are in the platform audit',
      ['billing.profile.update', 'invoice.draft', 'invoice.issue', 'invoice.payment', 'invoice.void', 'subscription.request.declined'].every((a) => actions.has(a)), [...actions].join(','));
    const events = new Set((await col('subscriptionevents').find({ orgId: oid(A) }).toArray()).map((e: any) => e.type));
    c.check('A\'s subscription history shows the invoice issued and paid', events.has('invoice_issued') && events.has('invoice_paid') && events.has('payment_confirmed'), [...events].join(','));
  } finally {
    try {
      clearOrgStateCache?.();
      const name = mongoose.connection.db.databaseName;
      if (/^iso_[a-z0-9_]*_scratch_billing$/.test(name)) await mongoose.connection.db.dropDatabase();
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
