/**
 * Payment providers — the seam a gateway plugs into, without rewriting the
 * subscription logic.
 *
 * Today one provider exists: `manual` (platform staff confirm payments in the
 * console). It has no webhooks. A gateway is added by registering a provider
 * whose `verify` checks the webhook's signature against the provider's secret
 * and turns the raw body into a VerifiedProviderEvent. Everything after that is
 * shared and provider-neutral:
 *
 *   verify signature   → refused before anything is written
 *   replay window      → an event outside ±BILLING_WEBHOOK_TOLERANCE_MS is refused
 *   store once         → (provider, eventId) unique: a redelivery is a no-op
 *   settle             → the SAME settleInvoice / recordPaymentFailure staff use
 *   reconcile          → compare the provider's settlements with our payments
 *
 * No route exposes this yet: there is no provider to receive events from, and
 * a webhook route needs the raw request body (mounted before the JSON parser)
 * so the signature can be checked over the exact bytes received. Wiring both is
 * part of choosing a gateway. Nothing here can mark anything paid on a client's
 * say-so: only a verified event from a registered provider, or a staff member.
 */

import crypto from 'crypto';
import { withoutTenantScope } from '../tenancy/context';
import { settleInvoice, BillingError } from './invoices';
import { recordPaymentFailure, type Actor } from '../subscriptions/service';

export interface VerifiedProviderEvent {
  eventId: string;
  type: 'payment.succeeded' | 'payment.failed' | string;
  occurredAt: Date;
  invoiceId?: string;
  orgId?: string;
  /** The provider's own payment id — becomes Payment.reference. */
  reference: string;
  amountMinor?: number;
  currency?: string;
  method?: string;
  failureReason?: string;
}

export interface BillingProvider {
  key: string;
  displayName: string;
  supportsWebhooks: boolean;
  /** Throw when the signature is missing or wrong. Never trust a body that has not passed this. */
  verify?(rawBody: Buffer, headers: Record<string, string | undefined>): VerifiedProviderEvent;
}

const MANUAL: BillingProvider = { key: 'manual', displayName: 'Manual confirmation', supportsWebhooks: false };
const registry = new Map<string, BillingProvider>([[MANUAL.key, MANUAL]]);

export function registerProvider(provider: BillingProvider): void {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(provider.key)) throw new Error(`Invalid provider key "${provider.key}".`);
  if (registry.has(provider.key)) throw new Error(`Provider "${provider.key}" is already registered.`);
  if (provider.supportsWebhooks && typeof provider.verify !== 'function') {
    throw new Error(`Provider "${provider.key}" receives webhooks but has no verify().`);
  }
  registry.set(provider.key, provider);
}

/** For tests only: remove a provider registered by the test itself. */
export function unregisterProvider(key: string): void {
  if (key !== 'manual') registry.delete(key);
}

export function getProvider(key: string): BillingProvider | undefined {
  return registry.get(key);
}

export function listProviders() {
  return [...registry.values()].map(({ key, displayName, supportsWebhooks }) => ({ key, displayName, supportsWebhooks }));
}

