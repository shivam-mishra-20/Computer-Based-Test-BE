/**
 * Shared attachment type rules for upload endpoints.
 *
 * This mirrors the mobile app's `lib/uploadValidation.ts` so the backend accepts
 * exactly what the client is allowed to pick. The mobile DocumentPicker reports a
 * file as valid by mimetype OR extension, which means it can send:
 *   - HEIC/HEIF photos (the iPhone default camera format)
 *   - files whose picker returned no/generic mimetype (sent as application/octet-stream,
 *     e.g. a PDF chosen from Google Drive)
 *   - image/jpg (some Android devices report this instead of image/jpeg)
 *
 * A strict mimetype-only allowlist rejects all of the above with a 400, which the app
 * surfaces as "Failed to upload one or more attachments". Validating by extension as a
 * fallback keeps the two sides in agreement.
 */

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp']);
const PDF_EXTENSIONS = new Set(['pdf']);
const DOC_EXTENSIONS = new Set(['doc', 'docx']);

const EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const DOC_MIME_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export const getFileExtension = (fileName?: string | null): string => {
  if (!fileName) return '';
  const segments = fileName.split('.');
  if (segments.length < 2) return '';
  return (segments.pop() || '').toLowerCase();
};

const isImage = (mime: string, ext: string): boolean =>
  mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext);

const isPdf = (mime: string, ext: string): boolean =>
  mime === 'application/pdf' || PDF_EXTENSIONS.has(ext);

const isDoc = (mime: string, ext: string): boolean =>
  DOC_MIME_TYPES.has(mime) || DOC_EXTENSIONS.has(ext);

/** PDF or image — used for homework/doubt attachments. */
export const isSupportedAttachment = (
  mimeType?: string | null,
  fileName?: string | null,
): boolean => {
  const mime = (mimeType || '').toLowerCase();
  const ext = getFileExtension(fileName);
  return isImage(mime, ext) || isPdf(mime, ext);
};

/** PDF, image, or Word document — used for study materials. */
export const isSupportedMaterial = (
  mimeType?: string | null,
  fileName?: string | null,
): boolean => {
  const mime = (mimeType || '').toLowerCase();
  const ext = getFileExtension(fileName);
  return isImage(mime, ext) || isPdf(mime, ext) || isDoc(mime, ext);
};

/** PDF only — used for study resources. */
export const isSupportedPdf = (
  mimeType?: string | null,
  fileName?: string | null,
): boolean => {
  const mime = (mimeType || '').toLowerCase();
  const ext = getFileExtension(fileName);
  return isPdf(mime, ext);
};

/**
 * Resolve the content type to store/serve with. When the client reports a
 * missing or generic mimetype (e.g. application/octet-stream for a Drive PDF),
 * infer it from the extension so the stored object serves with the correct type
 * and renders in the app instead of downloading as a blob.
 */
export const resolveContentType = (
  mimeType?: string | null,
  fileName?: string | null,
): string => {
  const mime = (mimeType || '').toLowerCase();
  if (!GENERIC_MIME_TYPES.has(mime)) return mime;
  const ext = getFileExtension(fileName);
  return EXTENSION_MIME[ext] || mime || 'application/octet-stream';
};

type MulterFile = { mimetype: string; originalname: string };
type MulterFilterCb = (error: Error | null, acceptFile?: boolean) => void;

const makeFilter = (
  predicate: (mimeType: string, fileName: string) => boolean,
  rejectionMessage: string,
) => {
  return (_req: unknown, file: MulterFile, cb: MulterFilterCb): void => {
    if (predicate(file.mimetype, file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(rejectionMessage));
    }
  };
};

/** multer fileFilter: PDFs and images (by mimetype or extension). */
export const attachmentFileFilter = makeFilter(
  isSupportedAttachment,
  'Only PDF and image files are allowed',
);

/** multer fileFilter: PDFs, images, and Word documents. */
export const materialFileFilter = makeFilter(
  isSupportedMaterial,
  'Only PDF, image, and document files are allowed',
);

/** multer fileFilter: PDFs only (tolerates a generic mimetype with a .pdf name). */
export const pdfFileFilter = makeFilter(
  isSupportedPdf,
  'Only PDF files are allowed',
);
