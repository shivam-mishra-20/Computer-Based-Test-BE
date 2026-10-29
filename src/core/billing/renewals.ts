/**
 * Renewals — the next period's invoice, before the current one ends, and its
 * payment by auto-pay where the institute has set it up.
 *
 *   RENEWAL_INVOICE_DAYS (7) before the period ends:
 *     a renewal invoice for the same plan, version and interval (an order of
 *     the institute's own, `origin: 'self-serve'`, so paying it extends the
 *     period from where it ends), issued at once when the seller profile has
 *     a legal name; the institute is told, and can pay it online.
 *   AUTOPAY_CHARGE_DAYS (3) before, with an active mandate:
 *     a charge for the invoice's balance, scheduled for the day before the
 *     period ends — Cashfree sends the pre-debit notice and debits.
 *   The day before, still unpaid: one reminder.
 *   After it ends: nothing new here — the lifecycle's grace period and its
 *     notices take over (core/subscriptions). One auto-pay retry is raised in
 *     grace if the first charge failed.
 *
 * Not renewed: platform-owned organizations, subscriptions not lifecycle-
 * managed, ones set to stop at period end, custom-priced plans, and trials
 * (a trial converts when the institute orders a plan, or — with auto-pay set
 * up — by the same invoice-and-charge as a renewal).
 *
 * Idempotent: one renewal invoice per subscription period (looked up by its
 * period start), one pending charge per invoice. Run by the daily sweep
 * (runLifecycleSweep) and from the console ("Run renewals now").
 */

import { withoutTenantScope } from '../tenancy/context';
import { createOrderInvoice, getBillingProfile, issueInvoice } from './invoices';
import { openOrderOf } from './selfServe';
import { autopayEnabled, raiseCharge, syncPendingCharges } from './autopay';
import { sendEventNotice } from './notices';
import { termsForSubscription } from '../subscriptions/catalogue';
import { recordSubscriptionEvent, type Actor } from '../subscriptions/service';

type Doc = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unscoped = (label: string, fn: () => any): Promise<any> => withoutTenantScope(`renewals:${label}`, fn) as Promise<any>;
const models = () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Subscription: require('../../models/Subscription').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Invoice: require('../../models/Invoice').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Org: require('../../models/Org').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Payment: require('../../models/Payment').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  AutopayMandate: require('../../models/AutopayMandate').default,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const RENEWALS: Actor = { kind: 'system', id: 'billing:renewals' };

const envDays = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 1 && v <= 60 ? v : fallback;
};
export const renewalInvoiceDays = () => envDays('RENEWAL_INVOICE_DAYS', 7);
export const autopayChargeDays = () => envDays('AUTOPAY_CHARGE_DAYS', 3);

/** Where a subscription's current access ends, and whether it is up for renewal now. Pure. */
export function renewalDue(
  sub: Doc,
  now: Date,
  opts: { invoiceDays?: number; autopay?: boolean } = {},
): { due: boolean; endsAt: Date | null; why: string } {
  const days = opts.invoiceDays ?? 7;
  if (sub.isPlatformOwned) return { due: false, endsAt: null, why: 'platform-owned' };
  if (!sub.managedSince) return { due: false, endsAt: null, why: 'not managed' };
  if (sub.cancelAtPeriodEnd) return { due: false, endsAt: null, why: 'stopping at period end' };
  if (!sub.planKey) return { due: false, endsAt: null, why: 'no plan' };
  let endsAt: Date | null = null;
  if (sub.status === 'active' && sub.periodEnd) endsAt = new Date(sub.periodEnd);
  else if (sub.status === 'trialing' && sub.trialEndsAt) {
    if (!opts.autopay) return { due: false, endsAt: new Date(sub.trialEndsAt), why: 'trial without auto-pay' };
    endsAt = new Date(sub.trialEndsAt);
  } else return { due: false, endsAt: null, why: `status ${sub.status}` };
  const left = endsAt.getTime() - now.getTime();
  if (left <= 0) return { due: false, endsAt, why: 'already ended' };
  if (left > days * DAY_MS) return { due: false, endsAt, why: 'not yet' };
  return { due: true, endsAt, why: 'due' };
}

