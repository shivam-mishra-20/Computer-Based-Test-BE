/**
 * Auto-pay — an institute authorises a Cashfree mandate once, and each renewal
 * invoice is charged to it.
 *
 *   Set up auto-pay ─▶ Cashfree subscription (ON_DEMAND, max = the dearest
 *                      self-serve plan for the institute's interval)
 *                  ─▶ subscriptionsCheckout ─▶ UPI Autopay / eNACH / card approval
 *                  ─▶ Cashfree POSTs back to us ─▶ we ask Cashfree ─▶ active
 *
 *   renewal invoice issued (core/billing/renewals) ─▶ a few days before the
 *   period ends: raise a charge for the invoice's balance, scheduled for the
 *   day before ─▶ Cashfree sends the pre-debit notice and debits ─▶ webhook or
 *   sweep: we ask Cashfree ─▶ SUCCESS ─▶ settleInvoice (provider cashfree)
 *
 * Off unless CASHFREE_AUTOPAY=on: Cashfree's Subscriptions product must be
 * enabled on the merchant account first. Pay-online renewals work without it.
 *
 * Guarantees: a charge is never above what the institute authorised; one
 * charge per invoice at a time; a successful charge for an invoice that was
 * already paid is refunded automatically; a mandate cancelled at the bank or in
 * the UPI app is seen as cancelled, and nothing more is raised on it.
 */

import mongoose from 'mongoose';
import { withoutTenantScope } from '../tenancy/context';
import { BillingError, getBillingProfile, settleInvoice } from './invoices';
import {
  CashfreeError,
  cancelMandate,
  cashfreeConfig,
  chargeStatusOf,
  createMandate,
  getMandate,
  getMandateCharge,
  mandateMethodOf,
  mandateStatusOf,
  raiseMandateCharge,
  type CashfreeSubscription,
} from './cashfree';
import { paymentsMode, planPriceFor, quoteLines, returnUrlFor, type PlanPrice } from './registrationPayments';
import { sendEventNotice } from './notices';
import { listPublicPlans, termsForSubscription } from '../subscriptions/catalogue';
import type { Actor } from '../subscriptions/service';

type Doc = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unscoped = (label: string, fn: () => any): Promise<any> => withoutTenantScope(`autopay:${label}`, fn) as Promise<any>;
const models = () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  AutopayMandate: require('../../models/AutopayMandate').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Subscription: require('../../models/Subscription').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Invoice: require('../../models/Invoice').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Org: require('../../models/Org').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Payment: require('../../models/Payment').default,
});

const LIVE = ['pending', 'active', 'paused', 'on_hold'];
const PROVIDER_ACTOR: Actor = { kind: 'system', id: 'provider:cashfree' };
const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_REUSE_MS = 30 * 60 * 1000;
const MANDATE_YEARS = 5;

export function autopayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.CASHFREE_AUTOPAY ?? '').trim().toLowerCase() === 'on' && paymentsMode(env) === 'on';
}

export function mandateView(m: Doc | null) {
  if (!m) return null;
  return {
    id: String(m._id),
    subscriptionId: m.subscriptionId as string,
    status: m.status as string,
    providerStatus: m.providerStatus ?? null,
    environment: m.environment as string,
    method: m.method ?? null,
    reference: m.reference ?? null,
    maxAmountMinor: m.maxAmountMinor as number,
    billingInterval: m.billingInterval as string,
    authorizedAt: m.authorizedAt ?? null,
    cancelledAt: m.cancelledAt ?? null,
    cancelReason: m.cancelReason ?? null,
    createdAt: m.createdAt,
    charges: (m.charges ?? []).slice(-12).reverse().map((c: Doc) => ({
      paymentId: c.paymentId,
      cfPaymentId: c.cfPaymentId ?? null,
      invoiceId: String(c.invoiceId),
      amountMinor: c.amountMinor,
      scheduledFor: c.scheduledFor,
      status: c.status,
      failureReason: c.failureReason ?? null,
      settledAt: c.settledAt ?? null,
    })),
  };
}

const liveFilter = (orgId: unknown) => ({ orgId, live: true });

async function liveMandate(orgId: unknown): Promise<Doc | null> {
  const { AutopayMandate } = models();
  return unscoped('live', () => AutopayMandate.findOne(liveFilter(orgId)).select('+sessionId').lean());
}

