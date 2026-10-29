/**
 * Registration payments (Cashfree) — the pure rules. No database, no network.
 * The end-to-end proof runs against a stand-in Cashfree (CASHFREE_BASE_URL)
 * and the `test` database; see docs/registration-payments.md.
 *
 *   npm run safety:registration-payments
 */

import crypto from 'crypto';
import {
  cashfreeConfig,
  cashfreeKeysPresent,
  cashfreePhone,
  credentialsFor,
  keyEnvironment,
  cashfreeTime,
  methodOfPaymentGroup,
  orderRequestBody,
  paymentGroupLabel,
  verifyWebhookSignature,
  webhookSignature,
  webhookTime,
} from '../../src/core/billing/cashfree';
import {
  buyerStateCodeOf,
  intervalOf,
  isEffective,
  newOrderId,
  paymentsMode,
  planPriceFor,
  quoteLines,
  refundStatusOf,
  returnUrlFor,
  summarize,
} from '../../src/core/billing/registrationPayments';
import { BillingError } from '../../src/core/billing/invoices';
import { chargeStatusOf, mandateMethodOf, mandateRequestBody, mandateStatusOf } from '../../src/core/billing/cashfree';
import { COOLING_OFF_DAYS, setupFeeShareMinor, suggestRefund } from '../../src/core/billing/refundPolicy';
import { chargeDate, renewalDue } from '../../src/core/billing/renewals';
import { webhookSubject } from '../../src/core/billing/gatewayWebhook';
import { publicApiBase } from '../../src/core/billing/publicBase';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);
const billingCode = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof BillingError ? e.code : `not a BillingError: ${(e as Error).message}`;
  }
};

const SANDBOX = { CASHFREE_APP_ID: 'TEST1234567890abcdef', CASHFREE_SECRET_KEY: 'cfsk_ma_test_secret' };
const LIVE = { CASHFREE_APP_ID: '1234567890abcdef', CASHFREE_SECRET_KEY: 'cfsk_ma_prod_secret' };

