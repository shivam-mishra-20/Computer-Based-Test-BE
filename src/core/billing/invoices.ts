/**
 * Invoices — admin-managed, issued by platform staff, settled by a payment
 * staff confirm (or, later, a verified provider event).
 *
 *   draft ──issue──▶ issued ──settled──▶ paid
 *     └─delete         └──void (unpaid, with a reason)
 *
 * Settling an invoice IS the payment confirmation: it records the payment
 * through the same idempotent path as any other (core/subscriptions/service
 * `recordManualPayment`, with the invoice attached), which extends the
 * subscription to the invoice's period. An invoice is settled by exactly one
 * payment for its full balance; a unique index on Payment.invoiceId makes two
 * simultaneous settlements impossible.
 *
 * Tax: computed by core/billing/gst.ts only when the platform's billing profile
 * has a GSTIN and a rate. Without them an invoice carries no GST and says it is
 * not a tax invoice. Nothing here invents tax information or claims compliance.
 *
 * Who may call what is decided by the routes (billing.manage / org.read for
 * staff; an organization's admins see their own issued invoices only).
 */

import mongoose from 'mongoose';
import { withoutTenantScope } from '../tenancy/context';
import { addInterval, type BillingInterval } from '../subscriptions/lifecycle';
import { termsForSubscription } from '../subscriptions/catalogue';
import { recordManualPayment, SubscriptionError, isPlatformOwned, type Actor } from '../subscriptions/service';
import {
  GST_STATE_CODES,
  TaxInputError,
  computeTax,
  financialYearOf,
  formatInvoiceNumber,
  gstinProblem,
  isInvoicePrefix,
  isStateCode,
  rupees,
} from './gst';
import { sendEventNotice } from './notices';

export class BillingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

type Doc = Record<string, any>;

const models = () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Invoice: require('../../models/Invoice').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  InvoiceCounter: require('../../models/InvoiceCounter').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  BillingProfile: require('../../models/BillingProfile').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Org: require('../../models/Org').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Subscription: require('../../models/Subscription').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SubscriptionEvent: require('../../models/SubscriptionEvent').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Payment: require('../../models/Payment').default,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unscoped = (label: string, fn: () => any): Promise<any> => withoutTenantScope(`billing:${label}`, fn) as Promise<any>;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLAIM_MS = 2 * 60 * 1000;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const SAC = /^[0-9]{4,8}$/;
const PINCODE = /^[1-9][0-9]{5}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : undefined);
const invalid = (message: string, field?: string) => new BillingError(400, 'BILLING_INVALID', message, field ? { field } : {});

// ── The seller: the platform's billing profile ─────────────────────────────

export async function getBillingProfile(): Promise<Doc> {
  const { BillingProfile } = models();
  const found = await unscoped('profile-read', () => BillingProfile.findOne({ key: 'platform' }).lean());
  return found ?? { key: 'platform', planPricesIncludeGst: false, invoicePrefix: 'INV', paymentTermsDays: 7 };
}

/** Whether invoices issued now would carry GST, and if not, why not. */
export function gstReadiness(profile: Doc): { gst: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!profile.legalName) missing.push('legal name');
  if (!profile.gstin) missing.push('GSTIN');
  if (!isStateCode(profile.stateCode)) missing.push('state code');
  if (!(profile.gstRatePercent > 0)) missing.push('GST rate');
  if (!profile.sacCode) missing.push('SAC code');
  return { gst: Boolean(profile.gstin && profile.gstRatePercent > 0), missing };
}

