/**
 * Refund requests — anyone eligible asks, a platform admin decides, and
 * approving is what sends the money back through Cashfree.
 *
 *   who asks                     for what
 *   ─────────────────────────    ──────────────────────────────────────────
 *   an applicant (order id +     the payment made with their application,
 *     the application's email)     before it is approved
 *   an institute's admin         a payment it made through Cashfree: its
 *                                  first payment, an invoice paid online, or
 *                                  a renewal charged to its auto-pay
 *   platform staff               either, on someone's behalf (approved at once)
 *   the system                   a paid application that is REJECTED (approved
 *                                  at once, in full); money taken twice for one
 *                                  invoice (approved at once, the duplicate)
 *
 * Approve: an amount (the policy's suggestion by default — core/billing/
 * refundPolicy — up to what is still refundable), a note, and whether the
 * refund ends the subscription. The Cashfree refund is requested at once; its
 * status is followed by webhook or by "check". The amounts land on the
 * Payment, the invoice and (for an application) the RegistrationPayment.
 *
 * Nothing here trusts a client about money: the amount paid comes from our own
 * records of what Cashfree confirmed.
 */

import mongoose from 'mongoose';
import { withoutTenantScope } from '../tenancy/context';
import { BillingError } from './invoices';
import { suggestRefund } from './refundPolicy';
import { createRefund, getMandateRefund, getRefund, refundMandateCharge, CashfreeError, type CashfreeRefund } from './cashfree';
import { refundStatusOf } from './registrationPayments';
import { sendEventNotice } from './notices';
import type { Actor } from '../subscriptions/service';

type Doc = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unscoped = (label: string, fn: () => any): Promise<any> => withoutTenantScope(`refund-request:${label}`, fn) as Promise<any>;
const models = () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RefundRequest: require('../../models/RefundRequest').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RegistrationPayment: require('../../models/RegistrationPayment').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  OrganizationRegistration: require('../../models/OrganizationRegistration').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Payment: require('../../models/Payment').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Invoice: require('../../models/Invoice').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  InvoiceCheckout: require('../../models/InvoiceCheckout').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  AutopayMandate: require('../../models/AutopayMandate').default,
});

const OPEN_STATES = ['open', 'refunding'];
const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const minorFromRupees = (v: unknown) => Math.round(Number(v) * 100);

export type Requester = { kind: 'applicant' | 'tenant' | 'platform' | 'system'; id?: string; email?: string; name?: string };

export type RefundTarget =
  | { registrationPaymentId: string }
  | { paymentId: string }
  /** Money Cashfree took twice for one invoice: no Payment of ours records it. */
  | { duplicate: { orgId: string; invoiceId: string; amountMinor: number; gateway: Doc; reason: string } };

// ── What is being refunded ─────────────────────────────────────────────────

interface Resolved {
  source: 'registration' | 'payment';
  registrationPaymentId?: unknown;
  registrationId?: unknown;
  orgId?: unknown;
  paymentId?: unknown;
  invoiceId?: unknown;
  gateway: Doc;
  paidMinor: number;
  alreadyRefundedMinor: number;
  beforeApproval: boolean;
  interval?: string;
  periodStart?: Date;
  periodEnd?: Date;
  paidAt?: Date;
  lines?: { description: string; amountMinor: number }[];
}

/** Where Cashfree holds a Payment's money, for payments recorded before `gateway` was stored. */
async function gatewayOfPayment(payment: Doc): Promise<Doc | null> {
  if (payment.gateway?.kind) return payment.gateway;
  const { RegistrationPayment, InvoiceCheckout, AutopayMandate } = models();
  const ref = String(payment.reference ?? '');
  const reg = await unscoped('gw-reg', () => RegistrationPayment.findOne({ 'payment.cfPaymentId': ref }).select('orderId').lean());
  if (reg) return { kind: 'order', orderId: reg.orderId };
  const co = await unscoped('gw-co', () => InvoiceCheckout.findOne({ 'payment.cfPaymentId': ref }).select('orderId').lean());
  if (co) return { kind: 'order', orderId: co.orderId };
  const m = await unscoped('gw-m', () => AutopayMandate.findOne({ 'charges.cfPaymentId': ref }).lean());
  const charge = m?.charges?.find((c: Doc) => c.cfPaymentId === ref);
  if (m && charge) return { kind: 'mandate', subscriptionId: m.subscriptionId, chargePaymentId: charge.paymentId };
  return null;
}

