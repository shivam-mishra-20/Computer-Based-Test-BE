import multer from 'multer';
import { Request, Response, NextFunction } from 'express';

const storage = multer.memoryStorage();

function wrap(mw: any) {
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err: any) => {
      if (err) return next(err);
      next();
    });
  };
}

// Parse only fields (no files). Use this when you expect only text fields.
export const parseFormFields = wrap(multer({ storage }).none());

// Accept any files and fields; make middleware forgiving about mime types.
export const parseAnyFiles = wrap(multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } }).any());