export async function updateBillingProfile(input: Doc, actor: Actor): Promise<Doc> {
  const set: Doc = {};
  const unset: Doc = {};
  const assign = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (value === null || value === '') unset[key] = 1;
    else set[key] = value;
  };
  assign('legalName', text(input.legalName, 200) ?? input.legalName);
  assign('tradeName', text(input.tradeName, 200) ?? input.tradeName);
  assign('address', text(input.address, 500) ?? input.address);
  assign('city', text(input.city, 100) ?? input.city);
  if (input.pincode) {
    if (!PINCODE.test(String(input.pincode))) throw invalid('A PIN code is 6 digits.', 'pincode');
  }
  assign('pincode', input.pincode === undefined ? undefined : String(input.pincode ?? ''));
  if (input.stateCode) {
    if (!isStateCode(String(input.stateCode))) throw invalid(`"${input.stateCode}" is not a GST state code.`, 'stateCode');
  }
  assign('stateCode', input.stateCode === undefined ? undefined : String(input.stateCode ?? ''));
  if (input.gstin) {
    const problem = gstinProblem(String(input.gstin));
    if (problem) throw invalid(problem, 'gstin');
  }
  assign('gstin', input.gstin === undefined ? undefined : String(input.gstin ?? '').toUpperCase());
  if (input.pan) {
    if (!PAN.test(String(input.pan).toUpperCase())) throw invalid('A PAN is 10 characters: 5 letters, 4 digits, a letter.', 'pan');
  }
  assign('pan', input.pan === undefined ? undefined : String(input.pan ?? '').toUpperCase());
  if (input.gstRatePercent !== undefined && input.gstRatePercent !== null && input.gstRatePercent !== '') {
    const rate = Number(input.gstRatePercent);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 28) throw invalid('The GST rate is a percentage above 0 and at most 28.', 'gstRatePercent');
    set.gstRatePercent = rate;
  } else if (input.gstRatePercent === null || input.gstRatePercent === '') unset.gstRatePercent = 1;
  if (input.sacCode) {
    if (!SAC.test(String(input.sacCode))) throw invalid('A SAC code is 4 to 8 digits.', 'sacCode');
  }
  assign('sacCode', input.sacCode === undefined ? undefined : String(input.sacCode ?? ''));
  if (input.planPricesIncludeGst !== undefined) set.planPricesIncludeGst = Boolean(input.planPricesIncludeGst);
  if (input.invoicePrefix !== undefined) {
    if (!isInvoicePrefix(input.invoicePrefix)) throw invalid('An invoice prefix is 1–5 letters or digits.', 'invoicePrefix');
    set.invoicePrefix = String(input.invoicePrefix).toUpperCase();
  }
  if (input.paymentTermsDays !== undefined) {
    const days = Number(input.paymentTermsDays);
    if (!Number.isInteger(days) || days < 0 || days > 90) throw invalid('Payment terms are 0 to 90 days.', 'paymentTermsDays');
    set.paymentTermsDays = days;
  }
  if (input.email) {
    if (!EMAIL.test(String(input.email))) throw invalid('That is not an email address.', 'email');
  }
  assign('email', input.email === undefined ? undefined : String(input.email ?? '').toLowerCase());
  assign('phone', text(input.phone, 30) ?? input.phone);
  assign('paymentInstructions', text(input.paymentInstructions, 1000) ?? input.paymentInstructions);

  // The GSTIN names the state and the PAN it was issued against: refuse a
  // profile that contradicts itself rather than print it on an invoice.
  const merged = { ...(await getBillingProfile()), ...set };
  for (const key of Object.keys(unset)) delete merged[key];
  if (merged.gstin && merged.stateCode && merged.gstin.slice(0, 2) !== merged.stateCode) {
    throw invalid('The GSTIN\'s first two digits must be the state code.', 'gstin');
  }
  if (merged.gstin && merged.pan && merged.gstin.slice(2, 12) !== merged.pan) {
    throw invalid('The GSTIN must contain the PAN.', 'pan');
  }

  set.updatedBy = { id: actor.id };
  const { BillingProfile } = models();
  return unscoped('profile-write', () =>
    BillingProfile.findOneAndUpdate(
      { key: 'platform' },
      { $set: { key: 'platform', ...set }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean(),
  );
}

// ── The buyer: the organization's billing details ──────────────────────────

export async function getOrgBilling(orgId: string): Promise<Doc> {
  const { Org } = models();
  const org = await unscoped('org-billing-read', () => Org.findById(orgId).select('name billing profile').lean());
  if (!org) throw new BillingError(404, 'ORG_NOT_FOUND', 'Organization not found.');
  return { name: org.name, ...(org.billing ?? {}) };
}

/** Organization admins (their own) and platform staff edit this. */
export async function updateOrgBilling(orgId: string, input: Doc): Promise<Doc> {
  const billing: Doc = {};
  if (input.legalName !== undefined) billing.legalName = text(input.legalName, 200) || undefined;
  if (input.address !== undefined) billing.address = text(input.address, 500) || undefined;
  if (input.city !== undefined) billing.city = text(input.city, 100) || undefined;
  if (input.pincode !== undefined) {
    const pin = String(input.pincode ?? '').trim();
    if (pin && !PINCODE.test(pin)) throw invalid('A PIN code is 6 digits.', 'pincode');
    billing.pincode = pin || undefined;
  }
  if (input.stateCode !== undefined) {
    const code = String(input.stateCode ?? '').trim();
    if (code && !isStateCode(code)) throw invalid(`"${code}" is not a GST state code.`, 'stateCode');
    billing.stateCode = code || undefined;
  }
  if (input.gstin !== undefined) {
    const gstin = String(input.gstin ?? '').trim().toUpperCase();
    if (gstin) {
      const problem = gstinProblem(gstin);
      if (problem) throw invalid(problem, 'gstin');
    }
    billing.gstin = gstin || undefined;
  }
  if (input.email !== undefined) {
    const email = String(input.email ?? '').trim().toLowerCase();
    if (email && !EMAIL.test(email)) throw invalid('That is not an email address.', 'email');
    billing.email = email || undefined;
  }
  if (input.phone !== undefined) billing.phone = text(input.phone, 30) || undefined;

  const { Org } = models();
  const current = await unscoped('org-billing-current', () => Org.findById(orgId).select('billing').lean());
  if (!current) throw new BillingError(404, 'ORG_NOT_FOUND', 'Organization not found.');
  const merged = { ...(current.billing ?? {}), ...billing };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  if (merged.gstin && merged.stateCode && merged.gstin.slice(0, 2) !== merged.stateCode) {
    throw invalid('The GSTIN\'s first two digits must be the billing state code.', 'gstin');
  }
  // A GSTIN names its state: fill the state in rather than ask for it twice.
  if (merged.gstin && !merged.stateCode) merged.stateCode = merged.gstin.slice(0, 2);
  await unscoped('org-billing-write', () => Org.updateOne({ _id: orgId }, { $set: { billing: merged } }));
  return getOrgBilling(orgId);
}

// ── Drafts ─────────────────────────────────────────────────────────────────

export interface LineInput {
  description: string;
  quantity?: number;
  /** Rupees. */
  unitPrice: number | string;
  sacCode?: string;
}

function normalizeLines(lines: unknown, defaultSac?: string): Doc[] {
  if (!Array.isArray(lines) || lines.length === 0) throw invalid('An invoice needs at least one line.', 'lines');
  if (lines.length > 50) throw invalid('An invoice has at most 50 lines.', 'lines');
  return lines.map((raw: Doc, i: number) => {
    const description = text(raw?.description, 300);
    if (!description) throw invalid(`Line ${i + 1} needs a description.`, 'lines');
    const quantity = raw?.quantity === undefined ? 1 : Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw invalid(`Line ${i + 1}: quantity is a whole number from 1 to 1000.`, 'lines');
    const price = Number(raw?.unitPrice);
    if (!Number.isFinite(price) || price < 0 || price > 10_000_000) throw invalid(`Line ${i + 1}: the unit price must be zero or more.`, 'lines');
    const sacCode = raw?.sacCode ? String(raw.sacCode) : defaultSac;
    if (sacCode && !SAC.test(sacCode)) throw invalid(`Line ${i + 1}: a SAC code is 4 to 8 digits.`, 'lines');
    const unitPriceMinor = Math.round(price * 100);
    return { description, quantity, unitPriceMinor, amountMinor: unitPriceMinor * quantity, ...(sacCode ? { sacCode } : {}) };
  });
}

/** Totals as they would be issued NOW — recomputed at issue, frozen after. */
function totalsFor(lines: Doc[], profile: Doc, buyer: Doc) {
  const linesTotal = lines.reduce((sum, l) => sum + l.amountMinor, 0);
  try {
    const tax = computeTax({
      linesTotalMinor: linesTotal,
      ratePercent: profile.gstRatePercent,
      sellerGstin: profile.gstin,
      sellerStateCode: profile.stateCode,
      buyerStateCode: buyer.stateCode,
      inclusive: profile.planPricesIncludeGst,
    });
    return { tax, problem: null as string | null };
  } catch (error) {
    if (error instanceof TaxInputError) {
      return {
        tax: computeTax({ linesTotalMinor: linesTotal }),
        problem: error.message,
      };
    }
    throw error;
  }
}

function taxFields(tax: ReturnType<typeof computeTax>) {
  return {
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

/** The next period to bill for: from where current access ends, one interval long. */
function nextPeriod(sub: Doc, now: Date): { start: Date; end: Date; interval: BillingInterval } {
  const interval: BillingInterval = sub.billingInterval === 'annual' ? 'annual' : 'monthly';
  let start = now;
  if (sub.status === 'active' && sub.periodEnd && new Date(sub.periodEnd) > now) start = new Date(sub.periodEnd);
  if (sub.status === 'trialing' && sub.trialEndsAt && new Date(sub.trialEndsAt) > now) start = new Date(sub.trialEndsAt);
  return { start, end: addInterval(start, interval), interval };
}

export interface DraftInput {
  /** Bill the subscription's plan for its next period. */
  fromSubscription?: boolean;
  lines?: LineInput[];
  periodStart?: string | Date;
  periodEnd?: string | Date;
  notes?: string;
}

const dateOf = (value: unknown, field: string): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value as string);
  if (Number.isNaN(d.getTime())) throw invalid(`${field} is not a valid date.`, field);
  return d;
};

export async function createDraftInvoice(orgId: string, input: DraftInput, actor: Actor): Promise<Doc> {
  if (!mongoose.Types.ObjectId.isValid(orgId)) throw new BillingError(404, 'ORG_NOT_FOUND', 'Organization not found.');
  const { Org, Subscription, Invoice } = models();
  const [org, sub] = await unscoped('draft-load', () =>
    Promise.all([Org.findById(orgId).select('name billing isPlatformOwned deletion').lean(), Subscription.findOne({ orgId }).lean()]),
  );
  if (!org) throw new BillingError(404, 'ORG_NOT_FOUND', 'Organization not found.');
  if (org.deletion) throw new BillingError(409, 'ORG_DELETING', 'This organization is being deleted.');
  if (isPlatformOwned(org, sub)) {
    throw new BillingError(409, 'PLATFORM_OWNED', 'This organization is platform-owned and is never invoiced.');
  }
  const profile = await getBillingProfile();
  const now = new Date();

  let lines: Doc[];
  const extra: Doc = {};
  if (input.fromSubscription) {
    if (!sub) throw new BillingError(404, 'SUBSCRIPTION_NOT_FOUND', 'This organization has no subscription to invoice.');
    const terms = await termsForSubscription(sub);
    if (!terms) throw new BillingError(409, 'PLAN_REQUIRED', 'The subscription has no plan; add the lines by hand.');
    const period = nextPeriod(sub, now);
    const price = period.interval === 'annual' ? terms.price?.annual : terms.price?.monthly;
    if (terms.customPricing || price === undefined || price === null) {
      throw new BillingError(409, 'PRICE_REQUIRED', `"${terms.name ?? terms.planKey}" has no ${period.interval} price; add the lines by hand.`);
    }
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    lines = normalizeLines(
      [{ description: `${terms.name ?? terms.planKey} plan, ${period.interval} (${fmt(period.start)} to ${fmt(period.end)})`, quantity: 1, unitPrice: price }],
      profile.sacCode,
    );
    Object.assign(extra, {
      periodStart: period.start,
      periodEnd: period.end,
      billingInterval: period.interval,
      planKey: terms.planKey,
      planVersion: terms.planVersion,
    });
  } else {
    lines = normalizeLines(input.lines, profile.sacCode);
    const start = dateOf(input.periodStart, 'periodStart');
    const end = dateOf(input.periodEnd, 'periodEnd');
    if (start && end && end <= start) throw invalid('The period must end after it starts.', 'periodEnd');
    if (start) extra.periodStart = start;
    if (end) extra.periodEnd = end;
    if (sub?.billingInterval) extra.billingInterval = sub.billingInterval;
  }

  const { tax } = totalsFor(lines, profile, { ...(org.billing ?? {}) });
  const created = await unscoped('draft-create', () =>
    Invoice.create({
      orgId,
      subscriptionId: sub?._id,
      status: 'draft',
      lines,
      currency: 'INR',
      ...taxFields(tax),
      ...extra,
      notes: text(input.notes, 1000),
      createdBy: { id: actor.id, role: actor.role },
    }),
  );
  return invoiceView(created.toObject());
}

/**
 * The period an institute's order pays for: from where its current access
 * ends (a running trial or paid period), otherwise from now — one interval.
 * The same anchoring `payment_confirmed` applies, so the invoice says exactly
 * what the payment will buy.
 */
export function orderPeriod(sub: Doc | null, interval: BillingInterval, now: Date): { start: Date; end: Date } {
  let start = now;
  if (sub?.status === 'active' && sub.periodEnd && new Date(sub.periodEnd) > now) start = new Date(sub.periodEnd);
  if (sub?.status === 'trialing' && sub.trialEndsAt && new Date(sub.trialEndsAt) > now) start = new Date(sub.trialEndsAt);
  return { start, end: addInterval(start, interval) };
}

export interface OrderInput {
  planKey: string;
  planVersion: number;
  billingInterval: BillingInterval;
  kind: 'new' | 'renewal' | 'upgrade' | 'downgrade';
}

/**
 * A draft invoice for an institute's own order (core/billing/selfServe): the
 * chosen plan's price for the chosen interval, for the next period. Marked
 * `origin: 'self-serve'`, so paying it applies the plan it names.
 */
export async function createOrderInvoice(orgId: string, input: OrderInput, actor: Actor): Promise<Doc> {
  const { Org, Subscription, Invoice } = models();
  const [org, sub] = await unscoped('order-load', () =>
    Promise.all([Org.findById(orgId).select('name billing isPlatformOwned deletion').lean(), Subscription.findOne({ orgId }).lean()]),
  );
  if (!org) throw new BillingError(404, 'ORG_NOT_FOUND', 'Organization not found.');
  if (org.deletion) throw new BillingError(409, 'ORG_DELETING', 'This organization is being deleted.');
  if (isPlatformOwned(org, sub)) throw new BillingError(409, 'PLATFORM_OWNED', 'This organization is platform-owned and is never invoiced.');

  const terms = await termsForSubscription({ planKey: input.planKey, planVersion: input.planVersion });
  if (!terms) throw new BillingError(404, 'PLAN_NOT_FOUND', 'That plan is not available.');
  const price = input.billingInterval === 'annual' ? terms.price?.annual : terms.price?.monthly;
  if (terms.customPricing || price === undefined || price === null || !(Number(price) > 0)) {
    throw new BillingError(409, 'PRICE_REQUIRED', `"${terms.name ?? input.planKey}" has no ${input.billingInterval} price. Talk to the platform team.`);
  }
  const profile = await getBillingProfile();
  const now = new Date();
  const period = orderPeriod(sub, input.billingInterval, now);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const lines = normalizeLines(
    [{ description: `${terms.name ?? input.planKey} plan, ${input.billingInterval} (${fmt(period.start)} to ${fmt(period.end)})`, quantity: 1, unitPrice: price }],
    profile.sacCode,
  );
  const setupFee = Number(terms.price?.setupFee ?? 0);
  // A setup fee is charged once: on the first paid order of an institute that never paid before.
  if (setupFee > 0 && input.kind === 'new') {
    lines.push(...normalizeLines([{ description: 'One-time setup fee', quantity: 1, unitPrice: setupFee }], profile.sacCode));
  }
  const { tax } = totalsFor(lines, profile, { ...(org.billing ?? {}) });
  const created = await unscoped('order-create', () =>
    Invoice.create({
      orgId,
      subscriptionId: sub?._id,
      status: 'draft',
      lines,
      currency: 'INR',
      ...taxFields(tax),
      periodStart: period.start,
      periodEnd: period.end,
      billingInterval: input.billingInterval,
      planKey: terms.planKey ?? input.planKey,
      planVersion: terms.planVersion ?? input.planVersion,
      origin: 'self-serve',
      order: { kind: input.kind, by: { id: actor.id, email: actor.email } },
      notes: `Ordered from the institute's admin panel (${input.kind}).`,
      createdBy: { id: actor.id, role: actor.role },
    }),
  );
  return invoiceView(created.toObject());
}

async function loadInvoice(invoiceId: string): Promise<Doc> {
  if (!mongoose.Types.ObjectId.isValid(invoiceId)) throw new BillingError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
  const { Invoice } = models();
  const invoice = await unscoped('invoice-load', () => Invoice.findById(invoiceId).lean());
  if (!invoice) throw new BillingError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
  return invoice;
}

export async function updateDraftInvoice(invoiceId: string, input: DraftInput): Promise<Doc> {
  const invoice = await loadInvoice(invoiceId);
  if (invoice.status !== 'draft') throw new BillingError(409, 'INVOICE_NOT_DRAFT', 'Only a draft can be edited. Void an issued invoice and issue a new one.');
  const profile = await getBillingProfile();
  const set: Doc = {};
  const lines = input.lines !== undefined ? normalizeLines(input.lines, profile.sacCode) : invoice.lines;
  if (input.lines !== undefined) set.lines = lines;
  if (input.notes !== undefined) set.notes = text(input.notes, 1000);
  const start = input.periodStart !== undefined ? dateOf(input.periodStart, 'periodStart') : invoice.periodStart;
  const end = input.periodEnd !== undefined ? dateOf(input.periodEnd, 'periodEnd') : invoice.periodEnd;
  if (start && end && new Date(end) <= new Date(start)) throw invalid('The period must end after it starts.', 'periodEnd');
  if (input.periodStart !== undefined) set.periodStart = start;
  if (input.periodEnd !== undefined) set.periodEnd = end;
  const buyer = await getOrgBilling(String(invoice.orgId));
  Object.assign(set, taxFields(totalsFor(lines, profile, buyer).tax));

  const { Invoice } = models();
  const saved = await unscoped('draft-update', () =>
    Invoice.findOneAndUpdate({ _id: invoice._id, status: 'draft', revision: invoice.revision }, { $set: set, $inc: { revision: 1 } }, { new: true }).lean(),
  );
  if (!saved) throw new BillingError(409, 'INVOICE_CONFLICT', 'The invoice changed while this was being saved. Reload it.');
  return invoiceView(saved);
}

export async function deleteDraftInvoice(invoiceId: string): Promise<void> {
  const invoice = await loadInvoice(invoiceId);
  if (invoice.status !== 'draft') throw new BillingError(409, 'INVOICE_NOT_DRAFT', 'Only a draft can be deleted; an issued invoice is voided.');
  const { Invoice } = models();
  const result = await unscoped('draft-delete', () => Invoice.deleteOne({ _id: invoice._id, status: 'draft' }));
  if (result.deletedCount !== 1) throw new BillingError(409, 'INVOICE_CONFLICT', 'The invoice changed; reload it.');
}

// ── Issue, void ────────────────────────────────────────────────────────────

async function recordInvoiceEvent(invoice: Doc, type: string, actor: Actor, metadata: Doc = {}) {
  try {
    const { SubscriptionEvent } = models();
    await unscoped('invoice-event', () =>
      SubscriptionEvent.create({
        orgId: invoice.orgId,
        subscriptionId: invoice.subscriptionId,
        type,
        actor: { kind: actor.kind, id: actor.id, role: actor.role },
        metadata: { invoiceId: String(invoice._id), number: invoice.number, totalMinor: invoice.totalMinor, ...metadata },
        at: new Date(),
      }),
    );
  } catch (error) {
    console.error(`[billing] could not record "${type}" for invoice ${invoice._id}:`, (error as Error).message);
  }
  void sendEventNotice(String(invoice.orgId), type, {
    metadata: { number: invoice.number, totalMinor: invoice.totalMinor, dueAt: invoice.dueAt, ...metadata },
  });
}

/** The next number in the financial year, for this prefix. A number taken is never reused. */
async function nextInvoiceNumber(profile: Doc, now: Date) {
  const { InvoiceCounter } = models();
  const financialYear = financialYearOf(now);
  const prefix = profile.invoicePrefix || 'INV';
  const counter = await unscoped('issue-counter', () =>
    InvoiceCounter.findOneAndUpdate({ prefix, financialYear }, { $inc: { seq: 1 } }, { upsert: true, new: true }).lean(),
  );
  return { number: formatInvoiceNumber(prefix, financialYear, counter.seq), financialYear, sequence: counter.seq as number };
}

const stateNameOf = (code?: string) => (code && GST_STATE_CODES[code]) || undefined;

/** The platform as the seller, copied onto an invoice at issue. */
function sellerParty(profile: Doc) {
  return {
    name: profile.tradeName || profile.legalName,
    legalName: profile.legalName,
    gstin: profile.gstin,
    pan: profile.pan,
    address: profile.address,
    city: profile.city,
    pincode: profile.pincode,
    stateCode: profile.stateCode,
    stateName: stateNameOf(profile.stateCode),
    email: profile.email,
    phone: profile.phone,
  };
}

/** The organization as the buyer: its billing details, else its profile. */
function buyerParty(org: Doc | null) {
  const billing = org?.billing ?? {};
  return {
    name: org?.name,
    legalName: billing.legalName || org?.name,
    gstin: billing.gstin,
    address: billing.address || org?.profile?.address,
    city: billing.city || org?.profile?.city,
    pincode: billing.pincode,
    stateCode: billing.stateCode,
    stateName: stateNameOf(billing.stateCode) || org?.profile?.state,
    email: billing.email || org?.profile?.contactEmail,
    phone: billing.phone || org?.profile?.contactPhone,
  };
}

/**
 * Issue a draft: take the next number in the financial year, freeze the totals
 * and copy the seller and buyer onto it. A draft is claimed before a number is
 * taken, so two simultaneous issues of one draft use one number.
 */
export async function issueInvoice(invoiceId: string, actor: Actor): Promise<Doc> {
  const invoice = await loadInvoice(invoiceId);
  if (invoice.status !== 'draft') throw new BillingError(409, 'INVOICE_NOT_DRAFT', `This invoice is already ${invoice.status}.`);
  const { Invoice, Org } = models();
  const now = new Date();

  const [profile, org] = await Promise.all([
    getBillingProfile(),
    unscoped('issue-org', () => Org.findById(invoice.orgId).select('name billing profile').lean()),
  ]);
  const buyerBilling = org?.billing ?? {};
  const { tax, problem } = totalsFor(invoice.lines, profile, buyerBilling);
  if (problem) throw new BillingError(400, 'BILLING_DETAILS_REQUIRED', problem);
  if (!(tax.totalMinor > 0)) throw new BillingError(400, 'INVOICE_EMPTY', 'An invoice must be for more than ₹0.');

  const claimed = await unscoped('issue-claim', () =>
    Invoice.findOneAndUpdate(
      {
        _id: invoice._id,
        status: 'draft',
        $or: [{ issuingAt: { $exists: false } }, { issuingAt: null }, { issuingAt: { $lt: new Date(now.getTime() - CLAIM_MS) } }],
      },
      { $set: { issuingAt: now } },
      { new: true },
    ).lean(),
  );
  if (!claimed) throw new BillingError(409, 'INVOICE_CONFLICT', 'This invoice is being issued by someone else.');

  try {
    const { number, financialYear, sequence } = await nextInvoiceNumber(profile, now);
    const issued = await unscoped('issue-write', () =>
      Invoice.findOneAndUpdate(
        { _id: invoice._id, status: 'draft' },
        {
          $set: {
            status: 'issued',
            number,
            financialYear,
            sequence,
            ...taxFields(tax),
            seller: sellerParty(profile),
            buyer: buyerParty(org),
            issuedAt: now,
            dueAt: new Date(now.getTime() + (profile.paymentTermsDays ?? 7) * DAY_MS),
            issuedBy: { id: actor.id, role: actor.role },
            paymentInstructions: profile.paymentInstructions,
          },
          $unset: { issuingAt: 1 },
          $inc: { revision: 1 },
        },
        { new: true },
      ).lean(),
    );
    if (!issued) throw new BillingError(409, 'INVOICE_CONFLICT', 'The invoice changed while it was being issued.');
    await recordInvoiceEvent(issued, 'invoice_issued', actor);
    return invoiceView(issued);
  } catch (error) {
    await unscoped('issue-release', () => Invoice.updateOne({ _id: invoice._id, status: 'draft' }, { $unset: { issuingAt: 1 } }));
    if (error instanceof TaxInputError) throw new BillingError(400, error.code, error.message);
    throw error;
  }
}

export async function voidInvoice(invoiceId: string, reason: unknown, actor: Actor): Promise<Doc> {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why.length < 3) throw new BillingError(400, 'REASON_REQUIRED', 'Give a reason for voiding the invoice.');
  const invoice = await loadInvoice(invoiceId);
  if (invoice.status === 'draft') throw new BillingError(409, 'INVOICE_NOT_ISSUED', 'A draft is deleted, not voided.');
  if (invoice.status === 'paid') {
    throw new BillingError(409, 'INVOICE_PAID', 'A paid invoice cannot be voided. Refunds and credit notes are not supported yet.');
  }
  if (invoice.status === 'void') return invoiceView(invoice);
  const { Invoice } = models();
  const voided = await unscoped('void', () =>
    Invoice.findOneAndUpdate(
      { _id: invoice._id, status: 'issued', amountPaidMinor: 0 },
      { $set: { status: 'void', voidedAt: new Date(), voidReason: why.slice(0, 500) }, $inc: { revision: 1 } },
      { new: true },
    ).lean(),
  );
  if (!voided) throw new BillingError(409, 'INVOICE_CONFLICT', 'The invoice changed (it may have just been paid). Reload it.');
  await recordInvoiceEvent(voided, 'invoice_voided', actor, { reason: why.slice(0, 500) });
  return invoiceView(voided);
}

