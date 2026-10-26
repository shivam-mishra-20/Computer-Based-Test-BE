/**
 * Telling an organization's administrators what happened to their
 * subscription — trial started or ending, grace period, read-only, payment
 * received, invoice issued, a request answered.
 *
 * In-app (and push, where a device is registered) through the existing
 * notification service, as type `general` with `data.type: 'subscription'` —
 * the apps already render `general`, so no client change is needed to show
 * them. Sent to the organization's approved admins only, inside the
 * organization's own tenant context.
 *
 * Never throws and never blocks the change it reports: a notice that fails to
 * send is logged; the subscription change already happened.
 */

import mongoose from 'mongoose';
import { runWithTenant, withoutTenantScope } from '../tenancy/context';
import { rupees } from './gst';

type Doc = Record<string, any>;

const MAX_RECIPIENTS = 25;

const day = (d?: Date | string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '';

export interface Notice {
  title: string;
  body: string;
}

/**
 * The notice for one subscription or invoice event, or null when the event is
 * not something an institute needs to be told about.
 */
export function noticeFor(type: string, ctx: { after?: Doc; metadata?: Doc; planName?: string }): Notice | null {
  const s = ctx.after ?? {};
  const m = ctx.metadata ?? {};
  const plan = ctx.planName ? `${ctx.planName} ` : '';
  switch (type) {
    case 'start_trial':
      return { title: 'Your free trial has started', body: `Your ${plan}trial runs until ${day(s.trialEndsAt)}.` };
    case 'extend_trial':
      return { title: 'Your trial has been extended', body: `It now runs until ${day(s.trialEndsAt)}.` };
    case 'activate':
    case 'payment_confirmed':
      return s.status === 'active'
        ? { title: 'Your subscription is active', body: s.periodEnd ? `Paid up until ${day(s.periodEnd)}. Thank you.` : 'Thank you.' }
        : type === 'payment_confirmed'
          ? { title: 'Payment received', body: 'Thank you. Your subscription remains on hold; the platform team will be in touch.' }
          : null;
    case 'payment_failed':
      return {
        title: 'A payment could not be completed',
        body: `Everything keeps working until ${day(s.graceEndsAt)}. Please renew before then to avoid interruption.`,
      };
    case 'trial_ended':
    case 'period_ended':
      // The institute had asked to stop at this point: it ends, without grace.
      if (s.status === 'cancelled') {
        return {
          title: 'Your subscription has ended',
          body: 'It was cancelled at the end of the period, as you asked. Your data is kept and can still be exported; choose a plan any time to continue.',
        };
      }
      return type === 'trial_ended'
        ? { title: 'Your trial has ended', body: `You have until ${day(s.graceEndsAt)} to choose a plan; everything keeps working until then.` }
        : { title: 'Your subscription is due for renewal', body: `You have until ${day(s.graceEndsAt)} to renew; everything keeps working until then.` };
    case 'cancellation_scheduled':
      return {
        title: 'Cancellation scheduled',
        body: `Everything keeps working until ${day(m.endsAt)}; the subscription stops then. You can keep it from Subscription & billing before that date.`,
      };
    case 'cancellation_withdrawn':
      return { title: 'Your subscription will continue', body: 'The scheduled cancellation was withdrawn.' };
    case 'order_declined':
      return {
        title: `Your order${ctx.planName ? ` for ${ctx.planName}` : ''} was declined`,
        body: m.reason ? `The platform team said: “${m.reason}”. Your plan has not changed.` : 'Your plan has not changed. See Subscription & billing.',
      };
    case 'order_applied':
      return { title: 'Your new plan is active', body: 'The platform team switched it on ahead of payment. Please pay the invoice by its due date.' };
    case 'order_placed':
      return m.issued
        ? null // the invoice_issued notice that follows says it all
        : { title: `Order placed${ctx.planName ? `: ${ctx.planName}` : ''}`, body: 'The platform team will send your invoice shortly. Your plan changes once it is paid.' };
    case 'grace_ended':
    case 'expire':
      return {
        title: 'Your organization is now read-only',
        body: 'Your data is safe: it can still be viewed and exported. Renew to make changes again.',
      };
    case 'suspend':
      return { title: 'Your subscription is on hold', body: 'Your organization is read-only for now. Your data is safe. The platform team will contact you.' };
    case 'reactivate':
      return { title: 'Your subscription is back on', body: 'You can make changes again.' };
    case 'cancel':
      return { title: 'Your subscription has been cancelled', body: 'Your organization is read-only. Your data is kept and can still be exported.' };
    case 'plan_changed':
      return { title: 'Your plan has changed', body: ctx.planName ? `You are now on ${ctx.planName}.` : 'Your plan has been updated.' };
    case 'invoice_issued':
      return { title: `New invoice ${m.number ?? ''}`.trim(), body: `₹${rupees(Number(m.totalMinor ?? 0))}${m.dueAt ? `, due ${day(m.dueAt)}` : ''}. See Billing for details.` };
    case 'invoice_paid':
      return { title: `Invoice ${m.number ?? ''} paid`.trim(), body: 'Thank you — your payment has been received.' };
    case 'invoice_voided':
      return { title: `Invoice ${m.number ?? ''} cancelled`.trim(), body: 'This invoice no longer needs to be paid.' };
    case 'trial_ending':
      return { title: `Your trial ends in ${m.days} day${m.days === 1 ? '' : 's'}`, body: `It ends on ${day(s.trialEndsAt)}. Choose a plan from Billing to keep going without interruption.` };
    case 'request_resolved':
      return { title: `Your ${m.kind ?? ''} request was ${m.status === 'declined' ? 'declined' : 'handled'}`.replace('  ', ' '), body: String(m.note ?? '') || 'See Billing for details.' };
    default:
      return null;
  }
}

/** Send a notice to the organization's approved administrators. */
export async function notifyOrgAdmins(orgId: string, notice: Notice, data: Doc = {}): Promise<number> {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(orgId))) return 0;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const User = require('../../models/User').default;
    const admins: Doc[] = await (withoutTenantScope('notices:admins', async () =>
      User.collection
        .find(
          { orgId: { $in: [String(orgId), new mongoose.Types.ObjectId(String(orgId))] }, role: 'admin', status: 'approved' },
          { projection: { _id: 1 } },
        )
        .limit(MAX_RECIPIENTS)
        .toArray(),
    ) as Promise<Doc[]>);
    if (!admins.length) return 0;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createAndSendNotification } = require('../../services/notificationService');
    await runWithTenant({ orgId: String(orgId), source: 'script' }, async () => {
      for (const admin of admins) {
        await createAndSendNotification({
          userId: String(admin._id),
          title: notice.title,
          body: notice.body,
          type: 'general',
          // No `screen`: the apps have no billing route, and the notification
          // service strips any screen that is not one (a deep-link misroute
          // otherwise). Administrators read billing on the web admin panel.
          data: { type: 'subscription', ...data },
        });
      }
    });
    return admins.length;
  } catch (error) {
    console.error(`[notices] could not notify the admins of ${orgId}:`, (error as Error).message);
    return 0;
  }
}

/** The notice for an event, sent — or nothing. Fire-and-forget from the caller. */
export async function sendEventNotice(orgId: string, type: string, ctx: { after?: Doc; metadata?: Doc; planName?: string } = {}): Promise<void> {
  const notice = noticeFor(type, ctx);
  if (!notice) return;
  await notifyOrgAdmins(orgId, notice, { event: type });
}
