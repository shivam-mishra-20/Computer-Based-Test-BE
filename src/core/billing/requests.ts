/**
 * Requests from an organization to the platform: renew, upgrade, downgrade,
 * cancel. A request changes nothing — platform staff act on it through the
 * lifecycle endpoints and then resolve it — so an organization asking for
 * Enterprise is a conversation, never a grant.
 */

import mongoose from 'mongoose';
import { withoutTenantScope } from '../tenancy/context';
import { BillingError } from './invoices';
import type { Actor } from '../subscriptions/service';
import { sendEventNotice } from './notices';

type Doc = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unscoped = (label: string, fn: () => any): Promise<any> => withoutTenantScope(`billing-requests:${label}`, fn) as Promise<any>;
const models = () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SubscriptionRequest: require('../../models/SubscriptionRequest').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Plan: require('../../models/Plan').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Org: require('../../models/Org').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  kinds: require('../../models/SubscriptionRequest').SUBSCRIPTION_REQUEST_KINDS as string[],
});

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

/**
 * Ask. One open request per kind: asking again returns the open one, so a
 * double click or an impatient admin is one request.
 */
export async function createSubscriptionRequest(
  orgId: string,
  input: { kind?: string; planKey?: string; billingInterval?: string; message?: string },
  requester: { id?: string; name?: string; email?: string },
) {
  const { SubscriptionRequest, Plan, kinds } = models();
  const kind = String(input.kind ?? '');
  if (!kinds.includes(kind)) {
    throw new BillingError(400, 'REQUEST_INVALID', `A request is one of: ${kinds.join(', ')}.`);
  }
  let planKey: string | undefined;
  if (input.planKey) {
    const plan = await unscoped('plan', () => Plan.findOne({ key: String(input.planKey).toLowerCase() }).lean());
    if (!plan || plan.isActive === false) throw new BillingError(400, 'PLAN_NOT_FOUND', 'That plan is not available.');
    planKey = plan.key;
  }
  if ((kind === 'upgrade' || kind === 'downgrade') && !planKey) {
    throw new BillingError(400, 'REQUEST_INVALID', 'Name the plan you would like to move to.');
  }
  const billingInterval = input.billingInterval === 'annual' ? 'annual' : input.billingInterval === 'monthly' ? 'monthly' : undefined;
  const message = typeof input.message === 'string' ? input.message.trim().slice(0, 1000) : undefined;
  // The open one, if there is one. The unique index below is what holds under
  // a race; this read is what holds before that index exists (a new database
  // builds it in the background after start-up).
  const existing = await unscoped('open-first', () => SubscriptionRequest.findOne({ orgId, kind, status: 'open' }).lean());
  if (existing) return { request: existing, duplicate: true };
  try {
    const created = await unscoped('create', () =>
      SubscriptionRequest.create({ orgId, kind, planKey, billingInterval, message, requestedBy: requester }),
    );
    return { request: created.toObject(), duplicate: false };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const open = await unscoped('open', () => SubscriptionRequest.findOne({ orgId, kind, status: 'open' }).lean());
    return { request: open, duplicate: true };
  }
}

export async function listOrgRequests(orgId: string) {
  const { SubscriptionRequest } = models();
  return unscoped('org-list', () => SubscriptionRequest.find({ orgId }).sort({ createdAt: -1 }).limit(50).lean());
}

export async function listSubscriptionRequests(query: { status?: string; limit?: number } = {}) {
  const { SubscriptionRequest, Org } = models();
  const filter: Doc = {};
  if (query.status) filter.status = query.status;
  const rows: Doc[] = await unscoped('list', () =>
    SubscriptionRequest.find(filter).sort({ createdAt: -1 }).limit(Math.min(query.limit ?? 100, 500)).lean(),
  );
  const orgs: Doc[] = await unscoped('list-orgs', () => Org.find({ _id: { $in: rows.map((r) => r.orgId) } }).select('name slug').lean());
  const byId = new Map(orgs.map((o) => [String(o._id), o]));
  return rows.map((r) => ({ ...r, organization: byId.get(String(r.orgId)) ?? null }));
}

/** Close a request as handled or declined. The change itself is made elsewhere, by staff. */
export async function resolveSubscriptionRequest(requestId: string, input: { status?: string; note?: string }, actor: Actor) {
  if (!mongoose.Types.ObjectId.isValid(requestId)) throw new BillingError(404, 'REQUEST_NOT_FOUND', 'Request not found.');
  const status = input.status === 'declined' ? 'declined' : input.status === 'resolved' ? 'resolved' : null;
  if (!status) throw new BillingError(400, 'REQUEST_INVALID', 'Resolve a request as "resolved" or "declined".');
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length < 3) throw new BillingError(400, 'REASON_REQUIRED', 'Say what was done, or why it was declined.');
  const { SubscriptionRequest } = models();
  const updated = await unscoped('resolve', () =>
    SubscriptionRequest.findOneAndUpdate(
      { _id: requestId, status: 'open' },
      { $set: { status, resolution: note.slice(0, 1000), resolvedAt: new Date(), resolvedBy: { id: actor.id, role: actor.role } } },
      { new: true },
    ).lean(),
  );
  if (!updated) {
    const exists = await unscoped('exists', () => SubscriptionRequest.exists({ _id: requestId }));
    if (!exists) throw new BillingError(404, 'REQUEST_NOT_FOUND', 'Request not found.');
    throw new BillingError(409, 'REQUEST_CLOSED', 'This request is already closed.');
  }
  void sendEventNotice(String(updated.orgId), 'request_resolved', {
    metadata: { kind: updated.kind, status: updated.status, note: updated.resolution },
  });
  return updated;
}
