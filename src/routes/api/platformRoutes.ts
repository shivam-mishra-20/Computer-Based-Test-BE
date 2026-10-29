/**
 * /api/platform/* — the master admin surface.
 *
 * `router.use(platformAuthMiddleware)` at the top means a route added later
 * cannot be left unguarded by forgetting a middleware — the guard is structural
 * rather than per-route discipline. Every route additionally declares the
 * platform capability it needs, so a `support` account cannot change a plan.
 *
 * Routes here are thin: validation, capability, delegate to `core/platform/*`,
 * audit. All the logic lives in services that are reused by the onboarding
 * orchestrator and the tests.
 */

import { Router, Request, Response } from 'express';
import { platformAuthMiddleware, requirePlatformCapability } from '../../middlewares/platformAuth';
import { completePlatformSignIn } from '../../core/platform/platformSignIn';
import { mfaRequiredFor, signMfaStepToken } from '../../core/auth/platformMfa';
import { withoutTenantScope } from '../../core/tenancy';
import { getEntitlement } from '../../core/entitlements/resolve';
import { listPlatformAudit, recordPlatformAction } from '../../core/platform/audit';
import { onboardOrganization } from '../../core/platform/onboarding';
import {
  BuildConfigIncomplete,
  MobileConfigConflict,
  OrganizationNotFound as MobileOrganizationNotFound,
  generateBuildConfig,
  getMobileConfig,
  reconcileBuildConfig,
  updateMobileConfig,
} from '../../core/platform/mobileBuild';
import {
  BuildNotAllowed,
  BuildNotFound,
  buildReadiness,
  cancelBuild,
  getBuild,
  listBuilds,
  markFailed,
  publicBuildViewOf,
  publicBuildViews,
  startBuild,
} from '../../core/platform/appBuilds';
import { parseBuildProfile } from '../../core/platform/mobileBuildRules';
import { RegistrationStorageFailed } from '../../core/platform/appExperience';
import { GuardianLinkError, listLinks, revokeLink, verifyLink } from '../../core/guardians/guardians';
import {
  registrationViewFor,
  updateRegistrationSettings,
} from '../../core/platform/registrationSettings';
import {
  buildDeletionPlan,
  DeletionRefused,
  deletionStatus,
  finishWithoutExternal,
  issuePlanToken,
  resumeDeletion,
  startDeletion,
  type Staff as DeletionStaff,
} from '../../core/platform/orgDeletion';
import {
  NativeAssetRejected,
  nativeAssetState,
  saveNativeAsset,
  type NativeAssetKind,
} from '../../core/platform/mobileAssets';
import { BUILD_ARTIFACT_TYPES, type IAppBuildJob } from '../../models/AppBuildJob';
import {
  activateDesign,
  DesignRequestError,
  getDesignRequest,
  linkBuildToRequest,
  listDesignRequests,
  reviewDesign,
} from '../../core/platform/appDesign';
import type { SelectableBuildProfile } from '../../core/platform/mobileBuildRules';
import { enqueuePrepare } from '../../queues/appBuildQueue';
import { uploadNativeAsset } from '../../middlewares/uploadNativeAsset';
import { assessApplication, applicationToOnboardingInput } from '../../core/platform/applicationProvisioning';
import { signAsset } from '../../core/platform/applications';
import {
  approveRegistration,
  getRegistration,
  listRegistrations,
  setRegistrationVerdict,
  RegistrationNotActionable,
  RegistrationNotFound,
} from '../../core/platform/registrations';
import {
  createOrganization,
  listOrganizations,
  getOrganizationDetail,
  setOrganizationStatus,
  updateOrganization,
  setOrganizationConfig,
  setOrganizationPolicy,
  setSubscription,
  listOrgUsers,
  listOrgRoles,
  listModules,
  listPlans,
  upsertPlan,
  createCustomRole,
  OrgSlugTaken,
} from '../../core/platform/organizations';
import type { PlatformRequestUser } from '../../middlewares/platformAuth';
import {
  SubscriptionError,
  assignPlan,
  getSubscriptionDetail,
  listSubscriptions,
  movePlanSubscribers,
  recordManualPayment,
  recordPaymentFailure,
  startManaging,
  startOrExtendTrial,
  transition as subscriptionTransition,
  type Actor as SubscriptionActor,
} from '../../core/subscriptions/service';
import {
  CatalogueError,
  LIMIT_KEYS,
  applyRecommendedCatalogue,
  listPlanVersions,
  recommendedCatalogueDiff,
  seedDefaultCatalogue,
  setPlanActive,
} from '../../core/subscriptions/catalogue';
import { SUBSCRIPTION_STATUSES } from '../../core/subscriptions/lifecycle';
import { sendUsageError, usageSummary } from '../../core/subscriptions/usage';
import {
  BillingError,
  createDraftInvoice,
  deleteDraftInvoice,
  getBillingProfile,
  getInvoice,
  getOrgBilling,
  gstReadiness,
  issueInvoice,
  listInvoices,
  settleInvoice,
  updateBillingProfile,
  updateDraftInvoice,
  updateOrgBilling,
  voidInvoice,
} from '../../core/billing/invoices';
import { listSubscriptionRequests, resolveSubscriptionRequest } from '../../core/billing/requests';
import { acceptOrder, applyOrderPlan, declineOrder, listOrders } from '../../core/billing/selfServe';
import { listProviders } from '../../core/billing/provider';
import { cashfreeStatus } from '../../core/billing/cashfree';
import {
  approveRefundRequest,
  declineRefundRequest,
  listRefundRequests,
  openRefundRequestCount,
  raiseRefundRequest,
  refreshRefundRequest,
  refundQuote,
  requestsForRegistration,
} from '../../core/billing/refundRequests';
import { runRenewals } from '../../core/billing/renewals';
import { listInvoiceCheckouts } from '../../core/billing/invoiceCheckout';
import { autopayEnabled, cancelAutopay, orgMandates } from '../../core/billing/autopay';
import {
  effectivePayment,
  invoiceRegistrationPayment,
  listRegistrationPayments,
  paymentsForRegistration,
  paymentsMode,
  refreshRefund,
  refreshRegistrationPayment,
  refundRegistrationPayment,
} from '../../core/billing/registrationPayments';
import { sendInvoiceDocument } from '../../core/billing/document';
import { GST_STATE_CODES } from '../../core/billing/gst';
import PlatformUserModel, { PLATFORM_ROLES, platformCapabilities } from '../../models/PlatformUser';
import UserModel from '../../models/User';
import { issueInvite, issueResetLink } from '../../core/accounts/accountLinks';
import { runWithTenant } from '../../core/tenancy/context';
import Org from '../../models/Org';
import mongoose from 'mongoose';
import {
  signPlatformToken,
  verifyPlatformRefreshToken,
  verifyToken,
} from '../../core/auth/tokens';
import { authLimiter } from '../../middlewares/rateLimiter';
import bcrypt from 'bcrypt';

/**
 * A real bcrypt hash of a value nobody knows, compared against when the account
 * does not exist so that a missing account and a wrong password take the same
 * time. Without it, "unknown email" returns in microseconds and "wrong
 * password" takes ~80ms, which is a perfectly usable account oracle.
 */
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const router = Router();

/**
 * POST /api/platform/login — the ONLY unauthenticated route on this surface.
 *
 * ── Why it is declared above `router.use(platformAuthMiddleware)` ───────────
 * The guard below is deliberately structural: every route added after it is
 * protected whether or not its author remembered to say so. Login is the one
 * route that cannot be, because it is what produces the credential. Putting it
 * here — above the guard, alone, with a comment — makes the exception visible
 * instead of hiding it behind a per-route opt-out that the next endpoint could
 * copy by accident.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 * It does not look at tenancy. There is no `orgId` in the request, none in the
 * response, and none in the token: platform staff belong to no organization by
 * definition, and a platform token carrying one would invite exactly the
 * confusion the separate audience exists to prevent.
 *
 * It also does not implement authentication. Password comparison lives on the
 * model, token minting in `core/auth/tokens`, revocation in `tokenVersion` —
 * all of which already existed. This route composes them.
 */
router.post('/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    // Bounded before anything touches the database. bcrypt on an unbounded
    // string is a denial-of-service primitive.
    if (!email || !password || email.length > 254 || password.length > 200) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PlatformUser = require('../../models/PlatformUser').default;
    const staff = await PlatformUser.findOne({ email }).select('+mfa');

    /**
     * ONE message for unknown-account, wrong-password and disabled-account.
     *
     * Distinguishing them turns this endpoint into an oracle that confirms
     * which of your staff addresses are real — useful to nobody but an
     * attacker, since a legitimate operator who has forgotten which is wrong
     * asks a colleague rather than the login form.
     *
     * The bcrypt comparison runs even when the account does not exist, so the
     * response time does not leak the answer either.
     */
    const DENIED = { message: 'Invalid credentials.' };
    const hash = staff?.password ?? DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(password, hash);

    if (!staff || !passwordMatches || !staff.isActive) {
      return res.status(401).json(DENIED);
    }

    // Two-factor sign-in (core/auth/platformMfa): an enrolled account gets a
    // short code-step token, never a session, until POST /login/mfa.
    if (staff.mfa?.enabled) {
      return res.json({
        mfaRequired: true,
        mfaToken: signMfaStepToken('platform-mfa', { id: String(staff._id), tokenVersion: Number(staff.tokenVersion ?? 0) || 0 }),
      });
    }
    // A role that must have MFA and has none may only enroll.
    if (mfaRequiredFor(staff.role)) {
      return res.json({
        mfaEnrollmentRequired: true,
        enrollToken: signMfaStepToken('platform-mfa-enroll', { id: String(staff._id), tokenVersion: Number(staff.tokenVersion ?? 0) || 0 }),
      });
    }

    // A 15-minute platform token, as before, plus a refresh token that renews
    // it for at most TOKEN_TTL.platformSession — see POST /refresh below.
    return completePlatformSignIn(req, res, staff, 'password');
  } catch (error) {
    console.error('[platform/login] failed:', (error as Error).message);
    return res.status(500).json({ message: 'Login failed.' });
  }
});

/** A token version as compared: a missing one is 0, as the model defaults it. */
function tokenVersionOf(value: unknown): number {
  return Number(value ?? 0) || 0;
}

/**
 * Renew a console session's access token.
 *
 * Above the guard for the same reason as login: the access token it renews has
 * expired, so the credential here is the refresh token itself — audience
 * `platform-refresh`, accepted nowhere else. The account must still exist, be
 * active, and hold the `tokenVersion` the refresh token was issued with, so
 * disabling a staff account ends its sessions at the next renewal at the
 * latest (and its access tokens at once, as before).
 *
 * Returns a new 15-minute access token only. The refresh token is not
 * re-issued, so a sign-in still ends TOKEN_TTL.platformSession after it began.
 */
