/**
 * The applicant's half of onboarding: drafts, assets, submission.
 *
 * ── Why a draft needs a token and not a login ───────────────────────────────
 * An institute filling in a nine-step application will not finish in one
 * sitting, and asking them to create an account first would mean building a
 * second identity system for people who are not yet customers — with password
 * reset, verification and recovery, all for a form.
 *
 * So a draft is addressed by its id and authorised by a high-entropy token
 * returned once at creation. The token is the only thing that grants access;
 * it is stored `select: false`, never listed, never logged, and compared in
 * constant time. Losing it means starting again, which is the correct trade
 * for a form nobody has paid for yet.
 *
 * ── What submission does and does not do ────────────────────────────────────
 * It validates, stamps `submittedAt`, and moves the row to `PENDING`. It does
 * not create an organization, a user, a role or an entitlement. Provisioning
 * happens when staff approve, through `onboardOrganization()` — see
 * `applicationProvisioning.ts` for the mapping.
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import bcrypt from 'bcrypt';
import { withoutTenantScope } from '../tenancy/context';
import { deleteStoragePrefix, putApplicationAsset, signUnchecked } from '../storage/storageService';
import { isValidHexColor } from './mobileBuildRules';
import {
  RegistrationValidationError,
  publicReference,
  validateRegistration,
  type RegistrationInput,
} from './registrations';
import type { IOrganizationRegistration } from '../../models/OrganizationRegistration';
import type { IOrganizationApplication } from '../../models/organizationApplication';

export class DraftNotFound extends Error {
  constructor() {
    super('No application found for that reference.');
    this.name = 'DraftNotFound';
  }
}

export class DraftNotEditable extends Error {
  /** Set when the client should act on the reason (APPLICATION_PAID: keep the draft). */
  code?: string;
  constructor(status: string, message?: string) {
    super(
      message ??
        `This application has already been submitted (status ${status}) and can no longer be edited. ` +
          'Contact the team if something needs to change.',
    );
    this.name = 'DraftNotEditable';
  }
}

export class AssetRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetRejected';
  }
}

/** A draft nobody touches is cleaned up rather than kept forever. */
const DRAFT_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

/* ══════════════════════════════════════════════════════════════════════════
   Token
   ══════════════════════════════════════════════════════════════════════════ */

function newDraftToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time comparison.
 *
 * `===` on a secret leaks its prefix through timing. The cost here is
 * negligible and the habit is the point — this is the only thing standing
 * between one applicant and another's application.
 */
function tokenMatches(supplied: string, stored: string): boolean {
  if (!supplied || !stored) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ══════════════════════════════════════════════════════════════════════════
   Drafts
   ══════════════════════════════════════════════════════════════════════════ */

/** Statuses whose application the applicant may still edit. */
const EDITABLE = new Set(['DRAFT', 'INFO_REQUESTED']);

function model() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../models/OrganizationRegistration').default;
}

export interface DraftHandle {
  registration: IOrganizationRegistration;
  /** Returned ONLY at creation. Never on a later read. */
  draftToken?: string;
}

/**
 * Start an application.
 *
 * Takes the same core contact fields the short registration form always did,
 * so the two entry points produce the same shape of row and the console queue
 * did not need to learn a second one.
 */
export async function createDraft(
  input: RegistrationInput,
  meta: { ip?: string },
): Promise<DraftHandle> {
  const clean = validateRegistration(input);
  const token = newDraftToken();

  return withoutTenantScope('application:create-draft', async () => {
    const created = await model().create({
      ...clean,
      source: 'WEB',
      submittedIp: meta.ip ? String(meta.ip).slice(0, 64) : undefined,
      status: 'DRAFT',
      draftToken: token,
      draftExpiresAt: new Date(Date.now() + DRAFT_TTL_MS),
      application: { version: 1 },
    });
    return { registration: created, draftToken: token };
  });
}

