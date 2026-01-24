import { Request, Response } from 'express';
import { bucket } from '../config/firebase';
import FileMetadata from '../models/FileMetadata';
import mongoose from 'mongoose';

// Allowed MIME types
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];

// Max file size: 10 MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

interface AuthRequest extends Request {
  user?: {
    _id: string;
    role: string;
    id: string;
  };
}

/**
 * Upload file to Firebase Storage for doubts
 * POST /api/doubts/upload
 */
export const uploadDoubtFile = async (req: AuthRequest, res: Response) => {
  try {
    console.log('[Upload] Request received:', {
      hasFile: !!req.file,
      body: req.body,
      userId: req.user?._id || req.user?.id,
    });

    if (!req.file) {
      console.error('[Upload] No file in request');
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = req.file;
    const { doubtId, messageId } = req.body;

    console.log('[Upload] File details:', {
      filename: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      doubtId,
    });

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return res.status(422).json({
        error: 'Invalid file type',
        message: 'Only JPEG, PNG, WEBP images and PDF files are allowed',
      });
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return res.status(422).json({
        error: 'File too large',
        message: 'Maximum file size is 10 MB',
      });
    }

    // Validate required fields
    if (!doubtId) {
      return res.status(400).json({ error: 'doubtId is required' });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const fileExtension = file.originalname.split('.').pop();
    const sanitizedFilename = `${timestamp}_${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

    // Storage path structure: /doubts/{doubtId}/{messageId}/{timestamp}_{originalFileName}
    const storagePath = messageId
      ? `doubts/${doubtId}/${messageId}/${sanitizedFilename}`
      : `doubts/${doubtId}/${sanitizedFilename}`;

    // Upload to Firebase Storage
    const blob = bucket.file(storagePath);
    const blobStream = blob.createWriteStream({
      metadata: {
        contentType: file.mimetype,
        metadata: {
          uploadedBy: req.user?._id || req.user?.id,
          doubtId,
          messageId: messageId || '',
          originalName: file.originalname,
        },
      },
      resumable: false,
    });

    await new Promise<void>((resolve, reject) => {
      blobStream.on('error', (err) => {
        console.error('Firebase upload error:', err);
        reject(err);
      });

      blobStream.on('finish', () => {
        resolve();
      });

      blobStream.end(file.buffer);
    });

    // Generate signed URL (expires in 7 days)
    const [signedUrl] = await blob.getSignedUrl({
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // Save metadata to MongoDB
    const fileMetadata = new FileMetadata({
      url: signedUrl,
      storagePath,
      fileName: file.originalname,
      fileType: file.mimetype,
      fileSize: file.size,
      uploadedBy: new mongoose.Types.ObjectId(req.user?._id || req.user?.id),
      relatedDoubtId: new mongoose.Types.ObjectId(doubtId),
      relatedMessageId: messageId || undefined,
    });

    await fileMetadata.save();

    console.log('[Upload] Success:', {
      fileId: fileMetadata._id,
      fileName: file.originalname,
      storagePath,
    });

    return res.status(201).json({
      success: true,
      file: {
        id: fileMetadata._id,
        url: signedUrl,
        fileName: file.originalname,
        fileType: file.mimetype,
        fileSize: file.size,
        storagePath,
      },
    });
  } catch (error) {
    console.error('[Upload] Error:', error);
    return res.status(500).json({
      error: 'Failed to upload file',
      message: error instanceof Error ? error.message : 'Unknown error',
      details: process.env.NODE_ENV === 'development' ? error : undefined,
    });
  }
};

/**
 * Get fresh signed URL for an existing file
 * GET /api/doubts/files/:fileId/url
 */
export const getFileSignedUrl = async (req: AuthRequest, res: Response) => {
  try {
    const { fileId } = req.params;

    const fileMetadata = await FileMetadata.findById(fileId);

    if (!fileMetadata) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Generate new signed URL (expires in 15 minutes)
    const blob = bucket.file(fileMetadata.storagePath);
    const [signedUrl] = await blob.getSignedUrl({
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    });

    // Update URL in database
    fileMetadata.url = signedUrl;
    await fileMetadata.save();

    return res.json({
      success: true,
      url: signedUrl,
      expiresIn: '15 minutes',
    });
  } catch (error) {
    console.error('Error generating signed URL:', error);
    return res.status(500).json({
      error: 'Failed to generate signed URL',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Delete file from Firebase Storage
 * DELETE /api/doubts/files/:fileId
 */
export const deleteDoubtFile = async (req: AuthRequest, res: Response) => {
  try {
    const { fileId } = req.params;

    const fileMetadata = await FileMetadata.findById(fileId);

    if (!fileMetadata) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Check if user is authorized (file owner or admin)
    if (
      fileMetadata.uploadedBy.toString() !== req.user?._id &&
      fileMetadata.uploadedBy.toString() !== req.user?.id &&
      req.user?.role !== 'admin'
    ) {
      return res
        .status(403)
        .json({ error: 'Unauthorized to delete this file' });
    }

    // Delete from Firebase Storage
    const blob = bucket.file(fileMetadata.storagePath);
    await blob.delete();

    // Delete metadata from MongoDB
    await FileMetadata.findByIdAndDelete(fileId);

    return res.json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting file:', error);
    return res.status(500).json({
      error: 'Failed to delete file',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Get all files for a doubt
 * GET /api/doubts/:doubtId/files
 */
export const getDoubtFiles = async (req: AuthRequest, res: Response) => {
  try {
    const { doubtId } = req.params;

    const files = await FileMetadata.find({
      relatedDoubtId: new mongoose.Types.ObjectId(doubtId),
    })
      .populate('uploadedBy', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    // Regenerate signed URLs for all files
    const filesWithUrls = await Promise.all(
      files.map(async (file: any) => {
        try {
          const blob = bucket.file(file.storagePath);
          const [signedUrl] = await blob.getSignedUrl({
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000, // 15 minutes
          });
          return {
            ...file,
            url: signedUrl,
          };
        } catch (err) {
          console.error(`Error generating URL for file ${file._id}:`, err);
          return file;
        }
      }),
    );

    return res.json({
      success: true,
      files: filesWithUrls,
    });
  } catch (error) {
    console.error('Error fetching files:', error);
    return res.status(500).json({
      error: 'Failed to fetch files',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Generate Signed URL for direct upload (PUT)
 * POST /api/doubts/upload-url
 */
export const generateUploadUrl = async (req: AuthRequest, res: Response) => {
  try {
    const { fileName, fileType, doubtId, messageId } = req.body;
    const userId = req.user?._id || req.user?.id;

    if (!fileName || !fileType || !doubtId) {
      return res
        .status(400)
        .json({ error: 'fileName, fileType, and doubtId are required' });
    }

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(fileType)) {
      return res.status(422).json({
        error: 'Invalid file type',
        message: 'Only JPEG, PNG, WEBP images and PDF files are allowed',
      });
    }

    const timestamp = Date.now();
    const sanitizedFilename = `${timestamp}_${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

    // Storage path structure: /doubts/{doubtId}/{messageId}/{timestamp}_{originalFileName}
    const storagePath = messageId
      ? `doubts/${doubtId}/${messageId}/${sanitizedFilename}`
      : `doubts/${doubtId}/${sanitizedFilename}`;

    const blob = bucket.file(storagePath);

    // Generate Signed URL for PUT request
    const [signedUrl] = await blob.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
      contentType: fileType,
    });

    return res.json({
      success: true,
      uploadUrl: signedUrl,
      storagePath,
      fileName,
      fileType,
    });
  } catch (error) {
    console.error('Error generating upload URL:', error);
    return res.status(500).json({
      error: 'Failed to generate upload URL',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
