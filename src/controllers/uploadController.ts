import { Request, Response } from 'express';
import { uploadToFirebase } from '../services/firebaseService';

// Handles single image upload (expects req.file from multer)
// Uploads to Firebase Storage and returns the public URL
export const uploadImageCtrl = async (req: Request, res: Response) => {
  try {
    const file = (req as any).file as any;
    if (!file) {
      return res.status(400).json({ message: 'Image file is required' });
    }

    // Create a unique filename preserving extension
    const safeBase = (file.originalname || 'image').replace(/[^a-zA-Z0-9-_\.]/g, '_');
    const ts = Date.now();
    const fileName = `images/${ts}_${safeBase}`;

    // Upload to Firebase Storage
    console.log(`Uploading image to Firebase: ${fileName}`);
    const publicUrl = await uploadToFirebase(
      file.buffer,
      fileName,
      file.mimetype || 'image/jpeg'
    );

    console.log(`Image uploaded successfully: ${publicUrl}`);
    res.status(201).json({ url: publicUrl, fileName });
  } catch (err: any) {
    console.error('Failed to upload image to Firebase:', err);
    res.status(500).json({ 
      message: err.message || 'Failed to upload image to Firebase Storage' 
    });
  }
};
