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
import { publicFormLimiter } from '../../middlewares/rateLimiter';
import {
  RegistrationValidationError,
  publicView,
  submitRegistration,
} from '../../core/platform/registrations';

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

export default router;
