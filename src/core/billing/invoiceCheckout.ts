/**
 * An institute paying an invoice online — a renewal, an upgrade it ordered, or
 * an invoice staff issued — through the same Cashfree checkout the public
 * application uses.
 *
 *   Pay now ─▶ Cashfree order for the invoice's balance ─▶ checkout
 *                       │
 *       the admin returns / webhook / staff "check" ─▶ checkPaidOrder
 *                       │ paid, for exactly that amount
 *       settleInvoice(provider cashfree) ─▶ plan applied or extended,
 *                                            invoice paid, notice sent
 *
 * Settlement is the existing `settleInvoice`: an institute's own order moves it
 * onto the plan it names; a renewal extends the period from where it ended.
 * Money Cashfree took for an invoice that was already paid (another tab, or
 * auto-pay first) becomes an approved refund, never a second period.
 */

import mongoose from 'mongoose';
import { withoutTenantScope } from '../tenancy/context';
import { BillingError, getBillingProfile, issueInvoice, settleInvoice } from './invoices';
import { cashfreeConfig, cashfreePhone, checkPaidOrder, createOrder, methodOfPaymentGroup, terminateOrder, CashfreeError } from './cashfree';
import { newOrderId, paymentsMode, returnUrlFor } from './registrationPayments';
import type { Actor } from '../subscriptions/service';

type Doc = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unscoped = (label: string, fn: () => any): Promise<any> => withoutTenantScope(`invoice-checkout:${label}`, fn) as Promise<any>;
const models = () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  InvoiceCheckout: require('../../models/InvoiceCheckout').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Invoice: require('../../models/Invoice').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Org: require('../../models/Org').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Payment: require('../../models/Payment').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  AutopayMandate: require('../../models/AutopayMandate').default,
});

const ORDER_LIFETIME_MS = 60 * 60 * 1000;
const REUSE_MARGIN_MS = 15 * 60 * 1000;
const PROVIDER_ACTOR: Actor = { kind: 'system', id: 'provider:cashfree' };
const minorOf = (rupees: unknown) => Math.round(Number(rupees) * 100);

export function checkoutView(record: Doc | null) {
  if (!record) return null;
  return {
    orderId: record.orderId as string,
    invoiceId: String(record.invoiceId),
    invoiceNumber: record.invoiceNumber ?? null,
    status: record.status as string,
    amountMinor: record.amountMinor as number,
    paidAt: record.paidAt ?? null,
    settled: Boolean(record.settledAt),
    reference: record.payment?.cfPaymentId ?? null,
    method: record.payment?.method ?? null,
    lastAttempt: record.status === 'paid' ? null : record.lastAttempt ?? null,
    settleError: record.settleError ?? null,
  };
}

/** The phone and email Cashfree needs for the payer, from what the platform knows. */
export async function payerOf(orgId: string, actorEmail?: string) {
  const { Org } = models();
  const org = await unscoped('payer-org', () => Org.findById(orgId).select('name billing profile').lean());
  if (!org) throw new BillingError(404, 'ORG_NOT_FOUND', 'Organization not found.');
  const phone = cashfreePhone(String(org.billing?.phone || org.profile?.contactPhone || ''));
  if (!phone) {
    throw new BillingError(400, 'BILLING_PHONE_REQUIRED', 'Add a phone number under Billing details first — the payment page needs one.', { field: 'phone' });
  }
  return { name: org.name as string, email: String(actorEmail || org.billing?.email || org.profile?.contactEmail || ''), phone };
}

/** A pending auto-pay charge for this invoice, if any: paying another way now would pay twice. */
async function pendingCharge(invoiceId: unknown) {
  const { AutopayMandate } = models();
  const m = await unscoped('pending-charge', () =>
    AutopayMandate.findOne({ charges: { $elemMatch: { invoiceId, status: 'pending' } } }).lean(),
  );
  return m ? m.charges.find((c: Doc) => String(c.invoiceId) === String(invoiceId) && c.status === 'pending') : null;
}

/**
 * Open (or reopen) the checkout for one of the organization's own invoices.
 * A draft of the institute's own order is issued first, when the platform's
 * seller details exist; an invoice already being charged to auto-pay is not
 * offered a second way to pay.
 */
