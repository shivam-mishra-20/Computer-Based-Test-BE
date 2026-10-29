/**
 * The public front door for institutes wanting to join the platform.
 *
 * ── One endpoint, and why it is not under /api/platform ─────────────────────
 * `/api/platform/*` is the staff surface: it requires a `PlatformUser` token
 * and is mounted only on the deployment where `TENANT_MODE=claim`. Putting a
 * public form there would mean either weakening that surface's auth or serving
 * the marketing site from the platform deployment. Neither is worth it for one
 * POST, so this lives in the existing `/api/public` namespace alongside the
 * other unauthenticated routes.
 *
 * ── What it cannot do ───────────────────────────────────────────────────────
 * It writes exactly one document to one collection. It creates no Org, no
 * User, no Role, no Subscription and no entitlement; it reads no tenant data;
 * and it accepts no orgId, status or review field from the client — the
 * handler picks fields explicitly, so an extra key in the body is ignored
 * rather than mass-assigned.
 *
 * Provisioning happens later, from the console, through
 * `onboardOrganization()`. See docs/organization-registration.md.
 *
 * The long application below also takes payment for a priced plan before it
 * can be submitted: those routes write RegistrationPayment rows and talk to
 * Cashfree, and still create no tenant. See docs/registration-payments.md.
 */

// Organization registration is the organization system's. A legacy deployment
// answers 404 here, exactly as it does for /api/platform, so no organization
// application can ever be written into the legacy database.
import { requirePlatformDeployment } from '../../middlewares/requirePlatformDeployment';
import express, { Request, Response } from 'express';
import { draftEditLimiter, previewLimiter, publicFormLimiter, uploadLimiter } from '../../middlewares/rateLimiter';
import { resolveBrandConfig, SUPPORTED_AUTH_ROLES } from '../../core/platform/mobileBuildRules';
import { uploadBrandAsset } from '../../middlewares/uploadBrandAsset';
import {
  RegistrationValidationError,
  publicView,
  submitRegistration,
} from '../../core/platform/registrations';
import {
  AssetRejected,
  DraftNotEditable,
  DraftNotFound,
  applicantAssetViews,
  createDraft,
  discardDraft,
  draftView,
  loadDraft,
  loadEditableDraft,
  saveDraft,
  setAdminPassword,
  storeAsset,
  submitApplication,
} from '../../core/platform/applications';
import { BillingError } from '../../core/billing/invoices';
import {
  PaymentRequired,
  applicantPaymentState,
  confirmOrder,
  startCheckout,
} from '../../core/billing/registrationPayments';
import { raiseRefundRequest, requesterView } from '../../core/billing/refundRequests';

const router = express.Router();

/**
 * POST /api/public/organization-registration
 *
 * Rate limited by IP through the existing `publicFormLimiter`. Unauthenticated
 * by design — requiring an account to ask for an account is a loop.
 */