/** The most an institute's renewals can come to on this interval: the dearest self-serve plan, tax included. */
export async function autopayCeilingMinor(orgId: string, interval: 'monthly' | 'annual', sub?: Doc | null): Promise<number> {
  const { Org } = models();
  const [profile, org, plans] = await Promise.all([
    getBillingProfile(),
    unscoped('ceiling-org', () => Org.findById(orgId).select('billing').lean()),
    listPublicPlans(),
  ]);
  const state = org?.billing?.stateCode ?? null;
  const totals: number[] = [];
  const consider = (plan: PlanPrice) => {
    if (planPriceFor(plan, interval) === null) return;
    try {
      totals.push(quoteLines(plan, interval, profile, state).totalMinor);
    } catch {
      /* not quotable without a billing state: skipped */
    }
  };
  for (const p of plans) if (!p.customPricing) consider(p as PlanPrice);
  // The plan the institute is on may be off sale; its renewal must still fit.
  if (sub?.planKey) {
    const terms = await termsForSubscription(sub);
    if (terms && !terms.customPricing) consider({ name: terms.name ?? sub.planKey, price: terms.price });
  }
  return totals.length ? Math.max(...totals) : 0;
}

// ── The institute's side ───────────────────────────────────────────────────

export async function autopayState(orgId: string) {
  const { AutopayMandate } = models();
  let current: Doc | null = await liveMandate(orgId);
  if (current?.status === 'pending' && (!current.lastCheckedAt || Date.now() - new Date(current.lastCheckedAt).getTime() > 20_000)) {
    current = (await syncMandate(current).catch(() => ({ mandate: current }))).mandate;
  }
  const last = current ?? (await unscoped('last', () => AutopayMandate.findOne({ orgId }).sort({ createdAt: -1 }).lean()));
  return { enabled: autopayEnabled(), environment: cashfreeConfig().environment, mandate: mandateView(last) };
}

/**
 * Start setting up auto-pay. Returns the session the admin panel opens with
 * Cashfree's `subscriptionsCheckout`. Cashfree sends the browser back to
 * `apiBase/public/payments/cashfree/autopay-return`, which checks the mandate
 * and redirects to `returnUrl` (the admin panel's own page).
 */
