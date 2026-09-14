import multer from 'multer';
import { preservingTenantContextOn } from '../core/tenancy/requestContext';

const storage = multer.memoryStorage();

/**
 * Wrapped so the tenant context survives the multipart parse.
 *
 * multer consumes the request STREAM and resumes the chain from the socket's
 * async context, where the AsyncLocalStorage store no longer exists — so every
 * handler behind it ran with no organization, and object storage (the one
 * unconditionally fail-closed consumer) refused the write. See
 * core/tenancy/requestContext.ts for the measurement.
 */
const uploadBase = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req: any, file: any, cb: any) => {
    console.log('[Multer] Processing file:', {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    });

    const okTypes = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
    ];
    
    if (okTypes.includes(file.mimetype)) {
      console.log('[Multer] File accepted');
      return cb(null, true);
    }
    
    console.error('[Multer] File rejected - invalid type:', file.mimetype);
    return cb(new Error('Only PDF or image files are allowed'));
  },
});

export const upload = preservingTenantContextOn(uploadBase);