/** Load a draft, proving the caller holds its token. */
export async function loadDraft(id: string, token: string): Promise<IOrganizationRegistration> {
  return withoutTenantScope('application:load-draft', async () => {
    // `+draftToken` because the field is `select: false` — it is read here and
    // nowhere else.
    const found = await model().findById(id).select('+draftToken');
    if (!found || !tokenMatches(token, found.draftToken ?? '')) {
      // Same error for "no such id" and "wrong token". Distinguishing them
      // would turn this into an oracle for which application ids exist.
      throw new DraftNotFound();
    }
    return found;
  });
}

/** Load a draft the applicant may still change — the checkout opens only on one. */
export async function loadEditableDraft(id: string, token: string): Promise<IOrganizationRegistration> {
  const found = await loadDraft(id, token);
  if (!EDITABLE.has(found.status)) throw new DraftNotEditable(found.status);
  return found;
}

/**
 * Merge a patch into the application.
 *
 * Section-wise replace rather than deep merge: the form edits a whole step at
 * a time, and a deep merge makes deleting a row impossible — the old array
 * would survive underneath the new one.
 */
export async function saveDraft(
  id: string,
  token: string,
  patch: Partial<IOrganizationApplication>,
  core?: RegistrationInput,
): Promise<IOrganizationRegistration> {
  const found = await loadDraft(id, token);
  if (!EDITABLE.has(found.status)) throw new DraftNotEditable(found.status);

  // The contact block can still change while the form is open; it is validated
  // by exactly the same function the short form uses.
  if (core) {
    const clean = validateRegistration({
      organizationName: core.organizationName ?? found.organizationName,
      organizationType: core.organizationType ?? found.organizationType,
      contactName: core.contactName ?? found.contactName,
      designation: core.designation ?? found.designation,
      email: core.email ?? found.email,
      phone: core.phone ?? found.phone,
      city: core.city ?? found.city,
      state: core.state ?? found.state,
      country: core.country ?? found.country,
      estimatedStudents: core.estimatedStudents ?? found.estimatedStudents,
      estimatedTeachers: core.estimatedTeachers ?? found.estimatedTeachers,
      message: core.message ?? found.message,
    });
    Object.assign(found, clean);
  }

  // The plan the institute would like. A preference, never a grant (see
  // IApplicationCommercial) — but it must name a plan that is actually offered,
  // so a reviewer is never shown a typo or a retired plan as the applicant's
  // choice.
  if (patch.commercial && typeof patch.commercial === 'object') {
    const raw = (patch.commercial as { planPreference?: unknown }).planPreference;
    if (raw === undefined || raw === null || raw === '') {
      delete (patch.commercial as { planPreference?: unknown }).planPreference;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { listPublicPlans } = require('../subscriptions/catalogue');
      const offered = (await listPublicPlans()) as { key: string }[];
      const key = String(raw).trim().toLowerCase();
      if (!offered.some((p) => p.key === key)) {
        throw new RegistrationValidationError({ 'commercial.planPreference': 'Choose one of the plans offered.' });
      }
      (patch.commercial as { planPreference?: string }).planPreference = key;
    }
    // Monthly or yearly: the price the checkout charges depends on it.
    const interval = (patch.commercial as { billingInterval?: unknown }).billingInterval;
    if (interval === undefined || interval === null || interval === '') {
      delete (patch.commercial as { billingInterval?: unknown }).billingInterval;
    } else if (interval !== 'monthly' && interval !== 'annual') {
      throw new RegistrationValidationError({ 'commercial.billingInterval': 'Choose monthly or yearly billing.' });
    }
    // Once paid, the plan is what was paid for. A later edit of the choice is
    // overruled here rather than refused, so the rest of the step still saves.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { effectivePayment } = require('../billing/registrationPayments');
    const paid = await effectivePayment(found._id);
    if (paid) {
      Object.assign(patch.commercial as Record<string, unknown>, {
        planPreference: paid.planKey,
        billingInterval: paid.billingInterval,
      });
    }
  }

  const current = (found.application ?? { version: 1 }) as IOrganizationApplication;
  const SECTIONS: (keyof IOrganizationApplication)[] = [
    'organization', 'branding', 'appExperience', 'academic', 'policy',
    'modules', 'staff', 'integrations', 'commercial', 'completedSteps',
  ];
  for (const key of SECTIONS) {
    if (patch[key] !== undefined) (current as Record<string, unknown>)[key] = patch[key];
  }
  // `assets` is never patched from the client: it is written only by the
  // upload route, from what was actually stored. A client-supplied asset list
  // would let an applicant claim a storage path they do not own.
  current.version = 1;

  found.application = current;
  found.draftExpiresAt = new Date(Date.now() + DRAFT_TTL_MS);
  found.markModified('application');

  await withoutTenantScope('application:save-draft', async () => found.save());
  return found;
}