export async function startInvoiceCheckout(
  orgId: string,
  invoiceId: string,
  opts: { returnUrl?: unknown; origin?: unknown; actor: Actor & { email?: string } },
) {
  const mode = paymentsMode();
  if (mode !== 'on') {
    throw new BillingError(503, 'PAYMENTS_UNAVAILABLE', mode === 'off' ? 'Online payment is not enabled.' : 'Online payment is not available right now. Please try again later.');
  }
  const { Invoice, InvoiceCheckout } = models();
  if (!mongoose.Types.ObjectId.isValid(invoiceId)) throw new BillingError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
  let invoice: Doc | null = await unscoped('invoice', () => Invoice.findById(invoiceId).lean());
  // Another organization's invoice answers exactly like a missing one.
  if (!invoice || String(invoice.orgId) !== String(orgId)) throw new BillingError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
  if (invoice.status === 'paid') throw new BillingError(409, 'INVOICE_ALREADY_PAID', 'This invoice has already been paid.');
  if (invoice.status === 'void') throw new BillingError(409, 'INVOICE_VOID', 'This invoice was cancelled.');
  if (invoice.status === 'draft') {
    const profile = await getBillingProfile();
    if (invoice.origin !== 'self-serve' || !String(profile.legalName ?? '').trim()) {
      throw new BillingError(409, 'INVOICE_NOT_READY', 'This invoice is still being prepared by the platform team. You can pay it once it is issued.');
    }
    await issueInvoice(String(invoice._id), opts.actor);
    invoice = await unscoped('invoice-issued', () => Invoice.findById(invoiceId).lean());
  }
  const balance = invoice!.totalMinor - (invoice!.amountPaidMinor ?? 0);
  if (!(balance >= 100)) throw new BillingError(409, 'NOTHING_TO_PAY', 'There is nothing left to pay on this invoice.');
  const charge = await pendingCharge(invoice!._id);
  if (charge) {
    throw new BillingError(409, 'AUTOPAY_SCHEDULED', `This invoice will be charged to your auto-pay on ${new Date(charge.scheduledFor).toLocaleDateString('en-IN')}. Turn auto-pay off first to pay another way.`);
  }

  const config = cashfreeConfig();
  const now = new Date();
  const open: Doc[] = await unscoped('pending', () =>
    InvoiceCheckout.find({ invoiceId: invoice!._id, status: 'pending' }).select('+paymentSessionId').sort({ createdAt: -1 }).lean(),
  );
  for (const p of open) {
    const synced = await syncInvoiceCheckout(p, 'tenant').catch(() => ({ record: p }));
    if (synced.record.status === 'paid') return { alreadyPaid: true as const, checkout: checkoutView(synced.record) };
    const reusable = synced.record.status === 'pending' && p.amountMinor === balance && p.environment === config.environment &&
      p.paymentSessionId && p.expiresAt && new Date(p.expiresAt).getTime() - now.getTime() > REUSE_MARGIN_MS;
    if (reusable) return { alreadyPaid: false as const, orderId: p.orderId as string, paymentSessionId: p.paymentSessionId as string, environment: config.environment, checkout: checkoutView(synced.record) };
    if (synced.record.status === 'pending') {
      await unscoped('supersede', () => InvoiceCheckout.updateOne({ _id: p._id, status: 'pending' }, { $set: { status: 'superseded' } }));
      void terminateOrder(p.orderId, config).catch(() => undefined);
    }
  }

  const payer = await payerOf(orgId, opts.actor.email);
  const orderId = newOrderId(now);
  const expiresAt = new Date(now.getTime() + ORDER_LIFETIME_MS);
  const created: Doc = (
    await unscoped('create', () =>
      InvoiceCheckout.create({
        orgId, invoiceId: invoice!._id, environment: config.environment, orderId, expiresAt, status: 'pending',
        amountMinor: balance, currency: invoice!.currency || 'INR', invoiceNumber: invoice!.number,
        createdBy: { id: opts.actor.id, email: opts.actor.email },
      }),
    )
  ).toObject();
  let order;
  try {
    order = await createOrder(
      {
        orderId,
        amountMinor: balance,
        currency: 'INR',
        customer: { id: `org${orgId}`, name: payer.name, email: payer.email, phone: payer.phone },
        returnUrl: returnUrlFor(opts.returnUrl, opts.origin, orderId),
        notifyUrl: config.notifyUrl,
        expiresAt,
        note: `Invoice ${invoice!.number ?? ''} — ${payer.name}`.slice(0, 200),
        tags: { kind: 'invoice', org: String(orgId), invoice: String(invoice!._id) },
      },
      config,
    );
  } catch (error) {
    await unscoped('create-failed', () => InvoiceCheckout.updateOne({ _id: created._id }, { $set: { status: 'failed', providerStatus: (error as Error).message?.slice(0, 200) } }));
    if (error instanceof CashfreeError) console.error(`[invoice-checkout] Cashfree ${error.status} ${error.code}: ${error.message}`);
    throw new BillingError(502, 'GATEWAY_ERROR', 'The payment could not be started right now. Please try again in a moment.');
  }
  await unscoped('created', () =>
    InvoiceCheckout.updateOne(
      { _id: created._id },
      { $set: { cfOrderId: order.cf_order_id !== undefined ? String(order.cf_order_id) : undefined, paymentSessionId: order.payment_session_id, providerStatus: order.order_status } },
    ),
  );
  if (!order.payment_session_id) throw new BillingError(502, 'GATEWAY_ERROR', 'The payment could not be started right now. Please try again in a moment.');
  return { alreadyPaid: false as const, orderId, paymentSessionId: order.payment_session_id as string, environment: config.environment, checkout: checkoutView(created) };
}

