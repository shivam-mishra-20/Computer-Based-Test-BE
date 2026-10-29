/**
 * Cashfree Payment Gateway — the HTTP client and the pure rules around it.
 *
 * ── Environments ────────────────────────────────────────────────────────────
 *   CASHFREE_ENV                sandbox (default) | production — which pair is used
 *   CASHFREE_TEST_APP_ID        sandbox client id      (Merchant Dashboard → Switch to Test)
 *   CASHFREE_TEST_SECRET_KEY    sandbox secret
 *   CASHFREE_PROD_APP_ID        production client id
 *   CASHFREE_PROD_SECRET_KEY    production secret
 *   CASHFREE_APP_ID / CASHFREE_SECRET_KEY
 *                               a single pair, used for whichever environment
 *                               has no pair of its own
 *   CASHFREE_API_VERSION        x-api-version (default 2025-01-01)
 *   CASHFREE_NOTIFY_URL         the public HTTPS address of our webhook, optional
 *
 * Both pairs can sit in the environment at once; switching CASHFREE_ENV is
 * the whole change from testing to taking real money. Secrets are sent only
 * to Cashfree, never to a client.
 *
 * Sandbox and production keys are different pairs, and each says which it is:
 * a test app id starts with "TEST" and a secret with `cfsk_ma_test_` (live:
 * `cfsk_ma_prod_`). A pair that does not match the environment it is pointed
 * at is refused before any order is created — a test key against the
 * production host, or a live key against the sandbox, is a configuration
 * mistake that would otherwise surface as a confusing 401.
 *
 * ── What this file trusts ───────────────────────────────────────────────────
 * Nothing a browser says. The checkout page only ever receives the order's
 * `payment_session_id`; whether an order was paid is learnt by asking Cashfree
 * from the server (`getOrder` + `getOrderPayments`). The webhook is verified by
 * its signature and then used only as a prompt to ask Cashfree again.
 */

import crypto from 'crypto';

export type CashfreeEnvironment = 'sandbox' | 'production';

const HOSTS: Record<CashfreeEnvironment, string> = {
  sandbox: 'https://sandbox.cashfree.com/pg',
  production: 'https://api.cashfree.com/pg',
};

export const DEFAULT_API_VERSION = '2025-01-01';

export interface CashfreeConfig {
  environment: CashfreeEnvironment;
  baseUrl: string;
  apiVersion: string;
  appId: string;
  secretKey: string;
  notifyUrl: string | null;
  /** Keys are present and match the environment. */
  configured: boolean;
  /** Why it is not usable, in words for an operator. Never contains a key. */
  problem: string | null;
}

function environmentOf(value: unknown): CashfreeEnvironment | null {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || v === 'sandbox' || v === 'test') return 'sandbox';
  if (v === 'production' || v === 'prod' || v === 'live') return 'production';
  return null;
}

/** Read from the environment each call, so a test can switch it. */
/** The key pair for an environment: its own pair, else the single shared one. */
export function credentialsFor(environment: CashfreeEnvironment, env: NodeJS.ProcessEnv = process.env) {
  const v = (name: string) => String(env[name] ?? '').trim();
  const own = environment === 'production'
    ? { appId: v('CASHFREE_PROD_APP_ID'), secretKey: v('CASHFREE_PROD_SECRET_KEY'), names: 'CASHFREE_PROD_APP_ID / CASHFREE_PROD_SECRET_KEY' }
    : { appId: v('CASHFREE_TEST_APP_ID'), secretKey: v('CASHFREE_TEST_SECRET_KEY'), names: 'CASHFREE_TEST_APP_ID / CASHFREE_TEST_SECRET_KEY' };
  if (own.appId || own.secretKey) return own;
  return { appId: v('CASHFREE_APP_ID'), secretKey: v('CASHFREE_SECRET_KEY'), names: 'CASHFREE_APP_ID / CASHFREE_SECRET_KEY' };
}