/* ══════════════════════════════════════════════════════════════════════════
   Submission
   ══════════════════════════════════════════════════════════════════════════ */

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The administrator provisioning creates: the one marked primary, else the first. */
export function primaryAdminOf(app: IOrganizationApplication | undefined): { name?: string; email?: string } | undefined {
  const admins = Array.isArray(app?.staff?.admins) ? app!.staff!.admins! : [];
  return admins.find((a) => a?.isPrimary) ?? admins[0];
}

/* ══════════════════════════════════════════════════════════════════════════
   The administrator's password
   ══════════════════════════════════════════════════════════════════════════ */

export const MIN_ADMIN_PASSWORD = 8;
const MAX_ADMIN_PASSWORD = 128;

/**
 * Set (or replace) the password the institute's administrator will sign in
 * with once the application is approved.
 *
 * Hashed here, immediately, with the same algorithm the User model uses; the
 * password itself is never written anywhere, never logged and never returned.
 * Its own call rather than part of a step save, so it is sent once — not
 * re-sent with every autosave of a draft that is otherwise plain data.
 */
export async function setAdminPassword(id: string, token: string, password: unknown): Promise<IOrganizationRegistration> {
  const value = typeof password === 'string' ? password : '';
  if (value.length < MIN_ADMIN_PASSWORD) {
    throw new RegistrationValidationError({ 'staff.password': `Use at least ${MIN_ADMIN_PASSWORD} characters.` });
  }
  if (value.length > MAX_ADMIN_PASSWORD) {
    throw new RegistrationValidationError({ 'staff.password': `Use at most ${MAX_ADMIN_PASSWORD} characters.` });
  }
  const found = await loadDraft(id, token);
  if (!EDITABLE.has(found.status)) throw new DraftNotEditable(found.status);

  const hash = await bcrypt.hash(value, 10);
  const setAt = new Date();
  await withoutTenantScope('application:admin-password', async () =>
    model().updateOne({ _id: found._id }, { $set: { adminPasswordHash: hash, adminPasswordSetAt: setAt } }),
  );
  found.adminPasswordSetAt = setAt;
  return found;
}

/**
 * What an applicant must supply before the form will submit.
 *
 * Deliberately shorter than what makes an organization fully configured. The
 * form's job is to collect what only the institute can answer; anything staff
 * can reasonably decide or fill in later is not worth blocking a submission
 * over. `assessApplication()` is the one that judges provisioning readiness,
 * and it is allowed to be stricter.
 */
