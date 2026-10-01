/**
 * Tenant-safe object-storage paths.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * Two path families were tenant-unsafe by construction:
 *
 *   materials/{classLevel}/{subject}/{ts}_{name}
 *   study-resources/pdfs/{classLevel}/{subject}/{ts}_{name}
 *
 * `classLevel` and `subject` are TENANT values. Every institute teaching class
 * 11 Physics wrote into `materials/11/Physics/`, so two organizations shared a
 * folder — and with every object world-readable, a listing of that prefix was a
 * listing of both institutes' teaching material.
 *
 * Two more collided rather than leaked: `images/{ts}_{name}` and
 * `diagrams/{ts}_{name}` are unique only if no two uploads share a millisecond.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Every tenant-owned object lives under `organizations/{orgId}/`. Isolation
 * becomes a property of the PATH, which means:
 *
 *   - two tenants cannot collide, whatever they name their classes;
 *   - a per-organization export or purge is a prefix operation;
 *   - a Storage rule can be written that is actually enforceable, because the
 *     organization is in the path rather than implied by the caller;
 *   - and a path handed to this backend can be CHECKED against the caller's
 *     organization before anything is read.
 *
 * That last one is what makes a guessed path useless to an attacker.
 *
 * ── Legacy paths ────────────────────────────────────────────────────────────
 * Every object uploaded before this change lives outside `organizations/`.
 * Those files are not moved — moving production objects is a separate,
 * supervised migration — so `isLegacyPath()` exists and the read path treats
 * them as what they are: pre-existing public objects belonging to Org 001.
 */

/** Modules that own files. Kept closed so a typo cannot invent a namespace. */
export const STORAGE_MODULES = [
  'materials',
  'study-resources',
  'homework',
  'doubts',
  'ai-content',
  'diagrams',
  'images',
  'profile',
  'schedule',
  'imports',
  // An organization's own brand images (logo, splash) uploaded by its
  // administrators. Public assets, under the organization's prefix.
  'branding',
] as const;

export type StorageModule = (typeof STORAGE_MODULES)[number];

export const TENANT_PREFIX = 'organizations';

/**
 * Where a file goes when there is NO organization to attribute it to.
 *
 * ── Why a namespace of its own ──────────────────────────────────────────────
 * The deployment serving abhigyan-gurukul-app has no organization on most
 * requests, and `putTenantFile` refused those writes outright. The tempting
 * fixes are all worse than the problem:
 *
 *   organizations/unknown/…   parses as tenant-owned to `parseTenantPath`, so a
 *                             future ownership check would hand the file to
 *                             whichever organization is later called "unknown".
 *   organizations/{ORG_001}/… attributes one institute's files to another the
 *                             moment a second tenant exists.
 *   the old flat paths        `materials/11/Physics/…` is the collision this
 *                             whole scheme was built to remove.
 *
 * So an unattributed file says so, in the path. `ownerOrgIdOf()` returns null
 * for it — which is the truth — and `pathBelongsToOrg()` refuses it for every
 * organization, so no tenant can ever claim it by guessing a path.
 *
 * These objects are PRIVATE, exactly like tenant ones. "No organization" is a
 * statement about attribution, never about access.
 */
export const LEGACY_PREFIX = 'legacy';