/** When to schedule the auto-pay debit: the day before access ends, never sooner than tomorrow. Pure. */
export function chargeDate(endsAt: Date, now: Date): Date {
  return new Date(Math.max(now.getTime() + DAY_MS, endsAt.getTime() - DAY_MS));
}

async function activeMandate(orgId: unknown): Promise<Doc | null> {
  const { AutopayMandate } = models();
  return unscoped('mandate', () => AutopayMandate.findOne({ orgId, live: true, status: 'active' }).lean());
}

/**
 * The invoice that renews this subscription: the open self-serve order if the
 * institute has one (its own upgrade or renewal), the renewal already raised
 * for this period, or a new one. Returns null when nothing is to be paid
 * (custom pricing, no price, or already paid).
 */
async function renewalInvoiceFor(sub: Doc, endsAt: Date, summary: Doc): Promise<Doc | null> {
  const { Invoice, Payment } = models();
  const orgId = String(sub.orgId);
  const already = await unscoped('existing', () =>
    // This period's: one starting where the current access ends (give or take
    // a clock skew), not any later one.
    Invoice.findOne({
      orgId: sub.orgId,
      origin: 'self-serve',
      status: { $in: ['draft', 'issued', 'paid'] },
      periodStart: { $gte: new Date(endsAt.getTime() - 12 * 60 * 60 * 1000), $lte: new Date(endsAt.getTime() + 12 * 60 * 60 * 1000) },
    })
      .sort({ createdAt: -1 })
      .lean(),
  );
  if (already) return already.status === 'paid' ? null : already;
  const open = await openOrderOf(orgId);
  if (open) return open;

  const terms = await termsForSubscription(sub);
  const interval = sub.billingInterval === 'annual' ? 'annual' : 'monthly';
  const price = interval === 'annual' ? terms?.price?.annual : terms?.price?.monthly;
  if (!terms || terms.customPricing || !(Number(price) > 0)) return null;
  const paidBefore = await unscoped('paid-before', () => Payment.exists({ orgId: sub.orgId, status: 'confirmed' }));
  const draft = await createOrderInvoice(
    orgId,
    { planKey: sub.planKey, planVersion: sub.planVersion ?? terms.planVersion ?? 1, billingInterval: interval, kind: paidBefore ? 'renewal' : 'new' },
    RENEWALS,
  );
  await unscoped('mark', () =>
    Invoice.updateOne({ _id: draft._id }, { $set: { 'order.auto': true, 'order.renewalOf': endsAt, notes: `Renewal for the period from ${endsAt.toISOString().slice(0, 10)}.` } }),
  );
  summary.invoiced++;
  let invoice: Doc = draft;
  const profile = await getBillingProfile();
  if (String(profile.legalName ?? '').trim()) {
    try {
      invoice = await issueInvoice(String(draft._id), RENEWALS);
      summary.issued++;
    } catch (error) {
      summary.errors.push(`${orgId}: renewal invoice left as a draft — ${(error as Error).message}`);
    }
  }
  const mandate = await activeMandate(sub.orgId);
  await recordSubscriptionEvent({
    orgId,
    subscriptionId: sub._id,
    // History only: the notice is sent below, and only for an issued invoice.
    type: 'renewal_invoice_created',
    actor: RENEWALS,
    metadata: { invoiceId: String(draft._id), number: invoice.number ?? null, totalMinor: invoice.totalMinor, periodStart: endsAt, issued: invoice.status === 'issued' },
    planName: terms.name,
  });
  if (invoice.status === 'issued') {
    void sendEventNotice(orgId, 'renewal_invoiced', {
      planName: terms.name,
      metadata: { number: invoice.number, totalMinor: invoice.totalMinor, periodStart: endsAt, autopayOn: Boolean(mandate) },
    });
    await unscoped('reminded', () => Invoice.updateOne({ _id: draft._id }, { $set: { 'order.remindedAt': new Date() } }));
  }
  return invoice;
}

export interface RenewalSummary {
  examined: number;
  invoiced: number;
  issued: number;
  charged: number;
  reminded: number;
  retried: number;
  charges: { checked: number; settled: number; failed: number };
  errors: string[];
}

