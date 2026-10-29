/**
 * Paying for a plan while applying — the Cashfree checkout on the public
 * institute application, and what happens to that money afterwards.
 *
 *   applicant chooses a plan ─▶ Review ─▶ checkout (a Cashfree order, terms frozen)
 *                                              │
 *                       browser returns / webhook arrives / staff press "check"
 *                                              │
 *                                  syncOrder: ask Cashfree, never the browser
 *                                              │ PAID
 *                              record it ─▶ submit the application (PENDING)
 *                                              │
 *          console: staff approve ─▶ organization created ─▶ this payment becomes
 *          its Payment (provider cashfree) and starts the subscription ACTIVE on
 *          the paid plan ─▶ staff can issue the (already paid) invoice
 *
 *          console: staff reject ─▶ the payment can be refunded through Cashfree
 *
 * ── Guarantees ───────────────────────────────────────────────────────────────
 *  - Paid is decided by Cashfree's own answer to a server-side request, with
 *    the amount and currency checked against what this order was created for.
 *    A browser can at most ask us to look again.
 *  - An application whose plan has a price cannot be submitted unpaid; one on a
 *    custom-priced plan (Enterprise) is submitted without payment, as before.
 *  - Once paid, the plan and billing interval on the application are locked to
 *    what was paid for.
 *  - The plan, lines and tax are frozen when the order is created; the invoice
 *    prints them, not whatever the catalogue says later.
 *  - A payment is applied to an organization once (Payment is unique on
 *    provider + org + Cashfree payment id), invoiced once (a claim on this
 *    record), and refunded only before it has been applied.
 *
 * ── Switches ─────────────────────────────────────────────────────────────────
 *  No Cashfree keys at all            payments off: the application behaves as
 *                                     before (plan preference, trial at approval)
 *  REGISTRATION_PAYMENTS=off          the same, deliberately
 *  Keys present but wrong for the     payments required but unavailable: nothing
 *  environment (see cashfree.ts)      is submitted unpaid by accident
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import { withoutTenantScope } from '../tenancy/context';
import { ensureVersioned, listPublicPlans } from '../subscriptions/catalogue';
import { BILLING_INTERVALS, type BillingInterval } from '../subscriptions/lifecycle';
import { recordManualPayment, updateSubscriptionShape, type Actor } from '../subscriptions/service';
import { BillingError, getBillingProfile, getInvoice, issuePaidInvoice, updateOrgBilling } from './invoices';
import { computeTax, GST_STATE_CODES, gstinProblem, isStateCode, TaxInputError } from './gst';
import {
  CashfreeError,
  cashfreeConfig,
  cashfreeKeysPresent,
  cashfreePhone,
  checkPaidOrder,
  createOrder,
  methodOfPaymentGroup,
  terminateOrder,
} from './cashfree';

type Doc = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unscoped = (label: string, fn: () => any): Promise<any> => withoutTenantScope(`registration-payment:${label}`, fn) as Promise<any>;
const models = () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RegistrationPayment: require('../../models/RegistrationPayment').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  OrganizationRegistration: require('../../models/OrganizationRegistration').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ProviderEvent: require('../../models/ProviderEvent').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Payment: require('../../models/Payment').default,
});

/** How long a checkout order can be paid. Long enough for a UPI app round trip and a retry. */
const ORDER_LIFETIME_MS = 60 * 60 * 1000;
/** A pending order is reused only if it has at least this long left. */
const REUSE_MARGIN_MS = 15 * 60 * 1000;
const CLAIM_MS = 2 * 60 * 1000;

export class PaymentRequired extends Error {
  readonly code = 'PAYMENT_REQUIRED';
  constructor(message = 'Complete the payment for your plan to submit the application.') {
    super(message);
    this.name = 'PaymentRequired';
  }
}

// ── Mode ───────────────────────────────────────────────────────────────────

export type PaymentsMode = 'on' | 'off' | 'unavailable';

/** on: take payments. off: no gateway configured (or switched off). unavailable: configured wrongly. */
export function paymentsMode(env: NodeJS.ProcessEnv = process.env): PaymentsMode {
  if (String(env.REGISTRATION_PAYMENTS ?? '').trim().toLowerCase() === 'off') return 'off';
  if (!cashfreeKeysPresent(env)) return 'off';
  return cashfreeConfig(env).configured ? 'on' : 'unavailable';
}

// ── Pure rules ─────────────────────────────────────────────────────────────

const STATE_ALIASES: Record<string, string> = {
  newdelhi: '07', delhincr: '07', nctofdelhi: '07', orissa: '21', pondicherry: '34', jk: '01',
  jammukashmir: '01', uttaranchal: '05', andaman: '35', daman: '26', diu: '26', dadranagarhaveli: '26',
};
const squash = (value: string) => value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
const STATE_BY_NAME = new Map(Object.entries(GST_STATE_CODES).map(([code, name]) => [squash(name), code]));

/**
 * The applicant's GST state (place of supply): from a valid GSTIN first — it
 * names its state — else from the state they typed. Null when neither says.
 */
export function buyerStateCodeOf(input: { gstNumber?: unknown; state?: unknown }): string | null {
  const gstin = String(input.gstNumber ?? '').trim().toUpperCase();
  if (gstin && !gstinProblem(gstin)) return gstin.slice(0, 2);
  const typed = String(input.state ?? '').trim();
  if (!typed) return null;
  if (isStateCode(typed)) return typed;
  const key = squash(typed);
  return STATE_BY_NAME.get(key) ?? STATE_ALIASES[key.replace(/and/g, '')] ?? STATE_ALIASES[key] ?? null;
}

