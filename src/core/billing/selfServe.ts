/**
 * An institute buying, changing and cancelling its own plan — from its admin
 * panel (`/api/org-admin/subscription/*`).
 *
 * ── What an institute can do on its own ─────────────────────────────────────
 * Anything that moves no money happens at once:
 *   start a free trial       once, on a self-serve plan, when it has no subscription
 *   switch plan in a trial   to another self-serve plan; the trial's end is unchanged
 *   cancel                   at the end of the trial or paid period (immediately
 *                            while overdue) — and withdraw that before it happens
 *
 * Anything that moves money is an ORDER: an invoice for the chosen plan and
 * interval (`origin: 'self-serve'`, core/billing/invoices `createOrderInvoice`).
 * The plan changes when that invoice is PAID — settled by platform staff after
 * they see the money (or, later, a verified provider event). Paying is the
 * only way an order changes anything, so an institute cannot grant itself a
 * plan by ordering one.
 *
 *   order ──▶ draft invoice ──issue──▶ issued ──paid──▶ plan applied, period extended
 *                  │                     │
 *                  └──withdraw (delete)  └──withdraw (void, unpaid only)
 *
 * The invoice is issued at once when the platform's billing profile can issue
 * one a customer can act on (a legal name and payment instructions); otherwise
 * it waits as a draft for staff to review and issue. Nothing here invents
 * seller details.
 *
 * ── Guarantees ───────────────────────────────────────────────────────────────
 *  - One open order per institute; ordering again returns 409 ORDER_OPEN.
 *  - Custom-priced plans (Enterprise) are never self-served.
 *  - Platform-owned organizations have nothing to buy (409 PLATFORM_OWNED).
 *  - Every status change still goes through the lifecycle table (service.ts).
 *  - The organization is always the caller's own: the router passes the
 *    principal's orgId and nothing here accepts another.
 */

import mongoose from 'mongoose';
import { withoutTenantScope } from '../tenancy/context';
import { ensureVersioned, listPublicPlans, termsForSubscription } from '../subscriptions/catalogue';
import { BILLING_INTERVALS, type BillingInterval } from '../subscriptions/lifecycle';
import {
  SubscriptionError,
  assignPlan,
  hasHadTrial,
  isPlatformOwned,
  recordSubscriptionEvent,
  scheduleCancellation,
  tenantSubscriptionView,
  transition,
  withdrawCancellation,
  type Actor,
} from '../subscriptions/service';
import {
  BillingError,
  createOrderInvoice,
  deleteDraftInvoice,
  getBillingProfile,
  invoiceView,
  issueInvoice,
  settleInvoice,
  voidInvoice,
  type SettleInput,
} from './invoices';
import { isStateCode } from './gst';

type Doc = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unscoped = (label: string, fn: () => any): Promise<any> => withoutTenantScope(`self-serve:${label}`, fn) as Promise<any>;
const models = () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Invoice: require('../../models/Invoice').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SubscriptionEvent: require('../../models/SubscriptionEvent').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Plan: require('../../models/Plan').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Subscription: require('../../models/Subscription').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Payment: require('../../models/Payment').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Org: require('../../models/Org').default,
});

const OPEN = ['draft', 'issued'];

type OfferedPlan = Awaited<ReturnType<typeof listPublicPlans>>[number];

/** The platform can issue an invoice a customer can act on: whom to pay, and how. */
export function canAutoIssue(profile: Doc): boolean {
  return Boolean(String(profile.legalName ?? '').trim() && String(profile.paymentInstructions ?? '').trim());
}

/** GST invoices need the buyer's state; without GST nothing is required of the buyer. */
function buyerDetailsMissing(profile: Doc, orgBilling: Doc | undefined): boolean {
  const gst = Boolean(profile.gstin && profile.gstRatePercent > 0);
  return gst && !isStateCode(orgBilling?.stateCode);
}

