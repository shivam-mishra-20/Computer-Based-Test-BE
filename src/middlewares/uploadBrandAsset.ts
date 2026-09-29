/**
 * Multer config for institute brand assets (logo, favicon) on the public
 * onboarding application.
 *
 * ── Why this is not the shared `upload` middleware ──────────────────────────
 * `upload` accepts PDF and raster images and is used by seventeen routes that
 * want exactly that. It does NOT accept `image/svg+xml`, while
 * `core/platform/applications.ts` explicitly does — its `ALLOWED_MIME` carries
 * a comment explaining why a vector logo is the one that produces good native
 * app icons, and the onboarding form tells applicants in so many words that an
 * SVG is the best thing to send. The result was that the recommended file was
 * refused by the middleware before the service that allows it ever ran.
 *
 * Widening the shared filter instead would let SVG — an XML document that can
 * carry script — into every other upload route on the platform, including ones
 * that publish what they store. The application asset path is safe for it
 * because those objects are stored private and are only ever read back through
 * a signed URL in an `<img>`, which does not execute script. So the narrower
 * allowance lives here, next to the one route that has earned it.
 *
 * ── Extension fallback ──────────────────────────────────────────────────────
 * Same reason as `uploadAiContent`: clients do not reliably label files.
 * Browsers hand `.svg` over as `image/svg+xml`, but some send an empty type,
 * and mobile pickers routinely send `application/octet-stream`. The claim is
 * not trusted either way — `storeAsset` sniffs the magic bytes and it is that
 * check, not this one, that decides what the file really is. This filter only
 * has to stop the obviously wrong thing early.
 *
 * ── Wrapped, like every multer instance in this directory ───────────────────
 * multer consumes the request STREAM and resumes the chain from the socket's
 * async context, where the AsyncLocalStorage store no longer exists. Any new
 * multer instance MUST go through `preservingTenantContextOn` or every handler
 * behind it runs with no organization. See core/tenancy/requestContext.ts.
 */
import multer from 'multer';
import { preservingTenantContextOn } from '../core/tenancy/requestContext';
import { MAX_ASSET_BYTES } from '../core/platform/applications';

const storage = multer.memoryStorage();

const OK_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/svg+xml',
]);

const OK_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg']);

/**
 * The decision, separated from the middleware so it can be asserted on
 * directly — multer does not expose its own fileFilter, and a rule that can
 * only be tested by uploading a file through HTTP to production storage does
 * not get tested. See scripts/safety/organization-application.e2e.test.ts.
 */
export function acceptsBrandAssetFile(originalname: string, mimetype: string): boolean {
  const ext = (String(originalname || '').toLowerCase().split('.').pop() || '').trim();
  return OK_MIME.has(String(mimetype || '').toLowerCase()) || OK_EXT.has(ext);
}

const uploadBrandAssetBase = multer({
  storage,
  // The same ceiling the service enforces and the form advertises, so a file
  // over it is refused before it is buffered rather than after.
  limits: { fileSize: MAX_ASSET_BYTES },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (acceptsBrandAssetFile(file.originalname, file.mimetype)) return cb(null, true);

    console.error('[uploadBrandAsset] Rejected file:', file.originalname, file.mimetype);
    // 400, not the 500 a bare Error would produce: sending a .docx as a logo
    // is a mistake the applicant can correct, and the message tells them how.
    // `errorHandler` honours `status` for 4xx.
    const err: Error & { status?: number } = new Error(
      'That file is not an image. Send a PNG, JPEG, WebP or SVG logo.',
    );
    err.status = 400;
    return cb(err);
  },
});

export const uploadBrandAsset = preservingTenantContextOn(uploadBrandAssetBase);
