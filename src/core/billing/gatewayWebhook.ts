/**
 * Every Cashfree webhook, one endpoint (routes/api/paymentWebhookRoutes.ts):
 *
 *   PAYMENT_* (an order)       registration checkout → confirmOrder
 *                              invoice checkout      → confirmInvoiceCheckout
 *   REFUND_*                   the refund request with that refund id → refresh
 *   SUBSCRIPTION_* (mandates)  the mandate and its charge → sync (core/billing/autopay)
 *
 * The signature (base64 HMAC-SHA256 of timestamp + raw body, with the secret)
 * and a time window are checked first; each event is stored once
 * (ProviderEvent, provider `cashfree`). Then the event is only a prompt: what
 * is recorded is Cashfree's answer to our own request, never the body's claims.
 */

import crypto from 'crypto';
import { withoutTenantScope } from '../tenancy/context';
import { BillingError } from './invoices';
import { cashfreeConfig, verifyWebhookSignature, webhookTime } from './cashfree';

type Doc = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unscoped = (label: string, fn: () => any): Promise<any> => withoutTenantScope(`cashfree-webhook:${label}`, fn) as Promise<any>;

const tolerance = () => {
  const v = Number(process.env.CASHFREE_WEBHOOK_TOLERANCE_MS);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
};

/** What the event is about, for the idempotency key and the routing. Pure. */
export function webhookSubject(body: Doc) {
  const type = String(body?.type ?? 'UNKNOWN').slice(0, 80);
  const data = body?.data ?? {};
  const orderId = String(data?.order?.order_id ?? data?.refund?.order_id ?? '').slice(0, 45);
  const subscriptionId = String(data?.subscription_id ?? data?.subscription_details?.subscription_id ?? '').slice(0, 250);
  const refundId = String(data?.refund?.refund_id ?? data?.refund_id ?? '').slice(0, 64);
  const reference = String(data?.payment?.cf_payment_id ?? data?.cf_payment_id ?? data?.refund?.cf_refund_id ?? data?.payment_id ?? '').slice(0, 64);
  const status = String(data?.payment?.payment_status ?? data?.payment_status ?? data?.subscription_details?.subscription_status ?? data?.refund?.refund_status ?? data?.refund_status ?? '').slice(0, 40);
  const kind: 'mandate' | 'refund' | 'order' | 'unknown' = type.startsWith('SUBSCRIPTION_')
    ? 'mandate'
    : type.includes('REFUND')
      ? 'refund'
      : orderId
        ? 'order'
        : 'unknown';
  // One event per (type, subject, reference, status): a status change of the
  // same object is a new event; the same delivery again is not.
  const eventId = `${type}:${orderId || subscriptionId}:${refundId || reference}:${status}`.slice(0, 200);
  return { type, kind, orderId, subscriptionId, refundId, reference, eventId, data };
}

export async function handleCashfreeWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, now = new Date()) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ProviderEvent = require('../../models/ProviderEvent').default;
  const config = cashfreeConfig();
  if (!config.secretKey) throw new BillingError(503, 'GATEWAY_NOT_CONFIGURED', 'Payments are not configured.');
  const timestamp = headers['x-webhook-timestamp'];
  if (!verifyWebhookSignature(rawBody, timestamp, headers['x-webhook-signature'], config.secretKey)) {
    throw new BillingError(401, 'SIGNATURE_INVALID', 'The webhook signature could not be verified.');
  }
  const at = webhookTime(timestamp);
  if (!at || Math.abs(now.getTime() - at.getTime()) > tolerance()) {
    throw new BillingError(400, 'EVENT_STALE', 'The event is outside the accepted time window.');
  }
  let body: Doc;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new BillingError(400, 'EVENT_INVALID', 'The event body is not JSON.');
  }
  const subject = webhookSubject(body);
  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  let stored: Doc;
  try {
    stored = (
      await unscoped('store', () =>
        ProviderEvent.create({
          provider: 'cashfree',
          eventId: subject.eventId,
          type: subject.type,
          occurredAt: at,
          reference: subject.reference || undefined,
          payloadHash,
          status: 'received',
        }),
      )
    ).toObject();
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    const existing = await unscoped('existing', () => ProviderEvent.findOne({ provider: 'cashfree', eventId: subject.eventId }).lean());
    if (existing?.status !== 'failed') return { duplicate: true, outcome: existing?.outcome ?? null };
    stored = existing;
  }
  const finish = (status: 'processed' | 'rejected' | 'failed', outcome: string) =>
    unscoped('finish', () => ProviderEvent.updateOne({ _id: stored._id }, { $set: { status, outcome: outcome.slice(0, 500), processedAt: new Date() } }));

  try {
    const outcome = await route(subject);
    await finish(outcome.handled ? 'processed' : 'rejected', outcome.what);
    return { duplicate: false, outcome: outcome.what };
  } catch (error) {
    await finish('failed', (error as Error).message ?? 'failed');
    throw error;
  }
}

async function route(subject: ReturnType<typeof webhookSubject>): Promise<{ handled: boolean; what: string }> {
  /* eslint-disable @typescript-eslint/no-var-requires */
  if (subject.kind === 'mandate') {
    const { onMandateWebhook } = require('./autopay');
    return { handled: true, what: await onMandateWebhook(subject.type, subject.data) };
  }
  if (subject.kind === 'refund') {
    const { refreshByRefundId } = require('./refundRequests');
    const result = subject.refundId ? await refreshByRefundId(subject.refundId) : null;
    return result ? { handled: true, what: `refund ${result.request.refund?.status}` } : { handled: false, what: `no refund request ${subject.refundId || '(none)'}` };
  }
  if (subject.kind === 'order') {
    const RegistrationPayment = require('../../models/RegistrationPayment').default;
    const registration = await unscoped('reg-order', () => RegistrationPayment.exists({ orderId: subject.orderId }));
    if (registration) {
      const { confirmOrder } = require('./registrationPayments');
      const result = await confirmOrder(subject.orderId, 'webhook');
      return { handled: true, what: `order ${result.payment?.status ?? '?'}${result.submission?.submitted ? ', application submitted' : ''}` };
    }
    const { confirmInvoiceCheckout, isInvoiceCheckout } = require('./invoiceCheckout');
    if (await isInvoiceCheckout(subject.orderId)) {
      const result = await confirmInvoiceCheckout(subject.orderId, 'webhook');
      return { handled: true, what: `invoice checkout ${result.checkout?.status ?? '?'}${result.checkout?.settled ? ', settled' : ''}` };
    }
    // Another integration on the same merchant account, or a test event.
    return { handled: false, what: `no order ${subject.orderId}` };
  }
  /* eslint-enable @typescript-eslint/no-var-requires */
  return { handled: false, what: `ignored ${subject.type}` };
}