router.post('/refresh', authLimiter, async (req: Request, res: Response) => {
  let claims: { id: string; tokenVersion?: number };
  try {
    claims = verifyPlatformRefreshToken(String(req.body?.refreshToken ?? ''));
  } catch {
    return res
      .status(401)
      .json({ message: 'Please sign in again.', code: 'REFRESH_INVALID' });
  }

  try {
    const staff = await PlatformUserModel.findById(claims.id).lean();
    if (
      !staff ||
      !staff.isActive ||
      tokenVersionOf(claims.tokenVersion) !== tokenVersionOf(staff.tokenVersion)
    ) {
      return res
        .status(401)
        .json({ message: 'Please sign in again.', code: 'SESSION_REVOKED' });
    }
    // The stored value exactly as login signs it — `platformAuthMiddleware`
    // compares the claim with the record as-is.
    const token = signPlatformToken({
      id: String(staff._id),
      role: staff.role,
      tokenVersion: staff.tokenVersion,
    });
    return res.json({ token, expiresIn: 15 * 60 });
  } catch (error) {
    console.error('[platform/refresh] failed:', (error as Error).message);
    return res.status(500).json({ message: 'Could not renew the session.' });
  }
});

/**
 * Sign out — on the server, not only in the browser.
 *
 * Clearing the tab's storage leaves the refresh token valid until it expires,
 * so a copy taken earlier would go on minting access tokens for up to
 * TOKEN_TTL.platformSession. This bumps the account's `tokenVersion` — the
 * same revocation deactivation uses — and every access and refresh token
 * issued before it stops working at once (platformAuthMiddleware and
 * POST /refresh both compare it). That is every console session of this
 * account, in every tab and browser: the version is per account, not per tab.
 *
 * Above the guard so it works after the access token has expired: the
 * credential is the refresh token, or else a still-valid access token. A
 * credential that was already revoked changes nothing.
 */
router.post('/logout', authLimiter, async (req: Request, res: Response) => {
  let claims: { id: string; tokenVersion?: number };
  try {
    const refreshToken =
      typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
    if (refreshToken) {
      claims = verifyPlatformRefreshToken(refreshToken);
    } else {
      const raw =
        req.header('Authorization')?.replace('Bearer ', '').trim() ?? '';
      claims = verifyToken<{ id: string; tokenVersion?: number; aud?: string }>(
        raw,
        'platform',
      );
    }
  } catch {
    return res.status(401).json({
      message: 'There is no platform session to sign out.',
      code: 'REFRESH_INVALID',
    });
  }

  try {
    const staff = await PlatformUserModel.findById(claims.id)
      .select('role tokenVersion')
      .lean();
    if (
      !staff ||
      tokenVersionOf(claims.tokenVersion) !== tokenVersionOf(staff.tokenVersion)
    ) {
      return res.status(204).end();
    }
    await PlatformUserModel.updateOne(
      { _id: staff._id },
      { $inc: { tokenVersion: 1 } },
    );

    (req as Request & { platformUser?: PlatformRequestUser }).platformUser = {
      id: String(staff._id),
      role: staff.role,
      capabilities: platformCapabilities(staff.role),
    };
    await recordPlatformAction(req, {
      action: 'platform.logout',
      entity: 'PlatformUser',
      entityId: String(staff._id),
    });
    return res.status(204).end();
  } catch (error) {
    console.error('[platform/logout] failed:', (error as Error).message);
    return res
      .status(500)
      .json({ message: 'Could not sign out on the server.' });
  }
});

// Two-factor sign-in routes (the code step, enrollment, resets) are their own
// router, mounted ahead of this one in app.ts — routes/api/platformMfaRoutes.
router.use(platformAuthMiddleware);

/**
 * An organization that is being deleted accepts no other changes.
 *
 * Without this, a half-deleted organization could be reactivated, given a new
 * build, or have its entitlement re-resolved — each of which writes new rows
 * the deletion then has to chase. Reads still work, and the deletion's own
 * routes are the only writes allowed.
 */
router.param('orgId', (req, res, next, orgId) => {
  if (req.method === 'GET' || /^\/orgs\/[^/]+\/deletion(\/|$)/.test(req.path)) return next();
  if (!mongoose.isValidObjectId(orgId)) return next();
  withoutTenantScope('platform:deletion-guard', async () => Org.exists({ _id: orgId, deletion: { $exists: true, $ne: null } }))
    .then((deleting) => {
      if (deleting) {
        return res.status(409).json({
          code: 'ORG_DELETING',
          message: 'This organization is being deleted. It cannot be changed.',
        });
      }
      return next();
    })
    .catch(next);
});

/** Wrap a handler so a thrown error becomes a clean 500 rather than a hang. */
/** The staff member making this request, as the subscription history records them. */
function staffActor(req: Request): SubscriptionActor {
  const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
  return { kind: 'platform', id: staff?.id, role: staff?.role };
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof OrgSlugTaken) {
        return res.status(409).json({ message: error.message, code: error.code });
      }
      if (error instanceof RegistrationNotFound || error instanceof MobileOrganizationNotFound) {
        return res.status(404).json({ message: error.message });
      }
      // A native identifier another organization already holds. 409, because
      // the request is well-formed and the resource state is what refuses it.
      if (error instanceof MobileConfigConflict) {
        return res.status(409).json({ message: error.message, field: error.field });
      }
      // Generation refused because the organization is not ready. The issues
      // are the answer, not a side note — the caller asked what is missing.
      if (error instanceof BuildConfigIncomplete) {
        return res.status(422).json({ message: error.message, issues: error.issues });
      }
      // A verdict the record's state does not allow — rejecting a registration
      // that already became an organization, say. The caller's request is
      // coherent but the resource is not in a state that permits it.
      if (error instanceof RegistrationNotActionable) {
        return res.status(409).json({ message: error.message });
      }
      // A design-request move the lifecycle does not allow, a stale record,
      // or a missing note — each carries its own status and a sentence.
      if (error instanceof DesignRequestError) {
        return res.status(error.status).json({ message: error.message, code: error.code });
      }
      // Lifecycle and catalogue refusals: each carries a stable code (see
      // docs/subscriptions-plan.md) and, for a refused transition, from where.
      if (error instanceof SubscriptionError) {
        return res.status(error.status).json({ message: error.message, code: error.code, ...error.details });
      }
      if (error instanceof CatalogueError) {
        return res.status(error.status).json({ message: error.message, code: error.code });
      }
      // A plan limit (a build beyond the month's allowance), or a usage check
      // that could not get its lease in time.
      if (sendUsageError(res, error)) return undefined;
      // Invoices, billing details and subscription requests.
      if (error instanceof BillingError) {
        return res.status(error.status).json({ message: error.message, code: error.code, ...error.details });
      }
      console.error(`[platform] ${req.method} ${req.path} failed:`, error);
      return res.status(500).json({ message: (error as Error).message || 'Platform request failed' });
    }
  };
}

// ── Session ────────────────────────────────────────────────────────────────

router.get('/me', (req: Request, res: Response) => {
  const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
  return res.json({ platformUser: staff });
});

// ── Dashboard ──────────────────────────────────────────────────────────────

router.get(
  '/dashboard',
  requirePlatformCapability('org.read'),
  handle(async (_req, res) => {
    const summary = await withoutTenantScope('platform:dashboard', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Org = require('../../models/Org').default;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const User = require('../../models/User').default;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Subscription = require('../../models/Subscription').default;

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Invoice = require('../../models/Invoice').default;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const SubscriptionRequest = require('../../models/SubscriptionRequest').default;
      const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const now = new Date();

      const [orgs, byStatus, users, subs, overdueInvoices, openInvoices, openRequests, endingSoon, openOrders, openRefunds] = await Promise.all([
        Org.countDocuments({}),
        Org.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
        User.countDocuments({}),
        Subscription.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
        Invoice.countDocuments({ status: 'issued', dueAt: { $lt: now } }),
        Invoice.countDocuments({ status: 'issued' }),
        SubscriptionRequest.countDocuments({ status: 'open' }),
        // Trials ending, renewals due and grace periods closing in the next week.
        Subscription.countDocuments({
          isPlatformOwned: { $ne: true },
          managedSince: { $exists: true },
          $or: [
            { status: 'trialing', trialEndsAt: { $lte: soon } },
            { status: 'active', periodEnd: { $lte: soon } },
            { status: 'past_due', graceEndsAt: { $lte: soon } },
          ],
        }),
        // Institutes' own orders still waiting for the platform (draft or unpaid).
        Invoice.countDocuments({ origin: 'self-serve', status: { $in: ['draft', 'issued'] } }),
        // Refund requests waiting for a decision (or a retry after Cashfree refused).
        openRefundRequestCount(),
      ]);

      return {
        organizations: orgs,
        organizationsByStatus: Object.fromEntries(
          (byStatus as { _id: string; n: number }[]).map((r) => [r._id ?? 'unknown', r.n]),
        ),
        users,
        subscriptionsByStatus: Object.fromEntries(
          (subs as { _id: string; n: number }[]).map((r) => [r._id ?? 'unknown', r.n]),
        ),
        modules: listModules().length,
        billing: { overdueInvoices, openInvoices, openRequests, dueWithinWeek: endingSoon, openOrders, openRefunds },
      };
    });

    const recent = await listPlatformAudit({ limit: 10 });
    return res.json({ summary, recentActivity: recent });
  }),
);

// ── Organizations ──────────────────────────────────────────────────────────

router.get(
  '/orgs',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const result = await listOrganizations({
      search: req.query.search as string,
      status: req.query.status as string,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      skip: req.query.skip ? Number(req.query.skip) : undefined,
    });
    return res.json(result);
  }),
);

router.post(
  '/orgs',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const { name, slug } = req.body ?? {};
    if (!name || !slug) {
      return res.status(400).json({ message: 'name and slug are required' });
    }
    const org = await createOrganization(req.body);
    await recordPlatformAction(req, {
      action: 'org.create',
      orgId: String(org._id),
      entity: 'Org',
      entityId: String(org._id),
      metadata: { name, slug },
    });
    return res.status(201).json({ organization: org });
  }),
);

/** The complete onboarding journey in one call. */
router.post(
  '/orgs/onboard',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    if (!req.body?.organization?.name || !req.body?.organization?.slug) {
      return res.status(400).json({ message: 'organization.name and organization.slug are required' });
    }
    const result = await onboardOrganization(req.body, { actor: staffActor(req) });
    await recordPlatformAction(req, {
      action: 'org.onboard',
      orgId: result.orgId,
      entity: 'Org',
      entityId: result.orgId,
      // Never the invite: it is a credential, returned once below and stored
      // only as a hash.
      metadata: { slug: result.slug, complete: result.complete, steps: result.steps, adminInvited: Boolean(result.adminInvite) },
    });
    // 207 when some step failed: the organization exists and is partially
    // configured, which is neither a success nor a clean failure, and the
    // console needs to show exactly which steps to retry.
    return res.status(result.complete ? 201 : 207).json(result);
  }),
);