export function validateApplicationForSubmission(
  registration: IOrganizationRegistration,
): Record<string, string> {
  const fields: Record<string, string> = {};
  const app = (registration.application ?? {}) as IOrganizationApplication;
  const branding = app.branding ?? {};
  const academic = app.academic ?? {};

  if (!text(registration.organizationName)) fields['organization.name'] = 'Institute name is required.';
  if (!text(registration.email)) fields['organization.email'] = 'Contact email is required.';
  if (!text(registration.phone)) fields['organization.phone'] = 'Contact mobile is required.';
  if (!text(registration.city)) fields['organization.city'] = 'City is required.';

  if (!text(branding.appName)) fields['branding.appName'] = 'App display name is required.';
  for (const [key, label] of [
    ['primaryColor', 'Primary colour'],
    ['secondaryColor', 'Secondary colour'],
    ['accentColor', 'Accent colour'],
  ] as const) {
    const value = text((branding as Record<string, unknown>)[key]);
    if (!value) fields[`branding.${key}`] = `${label} is required.`;
    else if (!isValidHexColor(value)) fields[`branding.${key}`] = `${label} must be a hex colour like #1D4ED8.`;
  }

  // The administrator signs in with the password chosen here as soon as the
  // institute is approved, so the account it belongs to must be complete.
  const admin = primaryAdminOf(app);
  if (!text(admin?.name)) fields['staff.name'] = 'Administrator name is required.';
  if (!EMAIL.test(text(admin?.email))) fields['staff.email'] = 'Enter a valid administrator email.';
  if (!registration.adminPasswordSetAt) fields['staff.password'] = 'Choose a password for the administrator.';

  const classLevels = Array.isArray(academic.classLevels) ? academic.classLevels : [];
  const subjects = Array.isArray(academic.subjects) ? academic.subjects : [];
  if (!classLevels.length) fields['academic.classLevels'] = 'Add at least one class or level.';
  if (!subjects.length) fields['academic.subjects'] = 'Add at least one subject.';

  // Duplicates are rejected at submission rather than silently collapsed:
  // `setOrganizationConfig` would insert both and the second would win, which
  // is a data loss nobody would notice.
  const dupeOf = (values: string[]) => {
    const seen = new Set<string>();
    return values.filter((v) => {
      const k = v.trim().toLowerCase();
      if (!k) return false;
      if (seen.has(k)) return true;
      seen.add(k);
      return false;
    });
  };
  const dupClasses = dupeOf(classLevels.map((c) => String(c.key ?? '')));
  if (dupClasses.length) fields['academic.classLevels'] = `Duplicate class keys: ${dupClasses.join(', ')}.`;
  const dupSubjects = dupeOf(subjects.map((s) => String(s.name ?? '')));
  if (dupSubjects.length) fields['academic.subjects'] = `Duplicate subjects: ${dupSubjects.join(', ')}.`;

  // A batch naming a class level that was never defined cannot be assigned to.
  const keys = new Set(classLevels.map((c) => String(c.key ?? '').toLowerCase()));
  const batches = Array.isArray(academic.batches) ? academic.batches : [];
  const orphans = batches
    .filter((b) => (b.classLevels ?? []).some((k) => !keys.has(String(k).toLowerCase())))
    .map((b) => String(b.name ?? '?'));
  if (orphans.length) {
    fields['academic.batches'] = `These batches use a class level that is not defined: ${orphans.join(', ')}.`;
  }

  return fields;
}

export async function submitApplication(
  id: string,
  token: string,
): Promise<IOrganizationRegistration> {
  const found = await loadDraft(id, token);
  if (!EDITABLE.has(found.status)) throw new DraftNotEditable(found.status);

  const fields = validateApplicationForSubmission(found);
  if (Object.keys(fields).length) throw new RegistrationValidationError(fields);

  // A plan with a price is paid for before the application is submitted
  // (core/billing/registrationPayments). Throws PaymentRequired otherwise.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { requirePaymentForSubmission } = require('../billing/registrationPayments');
  const paid = await requirePaymentForSubmission(found);
  if (paid) lockPaidPlan(found, paid);

  found.status = 'PENDING';
  found.submittedAt = new Date();
  // The token stops working the moment it is submitted: from here the
  // application belongs to the review queue, and an applicant editing it
  // underneath a reviewer is the race this prevents.
  found.draftToken = undefined;
  found.draftExpiresAt = undefined;

  await withoutTenantScope('application:submit', async () => found.save());
  return found;
}

/** The application names exactly the plan and interval that were paid for. */
function lockPaidPlan(found: IOrganizationRegistration, paid: { planKey: string; billingInterval: string }) {
  const app = (found.application ?? { version: 1 }) as IOrganizationApplication;
  app.commercial = { ...(app.commercial ?? {}), planPreference: paid.planKey, billingInterval: paid.billingInterval };
  found.application = app;
  found.markModified('application');
}

/**
 * Submit an application because its payment has just been verified — from
 * the applicant returning from Cashfree, the webhook, or staff checking the
 * order. No token: the verified payment is the authority, and the webhook
 * never had one.
 *
 * The same validation as `submitApplication` runs (it already ran before the
 * checkout was opened; this catches an edit made since). An application that
 * no longer passes stays a DRAFT — paid — and the applicant's own Submit
 * finishes it once the answers are fixed. Already submitted: nothing to do.
 */