async function resolveTarget(target: RefundTarget): Promise<Resolved> {
  const { RegistrationPayment, Payment, Invoice } = models();
  if ('duplicate' in target) {
    const d = target.duplicate;
    return {
      source: 'payment', orgId: d.orgId, invoiceId: d.invoiceId, gateway: d.gateway, paidMinor: d.amountMinor,
      alreadyRefundedMinor: 0, beforeApproval: true,
    };
  }
  if ('registrationPaymentId' in target) {
    if (!mongoose.Types.ObjectId.isValid(target.registrationPaymentId)) throw new BillingError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
    const rp = await unscoped('rp', () => RegistrationPayment.findById(target.registrationPaymentId).lean());
    if (!rp || rp.status !== 'paid') throw new BillingError(409, 'NOT_PAID', 'Only a paid payment can be refunded.');
    // Applied at approval: it is now the organization's payment, and refunding
    // it is a refund of a subscription payment.
    if (rp.appliedAt && rp.paymentId) return resolveTarget({ paymentId: String(rp.paymentId) });
    const refunded = rp.refund && rp.refund.status !== 'failed' ? Number(rp.refund.amountMinor ?? rp.totalMinor) : 0;
    return {
      source: 'registration', registrationPaymentId: rp._id, registrationId: rp.registrationId,
      gateway: { kind: 'order', orderId: rp.orderId, cfPaymentId: rp.payment?.cfPaymentId },
      paidMinor: rp.totalMinor, alreadyRefundedMinor: refunded, beforeApproval: true, lines: rp.lines,
      interval: rp.billingInterval, paidAt: rp.paidAt,
    };
  }
  if (!mongoose.Types.ObjectId.isValid(target.paymentId)) throw new BillingError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  const payment = await unscoped('payment', () => Payment.findById(target.paymentId).lean());
  if (!payment || payment.status !== 'confirmed') throw new BillingError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  if (payment.provider !== 'cashfree') {
    throw new BillingError(409, 'NOT_REFUNDABLE_ONLINE', 'This payment was not taken through Cashfree, so it is refunded outside the system (by bank transfer).');
  }
  const gateway = await gatewayOfPayment(payment);
  if (!gateway) throw new BillingError(409, 'GATEWAY_UNKNOWN', 'The Cashfree order for this payment could not be found.');
  const invoice = payment.invoiceId ? await unscoped('invoice', () => Invoice.findById(payment.invoiceId).select('lines').lean()) : null;
  const rp = await unscoped('rp-of-payment', () => RegistrationPayment.findOne({ paymentId: payment._id }).select('lines').lean());
  return {
    source: 'payment', orgId: payment.orgId, paymentId: payment._id, invoiceId: payment.invoiceId,
    gateway: { ...gateway, cfPaymentId: payment.reference },
    paidMinor: payment.amountMinor, alreadyRefundedMinor: Number(payment.refundedMinor ?? 0), beforeApproval: false,
    interval: payment.billingInterval, periodStart: payment.periodStart, periodEnd: payment.periodEnd, paidAt: payment.receivedAt,
    lines: (invoice?.lines ?? rp?.lines ?? []) as { description: string; amountMinor: number }[],
  };
}

async function billingIntervalOf(resolved: Resolved): Promise<string | undefined> {
  if (resolved.interval) return resolved.interval;
  if (!resolved.orgId) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Subscription = require('../../models/Subscription').default;
  const sub = await unscoped('interval', () => Subscription.findOne({ orgId: resolved.orgId }).select('billingInterval').lean());
  return sub?.billingInterval;
}

/** What the policy gives for a target, now — for the console's approve dialog and the institute's request form. */
export async function refundQuote(target: RefundTarget, now = new Date()) {
  const r = await resolveTarget(target);
  const suggestion = suggestRefund({
    beforeApproval: r.beforeApproval,
    paidMinor: r.paidMinor,
    alreadyRefundedMinor: r.alreadyRefundedMinor,
    billingInterval: await billingIntervalOf(r),
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    paidAt: r.paidAt,
    lines: r.lines,
    now,
  });
  return { ...suggestion, source: r.source, paidMinor: r.paidMinor, alreadyRefundedMinor: r.alreadyRefundedMinor };
}

