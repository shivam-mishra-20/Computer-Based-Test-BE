/**
 * Features that belong to ONE organization's systems, not to every tenant.
 *
 * ── Why a module gate is not enough ─────────────────────────────────────────
 * A module (`integrations`, say) is a commercial switch: "this organization may
 * use integrations". It says nothing about WHOSE external system an integration
 * reaches. The Firestore sync, the EtimeOffice biometric fetch and the EPUB
 * automation all read systems that belong to the organization the platform grew
 * out of — one global Firestore `Users` collection with no organization
 * dimension, one biometric account, one folder on the server. Enabling the
 * module for a second institute would hand it the first institute's staff and
 * students. So these routes also require that the caller's organization OWNS
 * that data: the legacy data owner (`LEGACY_DATA_ORG_ID`, or the pinned
 * organization on api-legacy).
 *
 * Anyone else gets a 404 with a plain explanation — the feature does not exist
 * for them, and the response says nothing about whose it is.
 *
 * ── Pre-migration ───────────────────────────────────────────────────────────
 * A deployment with no tenancy configured is single-institute by definition;
 * these features run exactly as they always have there.
 */

import { NextFunction, Request, Response } from 'express';
import { currentOrgId, withoutTenantScope } from '../core/tenancy/context';
import { legacyDataOrgId, tenancyConfigured } from '../core/tenancy/config';

function notAvailable(res: Response, feature: string) {
  return res.status(404).json({
    message: `${feature} is not available for your organization.`,
    code: 'FEATURE_NOT_AVAILABLE',
  });
}

/** True when the current request's organization owns the legacy, un-partitioned data. */
export function isLegacyDataOwnerRequest(): boolean {
  if (!tenancyConfigured()) return true;
  const orgId = currentOrgId();
  const owner = legacyDataOrgId();
  return Boolean(orgId && owner && orgId === owner);
}

export function requireLegacyDataOwner(feature: string) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (isLegacyDataOwnerRequest()) return next();
    return notAvailable(res, feature);
  };
}

const platformOwnedCache = new Map<string, { value: boolean; at: number }>();
const CACHE_MS = 60_000;

async function isPlatformOwnedOrg(orgId: string): Promise<boolean> {
  const hit = platformOwnedCache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const org = (await withoutTenantScope('gate:platform-owned', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../models/Org').default;
    return Org.findById(orgId).select('isPlatformOwned').lean();
  })) as { isPlatformOwned?: boolean } | null;
  const value = Boolean(org?.isPlatformOwned);
  platformOwnedCache.set(orgId, { value, at: Date.now() });
  return value;
}

/**
 * The platform's own catalogue (public assessments published to the open
 * internet under the platform's name) is authored by the platform's own
 * organizations — not by every institute that happens to have a teacher.
 */
export function requirePlatformOwnedOrg(feature: string) {
  return async (_req: Request, res: Response, next: NextFunction) => {
    if (!tenancyConfigured()) return next();
    const orgId = currentOrgId();
    try {
      if (orgId && (await isPlatformOwnedOrg(orgId))) return next();
    } catch {
      // Fail closed below.
    }
    return notAvailable(res, feature);
  };
}