export async function startAutopay(
  orgId: string,
  opts: { returnUrl?: unknown; origin?: unknown; apiBase: string; actor: Actor & { email?: string } },
) {
  if (!autopayEnabled()) {
    throw new BillingError(503, 'AUTOPAY_OFF', 'Auto-pay is not available yet. You can pay each renewal online.');
  }
  const { AutopayMandate, Subscription } = models();
  const sub: Doc | null = await unscoped('sub', () => Subscription.findOne({ orgId }).lean());
  if (!sub || !sub.managedSince || !['active', 'trialing', 'past_due'].includes(sub.status) || !sub.planKey) {
    throw new BillingError(409, 'NO_PAID_PLAN', 'Choose a plan first; auto-pay pays its renewals.');
  }
  if (sub.cancelAtPeriodEnd) throw new BillingError(409, 'CANCELLING', 'Your subscription is set to stop at the end of the period. Resume it to set up auto-pay.');
  const interval: 'monthly' | 'annual' = sub.billingInterval === 'annual' ? 'annual' : 'monthly';

  const existing = await liveMandate(orgId);
  if (existing) {
    if (existing.status === 'pending' && existing.sessionId && Date.now() - new Date(existing.createdAt).getTime() < PENDING_REUSE_MS) {
      return { subscriptionId: existing.subscriptionId, sessionId: existing.sessionId, environment: existing.environment, maxAmountMinor: existing.maxAmountMinor };
    }
    if (existing.status === 'pending') {
      await unscoped('retire', () => AutopayMandate.updateOne({ _id: existing._id, status: 'pending' }, { $set: { status: 'expired' }, $unset: { live: 1 } }));
    } else {
      throw new BillingError(409, 'AUTOPAY_ON', 'Auto-pay is already set up.');
    }
  }

  const returnTo = returnUrlFor(opts.returnUrl, opts.origin, '');
  if (!returnTo) throw new BillingError(400, 'RETURN_URL_INVALID', 'The page to come back to is not on this site.');
  const max = await autopayCeilingMinor(orgId, interval, sub);
  if (!(max >= 100)) throw new BillingError(409, 'NO_PRICE', 'There is no price to authorise for your billing interval.');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { payerOf } = require('./invoiceCheckout');
  const payer = await payerOf(orgId, opts.actor.email);
  if (!payer.email) throw new BillingError(400, 'BILLING_EMAIL_REQUIRED', 'Add a billing email under Billing details first.', { field: 'email' });

  const config = cashfreeConfig();
  const subscriptionId = `agm_${orgId}_${Date.now().toString(36)}`;
  const created: Doc = (
    await unscoped('create', () =>
      AutopayMandate.create({
        orgId, environment: config.environment, subscriptionId, status: 'pending', live: true, maxAmountMinor: max,
        billingInterval: interval, returnTo, createdBy: { id: opts.actor.id, email: opts.actor.email },
      }),
    )
  ).toObject();
  let sub2: CashfreeSubscription;
  try {
    sub2 = await createMandate(
      {
        subscriptionId,
        customer: { name: payer.name, email: payer.email, phone: payer.phone },
        planName: `${payer.name} ${interval === 'annual' ? 'yearly' : 'monthly'}`,
        maxAmountMinor: max,
        note: 'Platform subscription renewals',
        returnUrl: `${opts.apiBase.replace(/\/+$/, '')}/public/payments/cashfree/autopay-return?m=${encodeURIComponent(subscriptionId)}`,
        expiresAt: new Date(Date.now() + MANDATE_YEARS * 365 * DAY_MS),
        tags: { kind: 'autopay', org: String(orgId) },
      },
      config,
    );
  } catch (error) {
    await unscoped('create-failed', () =>
      AutopayMandate.updateOne({ _id: created._id }, { $set: { status: 'failed', providerStatus: (error as Error).message?.slice(0, 200) }, $unset: { live: 1 } }),
    );
    if (error instanceof CashfreeError) console.error(`[autopay] Cashfree ${error.status} ${error.code}: ${error.message}`);
    throw new BillingError(502, 'GATEWAY_ERROR', 'Auto-pay could not be started right now. Please try again in a moment.');
  }
  await unscoped('created', () =>
    AutopayMandate.updateOne(
      { _id: created._id },
      { $set: { cfSubscriptionId: sub2.cf_subscription_id !== undefined ? String(sub2.cf_subscription_id) : undefined, sessionId: sub2.subscription_session_id, providerStatus: sub2.subscription_status } },
    ),
  );
  if (!sub2.subscription_session_id) throw new BillingError(502, 'GATEWAY_ERROR', 'Auto-pay could not be started right now. Please try again in a moment.');
  return { subscriptionId, sessionId: sub2.subscription_session_id, environment: config.environment, maxAmountMinor: max };
}

/** Cashfree's return after authorising: check the mandate, then where to send the browser. */
export async function autopayReturn(subscriptionId: string): Promise<string | null> {
  const { AutopayMandate } = models();
  const m: Doc | null = await unscoped('return-load', () => AutopayMandate.findOne({ subscriptionId: String(subscriptionId ?? '').slice(0, 250) }).lean());
  if (!m) return null;
  const synced = await syncMandate(m).catch(() => ({ mandate: m }));
  if (!m.returnTo) return null;
  return `${m.returnTo}${m.returnTo.includes('?') ? '&' : '?'}autopay=${encodeURIComponent(synced.mandate.status)}`;
}

/** Turn auto-pay off. Staff or the institute; nothing more is charged. */
export async function cancelAutopay(orgId: string, actor: Actor, reason = 'Turned off by the institute') {
  const m = await liveMandate(orgId);
  if (!m) throw new BillingError(404, 'AUTOPAY_NOT_FOUND', 'Auto-pay is not set up.');
  return { mandate: mandateView(await cancelMandateRecord(m, reason)) };
}

/** The same, for code that ends a subscription: no mandate is not an error. */
export async function cancelAutopayFor(orgId: string, _actor: Actor, reason: string) {
  const m = await liveMandate(orgId);
  if (m) await cancelMandateRecord(m, reason);
}