// ── Settlement ─────────────────────────────────────────────────────────────

export interface SettleInput {
  amount: number | string;
  method: string;
  reference: string;
  receivedAt?: string | Date;
  notes?: string;
}

/**
 * Settle an issued invoice with one payment for its full balance. The payment
 * is recorded and applied exactly as a manual payment is — the subscription
 * becomes (or stays) active through the invoice's period — then the invoice is
 * marked paid. Retrying with the same reference is the same payment.
 */
export async function settleInvoice(invoiceId: string, input: SettleInput, actor: Actor, provider = 'manual') {
  const invoice = await loadInvoice(invoiceId);
  const reference = String(input.reference ?? '').trim();
  const { Payment, Invoice } = models();

  if (invoice.status === 'paid') {
    const same = await unscoped('settle-same', () =>
      Payment.findOne({ provider, orgId: invoice.orgId, reference, invoiceId: invoice._id, status: 'confirmed' }).lean(),
    );
    if (same) return { invoice: invoiceView(invoice), payment: same, duplicate: true };
    throw new BillingError(409, 'INVOICE_ALREADY_PAID', 'This invoice has already been paid.');
  }
  if (invoice.status === 'void') throw new BillingError(409, 'INVOICE_VOID', 'This invoice was voided.');
  if (invoice.status !== 'issued') throw new BillingError(409, 'INVOICE_NOT_ISSUED', 'Issue the invoice before recording a payment against it.');

  const balance = invoice.totalMinor - (invoice.amountPaidMinor ?? 0);
  const amountMinor = Math.round(Number(input.amount) * 100);
  if (amountMinor !== balance) {
    throw new BillingError(400, 'PAYMENT_AMOUNT_MISMATCH', `The payment must settle the invoice in full: ₹${rupees(balance)}.`, {
      expected: balance / 100,
    });
  }

  const periodEnd = invoice.periodEnd && new Date(invoice.periodEnd) > new Date() ? new Date(invoice.periodEnd) : undefined;
  let payment: Doc | null = null;
  let lifecycle: Doc = { applied: true };
  let duplicate = false;
  try {
    const result = await recordManualPayment(
      String(invoice.orgId),
      {
        amount: input.amount,
        method: input.method,
        reference,
        receivedAt: input.receivedAt,
        periodEnd,
        billingInterval: invoice.billingInterval,
        notes: input.notes ?? `Invoice ${invoice.number}`,
      },
      actor,
      {
        provider,
        invoiceId: String(invoice._id),
        // An institute's own order moves it to the plan it paid for (or starts
        // its subscription). A staff-drafted invoice never changes the plan.
        ...(invoice.origin === 'self-serve' && invoice.planKey
          ? { plan: { planKey: invoice.planKey, planVersion: invoice.planVersion } }
          : {}),
      },
    );
    payment = result.payment;
    duplicate = Boolean(result.duplicate);
    if (result.applied === false) lifecycle = { applied: false, pending: Boolean((result as Doc).pending) };
  } catch (error) {
    // The money is real even when the subscription could not take it (a
    // platform-owned or terminated subscription): the payment exists and the
    // invoice is paid; the lifecycle problem is reported, not hidden.
    if (error instanceof SubscriptionError && error.details?.paymentId) {
      payment = await unscoped('settle-recorded', () => Payment.findById(error.details.paymentId).lean());
      lifecycle = { applied: false, code: error.code, message: error.message };
    } else if (error instanceof SubscriptionError) {
      throw new BillingError(error.status, error.code, error.message, error.details);
    } else throw error;
  }

  const paid = await unscoped('settle-mark', () =>
    Invoice.findOneAndUpdate(
      { _id: invoice._id, status: 'issued' },
      {
        $set: { status: 'paid', paidAt: payment?.receivedAt ?? new Date(), amountPaidMinor: invoice.totalMinor },
        $addToSet: { paymentIds: payment?._id },
        $inc: { revision: 1 },
      },
      { new: true },
    ).lean(),
  );
  const current = paid ?? (await loadInvoice(invoiceId));
  if (paid) await recordInvoiceEvent(paid, 'invoice_paid', actor, { paymentId: String(payment?._id), reference });
  return { invoice: invoiceView(current), payment, duplicate, lifecycle };
}