export function intervalOf(value: unknown): BillingInterval {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'annual' || v === 'yearly') return 'annual';
  return (BILLING_INTERVALS as string[]).includes(v) ? (v as BillingInterval) : 'monthly';
}

export interface PlanPrice {
  name: string;
  price: { monthly?: number; annual?: number; setupFee?: number; currency?: string };
}

/** The price of a plan for an interval, in rupees, or null when it has none. */
export function planPriceFor(plan: PlanPrice, interval: BillingInterval): number | null {
  const raw = interval === 'annual' ? plan.price?.annual : plan.price?.monthly;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What a checkout charges: the plan for one interval from activation, the
 * setup fee once (an applicant has never paid before), and GST only when the
 * platform's billing profile has a GSTIN and a rate — exactly the rules an
 * invoice follows (core/billing/gst). Throws BillingError when GST applies and
 * the applicant's state is unknown, because the place of supply decides it.
 */
export function quoteLines(plan: PlanPrice, interval: BillingInterval, profile: Doc, buyerStateCode: string | null) {
  const price = planPriceFor(plan, interval);
  if (price === null) {
    throw new BillingError(409, 'PRICE_REQUIRED', `${plan.name} cannot be bought ${interval === 'annual' ? 'yearly' : 'monthly'}.`, {
      field: 'commercial.billingInterval',
    });
  }
  const sacCode = profile.sacCode ? String(profile.sacCode) : undefined;
  const line = (description: string, rupees: number) => {
    const minor = Math.round(rupees * 100);
    return { description, quantity: 1, unitPriceMinor: minor, amountMinor: minor, ...(sacCode ? { sacCode } : {}) };
  };
  const lines = [
    line(`${plan.name} plan — ${interval === 'annual' ? 'yearly' : 'monthly'} subscription (one ${interval === 'annual' ? 'year' : 'month'} from activation)`, price),
  ];
  const setupFee = Number(plan.price?.setupFee ?? 0);
  if (Number.isFinite(setupFee) && setupFee > 0) lines.push(line('One-time setup fee', setupFee));
  const linesTotalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);
  let tax;
  try {
    tax = computeTax({
      linesTotalMinor,
      ratePercent: profile.gstRatePercent,
      sellerGstin: profile.gstin,
      sellerStateCode: profile.stateCode,
      buyerStateCode: buyerStateCode ?? undefined,
      inclusive: profile.planPricesIncludeGst,
    });
  } catch (error) {
    if (error instanceof TaxInputError && error.code === 'BUYER_STATE_REQUIRED') {
      throw new BillingError(400, 'BILLING_STATE_REQUIRED', 'Tell us which state your institute is in — it decides the GST on your payment.', {
        field: 'core.state',
      });
    }
    if (error instanceof TaxInputError) throw new BillingError(503, 'BILLING_PROFILE_INCOMPLETE', 'Online payment is not available right now. Please try again later.');
    throw error;
  }
  return {
    lines,
    subtotalMinor: tax.subtotalMinor,
    tax: {
      regime: tax.regime,
      ...(tax.ratePercent !== undefined ? { ratePercent: tax.ratePercent } : {}),
      ...(tax.inclusive !== undefined ? { inclusive: tax.inclusive } : {}),
      ...(tax.placeOfSupply ? { placeOfSupply: tax.placeOfSupply } : {}),
      cgstMinor: tax.cgstMinor,
      sgstMinor: tax.sgstMinor,
      igstMinor: tax.igstMinor,
      totalMinor: tax.totalTaxMinor,
    },
    totalMinor: tax.totalMinor,
  };
}

/** Our Cashfree order id: unguessable, 3–45 characters of [A-Za-z0-9_-]. */
export function newOrderId(now = new Date()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(16);
  let random = '';
  for (const b of bytes) random += alphabet[b % alphabet.length];
  return `ag_${now.getTime().toString(36)}_${random}`;
}

/**
 * Where Cashfree sends the browser back: the address the page asked for, with
 * `{order_id}` filled in — but only on the page's own origin, which the
 * browser set and CORS has already allowed. Anything else gets no return URL
 * (the modal checkout does not need one).
 */
export function returnUrlFor(requested: unknown, origin: unknown, orderId: string): string | undefined {
  const raw = String(requested ?? '').trim();
  const from = String(origin ?? '').trim();
  if (!raw || !from) return undefined;
  let url: URL;
  let base: URL;
  try {
    url = new URL(raw.replace(/\{order_id\}/g, 'ORDERID'));
    base = new URL(from);
  } catch {
    return undefined;
  }
  if (url.origin !== base.origin) return undefined;
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return undefined;
  const out = url.toString().replace(/ORDERID/g, encodeURIComponent(orderId));
  return out.length <= 250 ? out : undefined;
}

/** A Cashfree refund status in our three. */
export function refundStatusOf(providerStatus: unknown): 'pending' | 'success' | 'failed' {
  const s = String(providerStatus ?? '').toUpperCase();
  if (s === 'SUCCESS') return 'success';
  // Order refunds say CANCELLED / REJECTED; mandate refunds CANCEL / FAILED.
  if (s === 'CANCELLED' || s === 'REJECTED' || s === 'CANCEL' || s === 'FAILED') return 'failed';
  return 'pending';
}

/** The payment that counts for a registration: paid, and not refunded (or refund failed). */
export function isEffective(record: Doc): boolean {
  return record.status === 'paid' && (!record.refund || record.refund.status === 'failed');
}

// ── Reads ──────────────────────────────────────────────────────────────────

const minorOf = (rupees: unknown) => Math.round(Number(rupees) * 100);