async function cancelMandateRecord(m: Doc, reason: string): Promise<Doc> {
  const { AutopayMandate } = models();
  try {
    await cancelMandate(m.subscriptionId);
  } catch (error) {
    // A mandate never authorised, or already cancelled at the bank, may refuse:
    // it is still over on our side.
    if (!(error instanceof CashfreeError)) throw error;
    console.error(`[autopay] cancel ${m.subscriptionId} at Cashfree: ${error.status} ${error.message}`);
  }
  const saved = await unscoped('cancel', () =>
    AutopayMandate.findOneAndUpdate(
      { _id: m._id },
      { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason.slice(0, 500) }, $unset: { live: 1 } },
      { new: true },
    ).lean(),
  );
  if (m.status === 'active') void sendEventNotice(String(m.orgId), 'autopay_cancelled', {});
  return saved;
}

// ── Following Cashfree ─────────────────────────────────────────────────────

export async function syncMandate(m: Doc): Promise<{ mandate: Doc }> {
  const { AutopayMandate } = models();
  const remote = await getMandate(m.subscriptionId);
  const status = mandateStatusOf(remote.subscription_status);
  const set: Doc = { status, providerStatus: remote.subscription_status, lastCheckedAt: new Date() };
  const unset: Doc = {};
  if (LIVE.includes(status)) set.live = true;
  else unset.live = 1;
  const auth = remote.authorisation_details;
  if (auth?.authorization_reference) set.reference = auth.authorization_reference;
  if (status === 'active') {
    set.method = mandateMethodOf(auth);
    if (!m.authorizedAt) set.authorizedAt = auth?.authorization_time ? new Date(auth.authorization_time) : new Date();
  }
  if (status === 'cancelled' && !m.cancelledAt) Object.assign(set, { cancelledAt: new Date(), cancelReason: m.cancelReason ?? `Cancelled at Cashfree (${remote.subscription_status})` });
  const saved = await unscoped('sync', () =>
    AutopayMandate.findOneAndUpdate({ _id: m._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true }).lean(),
  );
  if (status === 'active' && m.status !== 'active') {
    void sendEventNotice(String(m.orgId), 'autopay_active', { metadata: { method: set.method, maxAmountMinor: m.maxAmountMinor } });
  }
  if (status === 'cancelled' && m.status === 'active') void sendEventNotice(String(m.orgId), 'autopay_cancelled', {});
  return { mandate: saved ?? m };
}

/**
 * Charge an invoice to the institute's mandate, scheduled for `scheduledFor`
 * (Cashfree uses the date). One pending charge per invoice; above the
 * authorised ceiling nothing is raised and the institute is told to pay online.
 */
export async function raiseCharge(m: Doc, invoice: Doc, scheduledFor: Date) {
  const { AutopayMandate } = models();
  const balance = invoice.totalMinor - (invoice.amountPaidMinor ?? 0);
  const charges: Doc[] = m.charges ?? [];
  if (charges.some((c) => String(c.invoiceId) === String(invoice._id) && ['pending', 'success'].includes(c.status))) return { raised: false, reason: 'already' };
  const attempt = charges.filter((c) => String(c.invoiceId) === String(invoice._id)).length + 1;
  const paymentId = `agc_${String(invoice._id)}_${attempt}`;
  const base = { paymentId, invoiceId: invoice._id, amountMinor: balance, scheduledFor, raisedAt: new Date() };
  if (balance > m.maxAmountMinor) {
    await unscoped('over-limit', () =>
      AutopayMandate.updateOne({ _id: m._id }, { $push: { charges: { ...base, status: 'failed', providerStatus: 'OVER_LIMIT', failureReason: 'Above the authorised limit' } } }),
    );
    void sendEventNotice(String(m.orgId), 'autopay_over_limit', { metadata: { number: invoice.number, amountMinor: balance, maxAmountMinor: m.maxAmountMinor } });
    return { raised: false, reason: 'over-limit' };
  }
  try {
    const res = await raiseMandateCharge({ subscriptionId: m.subscriptionId, paymentId, amountMinor: balance, scheduledFor, remarks: `Invoice ${invoice.number ?? ''}`.trim() });
    const status = chargeStatusOf(res.payment_status);
    await unscoped('raised', () =>
      AutopayMandate.updateOne(
        { _id: m._id },
        { $push: { charges: { ...base, cfPaymentId: res.cf_payment_id !== undefined ? String(res.cf_payment_id) : undefined, status, providerStatus: res.payment_status, failureReason: res.failure_details?.failure_reason ?? undefined } } },
      ),
    );
    if (status === 'failed') void sendEventNotice(String(m.orgId), 'autopay_failed', { metadata: { number: invoice.number, reason: res.failure_details?.failure_reason } });
    else void sendEventNotice(String(m.orgId), 'autopay_scheduled', { metadata: { number: invoice.number, amountMinor: balance, scheduledFor } });
    return { raised: status !== 'failed', reason: status };
  } catch (error) {
    const reason = error instanceof CashfreeError ? error.message : (error as Error).message;
    await unscoped('raise-failed', () =>
      AutopayMandate.updateOne({ _id: m._id }, { $push: { charges: { ...base, status: 'failed', providerStatus: 'RAISE_FAILED', failureReason: String(reason).slice(0, 300) } } }),
    );
    void sendEventNotice(String(m.orgId), 'autopay_failed', { metadata: { number: invoice.number, reason: 'The charge could not be set up' } });
    return { raised: false, reason: 'error' };
  }
}