/** Which environment a key pair belongs to, by Cashfree's own markers; null when they disagree or say nothing. */
export function keyEnvironment(appId: string, secretKey: string): CashfreeEnvironment | null {
  const idTest = /^TEST/i.test(appId);
  const secret = /^cfsk_ma_test_/.test(secretKey) ? 'sandbox' : /^cfsk_ma_prod_/.test(secretKey) ? 'production' : null;
  if (secret === 'sandbox' && !idTest) return null;
  if (secret === 'production' && idTest) return null;
  return secret ?? (idTest ? 'sandbox' : 'production');
}

/** True when any Cashfree key is present at all (payments are meant to be on). */
export function cashfreeKeysPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY', 'CASHFREE_TEST_APP_ID', 'CASHFREE_TEST_SECRET_KEY', 'CASHFREE_PROD_APP_ID', 'CASHFREE_PROD_SECRET_KEY']
    .some((name) => String(env[name] ?? '').trim());
}

export function cashfreeConfig(env: NodeJS.ProcessEnv = process.env): CashfreeConfig {
  const environment = environmentOf(env.CASHFREE_ENV);
  const resolved = environment ?? 'sandbox';
  const { appId, secretKey, names } = credentialsFor(resolved, env);
  const notify = String(env.CASHFREE_NOTIFY_URL ?? '').trim();
  // Test-only: a local stand-in for Cashfree. Ignored in production.
  const override = environment !== 'production' ? String(env.CASHFREE_BASE_URL ?? '').trim().replace(/\/+$/, '') : '';

  let problem: string | null = null;
  if (!environment) problem = `CASHFREE_ENV must be "sandbox" or "production", not "${String(env.CASHFREE_ENV)}".`;
  else if (!appId || !secretKey) problem = `${names} are not both set.`;
  else {
    const keys = keyEnvironment(appId, secretKey);
    if (!keys) problem = `${names} do not match each other: one is a test key and the other a live one.`;
    else if (keys !== resolved) {
      problem = resolved === 'sandbox'
        ? `CASHFREE_ENV is sandbox but ${names} are production keys. Add the sandbox pair as CASHFREE_TEST_APP_ID and CASHFREE_TEST_SECRET_KEY (Merchant Dashboard → Switch to Test → Developers → API Keys).`
        : `CASHFREE_ENV is production but ${names} are sandbox (test) keys. Add the live pair as CASHFREE_PROD_APP_ID and CASHFREE_PROD_SECRET_KEY.`;
    }
  }
  return {
    environment: resolved,
    baseUrl: override || HOSTS[resolved],
    apiVersion: String(env.CASHFREE_API_VERSION ?? '').trim() || DEFAULT_API_VERSION,
    appId,
    secretKey,
    notifyUrl: /^https:\/\//i.test(notify) ? notify.slice(0, 250) : null,
    configured: !problem,
    problem,
  };
}

/** What an operator may see about the gateway: no key material. */
export function cashfreeStatus(env: NodeJS.ProcessEnv = process.env) {
  const c = cashfreeConfig(env);
  return {
    provider: 'cashfree',
    environment: c.environment,
    configured: c.configured,
    problem: c.problem,
    apiVersion: c.apiVersion,
    webhook: Boolean(c.notifyUrl),
  };
}

export class CashfreeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CashfreeError';
  }
}

const TIMEOUT_MS = 15_000;