export async function submitPaidApplication(id: string): Promise<{ submitted: boolean; status: string; fields?: Record<string, string> }> {
  const found = await withoutTenantScope('application:paid-load', async () => model().findById(id).select('+draftToken'));
  if (!found) throw new DraftNotFound();
  if (!EDITABLE.has(found.status)) return { submitted: false, status: found.status };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { effectivePayment } = require('../billing/registrationPayments');
  const paid = await effectivePayment(found._id);
  if (!paid) return { submitted: false, status: found.status };
  lockPaidPlan(found, paid);
  const fields = validateApplicationForSubmission(found);
  if (Object.keys(fields).length) {
    await withoutTenantScope('application:paid-lock', async () => found.save());
    return { submitted: false, status: found.status, fields };
  }
  found.status = 'PENDING';
  found.submittedAt = new Date();
  found.draftToken = undefined;
  found.draftExpiresAt = undefined;
  await withoutTenantScope('application:paid-submit', async () => found.save());
  return { submitted: true, status: found.status };
}

/**
 * Throw an unsubmitted draft away — the applicant's "start a new application".
 *
 * Only a DRAFT: once submitted the token is retired, and an application in the
 * review queue belongs to the reviewers. The uploaded files go first, from the
 * draft's own `applications/<id>/` prefix (a 24-hex id, which is what
 * `deleteStoragePrefix` insists on); a storage failure is logged and does not
 * keep the record alive — the person asked for a fresh start, and private
 * files nobody references cost a bucket entry, not a leak.
 */
export async function discardDraft(id: string, token: string): Promise<{ removedFiles: number }> {
  const found = await loadDraft(id, token);
  if (found.status !== 'DRAFT') throw new DraftNotEditable(found.status);
  // A paid application is kept: the payment belongs to it, and staff refund it
  // from the console if it is not wanted.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { effectivePayment } = require('../billing/registrationPayments');
  if (await effectivePayment(found._id)) {
    const refused = new DraftNotEditable('DRAFT', 'This application has been paid for, so it cannot be discarded. Contact the team if it is not wanted.');
    refused.code = 'APPLICATION_PAID';
    throw refused;
  }

  let removedFiles = 0;
  try {
    removedFiles = await deleteStoragePrefix(`applications/${String(found._id)}/`);
  } catch (err) {
    console.error('[application] could not delete draft files:', (err as Error)?.message);
  }
  await withoutTenantScope('application:discard-draft', async () => model().deleteOne({ _id: found._id, status: 'DRAFT' }));
  return { removedFiles };
}

/* ══════════════════════════════════════════════════════════════════════════
   Assets
   ══════════════════════════════════════════════════════════════════════════ */

/** Exported so `middlewares/uploadBrandAsset` enforces the same ceiling. */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const ALLOWED_KINDS = new Set(['logo', 'logoLight', 'logoDark', 'favicon']);
/**
 * SVG is accepted because a vector logo is what produces good native assets,
 * and it is exactly what institutes have. It is also an XML document that can
 * carry script, so it is stored private and never rendered inline by the
 * console — only downloaded or shown through a signed URL in an `<img>`, which
 * does not execute script.
 */
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
]);

/** Magic-byte check, because a client-supplied MIME type is a claim. */
function sniff(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  const head = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml';
  return null;
}