/** Ask Cashfree about one pending charge; settle the invoice the first time it is seen successful. */
export async function syncCharge(m: Doc, paymentId: string) {
  const { AutopayMandate, Invoice } = models();
  const charge = (m.charges ?? []).find((c: Doc) => c.paymentId === paymentId);
  if (!charge || charge.status === 'failed') return { status: charge?.status ?? 'missing' };
  if (charge.status === 'success' && charge.settledAt) return { status: 'success' };
  let status = charge.status;
  let remote: Doc | null = null;
  if (charge.status === 'pending') {
    remote = await getMandateCharge(m.subscriptionId, paymentId);
    status = chargeStatusOf(remote.payment_status);
    await unscoped('charge-sync', () =>
      AutopayMandate.updateOne(
        { _id: m._id, 'charges.paymentId': paymentId },
        {
          $set: {
            'charges.$.status': status,
            'charges.$.providerStatus': remote!.payment_status,
            'charges.$.checkedAt': new Date(),
            ...(remote!.cf_payment_id !== undefined ? { 'charges.$.cfPaymentId': String(remote!.cf_payment_id) } : {}),
            ...(remote!.failure_details?.failure_reason ? { 'charges.$.failureReason': String(remote!.failure_details.failure_reason).slice(0, 300) } : {}),
          },
        },
      ),
    );
  }
  if (status === 'failed') {
    const invoice = await unscoped('charge-invoice', () => Invoice.findById(charge.invoiceId).select('number').lean());
    void sendEventNotice(String(m.orgId), 'autopay_failed', { metadata: { number: invoice?.number, reason: remote?.failure_details?.failure_reason } });
    return { status };
  }
  if (status !== 'success') return { status };

  // Claimed by the write: one settlement per charge.
  const claimed = await unscoped('settle-claim', () =>
    AutopayMandate.findOneAndUpdate(
      { _id: m._id, charges: { $elemMatch: { paymentId, status: 'success', settledAt: { $exists: false } } } },
      { $set: { 'charges.$.settledAt': new Date() } },
      { new: true },
    ).lean(),
  );
  if (!claimed) return { status };
  const fresh = claimed.charges.find((c: Doc) => c.paymentId === paymentId);
  try {
    const result = await settleInvoice(
      String(fresh.invoiceId),
      {
        amount: fresh.amountMinor / 100,
        method: m.method && ['upi', 'card', 'bank_transfer'].includes(m.method) ? m.method : 'other',
        reference: String(fresh.cfPaymentId ?? paymentId),
        receivedAt: new Date(),
        notes: `Auto-pay charge ${paymentId}.`,
      },
      PROVIDER_ACTOR,
      'cashfree',
    );
    if (result.payment?._id) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Payment = require('../../models/Payment').default;
      await unscoped('charge-gateway', () =>
        Payment.updateOne({ _id: result.payment._id }, { $set: { gateway: { kind: 'mandate', subscriptionId: m.subscriptionId, chargePaymentId: paymentId } } }),
      );
      await unscoped('charge-ledger', () =>
        AutopayMandate.updateOne({ _id: m._id, 'charges.paymentId': paymentId }, { $set: { 'charges.$.ledgerPaymentId': result.payment._id } }),
      );
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'INVOICE_ALREADY_PAID' || code === 'INVOICE_VOID') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { raiseRefundRequest } = require('./refundRequests');
      await raiseRefundRequest(
        { duplicate: { orgId: String(m.orgId), invoiceId: String(fresh.invoiceId), amountMinor: fresh.amountMinor, gateway: { kind: 'mandate', subscriptionId: m.subscriptionId, chargePaymentId: paymentId, cfPaymentId: fresh.cfPaymentId }, reason: 'Invoice already paid' } },
        { reason: 'Duplicate payment: the invoice was already paid when auto-pay charged it.' },
        { kind: 'system', id: 'billing:duplicate' },
        { approveAs: { kind: 'system', id: 'billing:duplicate' }, approveNote: 'Refunded automatically: the invoice was already settled.' },
      ).catch((e: Error) => console.error(`[autopay] duplicate charge ${paymentId} not refunded:`, e.message));
      await unscoped('dup-mark', () => AutopayMandate.updateOne({ _id: m._id, 'charges.paymentId': paymentId }, { $set: { 'charges.$.settleError': 'Duplicate — refunded' } }));
    } else {
      await unscoped('settle-failed', () =>
        AutopayMandate.updateOne({ _id: m._id, 'charges.paymentId': paymentId }, { $set: { 'charges.$.settleError': (error as Error).message?.slice(0, 500) }, $unset: { 'charges.$.settledAt': 1 } }),
      );
      console.error(`[autopay] charge ${paymentId} succeeded but was not settled:`, (error as Error).message);
    }
  }
  return { status };
}