/**
 * An invoice for money a gateway has ALREADY collected and the subscription
 * has already been given — an institute that paid online while applying
 * (core/billing/registrationPayments). Numbered like any invoice, and issued
 * straight as paid: there is nothing left to settle, so settleInvoice (which
 * would apply the payment a second time) is not involved.
 *
 * The lines and tax are the ones the customer was charged, frozen at checkout,
 * not recomputed from today's billing profile: an invoice states what was
 * paid. The caller holds the claim that keeps one payment to one invoice.
 */
export interface PaidInvoiceInput {
  orgId: string;
  lines: Doc[];
  subtotalMinor: number;
  tax: Doc;
  totalMinor: number;
  currency?: string;
  planKey?: string;
  planVersion?: number;
  billingInterval?: string;
  periodStart?: Date;
  periodEnd?: Date;
  paymentId: string;
  paidAt: Date;
  registrationId?: string;
  notes?: string;
}

export async function issuePaidInvoice(input: PaidInvoiceInput, actor: Actor): Promise<Doc> {
  if (!(input.totalMinor > 0)) throw new BillingError(400, 'INVOICE_EMPTY', 'An invoice must be for more than ₹0.');
  const { Invoice, Org, Payment } = models();
  const [profile, org] = await Promise.all([
    getBillingProfile(),
    unscoped('paid-org', () => Org.findById(input.orgId).select('name billing profile').lean()),
  ]);
  if (!org) throw new BillingError(404, 'ORG_NOT_FOUND', 'Organization not found.');
  const now = new Date();
  const { number, financialYear, sequence } = await nextInvoiceNumber(profile, now);
  const created = await unscoped('paid-create', () =>
    Invoice.create({
      orgId: input.orgId,
      status: 'paid',
      number,
      financialYear,
      sequence,
      lines: input.lines,
      currency: input.currency ?? 'INR',
      subtotalMinor: input.subtotalMinor,
      tax: input.tax,
      totalMinor: input.totalMinor,
      amountPaidMinor: input.totalMinor,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      billingInterval: input.billingInterval,
      planKey: input.planKey,
      planVersion: input.planVersion,
      seller: sellerParty(profile),
      buyer: buyerParty(org),
      issuedAt: now,
      dueAt: input.paidAt,
      paidAt: input.paidAt,
      paymentIds: [input.paymentId],
      origin: 'registration',
      ...(input.registrationId ? { registrationId: input.registrationId } : {}),
      notes: text(input.notes, 1000),
      createdBy: { id: actor.id, role: actor.role },
      issuedBy: { id: actor.id, role: actor.role },
    }),
  );
  const invoice = created.toObject();
  await unscoped('paid-link', () =>
    Payment.updateOne({ _id: input.paymentId, invoiceId: { $exists: false } }, { $set: { invoiceId: invoice._id } }),
  );
  await recordInvoiceEvent(invoice, 'invoice_paid', actor, { paymentId: String(input.paymentId), origin: 'registration' });
  return invoiceView(invoice);
}