// ── Views ──────────────────────────────────────────────────────────────────

export function requestView(r: Doc): Doc & { id: string } {
  return { ...r, id: String(r._id) };
}

/** What a requester (an applicant or an institute) is shown: no staff identities. */
export function requesterView(r: Doc | null) {
  if (!r) return null;
  return {
    id: String(r._id),
    status: r.status as string,
    requestedMinor: r.requestedMinor as number,
    approvedMinor: r.decision?.amountMinor ?? null,
    refundedMinor: r.refund?.status === 'success' ? r.refund.amountMinor : 0,
    reason: r.reason as string,
    note: r.decision?.note ?? null,
    arn: r.refund?.arn ?? null,
    createdAt: r.createdAt,
    decidedAt: r.decision?.at ?? null,
    processedAt: r.refund?.processedAt ?? null,
    paymentId: r.paymentId ? String(r.paymentId) : null,
  };
}

// ── Raise ──────────────────────────────────────────────────────────────────

export interface RaiseInput {
  reason?: unknown;
  /** Rupees; staff may name an amount, a requester asks for the policy amount or everything. */
  amount?: unknown;
}

/**
 * Raise a request. One open request per payment: asking again returns it.
 * `scopeOrgId` (an institute's admin) refuses any payment not its own, the
 * same way as a missing one.
 */
export async function raiseRefundRequest(
  target: RefundTarget,
  input: RaiseInput,
  requester: Requester,
  opts: { scopeOrgId?: string; approveAs?: Actor & { email?: string }; approveNote?: string; endSubscription?: boolean; now?: Date } = {},
) {
  const { RefundRequest } = models();
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 1000) : '';
  if (reason.length < 3) throw new BillingError(400, 'REASON_REQUIRED', 'Say why the refund is wanted.', { field: 'reason' });
  const r = await resolveTarget(target);
  if (opts.scopeOrgId && String(r.orgId ?? '') !== String(opts.scopeOrgId)) {
    throw new BillingError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  }
  const duplicateKey = Object.fromEntries(
    [['invoiceId', r.invoiceId], ['gateway.chargePaymentId', r.gateway.chargePaymentId], ['gateway.orderId', r.gateway.orderId]].filter(([, v]) => v !== undefined && v !== null),
  );
  const key = r.source === 'registration' ? { registrationPaymentId: r.registrationPaymentId } : r.paymentId ? { paymentId: r.paymentId } : duplicateKey;
  const open = await unscoped('open', () => RefundRequest.findOne({ ...key, status: { $in: OPEN_STATES } }).lean());
  if (open) {
    if (opts.approveAs && open.status === 'open') return { request: (await approveRefundRequest(String(open._id), { amount: input.amount, note: opts.approveNote, endSubscription: opts.endSubscription }, opts.approveAs)).request, duplicate: true };
    return { request: requestView(open), duplicate: true };
  }
  // After the open-request check: a refund already under way is that request, not "nothing left".
  const refundable = r.paidMinor - r.alreadyRefundedMinor;
  if (!(refundable > 0)) throw new BillingError(409, 'NOTHING_REFUNDABLE', 'This payment has already been refunded in full.');

  const quote = suggestRefund({
    beforeApproval: r.beforeApproval, paidMinor: r.paidMinor, alreadyRefundedMinor: r.alreadyRefundedMinor,
    billingInterval: await billingIntervalOf(r), periodStart: r.periodStart, periodEnd: r.periodEnd, paidAt: r.paidAt, lines: r.lines,
    now: opts.now ?? new Date(),
  });
  const named = input.amount === undefined || input.amount === null || input.amount === '' ? null : minorFromRupees(input.amount);
  if (named !== null && (!(named > 0) || named > refundable)) {
    throw new BillingError(400, 'AMOUNT_INVALID', `The amount must be more than ₹0 and at most ₹${(refundable / 100).toFixed(2)}.`, { field: 'amount' });
  }
  const requestedMinor = named ?? (quote.amountMinor > 0 ? quote.amountMinor : refundable);

  const created = (
    await unscoped('create', () =>
      RefundRequest.create({
        source: r.source,
        registrationPaymentId: r.registrationPaymentId,
        registrationId: r.registrationId,
        orgId: r.orgId,
        paymentId: r.paymentId,
        invoiceId: r.invoiceId,
        gateway: r.gateway,
        paidMinor: r.paidMinor,
        requestedMinor,
        reason,
        requestedBy: requester,
        status: 'open',
        suggestion: { amountMinor: quote.amountMinor, rule: quote.rule, explanation: quote.explanation },
      }),
    )
  ).toObject();
  if (r.orgId && requester.kind === 'tenant') {
    void sendEventNotice(String(r.orgId), 'refund_requested', { metadata: { amountMinor: requestedMinor } });
  }
  if (opts.approveAs) {
    return {
      request: (await approveRefundRequest(String(created._id), { amount: named !== null ? named / 100 : undefined, note: opts.approveNote, endSubscription: opts.endSubscription }, opts.approveAs)).request,
      duplicate: false,
    };
  }
  return { request: requestView(created), duplicate: false };
}