/** Ask Cashfree about one invoice checkout; settle the invoice the first time it is seen paid. */
export async function syncInvoiceCheckout(record: Doc, by: 'tenant' | 'webhook' | 'staff' | 'system'): Promise<{ record: Doc }> {
  const { InvoiceCheckout } = models();
  if (record.status === 'paid') {
    if (!record.settledAt) await settleCheckout(record);
    return { record: await unscoped('reload', () => InvoiceCheckout.findById(record._id).lean()) };
  }
  const check = await checkPaidOrder(record.orderId, record.amountMinor, record.currency || 'INR');
  const now = new Date();
  const base = { lastCheckedAt: now, lastCheckedBy: by };
  if (check.state === 'paid') {
    const p = check.payment;
    const saved = await unscoped('paid', () =>
      InvoiceCheckout.findOneAndUpdate(
        { _id: record._id, status: { $ne: 'paid' } },
        {
          $set: {
            ...base, status: 'paid', providerStatus: 'PAID', paidAt: check.paidAt,
            payment: {
              cfPaymentId: String(p.cf_payment_id), method: methodOfPaymentGroup(p.payment_group), group: p.payment_group ?? undefined,
              bankReference: p.bank_reference ?? undefined, message: p.payment_message ?? undefined, amountMinor: minorOf(p.payment_amount), paidAt: check.paidAt,
            },
          },
          $unset: { lastAttempt: 1 },
        },
        { new: true },
      ).lean(),
    );
    const current = saved ?? (await unscoped('paid-reload', () => InvoiceCheckout.findById(record._id).lean()));
    if (current && !current.settledAt) await settleCheckout(current);
    return { record: await unscoped('reload', () => InvoiceCheckout.findById(record._id).lean()) };
  }
  const set: Doc = { ...base, providerStatus: check.state === 'mismatch' ? 'PAID_MISMATCH' : check.order.order_status };
  if (check.state === 'pending' && check.attempt) {
    set.lastAttempt = {
      status: String(check.attempt.payment_status),
      message: check.attempt.error_details?.error_description || check.attempt.payment_message || undefined,
      at: new Date(check.attempt.payment_completion_time || check.attempt.payment_time || now),
    };
  }
  if (check.state === 'closed' && record.status === 'pending') set.status = 'expired';
  if (check.state === 'mismatch') console.error(`[invoice-checkout] order ${record.orderId} is PAID at Cashfree but does not match.`);
  const saved = await unscoped('sync', () => InvoiceCheckout.findOneAndUpdate({ _id: record._id, status: { $ne: 'paid' } }, { $set: set }, { new: true }).lean());
  return { record: saved ?? record };
}

