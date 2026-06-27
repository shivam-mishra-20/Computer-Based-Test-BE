/**
 * Multer config for the AI Content Generator. Separate from the existing
 * `upload` middleware (PDF/images only) so we don't change current behaviour.
 * Accepts the document sources the AI tools support: PDF, PPTX, DOCX, images.
 * Filters by extension as a fallback because mobile clients often send a generic
 * `application/octet-stream` mimetype (see upload-gotchas).
 */
import multer from 'multer';

const storage = multer.memoryStorage();

const OK_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
]);

const OK_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'pptx', 'docx']);

export const uploadAiContent = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req: any, file: any, cb: any) => {
    const ext = (file.originalname.toLowerCase().split('.').pop() || '').trim();
    if (OK_MIME.has(file.mimetype) || OK_EXT.has(ext)) {
      return cb(null, true);
    }
    console.error('[uploadAiContent] Rejected file:', file.originalname, file.mimetype);
    return cb(new Error('Unsupported file type. Allowed: PDF, PPTX, DOCX, PNG, JPG, JPEG, WEBP'));
  },
});