/** The applicant's quotable reference — the same rule as everywhere (registrations.publicReference). */
function publicReference(registration: Doc): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../platform/registrations').publicReference(registration);
}

export async function effectivePayment(registrationId: string | mongoose.Types.ObjectId): Promise<Doc | null> {
  const { RegistrationPayment } = models();
  const rows: Doc[] = await unscoped('effective', () =>
    RegistrationPayment.find({ registrationId, status: 'paid' }).sort({ paidAt: 1, _id: 1 }).lean(),
  );
  return rows.find(isEffective) ?? null;
}

type OfferedPlan = Awaited<ReturnType<typeof listPublicPlans>>[number];

export interface PaymentRequirement {
  mode: PaymentsMode;
  required: boolean;
  /** payable: pay before submitting. custom: agreed with the team. no-plan: choose one. unpriced: not sold for this interval. */
  reason: 'off' | 'no-plans' | 'no-plan' | 'custom' | 'unpriced' | 'payable';
  plan: OfferedPlan | null;
  interval: BillingInterval;
  message: string;
}

/** Whether this application must be paid for before it can be submitted, and for what. */
export async function paymentRequirement(registration: Doc): Promise<PaymentRequirement> {
  const mode = paymentsMode();
  const commercial = (registration.application?.commercial ?? {}) as Doc;
  const interval = intervalOf(commercial.billingInterval);
  const base = { mode, plan: null, interval };
  if (mode === 'off') return { ...base, required: false, reason: 'off', message: 'Online payment is not enabled.' };
  const plans = await listPublicPlans();
  if (!plans.length) return { ...base, required: false, reason: 'no-plans', message: 'No plans are on sale.' };
  const key = String(commercial.planPreference ?? '').trim().toLowerCase();
  const plan = plans.find((p) => p.key === key) ?? null;
  if (!plan) return { ...base, required: true, reason: 'no-plan', message: key ? 'That plan is no longer offered. Choose another.' : 'Choose a plan.' };
  if (plan.customPricing) {
    return { ...base, plan, required: false, reason: 'custom', message: `${plan.name} is priced with our team — no payment is taken now.` };
  }
  if (planPriceFor(plan as PlanPrice, interval) === null) {
    return { ...base, plan, required: true, reason: 'unpriced', message: `${plan.name} cannot be bought ${interval === 'annual' ? 'yearly' : 'monthly'}.` };
  }
  return { ...base, plan, required: true, reason: 'payable', message: `Pay for ${plan.name} to submit your application.` };
}

/** What the applicant's own page shows about a payment. Never the session id of a paid order, never staff fields. */
export function applicantView(record: Doc | null) {
  if (!record) return null;
  return {
    orderId: record.orderId as string,
    status: record.status as string,
    planKey: record.planKey as string,
    planName: record.planName as string,
    billingInterval: record.billingInterval as string,
    lines: record.lines,
    subtotalMinor: record.subtotalMinor as number,
    tax: record.tax,
    totalMinor: record.totalMinor as number,
    paidAt: record.paidAt ?? null,
    method: record.payment?.method ?? null,
    reference: record.payment?.cfPaymentId ?? null,
    lastAttempt: record.status === 'paid' ? null : record.lastAttempt ?? null,
    refunded: Boolean(record.refund && record.refund.status !== 'failed'),
  };
}

/** The draft's payment panel: what is due, whether it is paid, and how to pay. */
export async function applicantPaymentState(registration: Doc) {
  const requirement = await paymentRequirement(registration);
  const config = cashfreeConfig();
  const paid = await effectivePayment(registration._id);
  let quote: Doc | null = null;
  let quoteProblem: { code: string; message: string; field?: string } | null = null;
  if (!paid && requirement.reason === 'payable' && requirement.plan) {
    try {
      const profile = await getBillingProfile();
      const commercial = (registration.application?.commercial ?? {}) as Doc;
      quote = {
        planKey: requirement.plan.key,
        planName: requirement.plan.name,
        billingInterval: requirement.interval,
        ...quoteLines(requirement.plan as PlanPrice, requirement.interval, profile, buyerStateCodeOf({ gstNumber: commercial.gstNumber, state: registration.state })),
      };
    } catch (error) {
      if (!(error instanceof BillingError)) throw error;
      quoteProblem = { code: error.code, message: error.message, ...(error.details.field ? { field: String(error.details.field) } : {}) };
    }
  }
  return {
    mode: requirement.mode,
    environment: config.environment,
    required: requirement.required && !paid,
    reason: paid ? 'paid' : requirement.reason,
    message: paid ? 'Payment received.' : requirement.message,
    quote,
    quoteProblem,
    paid: applicantView(paid),
  };
}

// ── Talking to Cashfree ────────────────────────────────────────────────────

function gatewayError(error: unknown, publicMessage: string): BillingError {
  if (error instanceof CashfreeError) {
    console.error(`[registration-payment] Cashfree ${error.status} ${error.code}: ${error.message}`);
    return new BillingError(error.status === 503 ? 503 : 502, 'GATEWAY_ERROR', publicMessage, { gateway: { status: error.status, code: error.code, message: error.message } });
  }
  return error as BillingError;
}

/**
 * Bring one record in line with Cashfree. The ONLY path to `paid`: Cashfree
 * says the order is PAID, a SUCCESS payment exists, and both amounts and the
 * currency match what this order was created for. Returns the fresh record
 * and whether this call is the one that saw it paid.
 */