/** A plan on sale and listed — the only plans an institute can choose itself. */
async function offeredPlan(planKey: unknown): Promise<OfferedPlan> {
  const key = String(planKey ?? '').trim().toLowerCase();
  if (!key) throw new BillingError(400, 'PLAN_REQUIRED', 'Choose a plan.');
  const plan = (await listPublicPlans()).find((p) => p.key === key);
  if (!plan) throw new BillingError(404, 'PLAN_NOT_FOUND', 'That plan is not available.');
  if (plan.customPricing) {
    throw new BillingError(409, 'CUSTOM_PRICING', `${plan.name} is priced for each institute. Ask the platform team for a quote.`);
  }
  return plan;
}

function intervalOf(value: unknown): BillingInterval {
  const v = String(value ?? 'monthly');
  if (!(BILLING_INTERVALS as string[]).includes(v)) {
    throw new BillingError(400, 'BILLING_INVALID', `Billing is one of: ${BILLING_INTERVALS.join(', ')}.`, { field: 'billingInterval' });
  }
  return v as BillingInterval;
}

const asBilling = (error: unknown): never => {
  if (error instanceof SubscriptionError) throw new BillingError(error.status, error.code, error.message, error.details);
  throw error;
};

async function loadSubscription(orgId: string): Promise<{ org: Doc | null; sub: Doc | null }> {
  const { Org, Subscription } = models();
  const [org, sub] = await unscoped('load', () =>
    Promise.all([
      Org.findById(orgId).select('name isPlatformOwned billing deletion').lean(),
      Subscription.findOne({ orgId }).lean(),
    ]),
  );
  if (!org) throw new BillingError(404, 'ORG_NOT_FOUND', 'Organization not found.');
  if (org.deletion) throw new BillingError(409, 'ORG_DELETING', 'This organization is being deleted.');
  if (isPlatformOwned(org, sub)) {
    throw new BillingError(409, 'PLATFORM_OWNED', 'Your institute is run by the platform itself; there is nothing to buy.');
  }
  return { org, sub };
}

export async function openOrderOf(orgId: string): Promise<Doc | null> {
  const { Invoice } = models();
  return unscoped('open-order', () =>
    Invoice.findOne({ orgId, origin: 'self-serve', status: { $in: OPEN } }).sort({ createdAt: -1 }).lean(),
  );
}

/** What the institute's own view of an order shows — the invoice, once issued, carries the rest. */
function orderView(invoice: Doc | null) {
  if (!invoice) return null;
  const v = invoiceView(invoice);
  return {
    id: String(v._id),
    status: v.status as 'draft' | 'issued',
    kind: v.order?.kind ?? null,
    planKey: v.planKey ?? null,
    billingInterval: v.billingInterval ?? null,
    number: v.number ?? null,
    totalMinor: v.totalMinor,
    periodStart: v.periodStart ?? null,
    periodEnd: v.periodEnd ?? null,
    dueAt: v.dueAt ?? null,
    overdue: v.overdue,
    paymentInstructions: v.status === 'issued' ? v.paymentInstructions ?? null : null,
    /** Staff already put the institute on this plan; the invoice is still to be paid. */
    planApplied: Boolean(v.order?.appliedAt),
    createdAt: v.createdAt,
  };
}

/**
 * The platform's last answer to the institute's last order, when that answer
 * was "declined" — so the institute sees why its order disappeared. A newer
 * order hides it.
 */
async function lastDeclineOf(orgId: string) {
  const { SubscriptionEvent } = models();
  const latest = await unscoped('last-decision', () =>
    SubscriptionEvent.findOne({ orgId, type: { $in: ['order_placed', 'order_declined'] } }).sort({ at: -1, _id: -1 }).lean(),
  );
  if (!latest || latest.type !== 'order_declined') return null;
  return {
    at: latest.at as Date,
    reason: (latest.metadata?.reason as string | undefined) ?? null,
    planKey: (latest.metadata?.planKey as string | undefined) ?? null,
  };
}

// ── What the institute can do right now ────────────────────────────────────