const tolerance = () => {
  const v = Number(process.env.BILLING_WEBHOOK_TOLERANCE_MS);
  return Number.isFinite(v) && v > 0 ? v : 5 * 60 * 1000;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unscoped = (label: string, fn: () => any): Promise<any> => withoutTenantScope(`billing-provider:${label}`, fn) as Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ProviderEventModel = () => require('../../models/ProviderEvent').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PaymentModel = () => require('../../models/Payment').default;
const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

/**
 * Handle one webhook delivery from `providerKey`. Returns what happened; a
 * BillingError means the delivery was refused (bad signature, stale, unknown
 * provider) and NOTHING was written.
 */
export async function handleProviderWebhook(
  providerKey: string,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  now = new Date(),
) {
  const provider = registry.get(providerKey);
  if (!provider || !provider.supportsWebhooks || !provider.verify) {
    throw new BillingError(404, 'PROVIDER_UNKNOWN', 'No such payment provider.');
  }
  let event: VerifiedProviderEvent;
  try {
    event = provider.verify(rawBody, headers);
  } catch {
    throw new BillingError(401, 'SIGNATURE_INVALID', 'The webhook signature could not be verified.');
  }
  if (!event?.eventId || !(event.occurredAt instanceof Date) || Number.isNaN(event.occurredAt.getTime())) {
    throw new BillingError(400, 'EVENT_INVALID', 'The event is missing its id or time.');
  }
  if (Math.abs(now.getTime() - event.occurredAt.getTime()) > tolerance()) {
    throw new BillingError(400, 'EVENT_STALE', 'The event is outside the accepted time window (possible replay).');
  }

  const ProviderEvent = ProviderEventModel();
  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  let stored: Record<string, any>;
  try {
    stored = (
      await unscoped('store', () =>
        ProviderEvent.create({
          provider: provider.key,
          eventId: event.eventId,
          type: event.type,
          occurredAt: event.occurredAt,
          orgId: event.orgId,
          invoiceId: event.invoiceId,
          reference: event.reference,
          amountMinor: event.amountMinor,
          payloadHash,
          status: 'received',
        }),
      )
    ).toObject();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const existing = await unscoped('existing', () => ProviderEvent.findOne({ provider: provider.key, eventId: event.eventId }).lean());
    // A redelivery of an event that failed is tried once more, under a claim so
    // two redeliveries do not both retry it.
    const retry =
      existing?.status === 'failed'
        ? await unscoped('retry-claim', () =>
            ProviderEvent.findOneAndUpdate({ _id: existing._id, status: 'failed' }, { $set: { status: 'received' } }, { new: true }).lean(),
          )
        : null;
    if (!retry) return { duplicate: true, event: existing };
    stored = retry;
  }

  const actor: Actor = { kind: 'system', id: `provider:${provider.key}` };
  const finish = (status: 'processed' | 'rejected' | 'failed', outcome: string, paymentId?: unknown) =>
    unscoped('finish', () =>
      ProviderEvent.findOneAndUpdate(
        { _id: stored._id },
        { $set: { status, outcome: outcome.slice(0, 500), processedAt: new Date(), ...(paymentId ? { paymentId } : {}) } },
        { new: true },
      ).lean(),
    );

  try {
    if (event.type === 'payment.succeeded') {
      if (!event.invoiceId) return { duplicate: false, event: await finish('rejected', 'no invoice named') };
      const result = await settleInvoice(
        event.invoiceId,
        { amount: (event.amountMinor ?? 0) / 100, method: event.method ?? 'other', reference: event.reference, receivedAt: event.occurredAt },
        actor,
        provider.key,
      );
      if (event.orgId && String(result.invoice.orgId) !== String(event.orgId)) {
        // Settled already by the invoice id; a mismatching org claim is recorded for review.
        return { duplicate: false, event: await finish('processed', 'organization in the event does not match the invoice', result.payment?._id) };
      }
      return { duplicate: false, event: await finish('processed', result.duplicate ? 'already settled' : 'invoice settled', result.payment?._id), result };
    }
    if (event.type === 'payment.failed') {
      if (!event.orgId) return { duplicate: false, event: await finish('rejected', 'no organization named') };
      const result = await recordPaymentFailure(
        event.orgId,
        { reference: event.reference, method: event.method ?? 'other', amount: (event.amountMinor ?? 0) / 100, reason: event.failureReason || 'Reported failed by the provider' },
        actor,
        { provider: provider.key },
      );
      return { duplicate: false, event: await finish('processed', `failure recorded (${result.lifecycle})`, result.payment?._id), result };
    }
    return { duplicate: false, event: await finish('processed', `ignored event type ${event.type}`) };
  } catch (error) {
    // Rejected for a reason in the event itself (wrong amount, unknown invoice):
    // recorded, not retried. Anything else is a failure a redelivery retries.
    const known = error instanceof BillingError || (error as { code?: string })?.code;
    const status = known && (error as { status?: number }).status && (error as { status: number }).status < 500 ? 'rejected' : 'failed';
    return { duplicate: false, event: await finish(status, (error as Error).message) };
  }
}

export interface SettlementRow {
  reference: string;
  amountMinor: number;
}

/**
 * Compare a provider's settlement report with the payments recorded for it.
 * Reports differences; fixes nothing — a mismatch in money is a person's
 * decision.
 */
export async function reconcileProvider(providerKey: string, settlements: SettlementRow[], since: Date, until = new Date()) {
  const Payment = PaymentModel();
  const recorded: Record<string, any>[] = await unscoped('reconcile', () =>
    Payment.find({ provider: providerKey, status: 'confirmed', receivedAt: { $gte: since, $lte: until } }).lean(),
  );
  const byRef = new Map(recorded.map((p) => [p.reference, p]));
  const seen = new Set<string>();
  const matched: string[] = [];
  const amountMismatch: { reference: string; provider: number; recorded: number }[] = [];
  const missingHere: SettlementRow[] = [];
  for (const row of settlements) {
    seen.add(row.reference);
    const payment = byRef.get(row.reference);
    if (!payment) missingHere.push(row);
    else if (payment.amountMinor !== row.amountMinor) amountMismatch.push({ reference: row.reference, provider: row.amountMinor, recorded: payment.amountMinor });
    else matched.push(row.reference);
  }
  const missingAtProvider = recorded.filter((p) => !seen.has(p.reference)).map((p) => ({ reference: p.reference, amountMinor: p.amountMinor, paymentId: String(p._id) }));
  return { provider: providerKey, since, until, matched: matched.length, amountMismatch, missingHere, missingAtProvider, clean: !amountMismatch.length && !missingHere.length && !missingAtProvider.length };
}
