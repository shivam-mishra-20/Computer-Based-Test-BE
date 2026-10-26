/**
 * /api/admissions — the admissions pipeline (services/admissions).
 *
 * Public (no account; listed in core/tenancy/publicRoutes):
 *   GET    /seats                                    seats left this session, per class
 *   POST   /enquiry                                  every website enquiry form → lead
 *   GET    /application/:token                       the family's form + where it stands
 *   POST   /application/:token                       submit / update the application
 *   POST   /application/:token/documents             upload one document (multipart `file`, `kind`)
 *   DELETE /application/:token/documents/:documentId remove one before a decision
 *   GET    /registration/:registrationId             fee-page lookup: class and status only
 *
 *   :token is the 192-bit personal link staff send; only its hash is stored.
 *
 * Staff (`enquiries.manage`; creating a student login also needs
 * `students.create`):
 *   GET   /admin/meta                                current session, hold days, staff list
 *   GET   /admin/leads                               every channel; filters as /api/agts
 *   GET   /admin/leads/:leadId
 *   PATCH /admin/leads/:leadId/owner
 *   POST  /admin/leads/:leadId/application-link
 *   POST  /admin/leads/:leadId/offer
 *   POST  /admin/leads/:leadId/waitlist
 *   POST  /admin/leads/:leadId/enrol
 *   GET   /admin/leads/:leadId/documents/:documentId  short-lived signed link
 *   GET   /admin/seats?session=   PUT /admin/seats
 *   GET   /admin/funnel?session=
 *
 * Status, notes, follow-ups and the contact log are the existing
 * /api/agts/admin/leads/:leadId/* routes — they were never AGTS-specific.
 *
 * Every handler reads an explicit allow-list of body fields (admissionValidation).
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import User from '../../models/User';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { requireStaffPermission } from '../../middlewares/requirePermission';
import { admissionApplicationLimiter, admissionLookupLimiter, publicFormLimiter } from '../../middlewares/rateLimiter';
import { TenantContextMissing, requireTenantScope } from '../../core/tenancy';
import { preservingTenantContextOn } from '../../core/tenancy/requestContext';
import { StorageAccessDenied } from '../../core/storage/storageService';
import { sendUsageError } from '../../core/subscriptions/usage';
import { mayActOn } from '../../controllers/userController';
import { LeadNotFound, getLead, listLeads } from '../../services/agts/leadService';
import { parseLeadListQuery, parseNote } from '../../services/agts/agtsValidation';
import {
  AdmissionError,
  addApplicationDocument,
  assignOwner,
  documentUrl,
  funnel,
  getApplication,
  getSeatTable,
  issueApplicationLink,
  lookupRegistration,
  makeOffer,
  publicSeats,
  recordEnrolment,
  removeApplicationDocument,
  saveSeatTable,
  submitApplication,
  submitEnquiry,
  waitlistLead,
} from '../../services/admissions/admissionService';
import {
  AdmissionValidationError,
  currentAdmissionSession,
  isValidSession,
  parseApplicationToken,
  parseDocumentKind,
  parseEnrolment,
  parseOffer,
  parseOwner,
  parseRegistrationId,
  parseSeatRows,
  seatHoldDays,
  validateApplication,
  validateEnquiry,
} from '../../services/admissions/admissionValidation';

const router = Router();

const actorOf = (req: Request) => {
  const user = (req as Request & { user?: { id?: string; name?: string } }).user;
  return { id: user?.id, name: user?.name };
};

function fail(res: Response, err: unknown, fallback: string) {
  if (err instanceof AdmissionValidationError) {
    return res.status(400).json({ message: err.message, code: 'ADMISSION_VALIDATION', errors: err.errors });
  }
  if (err instanceof AdmissionError) {
    return res.status(err.status).json({ message: err.message, code: err.code, ...(err.errors ? { errors: err.errors } : {}) });
  }
  if (err instanceof LeadNotFound) return res.status(404).json({ message: err.message, code: err.code });
  if (err instanceof StorageAccessDenied) return res.status(403).json({ message: err.message, code: err.code });
  if (sendUsageError(res, err)) return;
  if (err instanceof TenantContextMissing) {
    return res.status(403).json({ message: 'No organization context for this request.', code: 'TENANT_REQUIRED' });
  }
  console.error(`[admissions] ${fallback}:`, (err as Error)?.message);
  return res.status(500).json({ message: fallback, code: 'ADMISSIONS_ERROR' });
}

// Applications and leads are personal; never let an intermediary cache them.
const noStore = (_req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/** A malformed token is answered like an expired one, before any parsing or lookup. */
const requireToken = (req: Request, res: Response, next: NextFunction) => {
  if (!parseApplicationToken(req.params.token)) {
    return res.status(404).json({
      message: 'This application link has expired or is no longer valid. Please ask the admissions team for a new one.',
      code: 'APPLICATION_LINK_INVALID',
    });
  }
  next();
};

const DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

// Wrapped so the tenant context survives the multipart parse (see
// middlewares/upload.ts) — an unwrapped multer is how storage writes lost
// their organization before.
const documentUpload = preservingTenantContextOn(
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4 },
    fileFilter: (_req, file, cb) => {
      if (DOCUMENT_TYPES.includes(file.mimetype)) return cb(null, true);
      return cb(new Error('Only PDF or image files (JPG, PNG, WEBP) can be uploaded'));
    },
  }),
);

const parseDocument = (req: Request, res: Response, next: NextFunction) =>
  documentUpload.single('file')(req, res, (err?: any) => {
    if (!err) return next();
    const tooBig = err?.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      message: tooBig ? 'Files must be 5 MB or smaller.' : err?.message || 'Upload failed',
      code: tooBig ? 'FILE_TOO_LARGE' : 'UPLOAD_INVALID',
      errors: { file: tooBig ? 'Files must be 5 MB or smaller' : err?.message || 'Upload failed' },
    });
  });

// ── Public ──────────────────────────────────────────────────────────────────

router.get('/seats', async (_req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await publicSeats());
  } catch (err) {
    fail(res, err, 'Failed to load seats');
  }
});

router.post('/enquiry', publicFormLimiter, noStore, async (req, res) => {
  try {
    // A filled honeypot is a bot. It gets the same answer a family does.
    if (typeof req.body?.website === 'string' && req.body.website.trim()) return res.status(201).json({ received: true });
    res.status(201).json(await submitEnquiry(validateEnquiry(req.body)));
  } catch (err) {
    fail(res, err, 'Failed to send your enquiry');
  }
});

router.get('/application/:token', admissionApplicationLimiter, noStore, requireToken, async (req, res) => {
  try {
    res.json(await getApplication(req.params.token));
  } catch (err) {
    fail(res, err, 'Failed to load the application');
  }
});

router.post('/application/:token', admissionApplicationLimiter, noStore, requireToken, async (req, res) => {
  try {
    const input = validateApplication(req.body);
    res.json(await submitApplication(req.params.token, input));
  } catch (err) {
    fail(res, err, 'Failed to save the application');
  }
});

router.post('/application/:token/documents', admissionApplicationLimiter, noStore, requireToken, parseDocument, async (req, res) => {
  try {
    const kind = parseDocumentKind(req.body?.kind);
    res.status(201).json({ documents: await addApplicationDocument(req.params.token, (req as any).file, kind) });
  } catch (err) {
    fail(res, err, 'Failed to upload the document');
  }
});

router.delete('/application/:token/documents/:documentId', admissionApplicationLimiter, noStore, requireToken, async (req, res) => {
  try {
    res.json({ documents: await removeApplicationDocument(req.params.token, String(req.params.documentId || '').slice(0, 24)) });
  } catch (err) {
    fail(res, err, 'Failed to remove the document');
  }
});

router.get('/registration/:registrationId', admissionLookupLimiter, noStore, async (req, res) => {
  try {
    res.json(await lookupRegistration(parseRegistrationId(req.params.registrationId)));
  } catch (err) {
    fail(res, err, 'Failed to look up the registration');
  }
});