/** Strip anything that could escape the intended prefix or confuse a bucket. */
export function sanitizeSegment(input: string): string {
  return String(input ?? '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'file';
}

export interface TenantPathInput {
  orgId: string;
  module: StorageModule;
  /** The owning record, when there is one — a homework id, a doubt id. */
  entityId?: string;
  /** Unique per object. An ObjectId or a uuid; never a timestamp alone. */
  fileId: string;
  fileName: string;
}

/**
 * `organizations/{orgId}/{module}/{entityId}/{fileId}_{fileName}`
 *
 * `fileId` is required and must be unique — a timestamp is not, which is how
 * `images/{ts}_{name}` could collide on a busy second.
 */
export function tenantFilePath(input: TenantPathInput): string {
  const parts = [
    TENANT_PREFIX,
    sanitizeSegment(input.orgId),
    sanitizeSegment(input.module),
    input.entityId ? sanitizeSegment(input.entityId) : null,
    `${sanitizeSegment(input.fileId)}_${sanitizeSegment(input.fileName)}`,
  ].filter(Boolean);
  return parts.join('/');
}

export interface LegacyPathInput {
  module: StorageModule;
  /** The owning record, when there is one — a homework id, a doubt id. */
  entityId?: string;
  /** Unique per object. An ObjectId or a uuid; never a timestamp alone. */
  fileId: string;
  fileName: string;
}

/**
 * `legacy/{module}/{entityId}/{fileId}_{fileName}`
 *
 * The same shape as a tenant path minus the organization segment, so the two
 * are comparable at a glance and a later migration is a prefix rewrite rather
 * than a re-derivation.
 */
export function legacyFilePath(input: LegacyPathInput): string {
  const parts = [
    LEGACY_PREFIX,
    sanitizeSegment(input.module),
    input.entityId ? sanitizeSegment(input.entityId) : null,
    `${sanitizeSegment(input.fileId)}_${sanitizeSegment(input.fileName)}`,
  ].filter(Boolean);
  return parts.join('/');
}

/** True for an object this backend stored under the no-organization namespace. */
export function isLegacyNamespacePath(path: string | null | undefined): boolean {
  if (!path) return false;
  return String(path).replace(/^\/+/, '').startsWith(`${LEGACY_PREFIX}/`);
}

export interface ParsedTenantPath {
  orgId: string;
  module: string;
  entityId?: string;
  fileName: string;
}

/** Read a tenant path back. Returns null for anything not under the prefix. */
export function parseTenantPath(path: string | null | undefined): ParsedTenantPath | null {
  if (!path) return null;
  const clean = String(path).replace(/^\/+/, '');
  const segments = clean.split('/').filter(Boolean);
  if (segments.length < 4) return null;
  if (segments[0] !== TENANT_PREFIX) return null;

  const [, orgId, module, ...rest] = segments;
  if (!orgId || !module || rest.length === 0) return null;

  return {
    orgId,
    module,
    entityId: rest.length > 1 ? rest[0] : undefined,
    fileName: rest[rest.length - 1],
  };
}

/**
 * True for an object uploaded before this scheme existed.
 *
 * Legacy objects are PUBLIC and cannot be made private without rewriting ACLs
 * on production storage, which is a supervised migration rather than a code
 * change. Treating them as a distinct case — rather than pretending they are
 * private — is what keeps the read path honest.
 */
export function isLegacyPath(path: string | null | undefined): boolean {
  if (!path) return false;
  // `legacy/` is NOT one of these. Those objects are written by this backend
  // today and are PRIVATE, so handing back a public storage.googleapis.com URL
  // for one would both fail and misrepresent it as world-readable. They are
  // signed like any other private object — see `isLegacyNamespacePath`.
  if (isLegacyNamespacePath(path)) return false;
  return !String(path).replace(/^\/+/, '').startsWith(`${TENANT_PREFIX}/`);
}

/**
 * May a caller in `orgId` touch `path`?
 *
 * A tenant path must name their organization. A legacy path is NOT accepted
 * here: it carries no organization, so it cannot be authorized on its own and
 * must be reached through a record that does carry one.
 */
export function pathBelongsToOrg(path: string | null | undefined, orgId: string | null | undefined): boolean {
  const parsed = parseTenantPath(path);
  if (!parsed) return false;
  if (!orgId) return false;
  return parsed.orgId === String(orgId);
}

/** A stored value that is already a full URL rather than a storage path. */
export function isAbsoluteUrl(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/**
 * The storage path inside a legacy public URL, if it is one of ours.
 *
 * `https://storage.googleapis.com/<bucket>/<path>` -> `<path>`. Used to give an
 * existing row an ownership check even though its stored value is a URL.
 */
export function storagePathFromPublicUrl(url: string, bucket: string): string | null {
  if (!isAbsoluteUrl(url)) return null;
  const prefixes = [
    `https://storage.googleapis.com/${bucket}/`,
    `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/`,
  ];
  for (const prefix of prefixes) {
    if (url.startsWith(prefix)) {
      const rest = url.slice(prefix.length).split('?')[0];
      return decodeURIComponent(rest);
    }
  }
  return null;
}

/**
 * Is `path` inside the folder of doubt `doubtId`, in any namespace a doubt
 * upload has ever been written to?
 *
 *   doubts/{doubtId}/…                                  bare — every
 *                                                       `/upload-url` path
 *                                                       before it moved onto
 *                                                       `resolveStorageTarget`
 *   legacy/doubts/{doubtId}[_{messageId}]/…             no organization
 *   organizations/{orgId}/doubts/{doubtId}[_{messageId}]/…
 *
 * It says nothing about the ORGANIZATION — callers still check that. What it
 * pins is that a path a client hands back for this doubt was issued for this
 * doubt, so a caller who may read one conversation cannot name a file from
 * another one and have it signed.
 */
export function isDoubtFolderPath(
  path: string | null | undefined,
  doubtId: string | null | undefined,
): boolean {
  if (!path || !doubtId || isAbsoluteUrl(path)) return false;
  const id = String(doubtId);
  if (!/^[a-f0-9]{24}$/i.test(id)) return false;

  const segments = String(path).replace(/^\/+/, '').split('/');
  const ownsFolder = (segment: string | undefined) =>
    segment === id || (!!segment && segment.startsWith(`${id}_`));

  // The folder segment must be followed by at least the file name.
  if (segments[0] === 'doubts') {
    return segments.length >= 3 && segments[1] === id;
  }
  if (segments[0] === LEGACY_PREFIX) {
    return segments.length >= 4 && segments[1] === 'doubts' && ownsFolder(segments[2]);
  }
  if (segments[0] === TENANT_PREFIX) {
    return segments.length >= 5 && segments[2] === 'doubts' && ownsFolder(segments[3]);
  }
  return false;
}

/**
 * A bare `doubts/{doubtId}/…` object — what `/upload-url` issued before it was
 * moved onto `resolveStorageTarget`.
 *
 * `isLegacyPath` calls these "pre-tenant public objects", and until P9A they
 * were: `save-file-metadata` made each one public. P9A removed that call
 * without moving the path, so every one uploaded since is PRIVATE under a name
 * the read path still believes is public. They have to be signed.
 */
export function isBareDoubtPath(
  path: string | null | undefined,
  doubtId: string | null | undefined,
): boolean {
  return isDoubtFolderPath(path, doubtId) && String(path).replace(/^\/+/, '').startsWith('doubts/');
}
