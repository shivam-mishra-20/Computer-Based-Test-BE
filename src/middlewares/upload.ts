import multer from 'multer';

const storage = multer.memoryStorage();

export const upload = multer({
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