export async function syncOrder(record: Doc, by: 'applicant' | 'webhook' | 'staff' | 'system'): Promise<{ record: Doc; newlyPaid: boolean }> {
  const { RegistrationPayment } = models();
  if (record.status === 'paid') return { record, newlyPaid: false };
  const check = await checkPaidOrder(record.orderId, record.totalMinor, record.currency || 'INR', cashfreeConfig());
  const now = new Date();
  const providerStatus = check.state === 'paid' ? 'PAID' : check.state === 'mismatch' ? 'PAID_MISMATCH' : check.order.order_status;
  const checked = { lastCheckedAt: now, lastCheckedBy: by, providerStatus };

  if (check.state === 'mismatch') {
    // Money may have moved, but not the money this order asked for. Kept
    // visible for staff rather than called paid or quietly dropped.
    console.error(`[registration-payment] order ${record.orderId} is PAID at Cashfree but does not match (amount/currency/payment).`);
    const saved = await unscoped('mismatch', () => RegistrationPayment.findOneAndUpdate({ _id: record._id }, { $set: checked }, { new: true }).lean());
    return { record: saved ?? record, newlyPaid: false };
  }
  if (check.state === 'paid') {
    const success = check.payment;
    const saved = await unscoped('paid', () =>
      RegistrationPayment.findOneAndUpdate(
        { _id: record._id, status: { $ne: 'paid' } },
        {
          $set: {
            ...checked,
            status: 'paid',
            paidAt: check.paidAt,
            payment: {
              cfPaymentId: String(success.cf_payment_id),
              method: methodOfPaymentGroup(success.payment_group),
              group: success.payment_group ?? undefined,
              bankReference: success.bank_reference ?? undefined,
              message: success.payment_message ?? undefined,
              amountMinor: minorOf(success.payment_amount),
              paidAt: check.paidAt,
            },
          },
          $unset: { lastAttempt: 1 },
        },
        { new: true },
      ).lean(),
    );
    if (!saved) {
      const current = await unscoped('paid-current', () => RegistrationPayment.findById(record._id).lean());
      return { record: current ?? record, newlyPaid: false };
    }
    return { record: saved, newlyPaid: true };
  }

  const set: Doc = { ...checked };
  if (check.state === 'pending' && check.attempt) {
    const attempt = check.attempt;
    set.lastAttempt = {
      status: String(attempt.payment_status),
      message: attempt.error_details?.error_description || attempt.payment_message || undefined,
      at: new Date(attempt.payment_completion_time || attempt.payment_time || now),
    };
  } else if (check.state === 'closed' && record.status === 'pending') {
    set.status = 'expired';
  }
  const saved = await unscoped('sync', () =>
    RegistrationPayment.findOneAndUpdate({ _id: record._id, status: { $ne: 'paid' } }, { $set: set }, { new: true }).lean(),
  );
  return { record: saved ?? record, newlyPaid: false };
}

/** A payment has just been seen as paid: submit the application it is for, if it is still a draft. */
async function afterPaid(record: Doc) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { submitPaidApplication } = require('../platform/applications');
    return (await submitPaidApplication(String(record.registrationId))) as { submitted: boolean; status: string; fields?: Record<string, string> };
  } catch (error) {
    console.error(`[registration-payment] paid order ${record.orderId}: the application could not be submitted:`, (error as Error).message);
    return { submitted: false, status: 'DRAFT' };
  }
}

// ── The applicant's side ───────────────────────────────────────────────────

export interface CheckoutOptions {
  returnUrl?: unknown;
  origin?: unknown;
  ip?: string;
}

/**
 * Start (or resume) the checkout for a draft. The caller has proved the draft
 * token and that the draft is editable. Everything the submission needs is
 * checked BEFORE money is taken: paying for an application that cannot then
 * be submitted is the worst outcome this flow has.
 */