export async function selfServeState(orgId: string) {
  const [view, trialUsed, order, profile, lastDecline] = await Promise.all([
    tenantSubscriptionView(orgId),
    hasHadTrial(orgId),
    openOrderOf(orgId),
    getBillingProfile(),
    lastDeclineOf(orgId),
  ]);
  const status = view.status;
  const managed = view.managed;
  const ends = status === 'trialing' ? view.trialEndsAt : status === 'active' ? view.periodEnd : null;
  const owned = view.platformOwned;
  return {
    platformOwned: owned,
    managed,
    status,
    trialUsed,
    openOrder: orderView(order),
    /** The platform declined the institute's last order, and why. */
    lastDecline: order ? null : lastDecline,
    /** Orders are issued as invoices at once (true) or reviewed by the platform team first (false). */
    autoInvoice: canAutoIssue(profile),
    /** GST invoices need the institute's billing state before an order can be placed. */
    billingDetailsRequired: Boolean(profile.gstin && profile.gstRatePercent > 0),
    actions: {
      startTrial: !owned && !status && !trialUsed,
      switchTrialPlan: !owned && managed && status === 'trialing',
      order: !owned && status !== 'suspended' && !order,
      cancelAtPeriodEnd: !owned && managed && Boolean(ends) && !view.cancelAtPeriodEnd,
      cancelNow: !owned && managed && status === 'past_due',
      resume: !owned && view.cancelAtPeriodEnd && (status === 'trialing' || status === 'active'),
      withdrawOrder: Boolean(order),
    },
  };
}

// ── Actions ────────────────────────────────────────────────────────────────

/** A free trial on a self-serve plan — once per institute, only with no subscription. */
export async function startSelfServeTrial(orgId: string, input: { planKey?: unknown }, actor: Actor) {
  const plan = await offeredPlan(input.planKey);
  if (!plan.selfServe || !(plan.trialDays > 0)) {
    throw new BillingError(409, 'TRIAL_NOT_OFFERED', `${plan.name} has no free trial. Choose it with a payment instead.`);
  }
  const { sub } = await loadSubscription(orgId);
  if (sub) throw new BillingError(409, 'TRIAL_UNAVAILABLE', 'Your institute already has a subscription.');
  if (await hasHadTrial(orgId)) throw new BillingError(409, 'TRIAL_USED', 'Your institute has already had its free trial.');
  try {
    const result = await transition(orgId, 'start_trial', {
      actor,
      reason: 'Started from the institute admin panel',
      planKey: plan.key,
      planVersion: plan.version ?? undefined,
      days: plan.trialDays,
    });
    return { subscription: await tenantSubscriptionView(orgId), changed: result.changed };
  } catch (error) {
    return asBilling(error);
  }
}

/** Switch plan during a trial — nothing is charged, and the trial ends when it would have. */
export async function switchTrialPlan(orgId: string, input: { planKey?: unknown }, actor: Actor) {
  const plan = await offeredPlan(input.planKey);
  if (!plan.selfServe) throw new BillingError(409, 'NOT_SELF_SERVE', `${plan.name} is arranged with the platform team.`);
  const { sub } = await loadSubscription(orgId);
  if (!sub || sub.status !== 'trialing' || !sub.managedSince) {
    throw new BillingError(409, 'NOT_IN_TRIAL', 'Plans can be switched freely only during a trial. Order the plan instead.');
  }
  if (sub.planKey === plan.key) return { subscription: await tenantSubscriptionView(orgId), changed: false };
  try {
    const result = await assignPlan(orgId, {
      planKey: plan.key,
      planVersion: plan.version ?? undefined,
      actor,
      reason: 'Switched during the trial from the institute admin panel',
    });
    return { subscription: await tenantSubscriptionView(orgId), changed: result.changed };
  } catch (error) {
    return asBilling(error);
  }
}