// ── Reads ──────────────────────────────────────────────────────────────────

export function invoiceView(invoice: Doc): Doc & { id: string; balanceMinor: number; overdue: boolean; taxInvoice: boolean } {
  const now = Date.now();
  const balanceMinor = invoice.status === 'void' ? 0 : (invoice.totalMinor ?? 0) - (invoice.amountPaidMinor ?? 0);
  return {
    ...invoice,
    id: String(invoice._id),
    balanceMinor,
    overdue: invoice.status === 'issued' && invoice.dueAt ? new Date(invoice.dueAt).getTime() < now : false,
    taxInvoice: invoice.tax?.regime === 'gst',
  };
}

export async function getInvoice(invoiceId: string) {
  return invoiceView(await loadInvoice(invoiceId));
}

export async function listInvoices(query: { orgId?: string; status?: string; overdue?: boolean; limit?: number } = {}) {
  const { Invoice, Org } = models();
  const filter: Doc = {};
  if (query.orgId) {
    if (!mongoose.Types.ObjectId.isValid(query.orgId)) return [];
    filter.orgId = query.orgId;
  }
  if (query.status) filter.status = query.status;
  if (query.overdue) Object.assign(filter, { status: 'issued', dueAt: { $lt: new Date() } });
  const rows: Doc[] = await unscoped('list', () => Invoice.find(filter).sort({ createdAt: -1 }).limit(Math.min(query.limit ?? 100, 500)).lean());
  const orgs: Doc[] = await unscoped('list-orgs', () => Org.find({ _id: { $in: rows.map((r) => r.orgId) } }).select('name slug').lean());
  const byId = new Map(orgs.map((o) => [String(o._id), o]));
  return rows.map((r) => ({ ...invoiceView(r), organization: byId.get(String(r.orgId)) ?? null }));
}

