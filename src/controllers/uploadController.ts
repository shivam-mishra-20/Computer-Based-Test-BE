import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

// Handles single image upload (expects req.file from multer)
export const uploadImageCtrl = async (req: Request, res: Response) => {
  try {
  const file = (req as any).file as any;
    if (!file) return res.status(400).json({ message: 'Image file is required' });

  // Ensure uploads directory exists at process root (cwd)/uploads
  const uploadsDir = path.resolve(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Create a unique filename preserving extension
    const safeBase = (file.originalname || 'image').replace(/[^a-zA-Z0-9-_\.]/g, '_');
    const ts = Date.now();
  const fileName = `${ts}_${safeBase}`;
    const absPath = path.join(uploadsDir, fileName);

    // Write buffer to disk
    fs.writeFileSync(absPath, file.buffer);

    // Build public URL (served from /uploads)
  const base = process.env.PUBLIC_BASE_URL || '';
    const urlPath = `/uploads/${fileName}`;
    const publicUrl = base ? `${base.replace(/\/$/, '')}${urlPath}` : urlPath;

    res.status(201).json({ url: publicUrl, fileName });
  } catch (err: any) {
    res.status(500).json({ message: err.message || 'Failed to upload image' });
  }
};