/** How an order relates to what the institute has: its first, a renewal, or a move up or down. */
async function orderKind(orgId: string, sub: Doc | null, plan: OfferedPlan, interval: BillingInterval) {
  const { Payment } = models();
  const paidBefore = await unscoped('paid-before', () => Payment.exists({ orgId, status: 'confirmed' }));
  if (!sub || !paidBefore) return 'new' as const;
  if (sub.planKey === plan.key) return 'renewal' as const;
  const current = await termsForSubscription(sub);
  const price = (p?: { monthly?: number; annual?: number } | null) =>
    interval === 'annual' ? p?.annual ?? (p?.monthly ?? 0) * 12 : p?.monthly ?? 0;
  return price(plan.price as { monthly?: number; annual?: number }) >= price(current?.price)
    ? ('upgrade' as const)
    : ('downgrade' as const);
}

/**
 * Order a plan: buy, renew, upgrade or downgrade. Creates an invoice for the
 * next period on that plan; the plan changes when the invoice is paid.
 */
export async function placeOrder(orgId: string, input: { planKey?: unknown; billingInterval?: unknown }, actor: Actor) {
  const plan = await offeredPlan(input.planKey);
  const interval = intervalOf(input.billingInterval);
  const prices = plan.price as { monthly?: number; annual?: number };
  const price = interval === 'annual' ? prices.annual : prices.monthly;
  if (!(Number(price) > 0)) {
    throw new BillingError(409, 'PRICE_REQUIRED', `${plan.name} cannot be bought ${interval === 'annual' ? 'yearly' : 'monthly'}.`);
  }
  const { org, sub } = await loadSubscription(orgId);
  if (sub?.status === 'suspended') {
    throw new BillingError(409, 'SUBSCRIPTION_ON_HOLD', 'Your subscription is on hold. The platform team will contact you about it.');
  }
  const open = await openOrderOf(orgId);
  if (open) {
    throw new BillingError(409, 'ORDER_OPEN', 'You already have an order waiting for payment. Pay it, or withdraw it first.', {
      order: orderView(open),
    });
  }
  const profile = await getBillingProfile();
  if (buyerDetailsMissing(profile, org?.billing)) {
    throw new BillingError(400, 'BILLING_DETAILS_REQUIRED', 'Add your billing state under Billing details first — it decides the tax on your invoice.');
  }

  const kind = await orderKind(orgId, sub, plan, interval);
  // The invoice pins the terms on sale now; a plan never edited has no version yet.
  const planVersion = plan.version ?? (await ensureVersioned(plan.key));
  const draft = await createOrderInvoice(orgId, { planKey: plan.key, planVersion, billingInterval: interval, kind }, actor);

  // A second order racing this one: keep the older, remove this draft.
  const { Invoice } = models();
  const earliest = await unscoped('order-race', () =>
    Invoice.findOne({ orgId, origin: 'self-serve', status: { $in: OPEN } }).sort({ createdAt: 1, _id: 1 }).lean(),
  );
  if (earliest && String(earliest._id) !== String(draft._id)) {
    await deleteDraftInvoice(String(draft._id)).catch(() => undefined);
    throw new BillingError(409, 'ORDER_OPEN', 'You already have an order waiting for payment. Pay it, or withdraw it first.', {
      order: orderView(earliest),
    });
  }

  let invoice: Doc = draft;
  let issueProblem: string | null = null;
  if (canAutoIssue(profile)) {
    try {
      invoice = await issueInvoice(String(draft._id), actor);
    } catch (error) {
      // Left as a draft for staff, with the reason — the order is not lost.
      issueProblem = error instanceof BillingError ? error.message : 'The invoice could not be issued automatically.';
      console.error(`[self-serve] order ${draft._id} for ${orgId} left as a draft:`, issueProblem);
    }
  }
  await recordSubscriptionEvent({
    orgId,
    subscriptionId: sub?._id,
    type: 'order_placed',
    fromStatus: sub?.status ?? null,
    toStatus: sub?.status ?? null,
    actor,
    metadata: {
      invoiceId: String(draft._id),
      kind,
      planKey: plan.key,
      planVersion,
      billingInterval: interval,
      totalMinor: invoice.totalMinor,
      issued: invoice.status === 'issued',
      ...(issueProblem ? { issueProblem } : {}),
    },
    planName: plan.name,
  });
  return { order: orderView(invoice), kind, issued: invoice.status === 'issued' };
}

