import { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { requestIdOf } from './requestId';
import { serviceRealm } from '../core/realm/realm';

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

  const id = requestIdOf(req);
  // One JSON line per server error, for log search and alerting: which
  // request, where, and what — never the body, query string or headers.
  console.error(
    JSON.stringify({
      level: 'error',
      at: new Date().toISOString(),
      requestId: id,
      realm: serviceRealm(),
      method: req.method,
      path: req.path,
      status: 500,
      error: err?.name || 'Error',
      message: String(err?.message || '').slice(0, 300),
    }),
  );
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  return res.status(500).json({
    message: process.env.NODE_ENV === 'production' ? 'Server Error' : err?.message || 'Server Error',
    ...(id ? { requestId: id } : {}),
  });
};