/** An organization's own invoices — issued, paid or void; never drafts. */
export async function listOrgInvoices(orgId: string) {
  const { Invoice } = models();
  const rows: Doc[] = await unscoped('org-list', () =>
    Invoice.find({ orgId, status: { $ne: 'draft' } }).sort({ issuedAt: -1 }).limit(200).lean(),
  );
  return rows.map(invoiceView);
}

export async function getOrgInvoice(orgId: string, invoiceId: string) {
  const invoice = await loadInvoice(invoiceId);
  // Another organization's invoice and a draft answer exactly like a missing one.
  if (String(invoice.orgId) !== String(orgId) || invoice.status === 'draft') {
    throw new BillingError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
  }
  return invoiceView(invoice);
}

// ── The document ───────────────────────────────────────────────────────────

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const day = (d?: Date | string) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');

function party(title: string, p: Doc = {}) {
  const lines = [
    p.legalName || p.name,
    p.address,
    [p.city, p.pincode].filter(Boolean).join(' '),
    p.stateName ? `${p.stateName}${p.stateCode ? ` (state code ${p.stateCode})` : ''}` : '',
    p.gstin ? `GSTIN ${p.gstin}` : '',
    p.pan && !p.gstin ? `PAN ${p.pan}` : '',
    p.email,
    p.phone,
  ].filter(Boolean);
  return `<div class="party"><h3>${esc(title)}</h3>${lines.map((l) => `<div>${esc(l)}</div>`).join('') || '<div class="muted">Not provided</div>'}</div>`;
}