router.post('/organization-registration', requirePlatformDeployment, publicFormLimiter, async (req: Request, res: Response) => {
  try {
    // ── Honeypot ────────────────────────────────────────────────────────────
    // A field no human sees and no real browser fills. Scripted submitters
    // populate every input they find, so a non-empty value here is a bot.
    //
    // Answered with the SAME 201 shape a real submission gets, because a bot
    // that is told it failed retries with the field removed. Nothing is
    // written; the reference is a throwaway.
    if (typeof req.body?.website === 'string' && req.body.website.trim()) {
      return res.status(201).json({
        message:
          'Your institute registration has been submitted successfully. ' +
          'Our team will review your request and contact you shortly.',
        registration: {
          reference: 'REG-PENDING',
          organizationName: String(req.body?.organizationName ?? '').slice(0, 160),
          status: 'PENDING',
        },
      });
    }

    const { registration } = await submitRegistration(
      {
        // Explicit pick. `status`, `orgId`, `reviewedBy` and everything else
        // privileged are simply not read, so they cannot be supplied.
        organizationName: req.body?.organizationName,
        organizationType: req.body?.organizationType,
        contactName: req.body?.contactName,
        designation: req.body?.designation,
        email: req.body?.email,
        phone: req.body?.phone,
        city: req.body?.city,
        state: req.body?.state,
        country: req.body?.country,
        estimatedStudents: req.body?.estimatedStudents,
        estimatedTeachers: req.body?.estimatedTeachers,
        message: req.body?.message,
      },
      { ip: req.ip },
    );

    // A duplicate inside the window returns the original and the same 201.
    // From the applicant's side one submission happened, which is true — see
    // `submitRegistration`.
    return res.status(201).json({
      message:
        'Your institute registration has been submitted successfully. ' +
        'Our team will review your request and contact you shortly.',
      registration: publicView(registration),
    });
  } catch (err) {
    if (err instanceof RegistrationValidationError) {
      return res.status(400).json({
        message: 'Please correct the highlighted fields.',
        fields: err.fields,
      });
    }
    // Nothing internal reaches the caller: no stack, no driver message, no
    // collection name. The detail is logged where staff can read it.
    console.error('[organization-registration] submit failed:', err);
    return res.status(500).json({
      message: 'Could not submit your registration right now. Please try again shortly.',
    });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   The full onboarding application
   ══════════════════════════════════════════════════════════════════════════

   The short form above still exists and still works — it is the one-screen
   "get in touch" path, and every historical submission came through it. What
   follows is the long form: the same record, filled in properly, saved as the
   applicant goes.

   ── How access works without an account ────────────────────────────────────
   `POST /applications` returns an id and a one-time token. Every later call
   sends both. The token is the whole authorisation: it is high-entropy, stored
   `select: false`, compared in constant time, and cleared on submission. There
   is no account, because asking an institute to register an account in order
   to apply to register would be a loop.

   A wrong token and a non-existent id return the SAME error. Telling them
   apart would make this an oracle for which application ids exist.
   ══════════════════════════════════════════════════════════════════════════ */

/** The token, from a header so it never lands in a URL, a log or a referrer. */
function draftTokenOf(req: Request): string {
  const header = req.header('X-Application-Token');
  return typeof header === 'string' ? header.trim() : '';
}

function handleApplicationError(res: Response, err: unknown, what: string) {
  if (err instanceof RegistrationValidationError) {
    return res.status(400).json({ message: 'Please correct the highlighted fields.', fields: err.fields });
  }
  if (err instanceof DraftNotFound) {
    return res.status(404).json({ message: err.message });
  }
  if (err instanceof DraftNotEditable) {
    return res.status(409).json({ message: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  if (err instanceof AssetRejected) {
    return res.status(400).json({ message: err.message });
  }
  // 402: the application is complete, but its plan has not been paid for.
  if (err instanceof PaymentRequired) {
    return res.status(402).json({ message: err.message, code: err.code });
  }
  // Payment problems carry their own status and a sentence for the applicant.
  // The gateway's own words are logged, never sent to the public page.
  if (err instanceof BillingError) {
    const { gateway: _gateway, ...details } = err.details as Record<string, unknown>;
    void _gateway;
    return res.status(err.status).json({
      message: err.message,
      code: err.code,
      ...(details.field ? { fields: { [String(details.field)]: err.message } } : {}),
    });
  }
  console.error(`[organization-application] ${what} failed:`, err);
  return res.status(500).json({ message: 'Something went wrong. Please try again shortly.' });
}

/**
 * Resolve a draft brand into the configuration an app would be built with.
 *
 * ── Why the preview asks the server ─────────────────────────────────────────
 * The onboarding form shows an administrator what their institute's app will
 * look like. That promise is only worth making if the preview and the BUILD
 * resolve the configuration the same way — same defaults, same caps, same
 * answer about which roles actually work. The alternative is a preview that
 * re-implements the rules in the browser and drifts from them quietly, which
 * is the failure mode that makes a configuration screen untrustworthy.
 *
 * So the browser sends what has been typed and this returns what would be
 * built, through the same `resolveBrandConfig` the generated organization file
 * is written from.
 *
 * ── Why it is safe to be public ─────────────────────────────────────────────
 * It is a pure function behind an HTTP call. It reads no database, resolves no
 * organization, touches no tenant, and returns only a transformation of what
 * the caller already sent. There is nothing here to leak and nothing to
 * authorize against — the onboarding form has no account yet, which is the
 * whole reason it is on this router. It is rate limited because it is public,
 * not because it is sensitive — and by `previewLimiter`, which is sized for
 * someone typing, not by the submission limiter (twenty an hour blanked the
 * preview part-way through one person's first edit).
 */
router.post('/brand-preview', requirePlatformDeployment, previewLimiter, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    return res.json({
      brand: resolveBrandConfig({
        appName: body.appName as string,
        shortName: body.shortName as string,
        tagline: body.tagline as string,
        palette: (body.palette ?? {}) as never,
        authCopy: (body.authCopy ?? {}) as never,
        roles: (body.roles ?? {}) as never,
        registrationPolicy: body.registrationPolicy as never,
      }),
      // What the platform can authenticate today, so the editor can explain a
      // role it will not switch on rather than silently dropping it.
      supportedRoles: SUPPORTED_AUTH_ROLES,
    });
  } catch (err) {
    console.error('[brand-preview] failed:', err);
    return res.status(500).json({ message: 'Could not build the preview. Please try again.' });
  }
});

/**
 * GET /api/public/plans — the plans an institute can ask for on the form.
 *
 * Read-only catalogue data, the same an organization admin sees when choosing
 * an upgrade: name, price, trial length, limits and modules of the plans on
 * sale. Choosing one on the form records a PREFERENCE; the plan is granted (or
 * not) by platform staff at approval.
 */
router.get('/plans', requirePlatformDeployment, previewLimiter, async (_req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { listPublicPlans } = require('../../core/subscriptions/catalogue');
    return res.json({ plans: await listPublicPlans() });
  } catch (err) {
    console.error('[public-plans] failed:', err);
    return res.status(500).json({ message: 'Could not load plans right now.' });
  }
});

/** Start an application. Returns the id and the only copy of the token. */
router.post('/organization-applications', requirePlatformDeployment, publicFormLimiter, async (req: Request, res: Response) => {
  try {
    const { registration, draftToken } = await createDraft(
      {
        organizationName: req.body?.organizationName,
        organizationType: req.body?.organizationType,
        contactName: req.body?.contactName,
        designation: req.body?.designation,
        email: req.body?.email,
        phone: req.body?.phone,
        city: req.body?.city,
        state: req.body?.state,
        country: req.body?.country,
        estimatedStudents: req.body?.estimatedStudents,
        estimatedTeachers: req.body?.estimatedTeachers,
        message: req.body?.message,
      },
      { ip: req.ip },
    );
    return res.status(201).json({
      draft: draftView(registration),
      // Shown once. There is no endpoint that returns it again.
      draftToken,
    });
  } catch (err) {
    return handleApplicationError(res, err, 'create');
  }
});

/** Resume a draft. */
router.get('/organization-applications/:id', requirePlatformDeployment, draftEditLimiter, async (req: Request, res: Response) => {
  try {
    const found = await loadDraft(req.params.id, draftTokenOf(req));
    // Assets travel alongside the draft rather than inside it: the stored
    // record has a private storage path, and only a signed URL is displayable.
    return res.json({ draft: draftView(found), assets: await applicantAssetViews(found) });
  } catch (err) {
    return handleApplicationError(res, err, 'load');
  }
});

/** Save a step. Sections are replaced whole — see `saveDraft`. */
router.patch('/organization-applications/:id', requirePlatformDeployment, draftEditLimiter, async (req: Request, res: Response) => {
  try {
    const updated = await saveDraft(
      req.params.id,
      draftTokenOf(req),
      {
        organization: req.body?.application?.organization,
        branding: req.body?.application?.branding,
        // Named here or it is dropped: this handler passes sections by name,
        // and the App Experience step was missing from the list — so everything
        // an institute set on it was discarded before the draft was saved.
        appExperience: req.body?.application?.appExperience,
        academic: req.body?.application?.academic,
        policy: req.body?.application?.policy,
        modules: req.body?.application?.modules,
        staff: req.body?.application?.staff,
        integrations: req.body?.application?.integrations,
        commercial: req.body?.application?.commercial,
        completedSteps: req.body?.application?.completedSteps,
      },
      req.body?.core,
    );
    return res.json({ draft: draftView(updated) });
  } catch (err) {
    return handleApplicationError(res, err, 'save');
  }
});

/**
 * Upload one brand asset.
 *
 * Rate limited separately from the form: an upload is expensive and a form
 * save is not. The file's CONTENTS are sniffed — a client-declared MIME type
 * is a claim, not evidence — and it is stored private, outside the tenant
 * namespace, because no organization owns it yet.
 */
router.post(
  '/organization-applications/:id/assets', requirePlatformDeployment,
  uploadLimiter,
  // Not the shared `upload`: that one refuses image/svg+xml, which is the file
  // this form recommends. See middlewares/uploadBrandAsset.ts.
  uploadBrandAsset.single('file'),
  async (req: Request, res: Response) => {
    try {
      const file = (req as Request & { file?: { buffer: Buffer; originalname: string; mimetype: string } }).file;
      if (!file) return res.status(400).json({ message: 'No file was received.' });
      const updated = await storeAsset(
        req.params.id,
        draftTokenOf(req),
        file,
        String(req.body?.kind ?? 'logo'),
      );
      return res
        .status(201)
        .json({ draft: draftView(updated), assets: await applicantAssetViews(updated) });
    } catch (err) {
      return handleApplicationError(res, err, 'asset upload');
    }
  },
);

/**
 * Choose the administrator's password. Hashed on arrival and never returned;
 * approval creates the administrator's account with it, so no invitation link
 * is needed. Answers with the draft view, which says only `adminPasswordSet`.
 */
router.put('/organization-applications/:id/admin-password', requirePlatformDeployment, draftEditLimiter, async (req: Request, res: Response) => {
  try {
    const updated = await setAdminPassword(req.params.id, draftTokenOf(req), req.body?.password);
    return res.json({ draft: draftView(updated) });
  } catch (err) {
    return handleApplicationError(res, err, 'admin password');
  }
});

/**
 * Discard an unsubmitted draft — "start a new application". Needs the draft's
 * token like every other draft call; a submitted application cannot be
 * discarded from here (409).
 */
router.delete('/organization-applications/:id', requirePlatformDeployment, draftEditLimiter, async (req: Request, res: Response) => {
  try {
    const { removedFiles } = await discardDraft(req.params.id, draftTokenOf(req));
    return res.json({ discarded: true, removedFiles });
  } catch (err) {
    return handleApplicationError(res, err, 'discard');
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   Paying for the plan (Cashfree)
   ══════════════════════════════════════════════════════════════════════════

   A plan with a price is paid for before the application is submitted —
   core/billing/registrationPayments. The page asks what is due, opens the
   checkout with the session id returned here, and on its way back asks us to
   confirm. Confirming never takes the browser's word: the server asks Cashfree
   about the order, and only Cashfree's answer can mark it paid. */

/** What is due for this draft, and whether it is already paid. */
router.get('/organization-applications/:id/payment', requirePlatformDeployment, draftEditLimiter, async (req: Request, res: Response) => {
  try {
    const found = await loadDraft(req.params.id, draftTokenOf(req));
    return res.json({ payment: await applicantPaymentState(found) });
  } catch (err) {
    return handleApplicationError(res, err, 'payment state');
  }
});

/**
 * Open (or reopen) the checkout. Validates the whole application first —
 * nobody should pay for an application that then cannot be submitted.
 * Body: { returnUrl? } — this page's own address, with `{order_id}` in it.
 */
router.post('/organization-applications/:id/checkout', requirePlatformDeployment, draftEditLimiter, async (req: Request, res: Response) => {
  try {
    const found = await loadEditableDraft(req.params.id, draftTokenOf(req));
    const checkout = await startCheckout(found, {
      returnUrl: req.body?.returnUrl,
      origin: req.header('origin'),
      ip: req.ip,
    });
    return res.status(checkout.alreadyPaid ? 200 : 201).json({ checkout });
  } catch (err) {
    return handleApplicationError(res, err, 'checkout');
  }
});

/**
 * "I am back from paying." Keyed by the order id alone — a paid application
 * is submitted at once, which retires its draft token, and the applicant must
 * still be able to see the outcome. Answers only the payment's status and the
 * application's reference.
 */
router.post('/registration-payments/:orderId/confirm', requirePlatformDeployment, draftEditLimiter, async (req: Request, res: Response) => {
  try {
    return res.json(await confirmOrder(req.params.orderId, 'applicant'));
  } catch (err) {
    return handleApplicationError(res, err, 'payment confirm');
  }
});

/**
 * An applicant asking for their money back — withdrawing the application, or
 * after it was turned down. Proved by the order id (on their receipt) AND the
 * application's email; anything else answers like a missing payment. Platform
 * staff decide (core/billing/refundRequests). Body: { email, reason }.
 */
router.post('/registration-payments/:orderId/refund-request', requirePlatformDeployment, publicFormLimiter, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RegistrationPayment = require('../../models/RegistrationPayment').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OrganizationRegistration = require('../../models/OrganizationRegistration').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { withoutTenantScope } = require('../../core/tenancy/context');
    const orderId = String(req.params.orderId ?? '').trim();
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const record = /^[A-Za-z0-9_-]{3,45}$/.test(orderId)
      ? await withoutTenantScope('public:refund-request', () => RegistrationPayment.findOne({ orderId }).lean())
      : null;
    const reg = record
      ? await withoutTenantScope('public:refund-request-reg', () => OrganizationRegistration.findById(record.registrationId).select('email contactName').lean())
      : null;
    if (!record || !reg || !email || String(reg.email ?? '').toLowerCase() !== email) {
      return res.status(404).json({ message: 'No payment matches that order and email.' });
    }
    const result = await raiseRefundRequest(
      { registrationPaymentId: String(record._id) },
      { reason: req.body?.reason },
      { kind: 'applicant', email, name: reg.contactName },
    );
    return res.status(result.duplicate ? 200 : 201).json({ refundRequest: requesterView(result.request), duplicate: result.duplicate });
  } catch (err) {
    return handleApplicationError(res, err, 'refund request');
  }
});

/** Submit. Validates, stamps, and retires the token. */
router.post('/organization-applications/:id/submit', requirePlatformDeployment, draftEditLimiter, async (req: Request, res: Response) => {
  try {
    const submitted = await submitApplication(req.params.id, draftTokenOf(req));
    return res.json({
      message:
        'Your application has been submitted. Our team will review it and contact you shortly.',
      registration: publicView(submitted),
    });
  } catch (err) {
    return handleApplicationError(res, err, 'submit');
  }
});

export default router;