router.get(
  '/orgs/:orgId',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const detail = await getOrganizationDetail(req.params.orgId);
    if (!detail) return res.status(404).json({ message: 'Organization not found' });
    return res.json(detail);
  }),
);

router.patch(
  '/orgs/:orgId',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const updated = await updateOrganization(req.params.orgId, req.body ?? {});
    if (!updated) return res.status(404).json({ message: 'Organization not found' });
    await recordPlatformAction(req, {
      action: 'org.update',
      orgId: req.params.orgId,
      entity: 'Org',
      entityId: req.params.orgId,
      changes: req.body,
    });
    return res.json({ organization: updated });
  }),
);

/* ── Deleting an organization ───────────────────────────────────────────────
 * Preview → confirm → background run → verify. See core/platform/orgDeletion.
 *
 * `org.delete` is held by the owner role alone. The preview returns the plan
 * the SERVER built plus a short-lived token bound to this staff member and
 * organization; the start request must carry that token, the organization's
 * slug typed out, and an explicit acknowledgement. Nothing in a request says
 * what to delete — the plan is rebuilt from the database when the run starts.
 */
async function deletionStaff(req: Request): Promise<DeletionStaff> {
  const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
  const account = staff?.id
    ? await withoutTenantScope('platform:deletion-staff', async () =>
        PlatformUserModel.findById(staff.id).select('email').lean(),
      )
    : null;
  return {
    id: String(staff?.id ?? ''),
    role: staff?.role,
    email: (account as { email?: string } | null)?.email,
    ip: req.ip,
  };
}

function deletionRefusal(res: Response, err: unknown) {
  if (err instanceof DeletionRefused) {
    return res.status(err.httpStatus).json({ message: err.message, problems: err.problems });
  }
  throw err;
}

router.get(
  '/orgs/:orgId/deletion/preview',
  requirePlatformCapability('org.delete'),
  handle(async (req, res) => {
    try {
      const staff = await deletionStaff(req);
      const plan = await buildDeletionPlan(req.params.orgId);
      return res.json({ plan, planToken: plan.blockers.length ? null : issuePlanToken(req.params.orgId, staff.id) });
    } catch (err) {
      return deletionRefusal(res, err);
    }
  }),
);

router.get(
  '/orgs/:orgId/deletion',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    return res.json(await deletionStatus(req.params.orgId));
  }),
);

router.post(
  '/orgs/:orgId/deletion',
  requirePlatformCapability('org.delete'),
  handle(async (req, res) => {
    try {
      const staff = await deletionStaff(req);
      const plan = await startDeletion(req.params.orgId, staff, {
        confirmSlug: req.body?.confirmSlug,
        acknowledge: req.body?.acknowledge,
        planToken: req.body?.planToken,
      });
      return res.status(202).json({ state: 'running', plan });
    } catch (err) {
      return deletionRefusal(res, err);
    }
  }),
);

router.post(
  '/orgs/:orgId/deletion/resume',
  requirePlatformCapability('org.delete'),
  handle(async (req, res) => {
    try {
      await resumeDeletion(req.params.orgId, await deletionStaff(req));
      return res.status(202).json({ state: 'running' });
    } catch (err) {
      return deletionRefusal(res, err);
    }
  }),
);

router.post(
  '/orgs/:orgId/deletion/finish',
  requirePlatformCapability('org.delete'),
  handle(async (req, res) => {
    try {
      await finishWithoutExternal(req.params.orgId, await deletionStaff(req), {
        confirmSlug: req.body?.confirmSlug,
        acknowledge: req.body?.acknowledge,
      });
      return res.status(202).json({ state: 'running' });
    } catch (err) {
      return deletionRefusal(res, err);
    }
  }),
);

