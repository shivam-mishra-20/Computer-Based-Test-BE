/**
 * Tenant-safe object storage.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * `uploadToFirebase` called `file.save(…, { public: true })` and then
 * `makePublic()`, returning a permanent
 * `https://storage.googleapis.com/<bucket>/<path>` URL. Every homework
 * attachment, every study material, every profile image on the platform was
 * world-readable to anyone who had — or guessed — the URL. There was no signed
 * URL anywhere in the codebase.
 *
 * ── The model now ───────────────────────────────────────────────────────────
 *   upload    private object under `organizations/{orgId}/…`
 *   read      a SIGNED, expiring URL, minted only after the caller's
 *             organization has been checked against the path
 *   delete    same check, then the object and its metadata together
 *
 * The signature is what makes a guessed path useless: knowing
 * `organizations/<someone-else>/materials/…` does not let you read it, because
 * the URL that reads it can only be minted by this service, and this service
 * refuses to mint one for another organization.
 *
 * ── Why uploads are not made public "just for images" ───────────────────────
 * They were, and that is exactly how `materials/11/Physics/` ended up shared
 * between institutes. A file is either tenant-owned or it is not; "this one is
 * harmless" is a judgement that gets made once per module and wrong eventually.
 * Genuinely public assets — a marketing image — go through `putPublicAsset`,
 * which is a separate, explicit call with a separate, non-tenant path.
 */

import { currentOrgId } from '../tenancy';
import {
  isAbsoluteUrl,
  isLegacyPath,
  parseTenantPath,
  pathBelongsToOrg,
  sanitizeSegment,
  storagePathFromPublicUrl,
  tenantFilePath,
  type StorageModule,
} from './paths';

/** Seven days. Long enough that a URL handed to a client survives a session. */
export const DEFAULT_SIGNED_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class StorageAccessDenied extends Error {
  readonly code = 'STORAGE_ACCESS_DENIED';
  constructor(message = 'This file does not belong to your organization.') {
    super(message);
    this.name = 'StorageAccessDenied';
  }
}

function getBucket() {
  // Required lazily so this module is importable without Firebase configured —
  // the path logic above is pure and is unit-tested without any credential.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { initFirebaseAdmin } = require('../../services/firebaseService');
  initFirebaseAdmin();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const admin = require('firebase-admin');
  if (!admin.apps?.length) throw new Error('Firebase Admin SDK is not initialised');
  return admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET);
}

export function bucketName(): string {
  return process.env.FIREBASE_STORAGE_BUCKET || '';
}