async function call<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  opts: { idempotencyKey?: string; config?: CashfreeConfig } = {},
): Promise<T> {
  const config = opts.config ?? cashfreeConfig();
  if (!config.configured) throw new CashfreeError(503, 'GATEWAY_NOT_CONFIGURED', config.problem ?? 'Cashfree is not configured.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-version': config.apiVersion,
        'x-client-id': config.appId,
        'x-client-secret': config.secretKey,
        ...(opts.idempotencyKey ? { 'x-idempotency-key': opts.idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError';
    throw new CashfreeError(502, aborted ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNREACHABLE', aborted ? 'Cashfree did not answer in time.' : 'Cashfree could not be reached.');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = typeof data?.message === 'string' ? data.message : `Cashfree answered ${res.status}.`;
    const code = typeof data?.code === 'string' ? data.code : 'GATEWAY_ERROR';
    throw new CashfreeError(res.status, code, message);
  }
  return data as T;
}

// ── Orders ─────────────────────────────────────────────────────────────────

export interface CashfreeOrderInput {
  orderId: string;
  amountMinor: number;
  currency: string;
  customer: { id: string; name?: string; email?: string; phone: string };
  returnUrl?: string;
  notifyUrl?: string | null;
  expiresAt?: Date;
  note?: string;
  tags?: Record<string, string>;
}

export interface CashfreeOrder {
  cf_order_id?: string | number;
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'TERMINATION_REQUESTED' | string;
  payment_session_id?: string;
  order_expiry_time?: string;
}

export interface CashfreePayment {
  cf_payment_id: string | number;
  order_id?: string;
  payment_status: 'SUCCESS' | 'NOT_ATTEMPTED' | 'FAILED' | 'USER_DROPPED' | 'VOID' | 'CANCELLED' | 'PENDING' | string;
  payment_amount?: number;
  payment_currency?: string;
  payment_time?: string;
  payment_completion_time?: string;
  bank_reference?: string | null;
  payment_group?: string | null;
  payment_message?: string | null;
  error_details?: { error_description?: string; error_reason?: string } | null;
}

export interface CashfreeRefund {
  cf_refund_id?: string | number;
  refund_id: string;
  refund_amount: number;
  refund_status: 'SUCCESS' | 'PENDING' | 'PENDING_APPROVAL' | 'CANCELLED' | 'ONHOLD' | 'REJECTED' | string;
  status_description?: string;
  refund_arn?: string | null;
  processed_at?: string | null;
}

/** Cashfree's ISO format with the IST offset it stores expiry in. */
export function cashfreeTime(date: Date): string {
  const ist = new Date(date.getTime() + 330 * 60 * 1000);
  return `${ist.toISOString().slice(0, 19)}+05:30`;
}

/**
 * The phone Cashfree accepts: exactly ten digits for an Indian number, else
 * `+` and the international digits. The applicant's own formatting is kept on
 * the registration; this is only the copy sent to the gateway.
 */
export function cashfreePhone(raw: string): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

const clip = (value: string | undefined, max: number) => {
  const v = String(value ?? '').trim();
  return v.length >= 3 ? v.slice(0, max) : undefined;
};

export function orderRequestBody(input: CashfreeOrderInput) {
  return {
    order_id: input.orderId,
    order_amount: Number((input.amountMinor / 100).toFixed(2)),
    order_currency: input.currency,
    customer_details: {
      customer_id: input.customer.id,
      customer_phone: input.customer.phone,
      ...(clip(input.customer.name, 100) ? { customer_name: clip(input.customer.name, 100) } : {}),
      ...(clip(input.customer.email, 100) ? { customer_email: clip(input.customer.email, 100) } : {}),
    },
    order_meta: {
      ...(input.returnUrl ? { return_url: input.returnUrl.slice(0, 250) } : {}),
      ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
    },
    ...(input.expiresAt ? { order_expiry_time: cashfreeTime(input.expiresAt) } : {}),
    ...(clip(input.note, 200) ? { order_note: clip(input.note, 200) } : {}),
    ...(input.tags ? { order_tags: input.tags } : {}),
  };
}

export function createOrder(input: CashfreeOrderInput, config?: CashfreeConfig): Promise<CashfreeOrder> {
  // The order id doubles as the idempotency key: a retried create returns the
  // same order instead of a second one.
  return call<CashfreeOrder>('POST', '/orders', orderRequestBody(input), { idempotencyKey: input.orderId, config });
}

export function getOrder(orderId: string, config?: CashfreeConfig): Promise<CashfreeOrder> {
  return call<CashfreeOrder>('GET', `/orders/${encodeURIComponent(orderId)}`, undefined, { config });
}

export async function getOrderPayments(orderId: string, config?: CashfreeConfig): Promise<CashfreePayment[]> {
  const rows = await call<CashfreePayment[] | null>('GET', `/orders/${encodeURIComponent(orderId)}/payments`, undefined, { config });
  return Array.isArray(rows) ? rows : [];
}

/** Stop an unpaid order from being paid. Best effort: an order already paid or expired refuses. */
export function terminateOrder(orderId: string, config?: CashfreeConfig): Promise<CashfreeOrder> {
  return call<CashfreeOrder>('PATCH', `/orders/${encodeURIComponent(orderId)}`, { order_status: 'TERMINATED' }, { config });
}

export function createRefund(
  orderId: string,
  input: { refundId: string; amountMinor: number; note?: string },
  config?: CashfreeConfig,
): Promise<CashfreeRefund> {
  return call<CashfreeRefund>(
    'POST',
    `/orders/${encodeURIComponent(orderId)}/refunds`,
    {
      refund_amount: Number((input.amountMinor / 100).toFixed(2)),
      refund_id: input.refundId,
      ...(clip(input.note, 100) ? { refund_note: clip(input.note, 100) } : {}),
    },
    { idempotencyKey: input.refundId, config },
  );
}

export function getRefund(orderId: string, refundId: string, config?: CashfreeConfig): Promise<CashfreeRefund> {
  return call<CashfreeRefund>('GET', `/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`, undefined, { config });
}

const minorOfRupees = (rupees: unknown) => Math.round(Number(rupees) * 100);

export type PaidOrderCheck =
  | { state: 'paid'; payment: CashfreePayment; paidAt: Date }
  | { state: 'mismatch'; order: CashfreeOrder }
  | { state: 'pending'; attempt: CashfreePayment | null; order: CashfreeOrder }
  | { state: 'closed'; order: CashfreeOrder };

/**
 * Is this order paid — for exactly what it was created for? The only test any
 * checkout uses: Cashfree says PAID, a SUCCESS payment exists, and the order's
 * and the payment's amounts and currency equal what we expected. Asked from
 * the server; a browser or a webhook body never answers it.
 */
export async function checkPaidOrder(orderId: string, expectedMinor: number, currency = 'INR', config?: CashfreeConfig): Promise<PaidOrderCheck> {
  const order = await getOrder(orderId, config);
  if (order.order_status === 'PAID') {
    const payments = await getOrderPayments(orderId, config);
    const success = payments.find((p) => String(p.payment_status).toUpperCase() === 'SUCCESS');
    const ok =
      Boolean(success) &&
      minorOfRupees(order.order_amount) === expectedMinor &&
      minorOfRupees(success!.payment_amount) === expectedMinor &&
      String(order.order_currency || 'INR').toUpperCase() === String(currency || 'INR').toUpperCase();
    if (!ok) return { state: 'mismatch', order };
    return { state: 'paid', payment: success!, paidAt: new Date(success!.payment_completion_time || success!.payment_time || Date.now()) };
  }
  if (order.order_status === 'ACTIVE') {
    const payments = await getOrderPayments(orderId, config).catch(() => [] as CashfreePayment[]);
    const time = (p: CashfreePayment) => new Date(p.payment_completion_time || p.payment_time || 0).getTime() || 0;
    return { state: 'pending', attempt: [...payments].sort((a, b) => time(b) - time(a))[0] ?? null, order };
  }
  return { state: 'closed', order };
}

// ── Subscriptions (auto-pay mandates) ──────────────────────────────────────
// Cashfree's Subscriptions product, used ON_DEMAND: the institute authorises a
// mandate once (UPI Autopay, eNACH or a card), and the platform raises each
// renewal charge itself for the invoice amount, up to the mandate's maximum.
// Cashfree sends the customer the pre-debit notice. Needs Subscriptions
// enabled on the merchant account — see CASHFREE_AUTOPAY in autopay.ts.

export interface CashfreeSubscription {
  cf_subscription_id?: string | number;
  subscription_id: string;
  subscription_session_id?: string;
  subscription_status: string;
  authorisation_details?: {
    authorization_amount?: number;
    authorization_reference?: string;
    authorization_status?: string;
    authorization_time?: string;
    payment_group?: string;
    payment_method?: Record<string, unknown> | string;
  };
  plan_details?: { plan_max_amount?: number; plan_type?: string };
  next_schedule_date?: string | null;
}

export interface CashfreeSubscriptionPayment {
  cf_payment_id?: string | number;
  payment_id: string;
  subscription_id?: string;
  payment_status: string;
  payment_amount?: number;
  payment_type?: string;
  payment_schedule_date?: string;
  payment_initiated_date?: string;
  failure_details?: { failure_reason?: string | null } | null;
  retry_attempts?: number;
}

export interface MandateInput {
  subscriptionId: string;
  customer: { name?: string; email: string; phone: string };
  planName: string;
  maxAmountMinor: number;
  note?: string;
  returnUrl: string;
  expiresAt: Date;
  tags?: Record<string, string>;
}

export function mandateRequestBody(input: MandateInput) {
  return {
    subscription_id: input.subscriptionId,
    customer_details: {
      customer_email: input.customer.email,
      customer_phone: input.customer.phone,
      ...(clip(input.customer.name, 100) ? { customer_name: clip(input.customer.name, 100) } : {}),
    },
    plan_details: {
      plan_name: input.planName.slice(0, 40),
      plan_type: 'ON_DEMAND',
      plan_currency: 'INR',
      plan_max_amount: Number((input.maxAmountMinor / 100).toFixed(2)),
      ...(clip(input.note, 100) ? { plan_note: clip(input.note, 100) } : {}),
    },
    authorization_details: {
      // ₹1 to authorise, returned automatically (eNACH authorises with ₹0).
      authorization_amount: 1,
      authorization_amount_refund: true,
      payment_methods: ['upi', 'card', 'enach'],
    },
    subscription_meta: { return_url: input.returnUrl.slice(0, 250) },
    subscription_expiry_time: cashfreeTime(input.expiresAt),
    ...(input.tags ? { subscription_tags: input.tags } : {}),
  };
}

export function createMandate(input: MandateInput, config?: CashfreeConfig): Promise<CashfreeSubscription> {
  return call<CashfreeSubscription>('POST', '/subscriptions', mandateRequestBody(input), { idempotencyKey: input.subscriptionId, config });
}

export function getMandate(subscriptionId: string, config?: CashfreeConfig): Promise<CashfreeSubscription> {
  return call<CashfreeSubscription>('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`, undefined, { config });
}

export function cancelMandate(subscriptionId: string, config?: CashfreeConfig): Promise<CashfreeSubscription> {
  return call<CashfreeSubscription>(
    'POST',
    `/subscriptions/${encodeURIComponent(subscriptionId)}/manage`,
    { subscription_id: subscriptionId, action: 'CANCEL' },
    { config },
  );
}

/** Raise one charge on an ON_DEMAND mandate. Only the date of `scheduledFor` is used by Cashfree. */
export function raiseMandateCharge(
  input: { subscriptionId: string; paymentId: string; amountMinor: number; scheduledFor: Date; remarks?: string },
  config?: CashfreeConfig,
): Promise<CashfreeSubscriptionPayment> {
  return call<CashfreeSubscriptionPayment>(
    'POST',
    '/subscriptions/pay',
    {
      subscription_id: input.subscriptionId,
      payment_id: input.paymentId,
      payment_type: 'CHARGE',
      payment_amount: Number((input.amountMinor / 100).toFixed(2)),
      payment_schedule_date: cashfreeTime(input.scheduledFor),
      ...(clip(input.remarks, 100) ? { payment_remarks: clip(input.remarks, 100) } : {}),
    },
    { idempotencyKey: input.paymentId, config },
  );
}

export function getMandateCharge(subscriptionId: string, paymentId: string, config?: CashfreeConfig): Promise<CashfreeSubscriptionPayment> {
  return call<CashfreeSubscriptionPayment>(
    'GET',
    `/subscriptions/${encodeURIComponent(subscriptionId)}/payments/${encodeURIComponent(paymentId)}`,
    undefined,
    { config },
  );
}

export function refundMandateCharge(
  input: { subscriptionId: string; paymentId: string; refundId: string; amountMinor: number; note?: string },
  config?: CashfreeConfig,
): Promise<CashfreeRefund> {
  return call<CashfreeRefund>(
    'POST',
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}/refunds`,
    {
      subscription_id: input.subscriptionId,
      payment_id: input.paymentId,
      refund_id: input.refundId,
      refund_amount: Number((input.amountMinor / 100).toFixed(2)),
      ...(clip(input.note, 100) ? { refund_note: clip(input.note, 100) } : {}),
    },
    { idempotencyKey: input.refundId, config },
  );
}

export function getMandateRefund(subscriptionId: string, refundId: string, config?: CashfreeConfig): Promise<CashfreeRefund> {
  return call<CashfreeRefund>(
    'GET',
    `/subscriptions/${encodeURIComponent(subscriptionId)}/refunds/${encodeURIComponent(refundId)}`,
    undefined,
    { config },
  );
}

/** A Cashfree subscription status in ours. */
export function mandateStatusOf(providerStatus: unknown): 'pending' | 'active' | 'paused' | 'on_hold' | 'cancelled' | 'expired' {
  const s = String(providerStatus ?? '').toUpperCase();
  if (s === 'ACTIVE') return 'active';
  if (s === 'ON_HOLD') return 'on_hold';
  if (s === 'PAUSED' || s === 'CUSTOMER_PAUSED') return 'paused';
  if (s === 'CANCELLED' || s === 'CUSTOMER_CANCELLED') return 'cancelled';
  if (s === 'EXPIRED' || s === 'LINK_EXPIRED' || s === 'COMPLETED') return 'expired';
  return 'pending';
}

/** A mandate charge's status in ours. */
export function chargeStatusOf(providerStatus: unknown): 'pending' | 'success' | 'failed' {
  const s = String(providerStatus ?? '').toUpperCase();
  if (s === 'SUCCESS') return 'success';
  if (s === 'FAILED' || s === 'CANCELLED' || s === 'CANCEL' || s === 'DECLINED') return 'failed';
  return 'pending';
}

/** How the mandate was authorised, from Cashfree's authorisation details. */
export function mandateMethodOf(details: CashfreeSubscription['authorisation_details']): 'upi' | 'card' | 'bank_transfer' | 'other' {
  const raw = details?.payment_method;
  const key = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? Object.keys(raw)[0] : details?.payment_group;
  const k = String(key ?? '').toLowerCase();
  if (k.includes('upi')) return 'upi';
  if (k.includes('card')) return 'card';
  if (k.includes('nach')) return 'bank_transfer';
  return 'other';
}

// ── Pure rules ─────────────────────────────────────────────────────────────

/**
 * The webhook signature: base64(HMAC-SHA256(timestamp + rawBody, secret)),
 * over the bytes exactly as received. Compared in constant time.
 */
export function webhookSignature(rawBody: Buffer | string, timestamp: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(String(timestamp)).update(rawBody).digest('base64');
}

export function verifyWebhookSignature(
  rawBody: Buffer | string,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!timestamp || !signature || !secret) return false;
  const expected = Buffer.from(webhookSignature(rawBody, timestamp, secret));
  const given = Buffer.from(String(signature).trim());
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** The webhook timestamp as a date: Cashfree sends epoch milliseconds (seconds accepted too). */
export function webhookTime(timestamp: string | undefined): Date | null {
  const n = Number(timestamp);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n);
}

/** Cashfree's payment group, in the platform's payment methods (models/Payment PAYMENT_METHODS). */
export function methodOfPaymentGroup(group: unknown): 'upi' | 'card' | 'bank_transfer' | 'other' {
  const g = String(group ?? '').toLowerCase();
  if (g.startsWith('upi')) return 'upi';
  if (g.includes('card')) return 'card';
  if (g === 'net_banking' || g === 'bank_transfer') return 'bank_transfer';
  return 'other';
}

/** A readable name for the payment group, for staff screens and receipts. */
export function paymentGroupLabel(group: unknown): string {
  const g = String(group ?? '').trim();
  if (!g) return 'Online payment';
  return g.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bUpi\b/g, 'UPI').replace(/\bEmi\b/g, 'EMI');
}