/** Run once: invoices, charges and reminders due now. `orgId` limits it to one organization (console, tests). */
export async function runRenewals(now = new Date(), opts: { orgId?: string; limit?: number } = {}): Promise<RenewalSummary> {
  const { Subscription, Invoice, AutopayMandate } = models();
  const summary: RenewalSummary = { examined: 0, invoiced: 0, issued: 0, charged: 0, reminded: 0, retried: 0, charges: { checked: 0, settled: 0, failed: 0 }, errors: [] };
  const invoiceDays = renewalInvoiceDays();
  const chargeDays = autopayChargeDays();
  const autopayOn = autopayEnabled();
  const horizon = new Date(now.getTime() + invoiceDays * DAY_MS);

  // What Cashfree has collected (or refused) since the last run, first.
  if (autopayOn) summary.charges = await syncPendingCharges().catch((e) => {
    summary.errors.push(`charges: ${(e as Error).message}`);
    return summary.charges;
  });

  const filter: Doc = {
    managedSince: { $exists: true },
    isPlatformOwned: { $ne: true },
    cancelAtPeriodEnd: { $ne: true },
    $or: [
      { status: 'active', periodEnd: { $gt: now, $lte: horizon } },
      { status: 'trialing', trialEndsAt: { $gt: now, $lte: horizon } },
      { status: 'past_due' },
    ],
  };
  if (opts.orgId) filter.orgId = opts.orgId;
  const subs: Doc[] = await unscoped('find', () => Subscription.find(filter).limit(opts.limit ?? 1000).lean());
  const { Org } = models();
  for (const sub of subs) {
    summary.examined++;
    const orgId = String(sub.orgId);
    try {
      const org = await unscoped('org', () => Org.findById(sub.orgId).select('isPlatformOwned deletion').lean());
      if (!org || org.isPlatformOwned || org.deletion) continue;
      const mandate = autopayOn ? await activeMandate(sub.orgId) : null;

      if (sub.status === 'past_due') {
        // In grace: one more auto-pay attempt on the open renewal, if the first failed.
        if (!mandate) continue;
        const open = await openOrderOf(orgId);
        if (!open || open.status !== 'issued') continue;
        const tries = (mandate.charges ?? []).filter((c: Doc) => String(c.invoiceId) === String(open._id));
        const lastFailed = tries.length > 0 && tries.every((c: Doc) => c.status === 'failed') && tries[tries.length - 1].providerStatus !== 'OVER_LIMIT';
        const lastAt = tries.length ? new Date(tries[tries.length - 1].raisedAt).getTime() : 0;
        if (tries.length === 1 && lastFailed && now.getTime() - lastAt > 2 * DAY_MS) {
          const r = await raiseCharge(mandate, open, new Date(now.getTime() + DAY_MS));
          if (r.raised) summary.retried++;
        }
        continue;
      }

      const { due, endsAt } = renewalDue(sub, now, { invoiceDays, autopay: Boolean(mandate) });
      if (!due || !endsAt) continue;
      const invoice = await renewalInvoiceFor(sub, endsAt, summary);
      if (!invoice || invoice.status !== 'issued') continue;

      if (mandate && endsAt.getTime() - now.getTime() <= chargeDays * DAY_MS) {
        const latest = await unscoped('mandate-reload', () => AutopayMandate.findById(mandate._id).lean());
        const r = await raiseCharge(latest, invoice, chargeDate(endsAt, now));
        if (r.raised) summary.charged++;
        continue;
      }
      // The last day: one reminder for an invoice still unpaid (and not on auto-pay).
      const remindedAt = invoice.order?.remindedAt ? new Date(invoice.order.remindedAt).getTime() : 0;
      if (!mandate && endsAt.getTime() - now.getTime() <= DAY_MS && now.getTime() - remindedAt > DAY_MS) {
        void sendEventNotice(orgId, 'renewal_reminder', { metadata: { number: invoice.number, totalMinor: invoice.totalMinor - (invoice.amountPaidMinor ?? 0) } });
        await unscoped('remind', () => Invoice.updateOne({ _id: invoice._id }, { $set: { 'order.remindedAt': now } }));
        summary.reminded++;
      }
    } catch (error) {
      summary.errors.push(`${orgId}: ${(error as Error).message}`);
    }
  }
  return summary;
}
