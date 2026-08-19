import { Request, Response } from 'express';
import { bucket } from '../config/firebase';
import FileMetadata from '../models/FileMetadata';
import { currentOrgId, tenantScope } from '../core/tenancy';
import { isLegacyPath, pathBelongsToOrg } from '../core/storage/paths';
import { putTenantFile, resolveFileUrl } from '../core/storage/storageService';
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

    // ── Tenant-safe and PRIVATE ─────────────────────────────────────────
    // A doubt attachment is a photograph of a student's homework. It was
    // uploaded under `doubts/{doubtId}/…` and then made WORLD-READABLE, so
    // anyone with the URL — or willing to guess an ObjectId — could read it.
    // It is now private under organizations/{orgId}/ and reachable only
    // through a signed URL minted for someone whose organization owns it.
    const stored = await putTenantFile({
      buffer: file.buffer,
      fileName: sanitizedFilename,
      contentType: file.mimetype,
      module: 'doubts',
      entityId: messageId ? `${doubtId}_${messageId}` : String(doubtId),
    });
    const storagePath = stored.storagePath;
    // The stored value is the PATH. `getFileSignedUrl` signs it per request.
    const publicUrl = storagePath;

    // Save metadata to MongoDB
    const fileMetadata = new FileMetadata({
      url: publicUrl,
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
        url: publicUrl,
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
/**
 * A URL for a file the caller is entitled to.
 *
 * ── What this used to do ────────────────────────────────────────────────────
 * Despite the name, it returned a PERMANENT PUBLIC URL with
 * `expiresIn: 'never'`, and it performed no ownership check at all — any
 * authenticated user of any organization could exchange any file id for a URL
 * that never expired. The lookup was `findById` with no tenant scope, so under
 * `warn` it resolved another institute's file quite happily.
 *
 * Now: scoped lookup, explicit organization check, and a real signed URL that
 * expires. Legacy objects still carry a public ACL that only a supervised
 * production migration can remove, so for those the honest answer is the
 * public URL — but it is only handed to someone whose organization owns the
 * record.
 */
export const getFileSignedUrl = async (req: AuthRequest, res: Response) => {
  try {
    const { fileId } = req.params;

    const orgId = currentOrgId();
    const fileMetadata = await FileMetadata.findOne({ _id: fileId, ...tenantScope() });

    if (!fileMetadata) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Defence in depth: the row was already scoped, and the PATH is checked
    // too, so a mis-stamped row cannot leak an object it does not own.
    if (!isLegacyPath(fileMetadata.storagePath) && !pathBelongsToOrg(fileMetadata.storagePath, orgId)) {
      return res.status(403).json({ error: 'This file does not belong to your organization.' });
    }

    const url = await resolveFileUrl(fileMetadata.storagePath, { orgId });
    if (!url) return res.status(404).json({ error: 'File not available' });

    return res.json({
      success: true,
      url,
      expiresIn: isLegacyPath(fileMetadata.storagePath) ? 'never (legacy public object)' : '7d',
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

    // Scoped: `findById` alone resolved another organization's file, and the
    // admin branch below would then have let THEIR admin delete it.
    const fileMetadata = await FileMetadata.findOne({ _id: fileId, ...tenantScope() });

    if (!fileMetadata) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Check if user is authorized (file owner or admin OF THIS ORGANIZATION —
    // the row is already scoped, so `role === 'admin'` can no longer reach
    // across the tenant boundary).
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

    // Use public URLs (no regeneration needed)
    const filesWithUrls = files.map((file: any) => {
      // Ensure URL is public URL format
      const publicUrl = file.url.startsWith('http') 
        ? file.url 
        : `https://storage.googleapis.com/${bucket.name}/${file.storagePath}`;
      return {
        ...file,
        url: publicUrl,
      };
    });

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