/** Settle the invoice with the payment Cashfree confirmed. Money for an already-paid invoice is refunded. */
async function settleCheckout(record: Doc) {
  const { InvoiceCheckout, Payment } = models();
  try {
    const result = await settleInvoice(
      String(record.invoiceId),
      {
        amount: record.amountMinor / 100,
        method: record.payment?.method ?? 'other',
        reference: String(record.payment?.cfPaymentId ?? record.orderId),
        receivedAt: record.payment?.paidAt ?? record.paidAt,
        notes: `Paid online (Cashfree order ${record.orderId}).`,
      },
      PROVIDER_ACTOR,
      'cashfree',
    );
    if (result.payment?._id) {
      await unscoped('gateway', () => Payment.updateOne({ _id: result.payment._id }, { $set: { gateway: { kind: 'order', orderId: record.orderId } } }));
    }
    await unscoped('settled', () =>
      InvoiceCheckout.updateOne({ _id: record._id }, { $set: { settledAt: new Date(), paymentId: result.payment?._id }, $unset: { settleError: 1 } }),
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'INVOICE_ALREADY_PAID' || code === 'INVOICE_VOID') {
      await refundDuplicate(record, code === 'INVOICE_VOID' ? 'The invoice was cancelled before this payment arrived.' : 'The invoice had already been paid another way.');
      return;
    }
    await unscoped('settle-failed', () => InvoiceCheckout.updateOne({ _id: record._id }, { $set: { settleError: (error as Error).message?.slice(0, 500) } }));
    console.error(`[invoice-checkout] order ${record.orderId} paid but not settled:`, (error as Error).message);
  }
}

async function refundDuplicate(record: Doc, why: string) {
  const { InvoiceCheckout } = models();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { raiseRefundRequest } = require('./refundRequests');
  await raiseRefundRequest(
    { duplicate: { orgId: String(record.orgId), invoiceId: String(record.invoiceId), amountMinor: record.amountMinor, gateway: { kind: 'order', orderId: record.orderId, cfPaymentId: record.payment?.cfPaymentId }, reason: why } },
    { reason: `Duplicate payment: ${why}` },
    { kind: 'system', id: 'billing:duplicate' },
    { approveAs: { kind: 'system', id: 'billing:duplicate' }, approveNote: 'Refunded automatically: the invoice was already settled.' },
  ).catch((e: Error) => console.error(`[invoice-checkout] duplicate on ${record.orderId} not refunded:`, e.message));
  await unscoped('duplicate', () => InvoiceCheckout.updateOne({ _id: record._id }, { $set: { settledAt: new Date(), settleError: `Duplicate — refunded: ${why}` } }));
}

/** The institute coming back from paying (or a webhook): by order id, within the organization. */
export async function confirmInvoiceCheckout(orderId: string, by: 'tenant' | 'webhook' | 'staff' | 'system', scopeOrgId?: string) {
  const { InvoiceCheckout } = models();
  const id = String(orderId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{3,45}$/.test(id)) throw new BillingError(404, 'ORDER_NOT_FOUND', 'Payment not found.');
  const record: Doc | null = await unscoped('confirm-load', () => InvoiceCheckout.findOne({ orderId: id }).lean());
  if (!record || (scopeOrgId && String(record.orgId) !== String(scopeOrgId))) throw new BillingError(404, 'ORDER_NOT_FOUND', 'Payment not found.');
  try {
    const { record: fresh } = await syncInvoiceCheckout(record, by);
    return { checkout: checkoutView(fresh) };
  } catch (error) {
    if (error instanceof CashfreeError) {
      throw new BillingError(502, 'GATEWAY_ERROR', 'We could not confirm the payment with the gateway just now. If money left your account it is safe — try again in a minute.');
    }
    throw error;
  }
}

export async function isInvoiceCheckout(orderId: string): Promise<boolean> {
  const { InvoiceCheckout } = models();
  return Boolean(await unscoped('is', () => InvoiceCheckout.exists({ orderId })));
}

/** For the console: online invoice payments, newest first. */
export async function listInvoiceCheckouts(query: { orgId?: string; status?: string; limit?: number } = {}) {
  const { InvoiceCheckout, Org } = models();
  const filter: Doc = {};
  if (query.status) filter.status = query.status;
  if (query.orgId && mongoose.Types.ObjectId.isValid(query.orgId)) filter.orgId = query.orgId;
  const rows: Doc[] = await unscoped('list', () => InvoiceCheckout.find(filter).sort({ createdAt: -1 }).limit(Math.min(query.limit ?? 200, 500)).lean());
  const orgs: Doc[] = await unscoped('list-orgs', () => Org.find({ _id: { $in: rows.map((r) => r.orgId) } }).select('name slug').lean());
  const byId = new Map(orgs.map((o) => [String(o._id), o]));
  return rows.map((r) => ({ ...checkoutView(r), id: String(r._id), orgId: String(r.orgId), organization: byId.get(String(r.orgId)) ?? null, environment: r.environment, createdAt: r.createdAt }));
}