// ── Decide ─────────────────────────────────────────────────────────────────

async function loadRequest(id: string): Promise<Doc> {
  const { RefundRequest } = models();
  if (!mongoose.Types.ObjectId.isValid(id)) throw new BillingError(404, 'REFUND_REQUEST_NOT_FOUND', 'Refund request not found.');
  const found = await unscoped('load', () => RefundRequest.findById(id).lean());
  if (!found) throw new BillingError(404, 'REFUND_REQUEST_NOT_FOUND', 'Refund request not found.');
  return found;
}

async function refundedSoFar(request: Doc): Promise<number> {
  const r = await resolveTarget(
    request.source === 'registration'
      ? { registrationPaymentId: String(request.registrationPaymentId) }
      : request.paymentId
        ? { paymentId: String(request.paymentId) }
        : { duplicate: { orgId: String(request.orgId), invoiceId: String(request.invoiceId), amountMinor: request.paidMinor, gateway: request.gateway, reason: request.reason } },
  ).catch(() => null);
  return r ? r.alreadyRefundedMinor : 0;
}

/**
 * Approve: the Cashfree refund is requested now. A request that failed at
 * Cashfree can be approved again (a new refund id). `amount` in rupees
 * defaults to what was requested.
 */
export async function approveRefundRequest(
  id: string,
  input: { amount?: unknown; note?: unknown; endSubscription?: unknown },
  actor: Actor & { email?: string },
) {
  const { RefundRequest } = models();
  const request = await loadRequest(id);
  if (!['open', 'failed'].includes(request.status)) {
    throw new BillingError(409, 'REFUND_REQUEST_DECIDED', `This request is already ${request.status}.`, { status: request.status });
  }
  const remaining = request.paidMinor - (await refundedSoFar(request));
  const amountMinor = input.amount === undefined || input.amount === null || input.amount === '' ? Math.min(request.requestedMinor, remaining) : minorFromRupees(input.amount);
  if (!(amountMinor > 0) || amountMinor > remaining) {
    throw new BillingError(400, 'AMOUNT_INVALID', `The refund must be more than ₹0 and at most ₹${(remaining / 100).toFixed(2)}.`, { field: 'amount' });
  }
  if (request.source === 'registration' && amountMinor !== remaining) {
    throw new BillingError(400, 'FULL_REFUND_ONLY', 'An application that has not been approved is refunded in full.', { field: 'amount' });
  }
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 1000) : '';
  const endSubscription = Boolean(input.endSubscription) && request.source === 'payment' && Boolean(request.orgId) && Boolean(request.paymentId);
  const attempt = (Number(request.refund?.attempt) || 0) + 1;
  const refundId = `rf${attempt}_${String(request._id)}`;

  // Claimed by the write: two approvals at once send one refund.
  const claimed = await unscoped('approve-claim', () =>
    RefundRequest.findOneAndUpdate(
      { _id: request._id, status: { $in: ['open', 'failed'] } },
      {
        $set: {
          status: 'refunding',
          decision: { by: { id: actor.id, email: actor.email }, at: new Date(), note: note || undefined, amountMinor, endSubscription },
          refund: { refundId, attempt, status: 'pending', amountMinor, requestedAt: new Date() },
        },
      },
      { new: true },
    ).lean(),
  );
  if (!claimed) return { request: requestView(await loadRequest(id)), duplicate: true };

  // Mirror on the application's payment at once, so approval can no longer use it.
  if (request.source === 'registration') await mirrorRegistration(claimed, 'pending');

  let refund: CashfreeRefund;
  try {
    const g = request.gateway ?? {};
    refund = g.kind === 'mandate'
      ? await refundMandateCharge({ subscriptionId: g.subscriptionId, paymentId: g.chargePaymentId, refundId, amountMinor, note: note || request.reason })
      : await createRefund(g.orderId, { refundId, amountMinor, note: note || request.reason });
  } catch (error) {
    const message = error instanceof CashfreeError ? `Cashfree refused the refund: ${error.message}` : 'The refund could not be requested.';
    await unscoped('approve-failed', () =>
      RefundRequest.updateOne({ _id: request._id, 'refund.refundId': refundId }, { $set: { status: 'failed', 'refund.status': 'failed', 'refund.providerStatus': message.slice(0, 200) } }),
    );
    if (request.source === 'registration') await mirrorRegistration({ ...claimed, refund: { ...claimed.refund, status: 'failed' } }, 'failed');
    throw new BillingError(error instanceof CashfreeError && error.status < 500 ? 409 : 502, 'REFUND_FAILED', message);
  }

  if (endSubscription) await endSubscriptionFor(claimed, actor).catch((e) => console.error('[refund] subscription not ended:', (e as Error).message));
  if (claimed.orgId) void sendEventNotice(String(claimed.orgId), 'refund_approved', { metadata: { amountMinor } });
  const saved = await writeRefundStatus(claimed, refund);
  return { request: requestView(saved), duplicate: false };
}

