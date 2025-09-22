import multer from 'multer';

const storage = multer.memoryStorage();
export const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req: any, file: any, cb: any) => {
    const okTypes = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
    ];
    if (okTypes.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Only PDF or image files are allowed'));
  },
});
