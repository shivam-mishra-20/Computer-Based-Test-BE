/**
 * The refund policy, as arithmetic. Pure: no database, no clock of its own.
 *
 * It SUGGESTS. A platform admin approves every refund (core/billing/
 * refundRequests) and may approve a different amount, up to what is still
 * refundable; the suggestion and its rule are recorded beside the decision.
 *
 *   before-approval   paid with an application that has not been approved
 *                     (or was rejected): everything back
 *   cooling-off       the paid period began at most COOLING_OFF_DAYS ago:
 *                     the plan back in full; a one-time setup fee is kept,
 *                     because onboarding has been done
 *   annual-unused     a yearly plan after the cooling-off: the whole months
 *                     still unused, at 1/12 of the plan each; setup fee kept
 *   monthly-none      a monthly plan after the cooling-off: nothing — it is
 *                     cancelled at period end and runs until then
 *   period-over       the period the payment bought has ended: nothing
 *
 * Amounts are shares of what was actually paid, so GST charged on a line is
 * returned with that line. A payment already partly refunded is suggested no
 * more than what remains.
 */

export const COOLING_OFF_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = (365.25 / 12) * DAY_MS;

export type RefundRule = 'before-approval' | 'cooling-off' | 'annual-unused' | 'monthly-none' | 'period-over';

export interface RefundContext {
  /** Paid with an application that has not (yet) become an organization. */
  beforeApproval: boolean;
  paidMinor: number;
  alreadyRefundedMinor?: number;
  billingInterval?: 'monthly' | 'annual' | string | null;
  periodStart?: Date | string | null;
  periodEnd?: Date | string | null;
  paidAt?: Date | string | null;
  /** The lines the payment paid for (an invoice's, or the checkout's), to find a setup fee. */
  lines?: { description: string; amountMinor: number }[];
  now: Date;
}

export interface RefundSuggestion {
  amountMinor: number;
  rule: RefundRule;
  explanation: string;
  /** The refund ends the service the payment bought (the subscription should stop). */
  endsService: boolean;
  /** Most that can still be refunded on this payment. */
  refundableMinor: number;
}

const time = (d?: Date | string | null) => (d ? new Date(d).getTime() : NaN);
const rupees = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** The share of the payment that is a one-time setup fee (GST included pro rata). */
export function setupFeeShareMinor(paidMinor: number, lines: RefundContext['lines'] = []): number {
  const total = lines.reduce((sum, l) => sum + Math.max(0, l.amountMinor || 0), 0);
  if (!(total > 0)) return 0;
  const fee = lines.filter((l) => /setup fee/i.test(l.description)).reduce((sum, l) => sum + Math.max(0, l.amountMinor || 0), 0);
  return Math.round((paidMinor * fee) / total);
}

export function suggestRefund(ctx: RefundContext): RefundSuggestion {
  const refundable = Math.max(0, ctx.paidMinor - (ctx.alreadyRefundedMinor ?? 0));
  const cap = (n: number) => Math.max(0, Math.min(refundable, Math.round(n)));
  const now = ctx.now.getTime();

  if (ctx.beforeApproval) {
    return {
      amountMinor: refundable,
      rule: 'before-approval',
      explanation: 'Paid with an application that has not been approved: everything is refunded.',
      endsService: false,
      refundableMinor: refundable,
    };
  }

  const start = time(ctx.periodStart ?? ctx.paidAt);
  const end = time(ctx.periodEnd);
  const fee = setupFeeShareMinor(ctx.paidMinor, ctx.lines);
  const planShare = ctx.paidMinor - fee;

  if (Number.isFinite(end) && end <= now) {
    return {
      amountMinor: 0,
      rule: 'period-over',
      explanation: 'The period this payment paid for has already ended.',
      endsService: false,
      refundableMinor: refundable,
    };
  }

  // A period that starts later (a renewal paid early) has not been used at all.
  const sinceStart = Number.isFinite(start) ? now - start : 0;
  if (sinceStart <= COOLING_OFF_DAYS * DAY_MS) {
    return {
      amountMinor: cap(planShare),
      rule: 'cooling-off',
      explanation:
        `Within ${COOLING_OFF_DAYS} days of the period starting: the plan is refunded in full` +
        (fee > 0 ? `; the one-time setup fee (${rupees(fee)}) is kept, as onboarding is done.` : '.'),
      endsService: true,
      refundableMinor: refundable,
    };
  }

  if (ctx.billingInterval === 'annual' && Number.isFinite(end)) {
    const monthsLeft = Math.max(0, Math.floor((end - now) / MONTH_MS));
    const amount = cap((planShare * monthsLeft) / 12);
    return {
      amountMinor: amount,
      rule: 'annual-unused',
      explanation: monthsLeft
        ? `Yearly plan: ${monthsLeft} whole month${monthsLeft === 1 ? '' : 's'} unused, refunded at 1/12 of the plan each${fee > 0 ? ' (setup fee kept)' : ''}.`
        : 'Yearly plan in its last month: nothing unused to refund.',
      endsService: monthsLeft > 0,
      refundableMinor: refundable,
    };
  }

  return {
    amountMinor: 0,
    rule: 'monthly-none',
    explanation: `Monthly plan after the first ${COOLING_OFF_DAYS} days: no refund — cancel to stop at the end of the month; it runs until then.`,
    endsService: false,
    refundableMinor: refundable,
  };
}