/**
 * A self-contained, printable invoice: no scripts, no external assets, every
 * value escaped — it renders the same in a browser and in the PDF renderer
 * (which loads nothing it is not allowed to).
 */
export function renderInvoiceHtml(invoice: Doc): string {
  const tax = invoice.tax ?? { regime: 'none' };
  const isTaxInvoice = tax.regime === 'gst';
  const title = invoice.status === 'draft' ? 'Draft invoice' : isTaxInvoice ? 'Tax invoice' : 'Invoice';
  const rows = (invoice.lines ?? [])
    .map(
      (l: Doc) =>
        `<tr><td>${esc(l.description)}</td><td>${esc(l.sacCode ?? '')}</td><td class="n">${esc(l.quantity)}</td><td class="n">${rupees(l.unitPriceMinor)}</td><td class="n">${rupees(l.amountMinor)}</td></tr>`,
    )
    .join('');
  const totals: [string, number][] = [];
  if (isTaxInvoice && tax.inclusive) totals.push(['Taxable value', invoice.subtotalMinor]);
  else totals.push(['Subtotal', invoice.subtotalMinor]);
  if (tax.cgstMinor) totals.push([`CGST ${(tax.ratePercent ?? 0) / 2}%`, tax.cgstMinor]);
  if (tax.sgstMinor) totals.push([`SGST ${(tax.ratePercent ?? 0) / 2}%`, tax.sgstMinor]);
  if (tax.igstMinor) totals.push([`IGST ${tax.ratePercent ?? 0}%`, tax.igstMinor]);
  totals.push(['Total', invoice.totalMinor]);
  if (invoice.amountPaidMinor) totals.push(['Paid', invoice.amountPaidMinor]);
  if (invoice.refundedMinor) totals.push(['Refunded', invoice.refundedMinor]);
  const stamp =
    invoice.status === 'void'
      ? `<div class="stamp void">VOID — ${esc(invoice.voidReason ?? '')}</div>`
      : invoice.status === 'paid'
        ? `<div class="stamp paid">PAID ${esc(day(invoice.paidAt))}</div>`
        : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} ${esc(invoice.number ?? '')}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:12px;margin:0;padding:24px}
  h1{font-size:20px;margin:0}h3{font-size:12px;margin:0 0 4px;text-transform:uppercase;color:#6b7280}
  .head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px}
  .meta div{text-align:right}.parties{display:flex;gap:24px;margin:16px 0}.party{flex:1}
  table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border-bottom:1px solid #e5e7eb;padding:6px 4px;text-align:left}
  th{background:#f9fafb}.n{text-align:right}.totals{margin-left:auto;width:45%;margin-top:8px}
  .totals td{border:none;padding:3px 4px}.totals tr:last-child td{font-weight:bold;border-top:1px solid #9ca3af}
  .muted{color:#6b7280}.note{margin-top:16px;padding:8px;background:#f9fafb}
  .stamp{display:inline-block;margin-top:8px;padding:4px 10px;border:2px solid;font-weight:bold}
  .paid{color:#047857}.void{color:#b91c1c}
</style></head><body>
<div class="head"><div><h1>${esc(title)}</h1>${stamp}</div>
<div class="meta"><div><strong>${esc(invoice.number ?? 'Not yet numbered')}</strong></div>
<div>Issued ${esc(day(invoice.issuedAt))}</div><div>Due ${esc(day(invoice.dueAt))}</div>
${invoice.periodStart ? `<div>Period ${esc(day(invoice.periodStart))} to ${esc(day(invoice.periodEnd))}</div>` : ''}
${tax.placeOfSupply ? `<div>Place of supply: ${esc(GST_STATE_CODES[tax.placeOfSupply] ?? tax.placeOfSupply)} (${esc(tax.placeOfSupply)})</div>` : ''}
</div></div>
<div class="parties">${party('From', invoice.seller)}${party('Bill to', invoice.buyer)}</div>
<table><thead><tr><th>Description</th><th>SAC</th><th class="n">Qty</th><th class="n">Rate (₹)</th><th class="n">Amount (₹)</th></tr></thead><tbody>${rows}</tbody></table>
<table class="totals"><tbody>${totals.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">₹${rupees(v)}</td></tr>`).join('')}</tbody></table>
${isTaxInvoice ? '' : '<div class="note">This is not a GST tax invoice: no GST has been charged.</div>'}
${invoice.paymentInstructions ? `<div class="note"><strong>How to pay</strong><br>${esc(invoice.paymentInstructions)}</div>` : ''}
${invoice.notes ? `<div class="note">${esc(invoice.notes)}</div>` : ''}
</body></html>`;
}