export async function startCheckout(registration: Doc, opts: CheckoutOptions = {}) {
  const { RegistrationPayment } = models();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { validateApplicationForSubmission } = require('../platform/applications');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { RegistrationValidationError } = require('../platform/registrations');

  const already = await effectivePayment(registration._id);
  if (already) return { alreadyPaid: true as const, payment: applicantView(already), submission: await afterPaid(already) };

  const fields = validateApplicationForSubmission(registration) as Record<string, string>;
  if (Object.keys(fields).length) throw new RegistrationValidationError(fields);

  const requirement = await paymentRequirement(registration);
  if (requirement.mode === 'unavailable') {
    console.error(`[registration-payment] payments are configured wrongly: ${cashfreeConfig().problem}`);
    throw new BillingError(503, 'PAYMENTS_UNAVAILABLE', 'Online payment is not available right now. Please try again later, or contact us.');
  }
  if (!requirement.required) throw new BillingError(409, 'PAYMENT_NOT_REQUIRED', requirement.message);
  if (requirement.reason !== 'payable' || !requirement.plan) {
    throw new RegistrationValidationError({
      [requirement.reason === 'unpriced' ? 'commercial.billingInterval' : 'commercial.planPreference']: requirement.message,
    });
  }
  const plan = requirement.plan;
  const interval = requirement.interval;
  const commercial = (registration.application?.commercial ?? {}) as Doc;
  const profile = await getBillingProfile();
  const quote = quoteLines(plan as PlanPrice, interval, profile, buyerStateCodeOf({ gstNumber: commercial.gstNumber, state: registration.state }));
  const planVersion = plan.version ?? (await ensureVersioned(plan.key));
  const config = cashfreeConfig();
  const now = new Date();

  // An open order for exactly these terms is reused; any other is checked
  // first (it may have been paid in another tab) and then retired.
  const pending: Doc[] = await unscoped('pending', () =>
    RegistrationPayment.find({ registrationId: registration._id, status: 'pending' }).select('+paymentSessionId').sort({ createdAt: -1 }).lean(),
  );
  for (const open of pending) {
    let synced: Doc = open;
    try {
      const result = await syncOrder(open, 'applicant');
      synced = result.record;
      if (synced.status === 'paid') {
        return { alreadyPaid: true as const, payment: applicantView(synced), submission: await afterPaid(synced) };
      }
    } catch (error) {
      // Cashfree unreachable for an old order: leave it pending, start a new one.
      console.error(`[registration-payment] could not check order ${open.orderId}:`, (error as Error).message);
      continue;
    }
    const sameTerms =
      synced.status === 'pending' &&
      synced.environment === config.environment &&
      synced.planKey === plan.key &&
      synced.planVersion === planVersion &&
      synced.billingInterval === interval &&
      synced.totalMinor === quote.totalMinor &&
      synced.expiresAt && new Date(synced.expiresAt).getTime() - now.getTime() > REUSE_MARGIN_MS &&
      open.paymentSessionId;
    if (sameTerms) {
      return {
        alreadyPaid: false as const,
        orderId: open.orderId as string,
        paymentSessionId: open.paymentSessionId as string,
        environment: config.environment,
        payment: applicantView(synced),
      };
    }
    if (synced.status === 'pending') {
      await unscoped('supersede', () => RegistrationPayment.updateOne({ _id: open._id, status: 'pending' }, { $set: { status: 'superseded' } }));
      void terminateOrder(open.orderId, config).catch(() => undefined);
    }
  }

  const phone = cashfreePhone(registration.phone);
  if (!phone) throw new RegistrationValidationError({ 'core.phone': 'Enter a valid mobile number — the payment page needs it.' });
  const orderId = newOrderId(now);
  const expiresAt = new Date(now.getTime() + ORDER_LIFETIME_MS);
  const created: Doc = (
    await unscoped('create', () =>
      RegistrationPayment.create({
        registrationId: registration._id,
        provider: 'cashfree',
        environment: config.environment,
        orderId,
        expiresAt,
        status: 'pending',
        planKey: plan.key,
        planVersion,
        planName: plan.name,
        billingInterval: interval,
        ...quote,
        currency: 'INR',
        customer: {
          name: registration.contactName,
          email: registration.email,
          phone: registration.phone,
          organizationName: registration.organizationName,
        },
        createdIp: opts.ip ? String(opts.ip).slice(0, 64) : undefined,
      }),
    )
  ).toObject();

  let order;
  try {
    order = await createOrder(
      {
        orderId,
        amountMinor: quote.totalMinor,
        currency: 'INR',
        customer: { id: `reg${String(registration._id)}`, name: registration.contactName, email: registration.email, phone },
        returnUrl: returnUrlFor(opts.returnUrl, opts.origin, orderId),
        notifyUrl: config.notifyUrl,
        expiresAt,
        note: `${plan.name} (${interval}) — ${String(registration.organizationName ?? '').slice(0, 120)}`,
        tags: { registration: String(registration._id), plan: plan.key, interval },
      },
      config,
    );
  } catch (error) {
    await unscoped('create-failed', () =>
      RegistrationPayment.updateOne({ _id: created._id }, { $set: { status: 'failed', providerStatus: (error as Error).message?.slice(0, 200) } }),
    );
    throw gatewayError(error, 'The payment could not be started right now. Please try again in a moment.');
  }
  if (!order?.payment_session_id) {
    await unscoped('no-session', () => RegistrationPayment.updateOne({ _id: created._id }, { $set: { status: 'failed', providerStatus: 'NO_SESSION' } }));
    throw new BillingError(502, 'GATEWAY_ERROR', 'The payment could not be started right now. Please try again in a moment.');
  }
  const saved = await unscoped('created', () =>
    RegistrationPayment.findOneAndUpdate(
      { _id: created._id },
      {
        $set: {
          cfOrderId: order.cf_order_id !== undefined ? String(order.cf_order_id) : undefined,
          paymentSessionId: order.payment_session_id,
          providerStatus: order.order_status,
          ...(order.order_expiry_time && !Number.isNaN(new Date(order.order_expiry_time).getTime())
            ? { expiresAt: new Date(order.order_expiry_time) }
            : {}),
        },
      },
      { new: true },
    ).lean(),
  );
  return {
    alreadyPaid: false as const,
    orderId,
    paymentSessionId: order.payment_session_id as string,
    environment: config.environment,
    payment: applicantView(saved ?? created),
  };
}

/**
 * "I am back from the payment page" — or the webhook, or staff. The order id
 * is the only key (the draft token is retired the moment a paid application is
 * submitted), and the answer is only ever what Cashfree says about it.
 */
