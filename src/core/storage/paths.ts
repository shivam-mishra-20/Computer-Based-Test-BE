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
] as const;

export type StorageModule = (typeof STORAGE_MODULES)[number];

export const TENANT_PREFIX = 'organizations';

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
