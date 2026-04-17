import { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';

const isHttpErrorStatus = (value: unknown): value is number => {
  return typeof value === 'number' && value >= 400 && value < 600;
};

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'Uploaded file is too large' });
    }
    return res.status(400).json({ message: err.message || 'Invalid upload request' });
  }

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request payload too large' });
  }

  if (err?.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'Origin not allowed by CORS policy' });
  }

  const status =
    (isHttpErrorStatus(err?.status) && err.status) ||
    (isHttpErrorStatus(err?.statusCode) && err.statusCode) ||
    500;

  if (status >= 400 && status < 500) {
    return res.status(status).json({ message: err?.message || 'Request failed' });
  }

  console.error(`[${req.method} ${req.originalUrl}]`, err);
  return res.status(500).json({
    message: process.env.NODE_ENV === 'production' ? 'Server Error' : err?.message || 'Server Error',
  });
};