/** Every pending charge, everywhere — the sweep's step that settles what Cashfree has collected. */
export async function syncPendingCharges(limit = 500) {
  const { AutopayMandate } = models();
  const rows: Doc[] = await unscoped('pending-charges', () =>
    AutopayMandate.find({ $or: [{ 'charges.status': 'pending' }, { charges: { $elemMatch: { status: 'success', settledAt: { $exists: false } } } }] }).limit(limit).lean(),
  );
  let settled = 0;
  let failed = 0;
  for (const m of rows) {
    for (const c of m.charges ?? []) {
      if (c.status !== 'pending' && !(c.status === 'success' && !c.settledAt)) continue;
      try {
        const latest = await unscoped('reload', () => AutopayMandate.findById(m._id).lean());
        const r = await syncCharge(latest, c.paymentId);
        if (r.status === 'success') settled++;
        if (r.status === 'failed') failed++;
      } catch (error) {
        console.error(`[autopay] charge ${c.paymentId}:`, (error as Error).message);
      }
    }
  }
  return { checked: rows.length, settled, failed };
}

/** A Cashfree Subscriptions webhook (SUBSCRIPTION_*): ask Cashfree about the mandate and its charge. */
export async function onMandateWebhook(type: string, data: Doc) {
  const { AutopayMandate } = models();
  const subscriptionId = String(data?.subscription_id ?? data?.subscription_details?.subscription_id ?? '');
  if (type.includes('REFUND')) {
    const refundId = String(data?.refund_id ?? '');
    if (refundId) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { refreshByRefundId } = require('./refundRequests');
      await refreshByRefundId(refundId);
    }
    return 'refund refreshed';
  }
  const m: Doc | null = subscriptionId ? await unscoped('hook-load', () => AutopayMandate.findOne({ subscriptionId }).lean()) : null;
  if (!m) return `no mandate ${subscriptionId || '(none)'}`;
  const { mandate } = await syncMandate(m);
  const paymentId = String(data?.payment_id ?? '');
  if (paymentId && (mandate.charges ?? []).some((c: Doc) => c.paymentId === paymentId)) {
    const r = await syncCharge(mandate, paymentId);
    return `mandate ${mandate.status}, charge ${r.status}`;
  }
  return `mandate ${mandate.status}`;
}

/** For the console: one organization's mandates, newest first. */
export async function orgMandates(orgId: string) {
  const { AutopayMandate } = models();
  if (!mongoose.Types.ObjectId.isValid(orgId)) return [];
  const rows: Doc[] = await unscoped('org-mandates', () => AutopayMandate.find({ orgId }).sort({ createdAt: -1 }).limit(20).lean());
  return rows.map(mandateView);
}