export async function storeAsset(
  id: string,
  token: string,
  file: { buffer: Buffer; originalname: string; mimetype: string },
  kind: string,
): Promise<IOrganizationRegistration> {
  const found = await loadDraft(id, token);
  if (!EDITABLE.has(found.status)) throw new DraftNotEditable(found.status);

  if (!ALLOWED_KINDS.has(kind)) throw new AssetRejected(`"${kind}" is not a brand asset slot.`);
  if (!file?.buffer?.length) throw new AssetRejected('The file was empty.');
  if (file.buffer.length > MAX_ASSET_BYTES) {
    throw new AssetRejected(`Images must be under ${MAX_ASSET_BYTES / 1024 / 1024} MB.`);
  }

  const sniffed = sniff(file.buffer);
  if (!sniffed || !ALLOWED_MIME.has(sniffed)) {
    throw new AssetRejected(
      'That does not look like a PNG, JPEG, WebP or SVG image. The file contents are checked, not its name.',
    );
  }

  const stored = await putApplicationAsset({
    buffer: file.buffer,
    applicationId: String(found._id),
    fileName: file.originalname || `${kind}.img`,
    contentType: sniffed,
    kind,
  });

  const app = (found.application ?? { version: 1 }) as IOrganizationApplication;
  const assets = (app.assets ?? []).filter((a) => a.kind !== kind);
  assets.push({
    assetId: stored.fileId,
    kind,
    filename: stored.fileName,
    mimeType: sniffed,
    bytes: stored.size,
    storagePath: stored.storagePath,
    uploadedAt: new Date(),
  });
  app.assets = assets;

  const brandKey = {
    logo: 'logoAssetId',
    logoLight: 'lightLogoAssetId',
    logoDark: 'darkLogoAssetId',
    favicon: 'faviconAssetId',
  }[kind] as string;
  app.branding = { ...(app.branding ?? {}), [brandKey]: stored.fileId };

  found.application = app;
  found.markModified('application');
  await withoutTenantScope('application:store-asset', async () => found.save());
  return found;
}

/**
 * A signed, expiring URL for one application asset.
 *
 * `signUnchecked` is correct here and named to make that visible: the caller
 * has already been authorized as platform staff by the route, and the file is
 * outside the tenant namespace so there is no owning organization to check
 * against.
 */
export async function signAsset(storagePath: string, ttlMs?: number): Promise<string> {
  return signUnchecked(storagePath, ttlMs);
}

/* ══════════════════════════════════════════════════════════════════════════
   What the applicant is allowed to see
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The applicant's own uploads, as something a browser can display.
 *
 * The stored record holds a storage PATH, not a URL, and the object is
 * private — an `<img src>` pointed at the raw path, or at a guessed public
 * googleapis URL, renders a broken image. So each asset is signed here, the
 * same way staff read them, and the applicant sees the file they just sent.
 *
 * `signUnchecked` is the right call: the route has already proved possession
 * of the draft token, and an application asset has no owning organization to
 * check against. Signing is best-effort per asset — one unreadable object
 * must not take down the step that shows the rest.
 *
 * The TTL is deliberately short. This is a preview inside an open form, not a
 * link anyone should be able to keep.
 */
const APPLICANT_ASSET_TTL_MS = 30 * 60 * 1000;

export async function applicantAssetViews(
  registration: IOrganizationRegistration,
): Promise<
  Array<{
    kind: string;
    filename: string;
    mimeType: string;
    bytes: number;
    uploadedAt?: Date;
    url: string | null;
  }>
> {
  const assets = registration.application?.assets ?? [];
  return Promise.all(
    assets.map(async (a) => ({
      kind: a.kind,
      filename: a.filename,
      mimeType: a.mimeType,
      bytes: a.bytes,
      uploadedAt: a.uploadedAt,
      url: await signAsset(a.storagePath, APPLICANT_ASSET_TTL_MS).catch(() => null),
    })),
  );
}

/**
 * The draft as the applicant may read it back.
 *
 * Everything staff-only is stripped: the IP, the dedupe key, review notes,
 * reviewer identity, the resulting orgId, and the draft token itself.
 */
export function draftView(registration: IOrganizationRegistration) {
  return {
    reference: publicReference(registration),
    id: String(registration._id),
    status: registration.status,
    organizationName: registration.organizationName,
    organizationType: registration.organizationType,
    contactName: registration.contactName,
    designation: registration.designation,
    email: registration.email,
    phone: registration.phone,
    city: registration.city,
    state: registration.state,
    country: registration.country,
    estimatedStudents: registration.estimatedStudents,
    estimatedTeachers: registration.estimatedTeachers,
    message: registration.message,
    application: registration.application ?? { version: 1 },
    // Whether a password was chosen — never the password or its hash.
    adminPasswordSet: Boolean(registration.adminPasswordSetAt),
    submittedAt: registration.submittedAt,
    updatedAt: registration.updatedAt,
  };
}