export async function confirmOrder(orderId: string, by: 'applicant' | 'webhook' | 'staff' | 'system') {
  const { RegistrationPayment, OrganizationRegistration } = models();
  const id = String(orderId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{3,45}$/.test(id)) throw new BillingError(404, 'ORDER_NOT_FOUND', 'Payment not found.');
  const record: Doc | null = await unscoped('confirm-load', () => RegistrationPayment.findOne({ orderId: id }).lean());
  if (!record) throw new BillingError(404, 'ORDER_NOT_FOUND', 'Payment not found.');
  let current = record;
  let newlyPaid = false;
  if (record.status !== 'paid') {
    try {
      ({ record: current, newlyPaid } = await syncOrder(record, by));
    } catch (error) {
      throw gatewayError(error, 'We could not confirm the payment with the gateway just now. If money left your account, it is safe — try again in a minute.');
    }
  }
  // A paid order whose application is still a draft is submitted now — on
  // the first sighting, and on any later one (a retry after a failed submit).
  let submission: { submitted: boolean; status: string; fields?: Record<string, string> } | null = null;
  if (current.status === 'paid' && isEffective(current)) {
    const reg = await unscoped('confirm-reg', () => OrganizationRegistration.findById(current.registrationId).select('status').lean());
    if (newlyPaid || reg?.status === 'DRAFT') submission = await afterPaid(current);
  }
  const reg = await unscoped('confirm-reg-after', () =>
    OrganizationRegistration.findById(current.registrationId).select('status organizationName email submittedAt').lean(),
  );
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { latestForRegistrationPayment, requesterView } = require('./refundRequests');
  return {
    payment: applicantView(current),
    refundRequest: requesterView(await latestForRegistrationPayment(current._id)),
    registration: reg
      ? {
          reference: publicReference(reg),
          organizationName: reg.organizationName as string,
          email: reg.email as string,
          status: reg.status as string,
          submittedAt: reg.submittedAt ?? null,
        }
      : null,
    submission,
  };
}

/** The gate on submission: refused while a payable plan is unpaid. Returns the paid record, if any. */
export async function requirePaymentForSubmission(registration: Doc): Promise<Doc | null> {
  const paid = await effectivePayment(registration._id);
  if (paid) return paid;
  const requirement = await paymentRequirement(registration);
  if (!requirement.required) return null;
  if (requirement.mode === 'unavailable') {
    throw new BillingError(503, 'PAYMENTS_UNAVAILABLE', 'Online payment is not available right now, so the application cannot be submitted yet. Please try again later.');
  }
  if (requirement.reason !== 'payable') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RegistrationValidationError } = require('../platform/registrations');
    throw new RegistrationValidationError({
      [requirement.reason === 'unpriced' ? 'commercial.billingInterval' : 'commercial.planPreference']: requirement.message,
    });
  }
  throw new PaymentRequired();
}

// ── Approval: the payment becomes the organization's ───────────────────────

/** Fill the new organization's billing details from the application, where it has none. */
async function billingFromApplication(orgId: string, registration: Doc) {
  const commercial = (registration.application?.commercial ?? {}) as Doc;
  const gstin = String(commercial.gstNumber ?? '').trim().toUpperCase();
  const stateCode = buyerStateCodeOf({ gstNumber: gstin, state: registration.state });
  const patch: Doc = {
    legalName: String(commercial.legalEntityName || registration.application?.organization?.legalName || registration.organizationName || '').trim() || undefined,
    ...(gstin && !gstinProblem(gstin) ? { gstin } : {}),
    ...(stateCode ? { stateCode } : {}),
    email: String(commercial.billingEmail || registration.email || '').trim() || undefined,
    phone: String(registration.phone || '').trim() || undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Org = require('../../models/Org').default;
  const org = await unscoped('org-billing', () => Org.findById(orgId).select('billing').lean());
  const existing = (org?.billing ?? {}) as Doc;
  const missing = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && !existing[k]));
  if (Object.keys(missing).length) await updateOrgBilling(orgId, missing);
}

/**
 * Carry the paid checkout over to the organization approval just created:
 * record it as the organization's Payment (provider cashfree, reference =
 * Cashfree's payment id), which starts the subscription ACTIVE on the paid
 * plan for one interval from now; then switch off the plan's modules the
 * applicant chose not to have. Idempotent — an approval retried after a
 * partial run finds the payment already recorded and applied.
 */
export async function applyRegistrationPayment(record: Doc, orgId: string, registration: Doc, actor: Actor) {
  const { RegistrationPayment } = models();
  const step = (ok: boolean, detail: string) => ({ step: 'payment', ok, detail });
  if (!isEffective(record)) return step(false, 'The payment is not usable (refunded or not paid).');
  if (record.orgId && String(record.orgId) !== String(orgId)) {
    return step(false, `This payment was already applied to another organization (${record.orgId}).`);
  }
  try {
    await billingFromApplication(orgId, registration).catch((error) =>
      console.error('[registration-payment] billing details not copied:', (error as Error).message),
    );
    const result = await recordManualPayment(
      orgId,
      {
        amount: record.totalMinor / 100,
        currency: record.currency || 'INR',
        method: record.payment?.method ?? 'other',
        reference: String(record.payment?.cfPaymentId ?? record.orderId),
        receivedAt: record.payment?.paidAt ?? record.paidAt,
        billingInterval: record.billingInterval,
        notes: `Paid online with the application (Cashfree order ${record.orderId}).`,
      },
      actor,
      { provider: 'cashfree', plan: { planKey: record.planKey, planVersion: record.planVersion } },
    );

    // The plan's modules the applicant switched off on the form. Only keys
    // the plan includes; everything else is ignored.
    const excluded: string[] = Array.isArray(registration.application?.modules?.excluded)
      ? registration.application.modules.excluded.map(String)
      : [];
    const plan = (await listPublicPlans()).find((p) => p.key === record.planKey);
    const planModules = new Set((plan?.modules ?? []).map((m: { key: string }) => m.key));
    const removals = [...new Set(excluded.filter((k) => planModules.has(k)))];
    if (removals.length && !record.appliedAt) {
      await updateSubscriptionShape(orgId, { removals }, actor).catch((error) =>
        console.error('[registration-payment] module choices not applied:', (error as Error).message),
      );
    }

    await unscoped('applied', () =>
      RegistrationPayment.updateOne(
        { _id: record._id },
        { $set: { orgId, appliedAt: record.appliedAt ?? new Date(), paymentId: result.payment?._id }, $unset: { applyError: 1 } },
      ),
    );
    // Where Cashfree holds this money — what a later refund is sent against.
    if (result.payment?._id) {
      await unscoped('payment-gateway', () =>
        models().Payment.updateOne({ _id: result.payment._id }, { $set: { gateway: { kind: 'order', orderId: record.orderId } } }),
      );
    }
    const until = result.subscription?.periodEnd ?? result.payment?.periodEnd;
    return step(
      true,
      `${record.planName} (${record.billingInterval}) paid online — active${until ? ` until ${new Date(until).toISOString().slice(0, 10)}` : ''}${removals.length ? `; switched off as chosen: ${removals.join(', ')}` : ''}.`,
    );
  } catch (error) {
    const message = (error as Error).message?.slice(0, 500) ?? 'The payment could not be applied.';
    await unscoped('apply-failed', () => RegistrationPayment.updateOne({ _id: record._id }, { $set: { applyError: message } }));
    return step(false, `Payment not applied: ${message}`);
  }
}