/** Withdraw an unpaid order: a draft is deleted, an issued invoice voided. */
export async function withdrawOrder(orgId: string, invoiceId: string, actor: Actor) {
  if (!mongoose.Types.ObjectId.isValid(invoiceId)) throw new BillingError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  const { Invoice } = models();
  const invoice = await unscoped('withdraw-load', () => Invoice.findById(invoiceId).lean());
  // Another organization's invoice, or one staff drafted, answers like a missing one.
  if (!invoice || String(invoice.orgId) !== String(orgId) || invoice.origin !== 'self-serve') {
    throw new BillingError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }
  if (invoice.status === 'paid') throw new BillingError(409, 'INVOICE_PAID', 'This order has been paid and cannot be withdrawn.');
  if (invoice.status === 'void') return { withdrawn: false };
  if (invoice.status === 'draft') await deleteDraftInvoice(invoiceId);
  else await voidInvoice(invoiceId, 'Withdrawn by the institute before payment', actor);
  await recordSubscriptionEvent({
    orgId,
    subscriptionId: invoice.subscriptionId,
    type: 'order_withdrawn',
    actor,
    metadata: { invoiceId, number: invoice.number ?? null, planKey: invoice.planKey ?? null },
  });
  return { withdrawn: true };
}

/**
 * Cancel. A trial or paid period runs to its end and then stops; an overdue
 * subscription (in grace) is cancelled now. An unpaid order is withdrawn with
 * it — paying it later would otherwise undo the cancellation.
 */
export async function cancelSubscription(orgId: string, input: { reason?: unknown }, actor: Actor) {
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 1000) : '';
  const { sub } = await loadSubscription(orgId);
  if (!sub) throw new BillingError(404, 'SUBSCRIPTION_NOT_FOUND', 'There is no subscription to cancel.');
  const open = await openOrderOf(orgId);
  try {
    let result: { when: 'period-end' | 'now'; endsAt?: Date | null };
    if (sub.status === 'past_due') {
      await transition(orgId, 'cancel', {
        actor,
        reason: `Cancelled by the institute${reason ? `: ${reason}` : ''}`,
      });
      result = { when: 'now' };
    } else {
      const scheduled = await scheduleCancellation(orgId, { actor, reason });
      result = { when: 'period-end', endsAt: scheduled.endsAt ?? null };
    }
    if (open) await withdrawOrder(orgId, String(open._id), actor).catch(() => undefined);
    // Nothing is to be charged any more: auto-pay goes too (set up again after resuming).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { cancelAutopayFor } = require('./autopay');
    await cancelAutopayFor(orgId, actor, 'Subscription cancelled by the institute').catch(() => undefined);
    return { ...result, subscription: await tenantSubscriptionView(orgId) };
  } catch (error) {
    return asBilling(error);
  }
}

/** Keep the subscription after all: withdraw a cancellation scheduled for period end. */
export async function resumeSubscription(orgId: string, actor: Actor) {
  await loadSubscription(orgId);
  try {
    const result = await withdrawCancellation(orgId, { actor });
    return { changed: result.changed, subscription: await tenantSubscriptionView(orgId) };
  } catch (error) {
    return asBilling(error);
  }
}

// ── The platform's side: orders waiting for staff ──────────────────────────
// Read and acted on from the console (/api/platform/orders). An order is
// accepted by recording the money staff have seen arrive — which applies the
// plan through the same settlement as any invoice — or declined with a reason
// the institute is told. Staff may also put the institute on the ordered plan
// before the money arrives; the invoice then stays open to be paid.

async function loadOrder(invoiceId: string): Promise<Doc> {
  if (!mongoose.Types.ObjectId.isValid(invoiceId)) throw new BillingError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  const { Invoice } = models();
  const invoice = await unscoped('order-load', () => Invoice.findById(invoiceId).lean());
  if (!invoice || invoice.origin !== 'self-serve') throw new BillingError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  return invoice;
}

