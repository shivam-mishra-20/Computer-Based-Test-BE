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
import { withoutTenantScope } from '../tenancy/context';
import { putApplicationAsset, signUnchecked } from '../storage/storageService';
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
  constructor(status: string) {
    super(
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

  const current = (found.application ?? { version: 1 }) as IOrganizationApplication;
  const SECTIONS: (keyof IOrganizationApplication)[] = [
    'organization', 'branding', 'academic', 'policy',
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

/* ══════════════════════════════════════════════════════════════════════════
   Assets
   ══════════════════════════════════════════════════════════════════════════ */

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
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
    submittedAt: registration.submittedAt,
    updatedAt: registration.updatedAt,
  };
}