// ── The console's side ─────────────────────────────────────────────────────

/** Everything staff see about one payment — never the checkout session id. */
export function staffView(record: Doc): Doc & { id: string; effective: boolean; refundable: boolean; invoiceable: boolean } {
  const { paymentSessionId: _session, ...rest } = record;
  void _session;
  return {
    ...rest,
    id: String(record._id),
    effective: isEffective(record),
    // Before approval: refunded in full. After: as the organization's payment, by the policy.
    refundable: record.status === 'paid' && (!record.refund || record.refund.status === 'failed'),
    invoiceable: Boolean(record.appliedAt && record.paymentId && !record.invoiceId),
  };
}

export type PaymentSummary = {
  state: 'paid' | 'applied' | 'refund_pending' | 'refunded' | 'pending' | 'failed' | 'none';
  totalMinor?: number;
  planName?: string;
  billingInterval?: string;
  paidAt?: Date | null;
  environment?: string;
  count: number;
};

/** One line per registration for the queue: the payment that matters most. */
export function summarize(records: Doc[]): PaymentSummary {
  if (!records.length) return { state: 'none', count: 0 };
  const pick = (r: Doc, state: PaymentSummary['state']): PaymentSummary => ({
    state,
    totalMinor: r.totalMinor,
    planName: r.planName,
    billingInterval: r.billingInterval,
    paidAt: r.paidAt ?? null,
    environment: r.environment,
    count: records.length,
  });
  const effective = records.find(isEffective);
  if (effective) return pick(effective, effective.appliedAt ? 'applied' : 'paid');
  const refunded = records.find((r) => r.status === 'paid' && r.refund);
  if (refunded) return pick(refunded, refunded.refund.status === 'success' ? 'refunded' : 'refund_pending');
  const pending = records.find((r) => r.status === 'pending');
  if (pending) return pick(pending, 'pending');
  return pick(records[0], 'failed');
}

export async function paymentSummariesFor(registrationIds: unknown[]): Promise<Map<string, PaymentSummary>> {
  const { RegistrationPayment } = models();
  const ids = registrationIds.map(String).filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!ids.length) return new Map();
  const rows: Doc[] = await unscoped('summaries', () =>
    RegistrationPayment.find({ registrationId: { $in: ids } }).sort({ createdAt: -1 }).lean(),
  );
  const byReg = new Map<string, Doc[]>();
  for (const r of rows) {
    const key = String(r.registrationId);
    byReg.set(key, [...(byReg.get(key) ?? []), r]);
  }
  return new Map([...byReg.entries()].map(([k, list]) => [k, summarize(list)]));
}

export async function paymentsForRegistration(registrationId: string) {
  const { RegistrationPayment } = models();
  if (!mongoose.Types.ObjectId.isValid(registrationId)) return [];
  const rows: Doc[] = await unscoped('for-registration', () =>
    RegistrationPayment.find({ registrationId }).sort({ createdAt: -1 }).limit(50).lean(),
  );
  return rows.map(staffView);
}

/** Online payments across registrations, newest first. ?status=paid|pending|refunded|… */
export async function listRegistrationPayments(query: { status?: string; limit?: number } = {}) {
  const { RegistrationPayment, OrganizationRegistration } = models();
  const filter: Doc = {};
  if (query.status === 'refunded') filter.refund = { $exists: true };
  else if (query.status) filter.status = query.status;
  const rows: Doc[] = await unscoped('list', () =>
    RegistrationPayment.find(filter).sort({ createdAt: -1 }).limit(Math.min(query.limit ?? 200, 500)).lean(),
  );
  const regs: Doc[] = await unscoped('list-regs', () =>
    OrganizationRegistration.find({ _id: { $in: rows.map((r) => r.registrationId) } })
      .select('organizationName contactName email status orgId orgSlug')
      .lean(),
  );
  const byId = new Map(regs.map((r) => [String(r._id), r]));
  return rows.map((r) => {
    const reg = byId.get(String(r.registrationId));
    return {
      ...staffView(r),
      registration: reg
        ? {
            id: String(reg._id),
            reference: publicReference(reg),
            organizationName: reg.organizationName as string,
            contactName: reg.contactName as string,
            email: reg.email as string,
            status: reg.status as string,
            orgId: reg.orgId ? String(reg.orgId) : null,
          }
        : null,
    };
  });
}

async function loadRecord(id: string): Promise<Doc> {
  const { RegistrationPayment } = models();
  if (!mongoose.Types.ObjectId.isValid(id)) throw new BillingError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  const record = await unscoped('load', () => RegistrationPayment.findById(id).lean());
  if (!record) throw new BillingError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  return record;
}

