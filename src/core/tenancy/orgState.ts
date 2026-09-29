/**
 * Is an organization open for business right now?
 *
 * Read on every authenticated tenant request, so it is cached briefly and
 * cleared by the two things that change it: a status change and a deletion.
 *
 *   deleting    An organization whose deletion has started (or stopped part
 *               way). Its users are refused outright: the data is being
 *               removed, and a user still working inside it would be writing
 *               rows the deletion then has to chase.
 *   read-only   suspended / cancelled / terminated. What the console promises
 *               operators: "Suspension makes the organization read-only. Their
 *               data stays visible and exportable." Writes are refused; reads
 *               are not, and an exam attempt already in progress may finish.
 *   missing     A claim names an organization that no longer exists.
 */

import { withoutTenantScope } from './context';

export interface OrgState {
  exists: boolean;
  status?: string;
  deleting: boolean;
}

export const READ_ONLY_STATUSES = new Set(['suspended', 'cancelled', 'terminated']);

const CACHE_MS = 15_000;
const cache = new Map<string, { state: OrgState; at: number }>();

export async function orgStateOf(orgId: string): Promise<OrgState> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.state;
  const org = (await withoutTenantScope('tenancy:org-state', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../../models/Org').default;
    return Org.findById(orgId).select('status deletion').lean();
  })) as { status?: string; deletion?: unknown } | null;
  const state: OrgState = org
    ? { exists: true, status: org.status, deleting: Boolean(org.deletion) }
    : { exists: false, deleting: false };
  cache.set(orgId, { state, at: Date.now() });
  return state;
}

/** Forget cached state — after a status change, a deletion step, or in tests. */
export function clearOrgStateCache(orgId?: string): void {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}