export async function declineRefundRequest(id: string, input: { note?: unknown }, actor: Actor & { email?: string }) {
  const { RefundRequest } = models();
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 1000) : '';
  if (note.length < 3) throw new BillingError(400, 'REASON_REQUIRED', 'Say why the refund is declined; the requester is shown it.', { field: 'note' });
  const saved = await unscoped('decline', () =>
    RefundRequest.findOneAndUpdate(
      { _id: oid(id), status: 'open' },
      { $set: { status: 'declined', decision: { by: { id: actor.id, email: actor.email }, at: new Date(), note } } },
      { new: true },
    ).lean(),
  );
  if (!saved) {
    const current = await loadRequest(id);
    throw new BillingError(409, 'REFUND_REQUEST_DECIDED', `This request is already ${current.status}.`, { status: current.status });
  }
  if (saved.orgId) void sendEventNotice(String(saved.orgId), 'refund_declined', { metadata: { note } });
  return { request: requestView(saved) };
}

/** Ask Cashfree where a refund has got to (staff "check", or a refund webhook). */
export async function refreshRefundRequest(id: string) {
  const request = await loadRequest(id);
  if (!request.refund?.refundId) throw new BillingError(409, 'NO_REFUND', 'No refund has been requested yet.');
  if (request.refund.status !== 'pending') return { request: requestView(request) };
  const g = request.gateway ?? {};
  try {
    const refund = g.kind === 'mandate' ? await getMandateRefund(g.subscriptionId, request.refund.refundId) : await getRefund(g.orderId, request.refund.refundId);
    return { request: requestView(await writeRefundStatus(request, refund)) };
  } catch (error) {
    if (error instanceof CashfreeError) throw new BillingError(502, 'GATEWAY_ERROR', `Cashfree: ${error.message}`);
    throw error;
  }
}

/** A refund webhook, by our refund id. */
export async function refreshByRefundId(refundId: string) {
  const { RefundRequest } = models();
  const found = await unscoped('by-refund-id', () => RefundRequest.findOne({ 'refund.refundId': refundId }).select('_id').lean());
  return found ? refreshRefundRequest(String(found._id)) : null;
}

// ── Effects ────────────────────────────────────────────────────────────────