/** Staff: ask Cashfree again (an applicant who closed the tab before coming back). */
export async function refreshRegistrationPayment(id: string) {
  const record = await loadRecord(id);
  const result = await confirmOrder(record.orderId, 'staff').catch((error) => {
    if (error instanceof BillingError && error.details?.gateway) {
      const g = error.details.gateway as Doc;
      throw new BillingError(error.status, error.code, `Cashfree: ${g.message} (${g.status})`, error.details);
    }
    throw error;
  });
  const fresh = await loadRecord(id);
  if (fresh.refund?.status === 'pending') await refreshRefund(id).catch(() => undefined);
  return { payment: staffView(await loadRecord(id)), submission: result.submission };
}

/**
 * Staff: refund this payment now — a refund request raised and approved by
 * the same person (core/billing/refundRequests). Before approval it is always
 * the full amount; after approval it is the organization's payment, refunded
 * by the amount given (default: what the refund policy suggests).
 */
export async function refundRegistrationPayment(
  id: string,
  input: { reason?: unknown; amount?: unknown; endSubscription?: unknown },
  actor: Actor & { email?: string },
) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { raiseRefundRequest } = require('./refundRequests');
  const record = await loadRecord(id);
  const result = await raiseRefundRequest(
    { registrationPaymentId: String(record._id) },
    { reason: input.reason, amount: input.amount },
    { kind: 'platform', id: actor.id, email: actor.email },
    { approveAs: actor, approveNote: typeof input.reason === 'string' ? input.reason : undefined, endSubscription: input.endSubscription },
  );
  return { payment: staffView(await loadRecord(id)), request: result.request, duplicate: result.duplicate };
}

/** Staff (or the webhook): where this payment's refund has got to. */
export async function refreshRefund(id: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { latestForRegistrationPayment, refreshRefundRequest } = require('./refundRequests');
  const record = await loadRecord(id);
  const request = await latestForRegistrationPayment(record._id);
  if (!request?.refund?.refundId) throw new BillingError(409, 'NO_REFUND', 'No refund has been requested for this payment.');
  const result = await refreshRefundRequest(String(request._id));
  return { payment: staffView(await loadRecord(id)), request: result.request };
}

/**
 * Staff: issue the invoice for a payment that has been applied. Already paid
 * the moment it is issued; numbered from the same sequence as every invoice;
 * printing the lines and tax the institute was charged. Once per payment.
 */
export async function invoiceRegistrationPayment(id: string, actor: Actor) {
  const { RegistrationPayment, Payment, OrganizationRegistration } = models();
  const record = await loadRecord(id);
  if (record.invoiceId) return { invoice: await getInvoice(String(record.invoiceId)), duplicate: true };
  if (!record.appliedAt || !record.orgId || !record.paymentId) {
    throw new BillingError(409, 'NOT_APPLIED', 'Approve the application first — the invoice is issued to the organization approval creates.');
  }
  const profile = await getBillingProfile();
  if (!String(profile.legalName ?? '').trim()) {
    throw new BillingError(409, 'SELLER_PROFILE_REQUIRED', 'Add the platform\'s legal name under Billing → Seller profile first; it is printed on every invoice.');
  }
  const now = new Date();
  const claimed: Doc | null = await unscoped('invoice-claim', () =>
    RegistrationPayment.findOneAndUpdate(
      {
        _id: record._id,
        invoiceId: { $exists: false },
        $or: [{ invoicingAt: null }, { invoicingAt: { $exists: false } }, { invoicingAt: { $lt: new Date(now.getTime() - CLAIM_MS) } }],
      },
      { $set: { invoicingAt: now } },
      { new: true },
    ).lean(),
  );
  if (!claimed) {
    const fresh = await loadRecord(id);
    if (fresh.invoiceId) return { invoice: await getInvoice(String(fresh.invoiceId)), duplicate: true };
    throw new BillingError(409, 'INVOICE_IN_PROGRESS', 'The invoice is being issued by someone else. Reload in a moment.');
  }
  try {
    const [payment, registration] = await Promise.all([
      unscoped('invoice-payment', () => Payment.findById(record.paymentId).lean()),
      unscoped('invoice-reg', () => OrganizationRegistration.findById(record.registrationId).select('_id').lean()),
    ]);
    const invoice = await issuePaidInvoice(
      {
        orgId: String(record.orgId),
        lines: record.lines,
        subtotalMinor: record.subtotalMinor,
        tax: record.tax,
        totalMinor: record.totalMinor,
        currency: record.currency,
        planKey: record.planKey,
        planVersion: record.planVersion,
        billingInterval: record.billingInterval,
        periodStart: payment?.periodStart,
        periodEnd: payment?.periodEnd,
        paymentId: String(record.paymentId),
        paidAt: record.payment?.paidAt ?? record.paidAt ?? now,
        registrationId: registration ? String(registration._id) : undefined,
        notes: `Paid online with the application — Cashfree payment ${record.payment?.cfPaymentId ?? '—'}, order ${record.orderId}.`,
      },
      actor,
    );
    await unscoped('invoice-link', () =>
      RegistrationPayment.updateOne({ _id: record._id }, { $set: { invoiceId: invoice._id, invoicingAt: null } }),
    );
    return { invoice, duplicate: false };
  } catch (error) {
    await unscoped('invoice-release', () => RegistrationPayment.updateOne({ _id: record._id, invoiceId: { $exists: false } }, { $set: { invoicingAt: null } }));
    throw error;
  }
}