function requireOpen(invoice: Doc) {
  if (!OPEN.includes(invoice.status)) {
    throw new BillingError(
      409,
      invoice.status === 'paid' ? 'INVOICE_ALREADY_PAID' : 'ORDER_CLOSED',
      invoice.status === 'paid' ? 'This order has already been paid.' : 'This order is no longer open.',
      { status: invoice.status },
    );
  }
}

/** Institute orders for the console: open ones by default (`status=all` for every one), newest first. */
export async function listOrders(query: { status?: string; orgId?: string; limit?: number } = {}) {
  const { Invoice, Org, Subscription, Plan } = models();
  const filter: Doc = { origin: 'self-serve' };
  if (query.status !== 'all') filter.status = { $in: OPEN };
  if (query.orgId) {
    if (!mongoose.Types.ObjectId.isValid(query.orgId)) return [];
    filter.orgId = query.orgId;
  }
  const rows: Doc[] = await unscoped('orders-list', () =>
    Invoice.find(filter).sort({ createdAt: -1 }).limit(Math.min(query.limit ?? 100, 500)).lean(),
  );
  const orgIds = [...new Set(rows.map((r) => String(r.orgId)))];
  const planKeys = [...new Set(rows.map((r) => r.planKey).filter(Boolean))];
  const [orgs, subs, plans] = (await unscoped('orders-context', () =>
    Promise.all([
      Org.find({ _id: { $in: orgIds } }).select('name slug').lean(),
      Subscription.find({ orgId: { $in: orgIds } }).select('orgId status planKey billingInterval managedSince').lean(),
      Plan.find({ key: { $in: planKeys } }).select('key name').lean(),
    ]),
  )) as Doc[][];
  const orgById = new Map(orgs.map((o) => [String(o._id), o]));
  const subByOrg = new Map(subs.map((x) => [String(x.orgId), x]));
  const planName = new Map(plans.map((p) => [p.key, p.name]));
  return rows.map((r) => {
    const v = invoiceView(r);
    const org = orgById.get(String(r.orgId));
    const sub = subByOrg.get(String(r.orgId));
    return {
      id: String(r._id),
      orgId: String(r.orgId),
      organization: org ? { name: org.name as string, slug: org.slug as string } : null,
      status: v.status as 'draft' | 'issued' | 'paid' | 'void',
      kind: v.order?.kind ?? null,
      planKey: v.planKey ?? null,
      planName: planName.get(v.planKey) ?? v.planKey ?? null,
      planVersion: v.planVersion ?? null,
      billingInterval: v.billingInterval ?? null,
      number: v.number ?? null,
      totalMinor: v.totalMinor,
      balanceMinor: v.balanceMinor,
      periodStart: v.periodStart ?? null,
      periodEnd: v.periodEnd ?? null,
      dueAt: v.dueAt ?? null,
      overdue: v.overdue,
      orderedBy: v.order?.by?.email ?? null,
      planApplied: Boolean(v.order?.appliedAt),
      createdAt: v.createdAt,
      paidAt: v.paidAt ?? null,
      voidReason: v.voidReason ?? null,
      subscription: sub
        ? { status: sub.status, planKey: sub.planKey ?? null, managed: Boolean(sub.managedSince), billingInterval: sub.billingInterval ?? null }
        : null,
    };
  });
}

/**
 * Accept an order: the payment has arrived. A draft is issued first; then the
 * payment settles the invoice in full, which applies the ordered plan and
 * extends the subscription to the invoice's period (invoices.settleInvoice).
 */