/** Record Cashfree's answer; on the move to success, add the amount to the ledger once. */
async function writeRefundStatus(request: Doc, refund: CashfreeRefund): Promise<Doc> {
  const { RefundRequest } = models();
  const status = refundStatusOf(refund.refund_status);
  const set: Doc = {
    'refund.status': status,
    'refund.providerStatus': String(refund.refund_status ?? ''),
    ...(refund.cf_refund_id !== undefined ? { 'refund.cfRefundId': String(refund.cf_refund_id) } : {}),
    ...(refund.refund_arn ? { 'refund.arn': String(refund.refund_arn) } : {}),
  };
  if (status === 'success') Object.assign(set, { status: 'refunded', 'refund.processedAt': refund.processed_at ? new Date(refund.processed_at) : new Date() });
  if (status === 'failed') set.status = 'failed';
  // Only the write that moves the refund out of `pending` applies its effects.
  const moved = await unscoped('refund-status', () =>
    RefundRequest.findOneAndUpdate({ _id: request._id, 'refund.refundId': request.refund.refundId, 'refund.status': 'pending' }, { $set: set }, { new: true }).lean(),
  );
  const saved = moved ?? (await loadRequest(String(request._id)));
  if (moved && status !== 'pending') {
    if (status === 'success') await addToLedger(saved);
    if (saved.source === 'registration') await mirrorRegistration(saved, status);
    if (status === 'success' && saved.orgId) void sendEventNotice(String(saved.orgId), 'refund_completed', { metadata: { amountMinor: saved.refund.amountMinor, arn: saved.refund.arn } });
  } else if (moved && saved.source === 'registration') {
    await mirrorRegistration(saved, 'pending');
  }
  return saved;
}

async function addToLedger(request: Doc) {
  const { Payment, Invoice } = models();
  const amount = Number(request.refund?.amountMinor ?? 0);
  if (!(amount > 0)) return;
  if (request.paymentId) await unscoped('ledger-payment', () => Payment.updateOne({ _id: request.paymentId }, { $inc: { refundedMinor: amount } }));
  if (request.invoiceId && request.paymentId) await unscoped('ledger-invoice', () => Invoice.updateOne({ _id: request.invoiceId }, { $inc: { refundedMinor: amount } }));
}

/** The application's payment carries the refund too: a refunded payment is never used at approval. */
async function mirrorRegistration(request: Doc, status: 'pending' | 'success' | 'failed') {
  const { RegistrationPayment } = models();
  await unscoped('mirror', () =>
    RegistrationPayment.updateOne(
      { _id: request.registrationPaymentId },
      {
        $set: {
          refund: {
            refundId: request.refund.refundId,
            attempt: request.refund.attempt,
            cfRefundId: request.refund.cfRefundId,
            status,
            providerStatus: request.refund.providerStatus,
            amountMinor: request.refund.amountMinor,
            reason: request.decision?.note || request.reason,
            arn: request.refund.arn,
            requestedAt: request.refund.requestedAt,
            processedAt: request.refund.processedAt,
            requestedBy: request.decision?.by,
            refundRequestId: String(request._id),
          },
        },
      },
    ),
  );
}

/** A refund that ends the service the payment bought: the subscription is cancelled now. */
async function endSubscriptionFor(request: Doc, actor: Actor) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { transition } = require('../subscriptions/service');
  await transition(String(request.orgId), 'cancel', { actor, reason: `Refund approved (${(request.refund.amountMinor / 100).toFixed(2)} INR): ${request.decision?.note || request.reason}`.slice(0, 1000) });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { cancelAutopayFor } = require('./autopay');
  await cancelAutopayFor(String(request.orgId), actor, 'Subscription ended by a refund').catch(() => undefined);
}

// ── Reads ──────────────────────────────────────────────────────────────────

export async function listRefundRequests(query: { status?: string; orgId?: string; limit?: number } = {}) {
  const { RefundRequest, OrganizationRegistration } = models();
  const filter: Doc = {};
  if (query.status === 'open') filter.status = { $in: ['open', 'failed'] };
  else if (query.status) filter.status = query.status;
  if (query.orgId && mongoose.Types.ObjectId.isValid(query.orgId)) filter.orgId = query.orgId;
  const rows: Doc[] = await unscoped('list', () => RefundRequest.find(filter).sort({ createdAt: -1 }).limit(Math.min(query.limit ?? 200, 500)).lean());
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Org = require('../../models/Org').default;
  const [orgs, regs] = (await unscoped('list-context', () =>
    Promise.all([
      Org.find({ _id: { $in: rows.map((r) => r.orgId).filter(Boolean) } }).select('name slug').lean(),
      OrganizationRegistration.find({ _id: { $in: rows.map((r) => r.registrationId).filter(Boolean) } }).select('organizationName email status').lean(),
    ]),
  )) as Doc[][];
  const orgById = new Map(orgs.map((o) => [String(o._id), o]));
  const regById = new Map(regs.map((r) => [String(r._id), r]));
  return rows.map((r) => ({
    ...requestView(r),
    organization: r.orgId ? orgById.get(String(r.orgId)) ?? null : null,
    registration: r.registrationId ? regById.get(String(r.registrationId)) ?? null : null,
  }));
}

