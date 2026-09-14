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
 */

import express, { Request, Response } from 'express';
import { publicFormLimiter, uploadLimiter } from '../../middlewares/rateLimiter';
import { upload } from '../../middlewares/upload';
import {
  RegistrationValidationError,
  publicView,
  submitRegistration,
} from '../../core/platform/registrations';
import {
  AssetRejected,
  DraftNotEditable,
  DraftNotFound,
  createDraft,
  draftView,
  loadDraft,
  saveDraft,
  storeAsset,
  submitApplication,
} from '../../core/platform/applications';

const router = express.Router();

/**
 * POST /api/public/organization-registration
 *
 * Rate limited by IP through the existing `publicFormLimiter`. Unauthenticated
 * by design — requiring an account to ask for an account is a loop.
 */
router.post('/organization-registration', publicFormLimiter, async (req: Request, res: Response) => {
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
    return res.status(409).json({ message: err.message });
  }
  if (err instanceof AssetRejected) {
    return res.status(400).json({ message: err.message });
  }
  console.error(`[organization-application] ${what} failed:`, err);
  return res.status(500).json({ message: 'Something went wrong. Please try again shortly.' });
}

/** Start an application. Returns the id and the only copy of the token. */
router.post('/organization-applications', publicFormLimiter, async (req: Request, res: Response) => {
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
router.get('/organization-applications/:id', publicFormLimiter, async (req: Request, res: Response) => {
  try {
    const found = await loadDraft(req.params.id, draftTokenOf(req));
    return res.json({ draft: draftView(found) });
  } catch (err) {
    return handleApplicationError(res, err, 'load');
  }
});

/** Save a step. Sections are replaced whole — see `saveDraft`. */
router.patch('/organization-applications/:id', publicFormLimiter, async (req: Request, res: Response) => {
  try {
    const updated = await saveDraft(
      req.params.id,
      draftTokenOf(req),
      {
        organization: req.body?.application?.organization,
        branding: req.body?.application?.branding,
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
  '/organization-applications/:id/assets',
  uploadLimiter,
  upload.single('file'),
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
      return res.status(201).json({ draft: draftView(updated) });
    } catch (err) {
      return handleApplicationError(res, err, 'asset upload');
    }
  },
);

/** Submit. Validates, stamps, and retires the token. */
router.post('/organization-applications/:id/submit', publicFormLimiter, async (req: Request, res: Response) => {
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