export async function acceptOrder(invoiceId: string, input: Partial<SettleInput>, actor: Actor) {
  const order = await loadOrder(invoiceId);
  requireOpen(order);
  // The payment is checked BEFORE a draft is issued: a refused payment must
  // leave the order exactly as it was, not issued and unpaid.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PAYMENT_METHODS } = require('../../models/Payment');
  const reference = String(input.reference ?? '').trim();
  if (reference.length < 3 || reference.length > 120) {
    throw new BillingError(400, 'PAYMENT_INVALID', 'A payment reference (UTR, cheque or transaction number) of 3–120 characters is required.');
  }
  if (!PAYMENT_METHODS.includes(String(input.method ?? ''))) {
    throw new BillingError(400, 'PAYMENT_INVALID', `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}.`);
  }
  if (input.amount !== undefined && input.amount !== null && input.amount !== '' && !(Number(input.amount) > 0)) {
    throw new BillingError(400, 'PAYMENT_INVALID', 'The amount must be more than zero.');
  }
  let issuedNow = false;
  if (order.status === 'draft') {
    await issueInvoice(invoiceId, actor);
    issuedNow = true;
  }
  const fresh = await loadOrder(invoiceId);
  const balance = (fresh.totalMinor - (fresh.amountPaidMinor ?? 0)) / 100;
  const amount = input.amount === undefined || input.amount === null || input.amount === '' ? balance : input.amount;
  const result = await settleInvoice(
    invoiceId,
    { amount, method: String(input.method), reference, receivedAt: input.receivedAt, notes: input.notes },
    actor,
  );
  return { ...result, issuedNow };
}

/**
 * Put the institute on the ordered plan now, before the payment arrives (an
 * agreed exception). The invoice stays open; paying it later extends the
 * period as usual. Needs an existing subscription — with none, recording the
 * payment is what starts it.
 */
export async function applyOrderPlan(invoiceId: string, input: { reason?: unknown }, actor: Actor) {
  const order = await loadOrder(invoiceId);
  requireOpen(order);
  const { Subscription, Invoice } = models();
  const sub = await unscoped('apply-sub', () => Subscription.findOne({ orgId: order.orgId }).select('_id').lean());
  if (!sub) {
    throw new BillingError(409, 'SUBSCRIPTION_NOT_FOUND', 'This institute has no subscription yet. Record the payment to start it on the ordered plan.');
  }
  const reason =
    typeof input.reason === 'string' && input.reason.trim()
      ? input.reason.trim().slice(0, 1000)
      : `Applied from the institute's order ${order.number ?? '(not yet invoiced)'} before payment`;
  try {
    const result = await assignPlan(String(order.orgId), {
      planKey: order.planKey,
      planVersion: order.planVersion,
      billingInterval: order.billingInterval,
      actor,
      reason,
    });
    await unscoped('apply-mark', () =>
      Invoice.updateOne(
        { _id: order._id, origin: 'self-serve' },
        { $set: { 'order.appliedAt': new Date(), 'order.appliedBy': { id: actor.id, email: actor.email } } },
      ),
    );
    await recordSubscriptionEvent({
      orgId: String(order.orgId),
      subscriptionId: order.subscriptionId,
      type: 'order_applied',
      actor,
      reason,
      metadata: { invoiceId: String(order._id), number: order.number ?? null, planKey: order.planKey },
    });
    return { changed: result.changed, subscription: result.subscription };
  } catch (error) {
    return asBilling(error);
  }
}

/** Decline an order, with a reason the institute is shown. A draft is deleted; an issued invoice is voided. */
export async function declineOrder(invoiceId: string, input: { reason?: unknown }, actor: Actor) {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 3) throw new BillingError(400, 'REASON_REQUIRED', 'Say why the order is declined; the institute is shown it.');
  const order = await loadOrder(invoiceId);
  requireOpen(order);
  if (order.status === 'draft') await deleteDraftInvoice(invoiceId);
  else await voidInvoice(invoiceId, `Order declined: ${reason}`.slice(0, 500), actor);
  const plan = order.planKey
    ? await unscoped('decline-plan', () => models().Plan.findOne({ key: order.planKey }).select('name').lean())
    : null;
  await recordSubscriptionEvent({
    orgId: String(order.orgId),
    subscriptionId: order.subscriptionId,
    type: 'order_declined',
    actor,
    reason,
    metadata: { invoiceId: String(order._id), number: order.number ?? null, planKey: order.planKey ?? null, reason: reason.slice(0, 1000) },
    planName: plan?.name,
  });
  return { declined: true, orgId: String(order.orgId) };
}