router.post(
  '/orgs/:orgId/status',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const { status } = req.body ?? {};
    const allowed = ['trialing', 'active', 'past_due', 'suspended', 'cancelled', 'terminated'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${allowed.join(', ')}` });
    }
    const updated = await setOrganizationStatus(req.params.orgId, status);
    if (!updated) return res.status(404).json({ message: 'Organization not found' });
    await recordPlatformAction(req, {
      action: `org.status.${status}`,
      orgId: req.params.orgId,
      entity: 'Org',
      entityId: req.params.orgId,
      changes: { status },
    });
    return res.json({ organization: updated });
  }),
);

router.get(
  '/orgs/:orgId/users',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const result = await listOrgUsers(
      req.params.orgId,
      req.query.limit ? Number(req.query.limit) : 50,
      req.query.skip ? Number(req.query.skip) : 0,
    );
    return res.json(result);
  }),
);

router.get(
  '/orgs/:orgId/roles',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => res.json({ roles: await listOrgRoles(req.params.orgId) })),
);

router.post(
  '/orgs/:orgId/roles',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const { key, name, permissions } = req.body ?? {};
    if (!key || !name || !Array.isArray(permissions)) {
      return res.status(400).json({ message: 'key, name and permissions[] are required' });
    }
    const role = await createCustomRole(req.params.orgId, req.body);
    await recordPlatformAction(req, {
      action: 'org.role.upsert',
      orgId: req.params.orgId,
      entity: 'Role',
      entityId: role.id,
      metadata: { key, granted: role.granted.length, rejected: role.rejected },
    });
    return res.status(201).json(role);
  }),
);

// ── Organization configuration ─────────────────────────────────────────────

router.put(
  '/orgs/:orgId/config',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const counts = await setOrganizationConfig(req.params.orgId, req.body ?? {});
    await recordPlatformAction(req, {
      action: 'org.config.update',
      orgId: req.params.orgId,
      entity: 'OrgConfig',
      metadata: counts,
    });
    return res.json({ applied: counts });
  }),
);

router.put(
  '/orgs/:orgId/policy',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const policy = await setOrganizationPolicy(req.params.orgId, req.body ?? {});
    await recordPlatformAction(req, {
      action: 'org.policy.update',
      orgId: req.params.orgId,
      entity: 'OrgPolicy',
      changes: req.body,
    });
    return res.json({ policy });
  }),
);

// ── Entitlements and subscriptions ─────────────────────────────────────────

router.get(
  '/orgs/:orgId/entitlement',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => res.json({ entitlement: await getEntitlement(req.params.orgId) })),
);

router.put(
  '/orgs/:orgId/subscription',
  // Deliberately requires subscription.manage, NOT org.manage: a support
  // account may configure a customer's classes but must not change what they
  // are paying for.
  requirePlatformCapability('subscription.manage'),
  handle(async (req, res) => {
    const entitlement = await setSubscription(req.params.orgId, req.body ?? {}, staffActor(req));
    await recordPlatformAction(req, {
      action: 'org.subscription.update',
      orgId: req.params.orgId,
      entity: 'Subscription',
      changes: req.body,
      metadata: { modules: entitlement.modules.length, version: entitlement.version },
    });
    return res.json({ entitlement });
  }),
);

// ── Subscription lifecycle ─────────────────────────────────────────────────
// Every change below goes through core/subscriptions: validated against the
// lifecycle table, conditional on the revision it read, written to the
// subscription's own history AND to the platform audit. Reasons are required
// for staff decisions. Nothing here is reachable with a tenant token.

router.get(
  '/orgs/:orgId/subscription',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const [detail, entitlement] = await Promise.all([
      getSubscriptionDetail(req.params.orgId),
      getEntitlement(req.params.orgId),
    ]);
    const usage = await usageSummary(req.params.orgId, entitlement);
    return res.json({ ...detail, entitlement, usage });
  }),
);

/**
 * Bring a subscription from before the lifecycle under it, as it stands: its
 * status and limits are enforced from now on. Body: { reason }. The response's
 * entitlement and usage say what the organization can now do.
 */
router.post(
  '/orgs/:orgId/subscription/manage',
  requirePlatformCapability('subscription.manage'),
  handle(async (req, res) => {
    const result = await startManaging(req.params.orgId, { actor: staffActor(req), reason: req.body?.reason });
    await recordPlatformAction(req, {
      action: 'org.subscription.manage',
      orgId: req.params.orgId,
      entity: 'Subscription',
      changes: req.body,
      metadata: { changed: result.changed, writable: result.entitlement?.writable, status: result.subscription?.status },
    });
    return res.json({ ...result, usage: await usageSummary(req.params.orgId, result.entitlement) });
  }),
);

/** Start a trial, or extend the running one. Body: { days?, reason, planKey?, billingInterval? } */
router.post(
  '/orgs/:orgId/subscription/trial',
  requirePlatformCapability('subscription.manage'),
  handle(async (req, res) => {
    const body = req.body ?? {};
    const result = await startOrExtendTrial(req.params.orgId, {
      actor: staffActor(req),
      reason: body.reason,
      days: body.days === undefined ? undefined : Number(body.days),
      planKey: body.planKey,
      planVersion: body.planVersion === undefined ? undefined : Number(body.planVersion),
      billingInterval: body.billingInterval,
    });
    await recordPlatformAction(req, {
      action: 'org.subscription.trial',
      orgId: req.params.orgId,
      entity: 'Subscription',
      changes: body,
      metadata: { status: result.subscription?.status, trialEndsAt: result.subscription?.trialEndsAt },
    });
    return res.json(result);
  }),
);

/** Put the subscription on a plan (and version). Body: { planKey, planVersion?, billingInterval?, reason? } */
router.post(
  '/orgs/:orgId/subscription/plan',
  requirePlatformCapability('subscription.manage'),
  handle(async (req, res) => {
    const body = req.body ?? {};
    if (!body.planKey) return res.status(400).json({ message: 'planKey is required', code: 'SUBSCRIPTION_INVALID' });
    const result = await assignPlan(req.params.orgId, {
      planKey: String(body.planKey),
      planVersion: body.planVersion === undefined ? undefined : Number(body.planVersion),
      billingInterval: body.billingInterval,
      actor: staffActor(req),
      reason: body.reason,
    });
    await recordPlatformAction(req, {
      action: 'org.subscription.plan',
      orgId: req.params.orgId,
      entity: 'Subscription',
      changes: body,
      metadata: { planKey: result.subscription?.planKey, planVersion: result.subscription?.planVersion, changed: result.changed },
    });
    return res.json(result);
  }),
);

const STAFF_TRANSITIONS = ['activate', 'suspend', 'reactivate', 'cancel', 'expire'] as const;

/** A staff decision. Body: { event: activate|suspend|reactivate|cancel|expire, reason, periodEnd?, planKey? } */
router.post(
  '/orgs/:orgId/subscription/transition',
  requirePlatformCapability('subscription.manage'),
  handle(async (req, res) => {
    const body = req.body ?? {};
    if (!(STAFF_TRANSITIONS as readonly string[]).includes(body.event)) {
      return res.status(400).json({
        message: `event must be one of: ${STAFF_TRANSITIONS.join(', ')}. Trials use /trial; payments use /payments.`,
        code: 'SUBSCRIPTION_INVALID',
      });
    }
    const result = await subscriptionTransition(req.params.orgId, body.event, {
      actor: staffActor(req),
      reason: body.reason,
      periodEnd: body.periodEnd,
      billingInterval: body.billingInterval,
      planKey: body.planKey,
    });
    await recordPlatformAction(req, {
      action: `org.subscription.${body.event}`,
      orgId: req.params.orgId,
      entity: 'Subscription',
      changes: body,
      metadata: { status: result.subscription?.status },
    });
    return res.json(result);
  }),
);

/**
 * Record a payment staff have confirmed (bank transfer, UPI, cheque…) and apply
 * it. Idempotent on the reference. There is no "the client says it was paid"
 * path: a payment exists here only when a platform staff member records it.
 */
router.post(
  '/orgs/:orgId/payments',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const result = await recordManualPayment(req.params.orgId, req.body ?? {}, staffActor(req));
    await recordPlatformAction(req, {
      action: result.duplicate ? 'org.payment.record.duplicate' : 'org.payment.record',
      orgId: req.params.orgId,
      entity: 'Payment',
      entityId: String(result.payment?._id ?? ''),
      metadata: {
        reference: result.payment?.reference,
        amountMinor: result.payment?.amountMinor,
        applied: result.applied,
        periodEnd: result.payment?.periodEnd,
      },
    });
    return res.status(result.duplicate ? 200 : 201).json(result);
  }),
);

/** Record a failed payment. An active subscription enters its grace period. */
router.post(
  '/orgs/:orgId/payments/failed',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const result = await recordPaymentFailure(req.params.orgId, req.body ?? {}, staffActor(req));
    await recordPlatformAction(req, {
      action: 'org.payment.failed',
      orgId: req.params.orgId,
      entity: 'Payment',
      entityId: String(result.payment?._id ?? ''),
      metadata: { reference: result.payment?.reference, lifecycle: result.lifecycle, duplicate: result.duplicate },
    });
    return res.status(result.duplicate ? 200 : 201).json(result);
  }),
);

/** Subscriptions by status, or with a trial end / renewal / grace end within N days. */
router.get(
  '/subscriptions',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !(SUBSCRIPTION_STATUSES as string[]).includes(status)) {
      return res.status(400).json({ message: 'Unknown status', code: 'SUBSCRIPTION_INVALID' });
    }
    const due = req.query.dueWithinDays === undefined ? undefined : Number(req.query.dueWithinDays);
    const items = await listSubscriptions({
      status,
      dueWithinDays: due !== undefined && Number.isFinite(due) ? due : undefined,
      limit: Number(req.query.limit) || undefined,
      withUsage: req.query.withUsage === 'true',
      overLimit: req.query.overLimit === 'true',
    });
    return res.json({ items });
  }),
);

// ── Catalogue ──────────────────────────────────────────────────────────────

router.get(
  '/modules',
  requirePlatformCapability('org.read'),
  handle(async (_req, res) => res.json({ modules: listModules() })),
);

router.get(
  '/plans',
  requirePlatformCapability('org.read'),
  handle(async (_req, res) => res.json({ plans: await listPlans(), limitKeys: LIMIT_KEYS })),
);

router.get(
  '/plans/:key/versions',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => res.json({ versions: await listPlanVersions(req.params.key) })),
);

/**
 * Create or edit a plan. Changing its terms (modules, limits, price, custom
 * pricing, trial length) writes a new version; organizations already on the
 * plan keep the version they were sold until they are moved explicitly.
 */
router.put(
  '/plans',
  requirePlatformCapability('plan.manage'),
  handle(async (req, res) => {
    const { key, name } = req.body ?? {};
    if (!key || !name) {
      return res.status(400).json({ message: 'key and name are required', code: 'PLAN_INVALID' });
    }
    const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
    const result = await upsertPlan(req.body, { id: staff?.id });
    await recordPlatformAction(req, {
      action: result.newVersion ? 'plan.version' : 'plan.update',
      entity: 'Plan',
      entityId: String(result.plan?._id ?? key),
      changes: req.body,
      metadata: { version: result.version, newVersion: result.newVersion },
    });
    return res.json(result);
  }),
);

/** Put a plan on sale, or take it off. Existing subscribers are unaffected either way. */
router.post(
  '/plans/:key/active',
  requirePlatformCapability('plan.manage'),
  handle(async (req, res) => {
    const active = req.body?.active;
    if (typeof active !== 'boolean') return res.status(400).json({ message: 'active must be true or false', code: 'PLAN_INVALID' });
    const plan = await setPlanActive(req.params.key, active);
    await recordPlatformAction(req, {
      action: active ? 'plan.activate' : 'plan.deactivate',
      entity: 'Plan',
      entityId: String((plan as { _id?: unknown })._id),
      metadata: { key: req.params.key },
    });
    return res.json({ plan });
  }),
);

/** Create the default plans that do not exist yet. Never overwrites a plan. */
router.post(
  '/plans/seed-defaults',
  requirePlatformCapability('plan.manage'),
  handle(async (req, res) => {
    const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
    const result = await seedDefaultCatalogue({ id: staff?.id });
    await recordPlatformAction(req, { action: 'plan.seed-defaults', entity: 'Plan', metadata: result });
    return res.json(result);
  }),
);

/** The recommended catalogue next to each plan's current terms, with subscribers per version. */
router.get(
  '/plans/recommended',
  requirePlatformCapability('org.read'),
  handle(async (_req, res) => res.json({ plans: await recommendedCatalogueDiff(), limitKeys: LIMIT_KEYS })),
);

/** Adopt the recommended terms: new versions where they differ; subscribers stay where they are until moved. */
router.post(
  '/plans/apply-recommended',
  requirePlatformCapability('plan.manage'),
  handle(async (req, res) => {
    const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
    const results = await applyRecommendedCatalogue({ id: staff?.id });
    await recordPlatformAction(req, { action: 'plan.apply-recommended', entity: 'Plan', metadata: { results } });
    return res.json({ results });
  }),
);

/** Move a plan's subscribers on older versions to its current one. Body: { reason, includeUnmanaged? } */
router.post(
  '/plans/:key/move-subscribers',
  requirePlatformCapability('subscription.manage'),
  handle(async (req, res) => {
    const result = await movePlanSubscribers(req.params.key, {
      actor: staffActor(req),
      reason: req.body?.reason,
      includeUnmanaged: req.body?.includeUnmanaged === true,
    });
    await recordPlatformAction(req, {
      action: 'plan.move-subscribers',
      entity: 'Plan',
      metadata: { key: result.planKey, version: result.version, moved: result.moved.length, skipped: result.skipped.length, reason: req.body?.reason },
    });
    return res.json(result);
  }),
);

// ── Billing: the seller profile, invoices, requests ────────────────────────
// Invoices are admin-managed: staff draft, issue and void them, and record the
// payment that settles one (core/billing/invoices). Nothing here is reachable
// with a tenant token, and no route accepts "it was paid" from a client.

router.get(
  '/billing/profile',
  requirePlatformCapability('org.read'),
  handle(async (_req, res) => {
    const profile = await getBillingProfile();
    return res.json({
      profile,
      gst: gstReadiness(profile),
      stateCodes: GST_STATE_CODES,
      providers: listProviders(),
      // The online checkout on the public application (no key material).
      gateway: { ...cashfreeStatus(), mode: paymentsMode() },
    });
  }),
);

router.put(
  '/billing/profile',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const profile = await updateBillingProfile(req.body ?? {}, staffActor(req));
    await recordPlatformAction(req, { action: 'billing.profile.update', entity: 'BillingProfile', changes: req.body });
    return res.json({ profile, gst: gstReadiness(profile) });
  }),
);

router.get(
  '/orgs/:orgId/billing-details',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => res.json({ billing: await getOrgBilling(req.params.orgId) })),
);

router.put(
  '/orgs/:orgId/billing-details',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const billing = await updateOrgBilling(req.params.orgId, req.body ?? {});
    await recordPlatformAction(req, { action: 'org.billing.update', orgId: req.params.orgId, entity: 'Org', changes: req.body });
    return res.json({ billing });
  }),
);

router.get(
  '/orgs/:orgId/invoices',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => res.json({ invoices: await listInvoices({ orgId: req.params.orgId }) })),
);

/** Draft an invoice. Body: { fromSubscription: true } or { lines: [{description, quantity?, unitPrice}], periodStart?, periodEnd?, notes? } */
router.post(
  '/orgs/:orgId/invoices',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const invoice = await createDraftInvoice(req.params.orgId, req.body ?? {}, staffActor(req));
    await recordPlatformAction(req, { action: 'invoice.draft', orgId: req.params.orgId, entity: 'Invoice', entityId: invoice.id, metadata: { totalMinor: invoice.totalMinor } });
    return res.status(201).json({ invoice });
  }),
);

/** Invoices across organizations: ?status=draft|issued|paid|void, ?overdue=true */
router.get(
  '/invoices',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !['draft', 'issued', 'paid', 'void'].includes(status)) {
      return res.status(400).json({ message: 'Unknown status', code: 'BILLING_INVALID' });
    }
    return res.json({ invoices: await listInvoices({ status, overdue: req.query.overdue === 'true', limit: Number(req.query.limit) || undefined }) });
  }),
);

router.get(
  '/invoices/:id',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => res.json({ invoice: await getInvoice(req.params.id) })),
);

router.patch(
  '/invoices/:id',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const invoice = await updateDraftInvoice(req.params.id, req.body ?? {});
    await recordPlatformAction(req, { action: 'invoice.update', orgId: String(invoice.orgId), entity: 'Invoice', entityId: invoice.id, changes: req.body });
    return res.json({ invoice });
  }),
);

router.delete(
  '/invoices/:id',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    await deleteDraftInvoice(req.params.id);
    await recordPlatformAction(req, { action: 'invoice.delete', entity: 'Invoice', entityId: req.params.id });
    return res.json({ deleted: true });
  }),
);

router.post(
  '/invoices/:id/issue',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const invoice = await issueInvoice(req.params.id, staffActor(req));
    await recordPlatformAction(req, {
      action: 'invoice.issue',
      orgId: String(invoice.orgId),
      entity: 'Invoice',
      entityId: invoice.id,
      metadata: { number: invoice.number, totalMinor: invoice.totalMinor, taxInvoice: invoice.taxInvoice },
    });
    return res.json({ invoice });
  }),
);

router.post(
  '/invoices/:id/void',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const invoice = await voidInvoice(req.params.id, req.body?.reason, staffActor(req));
    await recordPlatformAction(req, { action: 'invoice.void', orgId: String(invoice.orgId), entity: 'Invoice', entityId: invoice.id, metadata: { number: invoice.number, reason: invoice.voidReason } });
    return res.json({ invoice });
  }),
);

/** Settle an issued invoice with the payment staff have confirmed. Body: { amount, method, reference, receivedAt?, notes? } */
router.post(
  '/invoices/:id/payments',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const result = await settleInvoice(req.params.id, req.body ?? {}, staffActor(req));
    await recordPlatformAction(req, {
      action: result.duplicate ? 'invoice.payment.duplicate' : 'invoice.payment',
      orgId: String(result.invoice.orgId),
      entity: 'Invoice',
      entityId: result.invoice.id,
      metadata: { number: result.invoice.number, reference: result.payment?.reference, lifecycle: (result as { lifecycle?: unknown }).lifecycle },
    });
    return res.status(result.duplicate ? 200 : 201).json(result);
  }),
);

/** The invoice as a printable page (default) or a PDF (?format=pdf). */
router.get(
  '/invoices/:id/document',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => sendInvoiceDocument(res, await getInvoice(req.params.id), String(req.query.format ?? 'html'))),
);

// ── Online payments taken while applying (Cashfree) ────────────────────────
// core/billing/registrationPayments. Reading needs org.read; anything that
// asks Cashfree, moves money or issues an invoice needs billing.manage. Paid
// is only ever what Cashfree answers to a request made from here.

/** The staff member, with the email the refund record names them by. */
async function staffWithEmail(req: Request) {
  const actor = staffActor(req);
  const found = actor.id && mongoose.Types.ObjectId.isValid(actor.id)
    ? await PlatformUserModel.findById(actor.id).select('email').lean()
    : null;
  return { ...actor, email: (found as { email?: string } | null)?.email };
}

/** ?status=pending|paid|failed|expired|superseded|refunded */
router.get(
  '/registration-payments',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    if (status && !['pending', 'paid', 'failed', 'expired', 'superseded', 'refunded'].includes(status)) {
      return res.status(400).json({ message: 'Unknown status', code: 'BILLING_INVALID' });
    }
    return res.json({
      payments: await listRegistrationPayments({ status, limit: Number(req.query.limit) || undefined }),
      gateway: { ...cashfreeStatus(), mode: paymentsMode() },
    });
  }),
);

/** Ask Cashfree again — for an applicant who paid and never came back to the page. */
router.post(
  '/registration-payments/:id/refresh',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const result = await refreshRegistrationPayment(req.params.id);
    await recordPlatformAction(req, {
      action: 'registration-payment.refresh',
      entity: 'RegistrationPayment',
      entityId: req.params.id,
      metadata: { status: result.payment.status, submitted: result.submission?.submitted ?? null },
    });
    return res.json(result);
  }),
);

/** Return the money through Cashfree (before approval only). Body: { reason } */
router.post(
  '/registration-payments/:id/refund',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const result = await refundRegistrationPayment(req.params.id, req.body ?? {}, await staffWithEmail(req));
    await recordPlatformAction(req, {
      action: result.duplicate ? 'registration-payment.refund.duplicate' : 'registration-payment.refund',
      entity: 'RegistrationPayment',
      entityId: req.params.id,
      metadata: { reason: req.body?.reason, amount: req.body?.amount, refundRequestId: result.request?.id },
    });
    return res.status(result.duplicate ? 200 : 201).json(result);
  }),
);

router.post(
  '/registration-payments/:id/refund/refresh',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => res.json(await refreshRefund(req.params.id))),
);

/** Issue the (already paid) invoice for a payment approval has applied. */
router.post(
  '/registration-payments/:id/invoice',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const result = await invoiceRegistrationPayment(req.params.id, staffActor(req));
    await recordPlatformAction(req, {
      action: result.duplicate ? 'registration-payment.invoice.duplicate' : 'registration-payment.invoice',
      orgId: String(result.invoice.orgId),
      entity: 'Invoice',
      entityId: result.invoice.id,
      metadata: { number: result.invoice.number, registrationPaymentId: req.params.id, totalMinor: result.invoice.totalMinor },
    });
    return res.status(result.duplicate ? 200 : 201).json(result);
  }),
);

// ── Refund requests ────────────────────────────────────────────────────────
// core/billing/refundRequests. Anyone eligible asks; staff decide here, and
// approving is what sends the refund to Cashfree. Reading needs org.read,
// deciding billing.manage.

/** ?status=open (open + failed) | refunding | refunded | declined | failed */
router.get(
  '/refund-requests',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    if (status && !['open', 'refunding', 'refunded', 'declined', 'failed'].includes(status)) {
      return res.status(400).json({ message: 'Unknown status', code: 'BILLING_INVALID' });
    }
    const orgId = typeof req.query.orgId === 'string' ? req.query.orgId : undefined;
    return res.json({ requests: await listRefundRequests({ status, orgId, limit: Number(req.query.limit) || undefined }) });
  }),
);

/** What the policy gives on a payment now. ?registrationPaymentId= | ?paymentId= */
router.get(
  '/refund-quote',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const rp = typeof req.query.registrationPaymentId === 'string' ? req.query.registrationPaymentId : '';
    const p = typeof req.query.paymentId === 'string' ? req.query.paymentId : '';
    if (!rp && !p) return res.status(400).json({ message: 'registrationPaymentId or paymentId is required', code: 'BILLING_INVALID' });
    return res.json({ quote: await refundQuote(rp ? { registrationPaymentId: rp } : { paymentId: p }) });
  }),
);

/**
 * Staff raise a request on someone's behalf. Body: { registrationPaymentId | paymentId,
 * reason, amount?, approve?, endSubscription? } — approve: true refunds now.
 */
router.post(
  '/refund-requests',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const staff = await staffWithEmail(req);
    const target = req.body?.registrationPaymentId
      ? { registrationPaymentId: String(req.body.registrationPaymentId) }
      : { paymentId: String(req.body?.paymentId ?? '') };
    const result = await raiseRefundRequest(
      target,
      { reason: req.body?.reason, amount: req.body?.amount },
      { kind: 'platform', id: staff.id, email: staff.email },
      req.body?.approve ? { approveAs: staff, approveNote: req.body?.note ?? req.body?.reason, endSubscription: req.body?.endSubscription } : {},
    );
    await recordPlatformAction(req, {
      action: req.body?.approve ? 'refund.raise-approve' : 'refund.raise',
      orgId: result.request.orgId ? String(result.request.orgId) : undefined,
      entity: 'RefundRequest',
      entityId: result.request.id,
      metadata: { amount: req.body?.amount, reason: req.body?.reason, duplicate: result.duplicate },
    });
    return res.status(result.duplicate ? 200 : 201).json(result);
  }),
);

/** Body: { amount? (rupees; default the requested amount), note?, endSubscription? } */
router.post(
  '/refund-requests/:id/approve',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const result = await approveRefundRequest(req.params.id, req.body ?? {}, await staffWithEmail(req));
    await recordPlatformAction(req, {
      action: 'refund.approve',
      orgId: result.request.orgId ? String(result.request.orgId) : undefined,
      entity: 'RefundRequest',
      entityId: req.params.id,
      metadata: { amountMinor: result.request.decision?.amountMinor, endSubscription: result.request.decision?.endSubscription, refund: result.request.refund?.status },
    });
    return res.json(result);
  }),
);

/** Body: { note } — shown to whoever asked. */
router.post(
  '/refund-requests/:id/decline',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const result = await declineRefundRequest(req.params.id, req.body ?? {}, await staffWithEmail(req));
    await recordPlatformAction(req, {
      action: 'refund.decline',
      orgId: result.request.orgId ? String(result.request.orgId) : undefined,
      entity: 'RefundRequest',
      entityId: req.params.id,
      metadata: { note: req.body?.note },
    });
    return res.json(result);
  }),
);

router.post(
  '/refund-requests/:id/refresh',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => res.json(await refreshRefundRequest(req.params.id))),
);

// ── Renewals, online invoice payments, auto-pay ────────────────────────────

/** Run the renewal step now (it also runs in the daily sweep). Body: { orgId? } */
router.post(
  '/renewals/run',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const orgId = typeof req.body?.orgId === 'string' && req.body.orgId ? req.body.orgId : undefined;
    const summary = await runRenewals(new Date(), { orgId });
    await recordPlatformAction(req, { action: 'renewals.run', orgId, entity: 'Subscription', metadata: { ...summary, errors: summary.errors.slice(0, 20) } });
    return res.json({ summary });
  }),
);

/** Invoices paid online by institutes. ?status=&orgId= */
router.get(
  '/invoice-checkouts',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    const orgId = typeof req.query.orgId === 'string' ? req.query.orgId : undefined;
    return res.json({ checkouts: await listInvoiceCheckouts({ status, orgId, limit: Number(req.query.limit) || undefined }) });
  }),
);

router.get(
  '/orgs/:orgId/autopay',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => res.json({ enabled: autopayEnabled(), mandates: await orgMandates(req.params.orgId) })),
);

/** Body: { reason } */
router.post(
  '/orgs/:orgId/autopay/cancel',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim().length >= 3 ? req.body.reason.trim().slice(0, 500) : null;
    if (!reason) return res.status(400).json({ message: 'Say why auto-pay is turned off.', code: 'REASON_REQUIRED' });
    const result = await cancelAutopay(req.params.orgId, staffActor(req), `Turned off by platform staff: ${reason}`);
    await recordPlatformAction(req, { action: 'autopay.cancel', orgId: req.params.orgId, entity: 'AutopayMandate', metadata: { reason } });
    return res.json(result);
  }),
);

// ── Institute orders (self-serve) ──────────────────────────────────────────
// An institute's own order from its admin panel is an invoice (origin
// 'self-serve'). Staff accept it by recording the payment — which applies the
// ordered plan — or put the institute on the plan before payment, or decline
// it with a reason the institute is shown. core/billing/selfServe.

/** ?status=open (default) | all, ?orgId= */
router.get(
  '/orders',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const status = req.query.status === 'all' ? 'all' : 'open';
    const orgId = typeof req.query.orgId === 'string' ? req.query.orgId : undefined;
    return res.json({ orders: await listOrders({ status, orgId, limit: Number(req.query.limit) || undefined }) });
  }),
);

/** The money arrived. Body: { method, reference, receivedAt?, notes?, amount? (defaults to the balance) } */
router.post(
  '/orders/:id/accept',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const result = await acceptOrder(req.params.id, req.body ?? {}, staffActor(req));
    await recordPlatformAction(req, {
      action: result.duplicate ? 'order.accept.duplicate' : 'order.accept',
      orgId: String(result.invoice.orgId),
      entity: 'Invoice',
      entityId: result.invoice.id,
      metadata: {
        number: result.invoice.number,
        planKey: result.invoice.planKey,
        reference: result.payment?.reference,
        issuedNow: result.issuedNow,
        lifecycle: (result as { lifecycle?: unknown }).lifecycle,
      },
    });
    return res.status(result.duplicate ? 200 : 201).json(result);
  }),
);

/** Put the institute on the ordered plan before payment; the invoice stays open. Body: { reason? } */
router.post(
  '/orders/:id/apply-plan',
  requirePlatformCapability('subscription.manage'),
  handle(async (req, res) => {
    const result = await applyOrderPlan(req.params.id, req.body ?? {}, staffActor(req));
    await recordPlatformAction(req, {
      action: 'order.apply-plan',
      orgId: result.subscription ? String(result.subscription.orgId) : undefined,
      entity: 'Invoice',
      entityId: req.params.id,
      metadata: { planKey: result.subscription?.planKey, reason: req.body?.reason },
    });
    return res.json(result);
  }),
);

/** Body: { reason } — shown to the institute. */
router.post(
  '/orders/:id/decline',
  requirePlatformCapability('billing.manage'),
  handle(async (req, res) => {
    const result = await declineOrder(req.params.id, req.body ?? {}, staffActor(req));
    await recordPlatformAction(req, { action: 'order.decline', orgId: result.orgId, entity: 'Invoice', entityId: req.params.id, metadata: { reason: req.body?.reason } });
    return res.json(result);
  }),
);

router.get(
  '/subscription-requests',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    return res.json({ requests: await listSubscriptionRequests({ status }) });
  }),
);

/** Close a request once it has been acted on (through the subscription endpoints) or declined. Body: { status: resolved|declined, note } */
router.post(
  '/subscription-requests/:id/resolve',
  requirePlatformCapability('subscription.manage'),
  handle(async (req, res) => {
    const request = await resolveSubscriptionRequest(req.params.id, req.body ?? {}, staffActor(req));
    await recordPlatformAction(req, { action: `subscription.request.${request.status}`, orgId: String(request.orgId), entity: 'SubscriptionRequest', entityId: req.params.id, metadata: { kind: request.kind, note: request.resolution } });
    return res.json({ request });
  }),
);

// ── Platform staff ─────────────────────────────────────────────────────────

router.get(
  '/staff',
  requirePlatformCapability('staff.manage'),
  handle(async (_req, res) => {
    const staff = await withoutTenantScope('platform:list-staff', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PlatformUser = require('../../models/PlatformUser').default;
      const rows = await PlatformUser.find({}).select('name email role isActive lastLoginAt createdAt +mfa').lean();
      // Whether two-factor sign-in is on — never the record (sealed secret,
      // recovery-code hashes).
      return rows.map(({ mfa, ...row }: { mfa?: { enabled?: boolean } }) => ({ ...row, mfaEnabled: Boolean(mfa?.enabled) }));
    });
    return res.json({ staff });
  }),
);

router.post(
  '/staff',
  requirePlatformCapability('staff.manage'),
  handle(async (req, res) => {
    const { name, email, password, role } = req.body ?? {};
    if (!name || !email || !password || !PLATFORM_ROLES.includes(role)) {
      return res.status(400).json({
        message: `name, email, password and role (${PLATFORM_ROLES.join('|')}) are required`,
      });
    }
    const created = await withoutTenantScope('platform:create-staff', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PlatformUser = require('../../models/PlatformUser').default;
      const user = await PlatformUser.create({ name, email, password, role, isActive: true });
      return { id: String(user._id), name: user.name, email: user.email, role: user.role };
    });
    await recordPlatformAction(req, {
      action: 'staff.create',
      entity: 'PlatformUser',
      entityId: (created as { id: string }).id,
      metadata: { email, role },
    });
    return res.status(201).json({ staff: created });
  }),
);

router.post(
  '/staff/:id/status',
  requirePlatformCapability('staff.manage'),
  handle(async (req, res) => {
    const { isActive } = req.body ?? {};
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'isActive (boolean) is required' });
    }
    const updated = await withoutTenantScope('platform:staff-status', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PlatformUser = require('../../models/PlatformUser').default;
      // Deactivating also bumps tokenVersion, so outstanding tokens stop
      // working immediately rather than at expiry. Disabling an account that
      // keeps working for 15 minutes is not disabling it.
      return PlatformUser.findByIdAndUpdate(
        req.params.id,
        { $set: { isActive }, $inc: { tokenVersion: 1 } },
        { new: true },
      )
        .select('name email role isActive')
        .lean();
    });
    if (!updated) return res.status(404).json({ message: 'Platform user not found' });
    await recordPlatformAction(req, {
      action: isActive ? 'staff.activate' : 'staff.deactivate',
      entity: 'PlatformUser',
      entityId: req.params.id,
    });
    return res.json({ staff: updated });
  }),
);

// ── Mobile build configuration ─────────────────────────────────────────────
//
// Reading takes `org.read`, like every other view of an organization. WRITING
// takes `app.manage`, which is deliberately not `org.manage`: the roles differ
// in what a mistake costs. A wrong colour is fixed by saving again; a wrong
// Android package name is a second store listing that cannot be merged with
// the first. See PlatformUser.ts.

router.get(
  '/orgs/:orgId/mobile',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const profile = (req.query.profile as string) || 'production';
    const view = await getMobileConfig(
      req.params.orgId,
      profile === 'development' || profile === 'preview' ? profile : 'production',
    );
    await recordPlatformAction(req, {
      action: 'mobile.view',
      orgId: req.params.orgId,
      entity: 'Org',
      entityId: req.params.orgId,
      metadata: { status: view.status, issues: view.issues.length },
    });
    return res.json(view);
  }),
);

/* ── Public registration, per application ────────────────────────────────
 *
 * An operator's view of whether this organization's app takes sign-ups, which
 * roles it offers, and where those registrations are stored. The store is
 * SHOWN here — to platform staff, for tracing — and is never accepted as input:
 * the PUT below takes a policy and roles, and the server assigns the collection.
 */
router.get(
  '/orgs/:orgId/registration',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const view = await registrationViewFor(req.params.orgId, { includeStore: true });
    if (!view) return res.status(404).json({ message: 'Organization not found.' });
    return res.json(view);
  }),
);

router.put(
  '/orgs/:orgId/registration',
  requirePlatformCapability('app.manage'),
  handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Only the policy, roles and support copy reach the organization — see
    // core/platform/registrationSettings. The server owns where registrations go.
    try {
      const saved = await updateRegistrationSettings(req.params.orgId, body);
      await recordPlatformAction(req, {
        action: 'registration.update',
        orgId: req.params.orgId,
        entity: 'Org',
        entityId: req.params.orgId,
        changes: { policy: body.policy, roles: body.roles },
        metadata: { storeProvisioned: Boolean(saved.registrationCollection) },
      });
      return res.json(await registrationViewFor(req.params.orgId, { includeStore: true }));
    } catch (err) {
      if (err instanceof RegistrationStorageFailed) {
        return res.status(503).json({ message: err.message, code: 'REGISTRATION_STORAGE_FAILED' });
      }
      throw err;
    }
  }),
);

/* ── Parent ↔ student links, for platform staff ─────────────────────────────
 * The same review an organization's own administrators do on
 * /api/guardian-links, for institutes that have no administrator yet or ask the
 * platform to act. The organization is the URL's, checked by capability; links
 * are only ever looked up INSIDE it, so an id from another organization is a 404.
 */
router.get(
  '/orgs/:orgId/guardian-links',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    return res.json({ links: await listLinks(req.params.orgId, String(req.query.status ?? '')) });
  }),
);

function decideGuardianLink(action: 'verify' | 'revoke') {
  return handle(async (req, res) => {
    const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
    try {
      const actor = { id: String(staff?.id ?? ''), kind: 'platform' as const };
      const link =
        action === 'verify'
          ? await verifyLink(req.params.orgId, req.params.linkId, actor)
          : await revokeLink(req.params.orgId, req.params.linkId, actor);
      await recordPlatformAction(req, {
        action: `guardian.link.${action}`,
        orgId: req.params.orgId,
        entity: 'GuardianLink',
        entityId: String(link._id),
        metadata: { status: link.status },
      });
      return res.json({ id: String(link._id), status: link.status });
    } catch (err) {
      if (err instanceof GuardianLinkError) {
        return res.status(err.httpStatus).json({ message: err.message, code: err.code });
      }
      throw err;
    }
  });
}

/* ── Helping an institute back in ────────────────────────────────────────────────────────────────────────
 * A fresh invitation for an administrator who never set a password, or a
 * reset link for one who is locked out. Returned once, audited without the
 * link. The user is looked up INSIDE the URL's organization, so an id from
 * another organization is a 404.
 */
function platformAccountLink(kind: 'invite' | 'reset') {
  return handle(async (req, res) => {
    const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
    const user = (await withoutTenantScope('platform:account-link', async () =>
      mongoose.isValidObjectId(req.params.userId)
        ? UserModel.findOne({ _id: req.params.userId, orgId: req.params.orgId }).select('inviteTokenHash').lean()
        : null,
    )) as { _id: unknown; inviteTokenHash?: string } | null;
    if (!user) return res.status(404).json({ message: 'User not found in this organization.' });
    if (kind === 'invite' && !user.inviteTokenHash) {
      return res.status(409).json({ message: 'This person has already set a password. Send a reset link instead.' });
    }
    const link = await runWithTenant({ orgId: req.params.orgId, source: 'script' }, async () =>
      kind === 'invite' ? issueInvite(user._id, `platform:${staff?.id ?? ''}`) : issueResetLink(user._id),
    );
    await recordPlatformAction(req, {
      action: `user.${kind}-link`,
      orgId: req.params.orgId,
      entity: 'User',
      entityId: String(user._id),
    });
    return res.json({ link: link.link, token: link.token, expiresAt: link.expiresAt, delivery: link.delivery });
  });
}

router.post('/orgs/:orgId/users/:userId/invite', requirePlatformCapability('org.manage'), platformAccountLink('invite'));
router.post('/orgs/:orgId/users/:userId/reset-link', requirePlatformCapability('org.manage'), platformAccountLink('reset'));

router.post('/orgs/:orgId/guardian-links/:linkId/verify', requirePlatformCapability('org.manage'), decideGuardianLink('verify'));
router.post('/orgs/:orgId/guardian-links/:linkId/revoke', requirePlatformCapability('org.manage'), decideGuardianLink('revoke'));

router.put(
  '/orgs/:orgId/mobile',
  requirePlatformCapability('app.manage'),
  handle(async (req, res) => {
    const before = await getMobileConfig(req.params.orgId);
    const view = await updateMobileConfig(req.params.orgId, req.body ?? {});

    await recordPlatformAction(req, {
      action: 'mobile.update',
      orgId: req.params.orgId,
      entity: 'Org',
      entityId: req.params.orgId,
      changes: req.body,
      metadata: { statusBefore: before.status, statusAfter: view.status },
    });
    // Readiness changing is the operationally interesting event — it is what
    // decides whether a build can be handed to a developer — so it is recorded
    // as its own entry rather than buried in the diff of the one above.
    if (before.status !== view.status) {
      await recordPlatformAction(req, {
        action: 'mobile.readiness',
        orgId: req.params.orgId,
        entity: 'Org',
        entityId: req.params.orgId,
        metadata: { from: before.status, to: view.status },
      });
    }
    return res.json(view);
  }),
);

router.post(
  '/orgs/:orgId/mobile/build-config',
  requirePlatformCapability('app.manage'),
  handle(async (req, res) => {
    const generated = await generateBuildConfig(req.params.orgId);
    await recordPlatformAction(req, {
      action: 'mobile.generate',
      orgId: req.params.orgId,
      entity: 'Org',
      entityId: req.params.orgId,
      metadata: { slug: generated.slug, androidPackage: generated.identity.androidPackage },
    });
    return res.json(generated);
  }),
);

router.post(
  '/orgs/:orgId/mobile/reconcile',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const result = await reconcileBuildConfig(req.params.orgId, req.body?.build ?? {});
    // Only a MISMATCH is audited. Recording every clean comparison would bury
    // the entries that matter in noise nobody reads.
    if (!result.matches) {
      await recordPlatformAction(req, {
        action: 'mobile.mismatch',
        orgId: req.params.orgId,
        entity: 'Org',
        entityId: req.params.orgId,
        metadata: { mismatches: result.mismatches },
      });
    }
    return res.json(result);
  }),
);

// ── Mobile app builds ──────────────────────────────────────────────────────
//
// The console's whole build surface. Reading a build takes `org.read`, like
// every other view of an organization; STARTING one takes `app.manage`, the
// same narrow grant that lets someone set an Android package name — because
// the two mistakes cost the same thing. A build is a store artifact wearing an
// institute's name.
//
// Nothing here waits for a build. Every handler returns in milliseconds and
// the work happens in the queue; see queues/appBuildQueue.ts for why the
// polling is a separate short job rather than a handler that blocks.

/**
 * Is this organization buildable, and for what.
 *
 * `?profile=preview` asks about an internal-testing build, which relaxes one
 * rule — a plaintext API address — and keeps every other. Anything else,
 * including nothing, asks about a release. `parseBuildProfile` falls back to
 * the strict answer, so a stale client or a typo can only tighten the rules.
 */
router.get(
  '/orgs/:orgId/mobile/build-readiness',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const readiness = await buildReadiness(
      req.params.orgId,
      parseBuildProfile(req.query.profile),
    );
    return res.json(readiness);
  }),
);

router.get(
  '/orgs/:orgId/mobile/assets',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    return res.json({ assets: await nativeAssetState(req.params.orgId) });
  }),
);

router.post(
  '/orgs/:orgId/mobile/assets/:kind',
  requirePlatformCapability('app.manage'),
  uploadNativeAsset.single('file'),
  handle(async (req, res) => {
    const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
    if (!file) return res.status(400).json({ message: 'No file was received.' });
    try {
      const saved = await saveNativeAsset(
        req.params.orgId,
        req.params.kind as NativeAssetKind,
        file,
      );
      await recordPlatformAction(req, {
        action: 'mobile.asset.upload',
        orgId: req.params.orgId,
        entity: 'Org',
        entityId: req.params.orgId,
        metadata: { kind: saved.kind, bytes: saved.bytes },
      });
      return res.status(201).json({ asset: saved, assets: await nativeAssetState(req.params.orgId) });
    } catch (err) {
      if (err instanceof NativeAssetRejected) return res.status(400).json({ message: err.message });
      throw err;
    }
  }),
);

router.get(
  '/orgs/:orgId/mobile/builds',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const builds = await listBuilds(req.params.orgId, Number(req.query.limit) || 25);
    return res.json({ builds: await publicBuildViews(builds) });
  }),
);

const QUEUE_DOWN = 'The build could not be queued. The build service is unavailable — try again shortly.';

/**
 * Create a build and put it on the queue — the one path that both "Start
 * build" and "Activate and build" (App designs) take, so a design build is
 * judged, queued and audited exactly like any other.
 *
 * Throws `BuildNotAllowed` / `BuildConfigIncomplete` for the caller to map.
 * A queue that is down is returned as `queueFailed` rather than thrown, after
 * failing the row: left alone it would sit in `queued` for ever AND hold the
 * live-build slot, so the next click would be told a build is already running
 * when none is.
 */
async function startQueuedBuild(
  req: Request,
  orgId: string,
  input: { artifactType: 'apk' | 'aab'; force?: boolean; appProfile?: SelectableBuildProfile },
): Promise<{ build: IAppBuildJob; created: boolean; queueFailed?: string }> {
  const actor = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
  const { build, created } = await startBuild({
    orgId,
    platform: 'android',
    artifactType: input.artifactType,
    requestedBy: String(actor?.id ?? ''),
    force: input.force === true,
    appProfile: input.appProfile,
  });

  if (created) {
    try {
      await enqueuePrepare({ buildId: String(build._id), orgId, platform: 'android', artifactType: input.artifactType });
    } catch (err) {
      await markFailed(String(build._id), {
        errorCode: 'QUEUE_UNAVAILABLE',
        errorMessage: QUEUE_DOWN,
        errorDetail: (err as Error)?.message,
      });
      return { build, created, queueFailed: QUEUE_DOWN };
    }
    // Audited on creation only. Recording the duplicate clicks as well would
    // bury the entries that matter under a person's mouse.
    await recordPlatformAction(req, {
      action: 'mobile.build.start',
      orgId,
      entity: 'AppBuildJob',
      entityId: String(build._id),
      metadata: {
        buildNumber: build.buildNumber,
        artifactType: build.artifactType,
        appVersion: build.appVersion,
        profile: build.buildProfile,
        androidPackage: (build.resolvedIdentity as Record<string, string> | undefined)?.androidPackage,
        design: build.design?.templateId,
      },
    });
  }
  return { build, created };
}

/**
 * Start a build.
 *
 * Answers 200 with `created: false` when an identical build is already
 * running, rather than 409. A second click is not an error to correct — the
 * person meant to start one build, and the honest reply is the build they
 * started. `force: true` is the explicit rebuild, which supersedes it.
 */
router.post(
  '/orgs/:orgId/mobile/builds',
  requirePlatformCapability('app.manage'),
  handle(async (req, res) => {
    const artifactType = String(req.body?.artifactType ?? '').toLowerCase();
    if (!BUILD_ARTIFACT_TYPES.includes(artifactType as never)) {
      return res.status(400).json({
        message: 'Choose APK or AAB.',
      });
    }

    try {
      const { build, created, queueFailed } = await startQueuedBuild(req, req.params.orgId, {
        artifactType: artifactType as 'apk' | 'aab',
        force: req.body?.force === true,
        appProfile: parseBuildProfile(req.body?.appProfile),
      });
      if (queueFailed) return res.status(503).json({ message: queueFailed });
      return res.status(created ? 201 : 200).json({ build: await publicBuildViewOf(build), created });
    } catch (err) {
      if (err instanceof BuildNotAllowed) {
        return res.status(422).json({ message: err.message, problems: err.problems });
      }
      if (err instanceof BuildConfigIncomplete) {
        return res.status(422).json({
          message: err.message,
          problems: err.issues.map((i) => i.message),
        });
      }
      throw err;
    }
  }),
);

router.get(
  '/mobile/builds/:buildId',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    try {
      return res.json({ build: await publicBuildViewOf(await getBuild(req.params.buildId)) });
    } catch (err) {
      if (err instanceof BuildNotFound) return res.status(404).json({ message: err.message });
      throw err;
    }
  }),
);

router.post(
  '/mobile/builds/:buildId/cancel',
  requirePlatformCapability('app.manage'),
  handle(async (req, res) => {
    try {
      const result = await cancelBuild(req.params.buildId);
      const build = await getBuild(req.params.buildId);
      if (result.cancelled) {
        await recordPlatformAction(req, {
          action: 'mobile.build.cancel',
          orgId: String(build.orgId),
          entity: 'AppBuildJob',
          entityId: req.params.buildId,
          metadata: { buildNumber: build.buildNumber },
        });
      }
      return res.json({ ...result, build: await publicBuildViewOf(build) });
    } catch (err) {
      if (err instanceof BuildNotFound) return res.status(404).json({ message: err.message });
      throw err;
    }
  }),
);

/**
 * Where to download the finished artifact.
 *
 * The URL is EAS's own, not one this server invents, and the binary is not
 * proxied: an APK is tens of megabytes and streaming it through the API buys
 * nothing except a slower download and a busy Node process. The request is
 * audited because who took a signed build out of the system is worth knowing.
 */
router.get(
  '/mobile/builds/:buildId/artifact',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    try {
      const build = await getBuild(req.params.buildId);
      if (build.status !== 'completed' || !build.artifactUrl) {
        return res.status(409).json({ message: 'This build has no downloadable file.' });
      }
      await recordPlatformAction(req, {
        action: 'mobile.build.download',
        orgId: String(build.orgId),
        entity: 'AppBuildJob',
        entityId: req.params.buildId,
        metadata: { buildNumber: build.buildNumber, artifactType: build.artifactType },
      });
      return res.json({ url: build.artifactUrl, filename: build.artifactFilename });
    } catch (err) {
      if (err instanceof BuildNotFound) return res.status(404).json({ message: err.message });
      throw err;
    }
  }),
);

// ── App designs ────────────────────────────────────────────────────────────
//
// Institutes choose and submit a design in the web Design Studio
// (/api/org-admin/app-design); staff review it here. Reading needs `org.read`.
// Every decision needs `app.manage` — the capability that starts builds —
// because activation decides what that organization's next build compiles in.
// Drafts never appear here: the queue starts at submission.

function staffOf(req: Request): { id?: string } {
  const actor = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
  return { id: actor?.id ? String(actor.id) : undefined };
}

router.get(
  '/app-design/requests',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    return res.json(
      await listDesignRequests({
        stage: typeof req.query.stage === 'string' ? req.query.stage : undefined,
        orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
        limit: Number(req.query.limit) || undefined,
      }),
    );
  }),
);

router.get(
  '/app-design/requests/:id',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => res.json({ request: await getDesignRequest(req.params.id) })),
);

/** One review decision. Declared per route below so each path is literal in the source (and in the API contract snapshot). */
function reviewHandler(action: 'request-changes' | 'approve' | 'reject') {
  return handle(async (req, res) => {
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    const view = await reviewDesign(req.params.id, action, staffOf(req), note);
    await recordPlatformAction(req, {
      action: `app-design.${action}`,
      orgId: view.orgId,
      entity: 'AppDesignRequest',
      entityId: view.id,
      metadata: { templateId: view.selection.templateId, revision: view.revision, note: note?.slice(0, 200) },
    });
    return res.json({ request: view });
  });
}

router.post('/app-design/requests/:id/request-changes', requirePlatformCapability('app.manage'), reviewHandler('request-changes'));
router.post('/app-design/requests/:id/approve', requirePlatformCapability('app.manage'), reviewHandler('approve'));
router.post('/app-design/requests/:id/reject', requirePlatformCapability('app.manage'), reviewHandler('reject'));

/**
 * Start a build for an ACTIVE design request and remember it on the request.
 *
 * Returns the build, or a `buildError` sentence: the design is already
 * active either way, and why the build could not start (a missing icon, no
 * Expo account) is the useful answer — the console offers the build again.
 */
async function buildForDesign(
  req: Request,
  requestId: string,
  orgId: string,
  wanted: Record<string, unknown>,
): Promise<{ build: Record<string, unknown> | null; created?: boolean; buildError?: { message: string; problems?: string[] } }> {
  const artifactType = String(wanted.artifactType ?? 'aab').toLowerCase();
  if (!BUILD_ARTIFACT_TYPES.includes(artifactType as never)) {
    return { build: null, buildError: { message: 'Choose APK or AAB.' } };
  }
  try {
    const { build, created, queueFailed } = await startQueuedBuild(req, orgId, {
      artifactType: artifactType as 'apk' | 'aab',
      appProfile: parseBuildProfile(wanted.appProfile),
      force: wanted.force === true,
    });
    if (queueFailed) return { build: null, buildError: { message: queueFailed } };
    if (created) await linkBuildToRequest(requestId, build);
    return { build: await publicBuildViewOf(build), created };
  } catch (err) {
    if (err instanceof BuildNotAllowed) return { build: null, buildError: { message: err.message, problems: err.problems } };
    if (err instanceof BuildConfigIncomplete) {
      return { build: null, buildError: { message: err.message, problems: err.issues.map((i) => i.message) } };
    }
    throw err;
  }
}

/**
 * Activate an approved design — it becomes what this organization's builds
 * compile in — and optionally start a build with it in the same step.
 */
router.post(
  '/app-design/requests/:id/activate',
  requirePlatformCapability('app.manage'),
  handle(async (req, res) => {
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    const view = await activateDesign(req.params.id, staffOf(req), note);
    await recordPlatformAction(req, {
      action: 'app-design.activate',
      orgId: view.orgId,
      entity: 'AppDesignRequest',
      entityId: view.id,
      metadata: { templateId: view.selection.templateId, templateVersion: view.selection.templateVersion, revision: view.revision },
    });
    const wanted = req.body?.build && typeof req.body.build === 'object' ? (req.body.build as Record<string, unknown>) : null;
    if (!wanted) return res.json({ request: await getDesignRequest(view.id), build: null });
    const built = await buildForDesign(req, view.id, view.orgId, wanted);
    return res.json({ request: await getDesignRequest(view.id), ...built });
  }),
);

/** Build an already-active design again — after fixing what stopped the first build, or for a store update. */
router.post(
  '/app-design/requests/:id/builds',
  requirePlatformCapability('app.manage'),
  handle(async (req, res) => {
    const request = await getDesignRequest(req.params.id);
    if (request.stage !== 'active') {
      return res.status(409).json({ message: 'Only the active design can be built. Activate it first.' });
    }
    const built = await buildForDesign(req, request.id, request.orgId, (req.body ?? {}) as Record<string, unknown>);
    return res.status(built.build ? (built.created ? 201 : 200) : 422).json({ request: await getDesignRequest(request.id), ...built });
  }),
);

// ── Organization registrations ─────────────────────────────────────────────
//
// The staff half of the public "Register your institute" flow. Reading needs
// `org.read`; approving creates a tenant, so it needs `org.manage` — the same
// capability `/orgs/onboard` requires, because approval IS that call.

router.get(
  '/registrations',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const result = await listRegistrations({
      status: req.query.status as string,
      search: req.query.search as string,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      skip: req.query.skip ? Number(req.query.skip) : undefined,
    });
    return res.json(result);
  }),
);

router.get(
  '/registrations/:id',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const registration = await getRegistration(req.params.id);
    if (!registration) return res.status(404).json({ message: 'Registration not found' });

    // Computed, never stored. A readiness flag written to the document would
    // go stale the moment anything it depends on changed, and an admin would
    // be reading yesterday's answer.
    const readiness = assessApplication(registration as never);
    const mapped = applicationToOnboardingInput(registration as never);

    // Opening someone's contact details is itself worth recording — this is
    // personal data, and "who looked at it" is the question an audit exists to
    // answer.
    await recordPlatformAction(req, {
      action: 'registration.view',
      entity: 'OrganizationRegistration',
      entityId: req.params.id,
    });

    return res.json({
      registration,
      // Payments taken at checkout while applying (core/billing/registrationPayments).
      payments: await paymentsForRegistration(req.params.id),
      refundRequests: await requestsForRegistration(req.params.id),
      readiness,
      // What provisioning WOULD apply, so an admin can see it before pressing
      // the button rather than discovering it in the result.
      provisioningPreview: {
        slug: mapped.input.organization.slug,
        branding: mapped.input.branding ?? {},
        configuration: mapped.input.configuration ?? {},
        policy: mapped.input.policy ?? {},
        modules: mapped.input.subscription?.addOns ?? [],
        droppedModules: mapped.droppedModules,
        adminPrefill: mapped.adminPrefill,
        // The applicant chose the administrator's password when applying —
        // approval creates the account with it and issues no invitation.
        adminPasswordChosen: Boolean((registration as { adminPasswordSetAt?: Date }).adminPasswordSetAt),
      },
    });
  }),
);

/**
 * A signed, expiring URL for one uploaded brand asset.
 *
 * The object is private and sits outside the tenant namespace, so there is no
 * owning organization to check against — the authorisation is this route's
 * `org.read` capability, and the signature is short-lived.
 */
router.get(
  '/registrations/:id/assets/:assetId',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const registration = await getRegistration(req.params.id);
    if (!registration) return res.status(404).json({ message: 'Registration not found' });

    const assets = (registration as { application?: { assets?: { assetId: string; storagePath: string; mimeType: string; filename: string }[] } })
      .application?.assets ?? [];
    const asset = assets.find((a) => a.assetId === req.params.assetId);
    if (!asset) return res.status(404).json({ message: 'Asset not found on this application' });

    // Fifteen minutes: long enough to render a page, short enough that a URL
    // pasted into a ticket stops working.
    const url = await signAsset(asset.storagePath, 15 * 60 * 1000);
    return res.json({ url, filename: asset.filename, mimeType: asset.mimeType });
  }),
);

/**
 * Approve, and provision.
 *
 * This does NOT contain a provisioning sequence. It calls
 * `approveRegistration()`, which calls `onboardOrganization()` — the same
 * orchestrator `/orgs/onboard` uses. The 207 semantics are preserved for the
 * same reason they exist there: a partial run leaves a resumable organization,
 * and re-posting this finishes it rather than duplicating it.
 */
router.post(
  '/registrations/:id/approve',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
    const result = await approveRegistration(req.params.id, req.body ?? {}, {
      id: staff?.id,
    });

    await recordPlatformAction(req, {
      action: result.created ? 'registration.approve' : 'registration.approve.retry',
      orgId: result.onboarding.orgId,
      entity: 'OrganizationRegistration',
      entityId: req.params.id,
      metadata: {
        slug: result.onboarding.slug,
        complete: result.onboarding.complete,
        steps: result.onboarding.steps,
        createdOrganization: result.created,
        droppedModules: result.droppedModules,
        plan: result.plan,
      },
    });

    return res.status(result.onboarding.complete ? 200 : 207).json({
      registration: result.registration,
      onboarding: result.onboarding,
      created: result.created,
      droppedModules: result.droppedModules,
      plan: result.plan,
    });
  }),
);

router.post(
  '/registrations/:id/reject',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
    const registration = await setRegistrationVerdict(
      req.params.id,
      'REJECTED',
      typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000) : undefined,
      { id: staff?.id },
    );

    // A paid application that is rejected gets its money back, in full, at
    // once: the refund request is raised and approved by the same decision.
    // If Cashfree refuses, the rejection stands and the request can be
    // approved again from the Payment card.
    const paid = await effectivePayment(String(registration._id));
    let refund: Record<string, unknown> | null = null;
    if (paid) {
      try {
        const result = await raiseRefundRequest(
          { registrationPaymentId: String(paid._id) },
          { reason: `Application rejected${registration.reviewNote ? `: ${registration.reviewNote}` : ''}` },
          { kind: 'system', id: 'registration:rejected' },
          { approveAs: await staffWithEmail(req), approveNote: 'Refunded in full: the application was rejected.' },
        );
        refund = { request: result.request };
      } catch (error) {
        refund = { error: (error as Error).message, code: (error as { code?: string }).code };
      }
    }

    await recordPlatformAction(req, {
      action: 'registration.reject',
      entity: 'OrganizationRegistration',
      entityId: req.params.id,
      metadata: { note: registration.reviewNote, refund: refund ? { requestId: (refund.request as { id?: string } | undefined)?.id, error: refund.error } : null },
    });

    return res.json({ registration, refund });
  }),
);

/**
 * Ask the applicant for more, or put a registration back in the queue.
 *
 * `INFO_REQUESTED` records that staff need something further. With no mail
 * system in this repository the request itself is made out of band — see
 * docs/organization-registration.md — and this endpoint records the state so
 * the queue does not keep presenting the row as untouched.
 */
router.post(
  '/registrations/:id/status',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const next = String(req.body?.status ?? '').toUpperCase();
    if (next !== 'INFO_REQUESTED' && next !== 'PENDING') {
      return res.status(400).json({
        message: 'status must be INFO_REQUESTED or PENDING. Use /approve or /reject for a verdict.',
      });
    }

    const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
    const registration = await setRegistrationVerdict(
      req.params.id,
      next,
      typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000) : undefined,
      { id: staff?.id },
    );

    await recordPlatformAction(req, {
      action: next === 'PENDING' ? 'registration.reopen' : 'registration.request-info',
      entity: 'OrganizationRegistration',
      entityId: req.params.id,
      metadata: { note: registration.reviewNote },
    });

    return res.json({ registration });
  }),
);

// ── Audit ──────────────────────────────────────────────────────────────────

router.get(
  '/audit',
  requirePlatformCapability('audit.read'),
  handle(async (req, res) => {
    const entries = await listPlatformAudit({
      orgId: req.query.orgId as string,
      actorId: req.query.actorId as string,
      action: req.query.action as string,
      limit: req.query.limit ? Number(req.query.limit) : 100,
    });
    return res.json({ entries });
  }),
);

export default router;