export async function orgRefundRequests(orgId: string) {
  const { RefundRequest } = models();
  const rows: Doc[] = await unscoped('org-list', () => RefundRequest.find({ orgId }).sort({ createdAt: -1 }).limit(100).lean());
  return rows.map(requesterView);
}

/**
 * An organization's own payments for its Billing page: each with whether it
 * can be refunded online, what the policy gives on it now, and the request
 * already raised on it.
 */
export async function orgPaymentsWithRefunds(orgId: string, now = new Date()) {
  const { Payment, Invoice, RefundRequest } = models();
  const rows: Doc[] = await unscoped('org-payments', () =>
    Payment.find({ orgId, status: 'confirmed' }).sort({ receivedAt: -1 }).limit(100).lean(),
  );
  const invoices: Doc[] = await unscoped('org-payments-invoices', () =>
    Invoice.find({ _id: { $in: rows.map((r) => r.invoiceId).filter(Boolean) } }).select('number').lean(),
  );
  const numberOf = new Map(invoices.map((i) => [String(i._id), i.number as string | undefined]));
  const requests: Doc[] = await unscoped('org-payments-requests', () =>
    RefundRequest.find({ paymentId: { $in: rows.map((r) => r._id) } }).sort({ createdAt: -1 }).lean(),
  );
  const latest = new Map<string, Doc>();
  for (const r of requests) if (!latest.has(String(r.paymentId))) latest.set(String(r.paymentId), r);
  const out = [];
  for (const p of rows) {
    const refundedMinor = Number(p.refundedMinor ?? 0);
    const online = p.provider === 'cashfree';
    let quote: Doc | null = null;
    if (online && refundedMinor < p.amountMinor) {
      quote = await refundQuote({ paymentId: String(p._id) }, now).catch(() => null);
    }
    const request = latest.get(String(p._id)) ?? null;
    out.push({
      id: String(p._id),
      amountMinor: p.amountMinor as number,
      refundedMinor,
      method: p.method as string,
      provider: p.provider as string,
      reference: p.reference as string,
      receivedAt: p.receivedAt,
      periodStart: p.periodStart ?? null,
      periodEnd: p.periodEnd ?? null,
      invoiceId: p.invoiceId ? String(p.invoiceId) : null,
      invoiceNumber: p.invoiceId ? numberOf.get(String(p.invoiceId)) ?? null : null,
      onlineRefund: online,
      canRequest: online && refundedMinor < p.amountMinor && !(request && ['open', 'refunding'].includes(request.status)),
      policy: quote ? { amountMinor: quote.amountMinor, rule: quote.rule, explanation: quote.explanation } : null,
      request: requesterView(request),
    });
  }
  return out;
}

export async function latestForRegistrationPayment(registrationPaymentId: unknown) {
  const { RefundRequest } = models();
  return unscoped('latest-rp', () => RefundRequest.findOne({ registrationPaymentId }).sort({ createdAt: -1 }).lean()) as Promise<Doc | null>;
}

export async function requestsForRegistration(registrationId: string) {
  const { RefundRequest } = models();
  if (!mongoose.Types.ObjectId.isValid(registrationId)) return [];
  const rows: Doc[] = await unscoped('for-reg', () => RefundRequest.find({ registrationId }).sort({ createdAt: -1 }).lean());
  return rows.map(requestView);
}

export async function openRefundRequestCount(): Promise<number> {
  const { RefundRequest } = models();
  return unscoped('count-open', () => RefundRequest.countDocuments({ status: { $in: ['open', 'failed'] } }));
}
