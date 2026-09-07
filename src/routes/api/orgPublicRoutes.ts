/**
 * GET /api/org/branding — the only thing a client may learn before logging in.
 *
 * ── Why this endpoint exists ────────────────────────────────────────────────
 * `/api/me/context` requires a token, and correctly so: modules, permissions,
 * limits and configuration are tenant data. But a login page has to be painted
 * in the institute's colours BEFORE anyone submits the credential that would
 * unlock that payload. Without this route the first screen every user sees is
 * the only screen that cannot be branded, which is the one place branding is
 * most obviously the product.
 *
 * ── What it deliberately does NOT return ────────────────────────────────────
 * Only name, slug, branding and locale. No modules (a competitor could
 * enumerate what an institute pays for), no limits (a headcount), no
 * configuration, no user counts, no subscription state. Everything here is
 * already visible to anyone who loads the institute's own login page, which is
 * the definition of public.
 *
 * ── Absent organization is not an error ─────────────────────────────────────
 * A pinned api-legacy deployment, an unresolvable Host, or a pre-migration
 * database all produce `{ organization: null }` with a 200. The client then
 * renders exactly what it renders today. Returning 404 here would force every
 * client into an error branch for the ordinary case.
 */

import { Router, Request, Response } from 'express';
import { currentOrgId, withoutTenantScope } from '../../core/tenancy';

const router = Router();

router.get('/branding', async (_req: Request, res: Response) => {
  try {
    const orgId = currentOrgId();
    if (!orgId) return res.json({ organization: null });

    const org = (await withoutTenantScope('org:read-public-branding', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Org = require('../../models/Org').default;
      return Org.findById(orgId).select('name slug status branding locale').lean();
    })) as {
      _id?: unknown;
      name?: string;
      slug?: string;
      status?: string;
      branding?: Record<string, unknown>;
      locale?: Record<string, unknown>;
    } | null;

    if (!org) return res.json({ organization: null });

    return res.json({
      organization: {
        id: String(org._id),
        name: org.name,
        slug: org.slug,
        status: org.status,
        branding: org.branding ?? {},
        locale: org.locale ?? {},
      },
    });
  } catch (error) {
    console.error('[org/branding] failed:', error);
    // Same reasoning as above: a client must never be blocked from rendering a
    // login form because a cosmetic lookup failed.
    return res.json({ organization: null });
  }
});

export default router;