/** A unique object id. Not a timestamp — two uploads can share a millisecond. */
function newFileId(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require('crypto');
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

export interface PutTenantFileInput {
  buffer: Buffer;
  fileName: string;
  contentType: string;
  module: StorageModule;
  entityId?: string;
  /** Defaults to the ambient tenant context. */
  orgId?: string | null;
}

export interface StoredFile {
  storagePath: string;
  fileId: string;
  fileName: string;
  contentType: string;
  size: number;
  orgId: string;
}

/**
 * Upload a tenant-owned file. PRIVATE — no public ACL is ever set.
 *
 * Refuses without an organization rather than falling back to a shared path:
 * an unattributed file is exactly the thing this whole change exists to
 * prevent, and a path with no owner cannot be authorized later.
 */
export async function putTenantFile(input: PutTenantFileInput): Promise<StoredFile> {
  const orgId = input.orgId ?? currentOrgId();
  if (!orgId) {
    throw new StorageAccessDenied(
      'Cannot store a tenant file without an organization context.',
    );
  }

  const fileId = newFileId();
  const storagePath = tenantFilePath({
    orgId: String(orgId),
    module: input.module,
    entityId: input.entityId,
    fileId,
    fileName: input.fileName,
  });

  const file = getBucket().file(storagePath);
  await file.save(input.buffer, {
    contentType: input.contentType,
    // No `public: true`, and no makePublic() call. This is the change.
    metadata: {
      contentType: input.contentType,
      metadata: {
        orgId: String(orgId),
        module: input.module,
        entityId: input.entityId ?? '',
        originalName: sanitizeSegment(input.fileName),
      },
    },
  });

  return {
    storagePath,
    fileId,
    fileName: input.fileName,
    contentType: input.contentType,
    size: input.buffer.length,
    orgId: String(orgId),
  };
}

/**
 * A signed, expiring URL for a tenant path.
 *
 * Checks ownership FIRST. The check is not an optimisation — it is the control,
 * and it runs before Firebase is contacted so it holds even when Storage is
 * unreachable.
 */
export async function signedUrlForTenantPath(
  storagePath: string,
  options: { ttlMs?: number; orgId?: string | null } = {},
): Promise<string> {
  const orgId = options.orgId ?? currentOrgId();
  if (!pathBelongsToOrg(storagePath, orgId)) throw new StorageAccessDenied();
  return signUnchecked(storagePath, options.ttlMs);
}

/**
 * Sign without an ownership check.
 *
 * For callers that have ALREADY authorized the file by another route — a
 * document they own that references it. Named so that using it by accident
 * looks wrong in review.
 */
export async function signUnchecked(
  storagePath: string,
  ttlMs: number = DEFAULT_SIGNED_URL_TTL_MS,
): Promise<string> {
  const [url] = await getBucket()
    .file(storagePath)
    .getSignedUrl({ action: 'read', expires: Date.now() + ttlMs, version: 'v4' });
  return url;
}

/**
 * Turn a stored value into something a client can fetch.
 *
 * ── The compatibility path ──────────────────────────────────────────────────
 * Every row written before this change stores a full public URL. Those objects
 * are still public in the bucket — they cannot be made private without
 * rewriting production ACLs — so returning them unchanged is both what works
 * and what is true. Rewriting them to signed URLs would imply a privacy the
 * object does not have.
 *
 * New rows store a PATH, and a path is signed on the way out.
 */
export async function resolveFileUrl(
  stored: string | null | undefined,
  options: { orgId?: string | null; ttlMs?: number } = {},
): Promise<string | null> {
  if (!stored) return null;

  // Legacy: an absolute URL to an already-public object. Unchanged.
  if (isAbsoluteUrl(stored)) return stored;

  // Legacy: a bare path from before the tenant prefix existed.
  if (isLegacyPath(stored)) {
    return `https://storage.googleapis.com/${bucketName()}/${stored}`;
  }

  try {
    return await signedUrlForTenantPath(stored, options);
  } catch (error) {
    if (error instanceof StorageAccessDenied) throw error;
    // A signing failure must not blank a whole list; the caller renders a
    // missing file rather than a broken page.
    console.error('[storage] failed to sign', stored, (error as Error).message);
    return null;
  }
}

/** Delete a tenant object after checking ownership. */
export async function deleteTenantFile(
  storagePath: string,
  options: { orgId?: string | null } = {},
): Promise<void> {
  const orgId = options.orgId ?? currentOrgId();
  if (!pathBelongsToOrg(storagePath, orgId)) throw new StorageAccessDenied();
  await getBucket().file(storagePath).delete({ ignoreNotFound: true } as never);
}

/**
 * The organization that owns a stored value, as far as it can be determined.
 *
 * A tenant path names its owner. A legacy URL or path does not — it predates
 * the scheme — so it returns null and the caller must authorize it through the
 * record that references it.
 */
export function ownerOrgIdOf(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const direct = parseTenantPath(stored);
  if (direct) return direct.orgId;
  const fromUrl = isAbsoluteUrl(stored) ? storagePathFromPublicUrl(stored, bucketName()) : null;
  const parsed = parseTenantPath(fromUrl);
  return parsed ? parsed.orgId : null;
}

/**
 * A tenant asset that must stay publicly fetchable by URL.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * Some objects are embedded in places that cannot carry a signed URL through
 * their whole life: a question diagram referenced from generated PDF HTML, a
 * profile image rendered in an `<img>` inside a client this change does not
 * touch. Making those private without converting every render path would break
 * legitimate Abhigyan access, which is the one thing this phase must not do.
 *
 * So they stay public — but they stop COLLIDING. `images/{ts}_{name}` and
 * `diagrams/{ts}_{name}` were unique only if no two uploads shared a
 * millisecond, and neither carried an organization at all. Under
 * `organizations/{orgId}/…` two tenants can no longer overwrite each other, a
 * per-organization purge becomes a prefix operation, and the object is
 * attributable.
 *
 * This is deliberately a SEPARATE function from `putTenantFile`. Making
 * something public should be a decision someone typed, visible in review — not
 * a default that a module inherits by accident, which is how
 * `materials/{class}/{subject}/` became world-readable in the first place.
 *
 * Converting these to signed URLs is tracked as remaining work; it needs the
 * render paths changed first.
 */
export async function putPublicTenantAsset(input: PutTenantFileInput): Promise<StoredFile & { url: string }> {
  const orgId = input.orgId ?? currentOrgId();
  const fileId = newFileId();

  // No organization (a pinned pre-migration deployment) keeps the legacy flat
  // path, so nothing changes for a deployment that has no tenants yet.
  const storagePath = orgId
    ? tenantFilePath({
        orgId: String(orgId),
        module: input.module,
        entityId: input.entityId,
        fileId,
        fileName: input.fileName,
      })
    : `${input.module}/${fileId}_${sanitizeSegment(input.fileName)}`;

  const bucket = getBucket();
  const file = bucket.file(storagePath);
  await file.save(input.buffer, {
    contentType: input.contentType,
    public: true,
    metadata: {
      contentType: input.contentType,
      metadata: { orgId: orgId ? String(orgId) : '', module: input.module },
    },
  });
  await file.makePublic();

  return {
    storagePath,
    fileId,
    fileName: input.fileName,
    contentType: input.contentType,
    size: input.buffer.length,
    orgId: orgId ? String(orgId) : '',
    url: `https://storage.googleapis.com/${bucket.name}/${storagePath}`,
  };
}