function main() {
  console.log('Registration payments\n');

  section('environment');
  const dflt = cashfreeConfig({ ...SANDBOX } as NodeJS.ProcessEnv);
  check('defaults to the sandbox host', dflt.environment === 'sandbox' && dflt.baseUrl === 'https://sandbox.cashfree.com/pg' && dflt.configured);
  const prod = cashfreeConfig({ ...LIVE, CASHFREE_ENV: 'production' } as NodeJS.ProcessEnv);
  check('production uses the production host', prod.environment === 'production' && prod.baseUrl === 'https://api.cashfree.com/pg' && prod.configured);
  check('"test" and "prod" are accepted spellings', cashfreeConfig({ ...SANDBOX, CASHFREE_ENV: 'test' } as NodeJS.ProcessEnv).environment === 'sandbox'
    && cashfreeConfig({ ...LIVE, CASHFREE_ENV: 'prod' } as NodeJS.ProcessEnv).environment === 'production');
  check('a sandbox key against production is refused', !cashfreeConfig({ ...SANDBOX, CASHFREE_ENV: 'production' } as NodeJS.ProcessEnv).configured);
  check('a live key against the sandbox is refused', !cashfreeConfig({ ...LIVE } as NodeJS.ProcessEnv).configured);
  check('an unknown environment is refused', !cashfreeConfig({ ...SANDBOX, CASHFREE_ENV: 'staging' } as NodeJS.ProcessEnv).configured);
  check('missing keys are refused', !cashfreeConfig({ CASHFREE_APP_ID: 'TESTx' } as NodeJS.ProcessEnv).configured);
  check('the problem never contains key material', !String(cashfreeConfig({ ...LIVE } as NodeJS.ProcessEnv).problem).includes(LIVE.CASHFREE_APP_ID));
  check('notify URL must be https', cashfreeConfig({ ...SANDBOX, CASHFREE_NOTIFY_URL: 'http://x.test/h' } as NodeJS.ProcessEnv).notifyUrl === null
    && cashfreeConfig({ ...SANDBOX, CASHFREE_NOTIFY_URL: 'https://x.test/h' } as NodeJS.ProcessEnv).notifyUrl === 'https://x.test/h');
  check('the test stand-in host is honoured in the sandbox only',
    cashfreeConfig({ ...SANDBOX, CASHFREE_BASE_URL: 'http://127.0.0.1:9/pg/' } as NodeJS.ProcessEnv).baseUrl === 'http://127.0.0.1:9/pg'
    && cashfreeConfig({ ...LIVE, CASHFREE_ENV: 'production', CASHFREE_BASE_URL: 'http://127.0.0.1:9/pg' } as NodeJS.ProcessEnv).baseUrl === 'https://api.cashfree.com/pg');
  check('a test app id with a live secret is refused as a mismatched pair', !cashfreeConfig({ CASHFREE_APP_ID: 'TEST1', CASHFREE_SECRET_KEY: 'cfsk_ma_prod_x' } as NodeJS.ProcessEnv).configured
    && keyEnvironment('TEST1', 'cfsk_ma_prod_x') === null && keyEnvironment('123', 'cfsk_ma_test_x') === null);
  check('key markers: TEST… / cfsk_ma_test_ is the sandbox, cfsk_ma_prod_ production', keyEnvironment('TEST1', 'cfsk_ma_test_x') === 'sandbox' && keyEnvironment('123', 'cfsk_ma_prod_x') === 'production');
  const both = {
    CASHFREE_TEST_APP_ID: 'TESTsandboxid', CASHFREE_TEST_SECRET_KEY: 'cfsk_ma_test_s',
    CASHFREE_PROD_APP_ID: '998877live', CASHFREE_PROD_SECRET_KEY: 'cfsk_ma_prod_p',
    CASHFREE_APP_ID: 'shared', CASHFREE_SECRET_KEY: 'shared',
  } as NodeJS.ProcessEnv;
  check('both pairs side by side: CASHFREE_ENV picks one', cashfreeConfig(both).appId === 'TESTsandboxid' && cashfreeConfig(both).configured
    && cashfreeConfig({ ...both, CASHFREE_ENV: 'production' }).appId === '998877live' && cashfreeConfig({ ...both, CASHFREE_ENV: 'production' }).configured);
  check('an environment without its own pair uses the shared one', credentialsFor('production', { CASHFREE_TEST_APP_ID: 'TESTx', CASHFREE_APP_ID: 'live1', CASHFREE_SECRET_KEY: 's' } as NodeJS.ProcessEnv).appId === 'live1');
  const liveOnly = cashfreeConfig({ CASHFREE_APP_ID: '12345', CASHFREE_SECRET_KEY: 'cfsk_ma_prod_abc' } as NodeJS.ProcessEnv);
  check('live keys only, sandbox selected: refused, and the message says which variables to add', !liveOnly.configured && /CASHFREE_TEST_APP_ID/.test(String(liveOnly.problem)) && !String(liveOnly.problem).includes('12345'));
  check('any of the six key variables means payments are meant to be on', cashfreeKeysPresent({ CASHFREE_PROD_APP_ID: 'x' } as NodeJS.ProcessEnv) && !cashfreeKeysPresent({} as NodeJS.ProcessEnv));
  check('the API version defaults to 2025-01-01 and can be set', dflt.apiVersion === '2025-01-01'
    && cashfreeConfig({ ...SANDBOX, CASHFREE_API_VERSION: '2026-01-01' } as NodeJS.ProcessEnv).apiVersion === '2026-01-01');

  section('payments mode');
  check('no keys at all: off (the application works as before)', paymentsMode({} as NodeJS.ProcessEnv) === 'off');
  check('REGISTRATION_PAYMENTS=off: off', paymentsMode({ ...SANDBOX, REGISTRATION_PAYMENTS: 'off' } as NodeJS.ProcessEnv) === 'off');
  check('keys for the wrong environment: unavailable (never silently free)', paymentsMode({ ...LIVE } as NodeJS.ProcessEnv) === 'unavailable');
  check('good sandbox keys: on', paymentsMode({ ...SANDBOX } as NodeJS.ProcessEnv) === 'on');

  section('the order sent to Cashfree');
  check('a ten-digit mobile is sent as is', cashfreePhone('98765 43210') === '9876543210');
  check('+91 and a leading 0 are stripped', cashfreePhone('+91 98765-43210') === '9876543210' && cashfreePhone('09876543210') === '9876543210');
  check('another country keeps its +', cashfreePhone('+44 20 7946 0958') === '+442079460958');
  check('too short is refused', cashfreePhone('12345') === null);
  const body = orderRequestBody({
    orderId: 'ag_x_1',
    amountMinor: 299900,
    currency: 'INR',
    customer: { id: 'reg0123', name: 'A', email: 'a@b.co', phone: '9876543210' },
    returnUrl: 'https://site.test/r?payment=ag_x_1',
    notifyUrl: null,
    expiresAt: new Date('2026-10-28T10:00:00Z'),
  });
  check('amount in rupees with two decimals', body.order_amount === 2999);
  check('a one-letter name is left out (Cashfree wants 3–100)', !('customer_name' in body.customer_details) && body.customer_details.customer_email === 'a@b.co');
  check('no notify URL is sent when none is configured', !('notify_url' in body.order_meta) && body.order_meta.return_url === 'https://site.test/r?payment=ag_x_1');
  check('expiry is written in IST', cashfreeTime(new Date('2026-10-28T10:00:00Z')) === '2026-10-28T15:30:00+05:30' && body.order_expiry_time === '2026-10-28T15:30:00+05:30');
  const ids = new Set(Array.from({ length: 200 }, () => newOrderId()));
  const one = newOrderId();
  check('order ids are unique and within Cashfree\'s 3–45 [A-Za-z0-9_-]', ids.size === 200 && /^[A-Za-z0-9_-]{3,45}$/.test(one) && one.length <= 32, one);

  section('the return address');
  check('same origin: {order_id} filled in', returnUrlFor('https://site.test/register-institute?payment={order_id}', 'https://site.test', 'ag_1') === 'https://site.test/register-institute?payment=ag_1');
  check('another origin is refused', returnUrlFor('https://evil.test/x?p={order_id}', 'https://site.test', 'ag_1') === undefined);
  check('plain http is refused except on localhost', returnUrlFor('http://site.test/x', 'http://site.test', 'ag_1') === undefined
    && returnUrlFor('http://localhost:5173/register-institute?payment={order_id}', 'http://localhost:5173', 'ag_1') === 'http://localhost:5173/register-institute?payment=ag_1');
  check('no origin (not a browser): no return URL', returnUrlFor('https://site.test/x', '', 'ag_1') === undefined);

  section('webhook signature');
  const raw = Buffer.from('{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"order":{"order_id":"ag_1"}}}');
  const ts = '1761631200000';
  const expected = crypto.createHmac('sha256', 'secret').update(ts + raw.toString()).digest('base64');
  check('base64(HMAC-SHA256(timestamp + raw body, secret))', webhookSignature(raw, ts, 'secret') === expected);
  check('a valid signature verifies', verifyWebhookSignature(raw, ts, expected, 'secret'));
  check('one changed byte fails', !verifyWebhookSignature(Buffer.from(raw.toString().replace('ag_1', 'ag_2')), ts, expected, 'secret'));
  check('another timestamp fails', !verifyWebhookSignature(raw, '1761631200001', expected, 'secret'));
  check('another secret fails', !verifyWebhookSignature(raw, ts, expected, 'other'));
  check('missing headers fail closed', !verifyWebhookSignature(raw, undefined, expected, 'secret') && !verifyWebhookSignature(raw, ts, undefined, 'secret'));
  check('timestamps in milliseconds and seconds both read', webhookTime('1761631200000')?.getTime() === 1761631200000 && webhookTime('1761631200')?.getTime() === 1761631200000);
  check('a junk timestamp is no time', webhookTime('soon') === null && webhookTime(undefined) === null);

  section('payment methods');
  check('UPI groups → upi', ['upi', 'upi_credit_card', 'upi_ppi'].every((g) => methodOfPaymentGroup(g) === 'upi'));
  check('cards and card EMIs → card', ['credit_card', 'debit_card', 'prepaid_card', 'credit_card_emi', 'debit_card_emi'].every((g) => methodOfPaymentGroup(g) === 'card'));
  check('net banking → bank_transfer', methodOfPaymentGroup('net_banking') === 'bank_transfer');
  check('wallets, pay later and the unknown → other', ['wallet', 'pay_later', '', undefined].every((g) => methodOfPaymentGroup(g) === 'other'));
  check('labels read naturally', paymentGroupLabel('upi_credit_card') === 'UPI Credit Card' && paymentGroupLabel('') === 'Online payment');

  section('the buyer\'s state (place of supply)');
  check('a valid GSTIN names the state', buyerStateCodeOf({ gstNumber: '27AAPFU0939F1ZV', state: 'Gujarat' }) === '27');
  check('an invalid GSTIN falls back to the typed state', buyerStateCodeOf({ gstNumber: '27AAPFU0938F1ZV', state: 'Gujarat' }) === '24');
  check('names are matched loosely', buyerStateCodeOf({ state: 'tamil nadu' }) === '33' && buyerStateCodeOf({ state: 'Jammu & Kashmir' }) === '01');
  check('common old and short names', buyerStateCodeOf({ state: 'Orissa' }) === '21' && buyerStateCodeOf({ state: 'New Delhi' }) === '07' && buyerStateCodeOf({ state: 'Pondicherry' }) === '34');
  check('a code is a code', buyerStateCodeOf({ state: '29' }) === '29');
  check('unknown or empty → null', buyerStateCodeOf({ state: 'Atlantis' }) === null && buyerStateCodeOf({}) === null);

  section('what a checkout charges');
  check('interval: monthly unless annual/yearly', intervalOf('annual') === 'annual' && intervalOf('yearly') === 'annual' && intervalOf('') === 'monthly' && intervalOf('weekly') === 'monthly');
  const growth = { name: 'Growth', price: { monthly: 2999, annual: 29990, currency: 'INR' } };
  check('price per interval', planPriceFor(growth, 'monthly') === 2999 && planPriceFor(growth, 'annual') === 29990);
  check('no price → null', planPriceFor({ name: 'X', price: { monthly: 10 } }, 'annual') === null && planPriceFor({ name: 'X', price: { monthly: 0 } }, 'monthly') === null);
  const noGst = quoteLines(growth, 'monthly', {}, null);
  check('without a GSTIN on the platform: no GST, total = price', noGst.tax.regime === 'none' && noGst.totalMinor === 299900 && noGst.lines.length === 1);
  check('the line says what is bought', /Growth plan — monthly subscription \(one month from activation\)/.test(noGst.lines[0].description));
  const yearly = quoteLines(growth, 'annual', {}, null);
  check('yearly is the yearly price', yearly.totalMinor === 2999000 && /yearly subscription \(one year from activation\)/.test(yearly.lines[0].description));
  const withFee = quoteLines({ name: 'S', price: { monthly: 999, setupFee: 500 } }, 'monthly', { sacCode: '998431' }, null);
  check('a setup fee is a second line, with the SAC code', withFee.lines.length === 2 && withFee.totalMinor === 149900 && withFee.lines.every((l) => l.sacCode === '998431'));
  const gstProfile = { gstin: '27AAPFU0939F1ZV', stateCode: '27', gstRatePercent: 18 };
  const intra = quoteLines(growth, 'monthly', gstProfile, '27');
  check('same state: CGST + SGST on top', intra.tax.regime === 'gst' && intra.tax.cgstMinor === 26991 && intra.tax.sgstMinor === 26991 && intra.totalMinor === 353882);
  const inter = quoteLines(growth, 'monthly', gstProfile, '24');
  check('another state: IGST', inter.tax.igstMinor === 53982 && inter.tax.cgstMinor === 0 && inter.totalMinor === 353882 && inter.tax.placeOfSupply === '24');
  const inclusive = quoteLines(growth, 'monthly', { ...gstProfile, planPricesIncludeGst: true }, '24');
  check('prices including GST: the total stays the price', inclusive.totalMinor === 299900 && inclusive.subtotalMinor + inclusive.tax.totalMinor === 299900);
  check('GST with an unknown buyer state is refused with the field to fix', billingCode(() => quoteLines(growth, 'monthly', gstProfile, null)) === 'BILLING_STATE_REQUIRED');
  check('an interval the plan is not sold for is refused', billingCode(() => quoteLines({ name: 'M', price: { monthly: 100 } }, 'annual', {}, null)) === 'PRICE_REQUIRED');

  section('refunds and which payment counts');
  check('refund statuses (orders and mandates)', refundStatusOf('SUCCESS') === 'success' && refundStatusOf('PENDING') === 'pending' && refundStatusOf('ONHOLD') === 'pending'
    && refundStatusOf('CANCELLED') === 'failed' && refundStatusOf('REJECTED') === 'failed' && refundStatusOf('CANCEL') === 'failed' && refundStatusOf('FAILED') === 'failed' && refundStatusOf('INITIALIZED') === 'pending');
  check('paid counts; refunded does not; a failed refund still counts',
    isEffective({ status: 'paid' }) && !isEffective({ status: 'paid', refund: { status: 'pending' } })
    && !isEffective({ status: 'paid', refund: { status: 'success' } }) && isEffective({ status: 'paid', refund: { status: 'failed' } })
    && !isEffective({ status: 'pending' }));
  check('summary: nothing', summarize([]).state === 'none');
  check('summary: paid wins over an older pending', summarize([{ status: 'pending', totalMinor: 1 }, { status: 'paid', totalMinor: 2, paidAt: new Date() }]).state === 'paid');
  check('summary: applied once approval used it', summarize([{ status: 'paid', appliedAt: new Date(), totalMinor: 2 }]).state === 'applied');
  check('summary: refunded / refund pending', summarize([{ status: 'paid', refund: { status: 'success' } }]).state === 'refunded'
    && summarize([{ status: 'paid', refund: { status: 'pending' } }]).state === 'refund_pending');
  check('summary: only failures', summarize([{ status: 'expired' }, { status: 'failed' }]).state === 'failed');

  section('refund policy');
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date('2026-11-15T10:00:00Z');
  const ago = (d: number) => new Date(now.getTime() - d * DAY);
  const ahead = (d: number) => new Date(now.getTime() + d * DAY);
  const pre = suggestRefund({ beforeApproval: true, paidMinor: 299900, now });
  check('before approval: everything back', pre.rule === 'before-approval' && pre.amountMinor === 299900 && !pre.endsService);
  const lines = [{ description: 'Growth plan — monthly', amountMinor: 299900 }, { description: 'One-time setup fee', amountMinor: 100000 }];
  check('setup fee share is pro rata of what was paid (GST included)', setupFeeShareMinor(399900, lines) === 100000 && setupFeeShareMinor(471882, lines) === 118000);
  const cool = suggestRefund({ beforeApproval: false, paidMinor: 399900, billingInterval: 'monthly', periodStart: ago(3), periodEnd: ahead(27), lines, now });
  check(`within ${COOLING_OFF_DAYS} days: the plan back, the setup fee kept, the service ends`, cool.rule === 'cooling-off' && cool.amountMinor === 299900 && cool.endsService);
  const coolNoFee = suggestRefund({ beforeApproval: false, paidMinor: 299900, billingInterval: 'monthly', periodStart: ago(7), periodEnd: ahead(23), now });
  check('exactly on day 7 still counts', coolNoFee.rule === 'cooling-off' && coolNoFee.amountMinor === 299900);
  const monthly = suggestRefund({ beforeApproval: false, paidMinor: 299900, billingInterval: 'monthly', periodStart: ago(10), periodEnd: ahead(20), now });
  check('monthly after the cooling-off: nothing, and the service carries on', monthly.rule === 'monthly-none' && monthly.amountMinor === 0 && !monthly.endsService);
  const annual = suggestRefund({ beforeApproval: false, paidMinor: 2999000, billingInterval: 'annual', periodStart: ago(100), periodEnd: ahead(265), now });
  check('yearly after the cooling-off: whole unused months at 1/12 each', annual.rule === 'annual-unused' && annual.amountMinor === Math.round((2999000 * 8) / 12) && annual.endsService, String(annual.amountMinor));
  const annualFee = suggestRefund({ beforeApproval: false, paidMinor: 3099000, billingInterval: 'annual', periodStart: ago(40), periodEnd: ahead(325), lines: [{ description: 'Growth plan — yearly', amountMinor: 2999000 }, { description: 'One-time setup fee', amountMinor: 100000 }], now });
  check('...the setup fee is kept out of the yearly refund', annualFee.amountMinor === Math.round((2999000 * 10) / 12), String(annualFee.amountMinor));
  const lastMonth = suggestRefund({ beforeApproval: false, paidMinor: 2999000, billingInterval: 'annual', periodStart: ago(340), periodEnd: ahead(25), now });
  check('a yearly plan in its last month: nothing unused', lastMonth.amountMinor === 0 && !lastMonth.endsService);
  const over = suggestRefund({ beforeApproval: false, paidMinor: 299900, billingInterval: 'monthly', periodStart: ago(40), periodEnd: ago(10), now });
  check('a period that has ended: nothing', over.rule === 'period-over' && over.amountMinor === 0);
  const early = suggestRefund({ beforeApproval: false, paidMinor: 299900, billingInterval: 'monthly', periodStart: ahead(3), periodEnd: ahead(33), now });
  check('a renewal paid ahead of its period: unused, refunded in full', early.rule === 'cooling-off' && early.amountMinor === 299900);
  const partly = suggestRefund({ beforeApproval: true, paidMinor: 299900, alreadyRefundedMinor: 100000, now });
  check('never more than what is left after earlier refunds', partly.amountMinor === 199900 && partly.refundableMinor === 199900);

  section('renewal timing');
  const sub = { managedSince: ago(90), planKey: 'growth', status: 'active', periodEnd: ahead(5) };
  check('active, ends in 5 days, 7-day window: due', renewalDue(sub, now, { invoiceDays: 7 }).due);
  check('ends in 10 days: not yet', !renewalDue({ ...sub, periodEnd: ahead(10) }, now, { invoiceDays: 7 }).due);
  check('already ended: not here (grace handles it)', !renewalDue({ ...sub, periodEnd: ago(1) }, now).due);
  check('stopping at period end: never', !renewalDue({ ...sub, cancelAtPeriodEnd: true }, now).due);
  check('not lifecycle-managed or platform-owned: never', !renewalDue({ ...sub, managedSince: undefined }, now).due && !renewalDue({ ...sub, isPlatformOwned: true }, now).due);
  const trial = { managedSince: ago(10), planKey: 'growth', status: 'trialing', trialEndsAt: ahead(3) };
  check('a trial converts by renewal only with auto-pay set up', !renewalDue(trial, now).due && renewalDue(trial, now, { autopay: true }).due);
  check('the debit is scheduled the day before access ends', chargeDate(ahead(3), now).getTime() === ahead(2).getTime());
  check('...but never sooner than tomorrow', chargeDate(new Date(now.getTime() + 6 * 60 * 60 * 1000), now).getTime() === ahead(1).getTime());

  section('auto-pay mandates');
  check('Cashfree subscription statuses', mandateStatusOf('ACTIVE') === 'active' && mandateStatusOf('BANK_APPROVAL_PENDING') === 'pending' && mandateStatusOf('INITIALIZED') === 'pending'
    && mandateStatusOf('ON_HOLD') === 'on_hold' && mandateStatusOf('CUSTOMER_PAUSED') === 'paused' && mandateStatusOf('CUSTOMER_CANCELLED') === 'cancelled'
    && mandateStatusOf('LINK_EXPIRED') === 'expired' && mandateStatusOf('COMPLETED') === 'expired');
  check('charge statuses', chargeStatusOf('SUCCESS') === 'success' && chargeStatusOf('FAILED') === 'failed' && chargeStatusOf('CANCELLED') === 'failed' && chargeStatusOf('PENDING') === 'pending' && chargeStatusOf('INITIALIZED') === 'pending');
  check('how it was authorised', mandateMethodOf({ payment_method: { upi: {} } }) === 'upi' && mandateMethodOf({ payment_method: 'card' }) === 'card' && mandateMethodOf({ payment_group: 'enach' }) === 'bank_transfer');
  const mb = mandateRequestBody({ subscriptionId: 'agm_x', customer: { name: 'Sunrise Academy', email: 'a@b.co', phone: '9876543210' }, planName: 'A very long institute name that goes past forty characters', maxAmountMinor: 799900, returnUrl: 'https://api.test/platform-api/public/payments/cashfree/autopay-return?m=agm_x', expiresAt: new Date('2031-01-01T00:00:00Z') });
  check('mandate: ON_DEMAND with the ceiling in rupees, plan name within 40', mb.plan_details.plan_type === 'ON_DEMAND' && mb.plan_details.plan_max_amount === 7999 && mb.plan_details.plan_name.length === 40);
  check('mandate: ₹1 authorisation, returned; UPI, card and eNACH offered', mb.authorization_details.authorization_amount === 1 && mb.authorization_details.authorization_amount_refund === true && mb.authorization_details.payment_methods.join() === 'upi,card,enach');

  section('webhook routing');
  const pay = webhookSubject({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'ag_1' }, payment: { cf_payment_id: 9, payment_status: 'SUCCESS' } } });
  check('a payment event routes by its order', pay.kind === 'order' && pay.orderId === 'ag_1' && pay.eventId === 'PAYMENT_SUCCESS_WEBHOOK:ag_1:9:SUCCESS');
  const subEv = webhookSubject({ type: 'SUBSCRIPTION_PAYMENT_SUCCESS', data: { subscription_id: 'agm_1', payment_id: 'agc_1', cf_payment_id: 77, payment_status: 'SUCCESS' } });
  check('a mandate event routes to auto-pay', subEv.kind === 'mandate' && subEv.subscriptionId === 'agm_1');
  const ref = webhookSubject({ type: 'REFUND_STATUS_WEBHOOK', data: { refund: { refund_id: 'rf1_abc', order_id: 'ag_1', refund_status: 'SUCCESS' } } });
  check('a refund event routes by its refund id', ref.kind === 'refund' && ref.refundId === 'rf1_abc');
  const later = webhookSubject({ type: 'SUBSCRIPTION_STATUS_CHANGED', data: { subscription_details: { subscription_id: 'agm_1', subscription_status: 'ACTIVE' } } });
  const earlier = webhookSubject({ type: 'SUBSCRIPTION_STATUS_CHANGED', data: { subscription_details: { subscription_id: 'agm_1', subscription_status: 'BANK_APPROVAL_PENDING' } } });
  check('a later status of the same mandate is a new event, not a duplicate', later.eventId !== earlier.eventId);

  section('public address for Cashfree callbacks');
  const savedBase = process.env.PUBLIC_API_BASE_URL;
  delete process.env.PUBLIC_API_BASE_URL;
  check('through the gateway: /platform-api on the forwarded host', publicApiBase({ host: '127.0.0.1:4000', 'x-forwarded-host': 'api.example.com', 'x-forwarded-proto': 'https' }, 'http') === 'https://api.example.com/platform-api');
  check('standalone: /api on the host', publicApiBase({ host: 'localhost:5000' }, 'http') === 'http://localhost:5000/api');
  process.env.PUBLIC_API_BASE_URL = 'https://api.example.com/platform-api/';
  check('PUBLIC_API_BASE_URL wins', publicApiBase({ host: 'x' }, 'http') === 'https://api.example.com/platform-api');
  if (savedBase === undefined) delete process.env.PUBLIC_API_BASE_URL; else process.env.PUBLIC_API_BASE_URL = savedBase;

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main();