// ── Staff ───────────────────────────────────────────────────────────────────

const staff = [authMiddleware, requireStaffPermission('enquiries.manage'), noStore];

const sessionOf = (value: unknown) => (isValidSession(value) ? String(value) : currentAdmissionSession());

router.get('/admin/meta', ...staff, async (_req, res) => {
  try {
    const people = await User.find({ ...requireTenantScope('admissions:staff'), role: { $nin: ['student', 'parent'] }, status: 'approved' })
      .select('name role')
      .sort({ name: 1 })
      .limit(200)
      .lean();
    res.json({
      session: currentAdmissionSession(),
      seatHoldDays: seatHoldDays(),
      staff: people.map((p: any) => ({ id: String(p._id), name: p.name, role: p.role })),
    });
  } catch (err) {
    fail(res, err, 'Failed to load the admissions settings');
  }
});

router.get('/admin/leads', ...staff, async (req, res) => {
  try {
    const query = parseLeadListQuery(req.query as Record<string, unknown>);
    if (!query.channel) query.channel = 'all';
    if (query.owner === 'me') query.owner = actorOf(req).id || 'none';
    res.json(await listLeads(query));
  } catch (err) {
    fail(res, err, 'Failed to load leads');
  }
});

router.get('/admin/leads/:leadId', ...staff, async (req, res) => {
  try {
    res.json(await getLead(req.params.leadId));
  } catch (err) {
    fail(res, err, 'Failed to load the lead');
  }
});

router.patch('/admin/leads/:leadId/owner', ...staff, async (req, res) => {
  try {
    res.json(await assignOwner(req.params.leadId, parseOwner(req.body?.owner), actorOf(req)));
  } catch (err) {
    fail(res, err, 'Failed to set the owner');
  }
});

router.post('/admin/leads/:leadId/application-link', ...staff, async (req, res) => {
  try {
    res.status(201).json(await issueApplicationLink(req.params.leadId, actorOf(req)));
  } catch (err) {
    fail(res, err, 'Failed to create the application link');
  }
});

router.post('/admin/leads/:leadId/offer', ...staff, async (req, res) => {
  try {
    res.json(await makeOffer(req.params.leadId, parseOffer(req.body), actorOf(req)));
  } catch (err) {
    fail(res, err, 'Failed to record the offer');
  }
});

router.post('/admin/leads/:leadId/waitlist', ...staff, async (req, res) => {
  try {
    res.json(await waitlistLead(req.params.leadId, parseNote(req.body?.note, 'note', false), actorOf(req)));
  } catch (err) {
    fail(res, err, 'Failed to waitlist the family');
  }
});

router.post('/admin/leads/:leadId/enrol', ...staff, async (req, res) => {
  try {
    const input = parseEnrolment(req.body);
    const mayCreate = input.account ? await mayActOn(req, 'student', 'create') : false;
    res.json(await recordEnrolment(req.params.leadId, input, actorOf(req), mayCreate));
  } catch (err) {
    fail(res, err, 'Failed to confirm the admission');
  }
});

router.get('/admin/leads/:leadId/documents/:documentId', ...staff, async (req, res) => {
  try {
    res.json(await documentUrl(req.params.leadId, String(req.params.documentId || '').slice(0, 24)));
  } catch (err) {
    fail(res, err, 'Failed to open the document');
  }
});

router.get('/admin/seats', ...staff, async (req, res) => {
  try {
    res.json(await getSeatTable(sessionOf(req.query.session)));
  } catch (err) {
    fail(res, err, 'Failed to load seats');
  }
});

router.put('/admin/seats', ...staff, async (req, res) => {
  try {
    const { session, rows } = parseSeatRows(req.body);
    res.json(await saveSeatTable(session, rows, actorOf(req)));
  } catch (err) {
    fail(res, err, 'Failed to save seats');
  }
});

router.get('/admin/funnel', ...staff, async (req, res) => {
  try {
    res.json(await funnel(sessionOf(req.query.session)));
  } catch (err) {
    fail(res, err, 'Failed to load the funnel');
  }
});

export default router;
