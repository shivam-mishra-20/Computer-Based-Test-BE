/**
 * Multer config for an organization's five native app images.
 *
 * PNG only, and only PNG: every one of these ends up in an Android manifest or
 * an Expo splash configuration that expects it, and a JPEG renamed `icon.png`
 * is accepted by every upload form on earth and rejected by `expo prebuild`
 * forty minutes into a build. The name is not trusted either way —
 * `mobileAssets.saveNativeAsset` sniffs the magic bytes and that check, not
 * this one, decides. This filter only stops the obviously wrong thing early.
 *
 * Wrapped, like every multer instance in this directory: multer consumes the
 * request stream and resumes the chain from the socket's async context, where
 * the tenant store no longer exists. See core/tenancy/requestContext.ts.
 */
import multer from 'multer';
import { preservingTenantContextOn } from '../core/tenancy/requestContext';
import { MAX_NATIVE_ASSET_BYTES } from '../core/platform/mobileAssets';

const storage = multer.memoryStorage();

const uploadNativeAssetBase = multer({
  storage,
  limits: { fileSize: MAX_NATIVE_ASSET_BYTES },
  fileFilter: (_req: any, file: any, cb: any) => {
    const ext = (file.originalname?.toLowerCase().split('.').pop() || '').trim();
    if (file.mimetype === 'image/png' || ext === 'png') return cb(null, true);

    console.error('[uploadNativeAsset] Rejected file:', file.originalname, file.mimetype);
    const err: Error & { status?: number } = new Error(
      'App icons and splash images must be PNG files.',
    );
    err.status = 400;
    return cb(err);
  },
});

export const uploadNativeAsset = preservingTenantContextOn(uploadNativeAssetBase);
