const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');
const sharp = require('sharp');

/**
 * Firebase Storage Service for Image Upload
 * Handles deduplication, parallel uploads, and URL generation
 */
class FirebaseImageUploader {
  constructor() {
    this.bucket = null;
    this.uploadedHashes = new Map(); // In-memory cache for session
    this.maxConcurrentUploads = 6;
    this.retryAttempts = 2;
    this.retryDelay = 1000; // ms
  }

  /**
   * Initialize Firebase Admin SDK and get storage bucket
   */
  initialize() {
    if (this.bucket) return this.bucket;

    try {
      // Check if already initialized
      if (!admin.apps.length) {
        const serviceAccount = require('../../firebase-admin.json');
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          storageBucket: process.env.FIREBASE_STORAGE_BUCKET || serviceAccount.project_id + '.appspot.com'
        });
      }

      this.bucket = admin.storage().bucket();
      console.log('[Firebase] Storage initialized successfully');
      return this.bucket;
    } catch (error) {
      console.error('[Firebase] Initialization failed:', error.message);
      throw error;
    }
  }

  /**
   * Calculate SHA-256 hash of image buffer
   * @param {Buffer} buffer - Image buffer
   * @returns {string} - Hex hash
   */
  hashImage(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
  }

  /**
   * Generate deterministic storage path
   * @param {Object} params - Path parameters
   * @returns {string} - Storage path
   */
  generatePath({ className, subject, bookHash, chapter, questionNumber, imageHash, extension }) {
    // Clean parameters
    const cleanClass = (className || 'unknown').replace(/\s+/g, '_').toLowerCase();
    const cleanSubject = (subject || 'general').replace(/\s+/g, '_').toLowerCase();
    const cleanChapter = (chapter || 'general').replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
    const cleanBookHash = (bookHash || 'unknown').substring(0, 8);
    
    return `questions/${cleanClass}/${cleanSubject}/${cleanBookHash}/${cleanChapter}/q_${questionNumber}_${imageHash}.${extension}`;
  }

  /**
   * Get MIME type from extension
   * @param {string} extension - File extension
   * @returns {string} - MIME type
   */
  getMimeType(extension) {
    const ext = extension.toLowerCase().replace('.', '');
    const mimeTypes = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'svg': 'image/svg+xml',
      'webp': 'image/webp'
    };
    return mimeTypes[ext] || 'image/png';
  }

  /**
   * Get image dimensions using sharp
   * @param {Buffer} buffer - Image buffer
   * @returns {Promise<{width: number, height: number}>}
   */
  async getImageDimensions(buffer) {
    try {
      const metadata = await sharp(buffer).metadata();
      return {
        width: metadata.width,
        height: metadata.height
      };
    } catch (error) {
      console.warn('[Firebase] Failed to get image dimensions:', error.message);
      return { width: null, height: null };
    }
  }

  /**
   * Check if image already exists in Firebase Storage
   * @param {string} storagePath - Storage path
   * @returns {Promise<boolean>}
   */
  async fileExists(storagePath) {
    try {
      const file = this.bucket.file(storagePath);
      const [exists] = await file.exists();
      return exists;
    } catch (error) {
      return false;
    }
  }

  /**
   * Upload single image to Firebase Storage with retry logic
   * @param {Buffer} imageBuffer - Image buffer
   * @param {Object} metadata - Image metadata
   * @param {number} attempt - Current retry attempt
   * @returns {Promise<Object>} - Diagram metadata
   */
  async uploadImage(imageBuffer, metadata, attempt = 1) {
    const { className, subject, bookHash, chapter, questionNumber, extension } = metadata;

    try {
      // Initialize bucket if needed
      if (!this.bucket) {
        this.initialize();
      }

      // Calculate hash
      const imageHash = this.hashImage(imageBuffer);

      // Check session cache
      if (this.uploadedHashes.has(imageHash)) {
        console.log(`[Firebase] Image already uploaded in this session: ${imageHash}`);
        return this.uploadedHashes.get(imageHash);
      }

      // Generate storage path
      const storagePath = this.generatePath({
        className,
        subject,
        bookHash,
        chapter,
        questionNumber,
        imageHash,
        extension
      });

      // Check if file exists (deduplication across sessions)
      const exists = await this.fileExists(storagePath);
      if (exists) {
        console.log(`[Firebase] Image already exists: ${storagePath}`);
        const file = this.bucket.file(storagePath);
        const [url] = await file.getSignedUrl({
          action: 'read',
          expires: Date.now() + 1000 * 60 * 60 * 24 * 365 * 10 // 10 years
        });

        const diagramMetadata = {
          storage: 'firebase',
          path: storagePath,
          url: url,
          hash: imageHash
        };

        this.uploadedHashes.set(imageHash, diagramMetadata);
        return diagramMetadata;
      }

      // Get image dimensions
      const { width, height } = await this.getImageDimensions(imageBuffer);

      // Upload to Firebase Storage
      const file = this.bucket.file(storagePath);
      const mimeType = this.getMimeType(extension);

      await file.save(imageBuffer, {
        resumable: false,
        metadata: {
          contentType: mimeType,
          metadata: {
            questionNumber: questionNumber.toString(),
            hash: imageHash,
            uploadedAt: new Date().toISOString()
          }
        }
      });

      console.log(`[Firebase] Uploaded: ${storagePath}`);

      // Generate signed URL (10 years expiry)
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 1000 * 60 * 60 * 24 * 365 * 10
      });

      const diagramMetadata = {
        storage: 'firebase',
        path: storagePath,
        url: url,
        width,
        height,
        hash: imageHash
      };

      // Cache in session
      this.uploadedHashes.set(imageHash, diagramMetadata);

      return diagramMetadata;

    } catch (error) {
      // Retry logic
      if (attempt < this.retryAttempts) {
        console.warn(`[Firebase] Upload failed (attempt ${attempt}), retrying...`);
        await this.sleep(this.retryDelay * attempt);
        return this.uploadImage(imageBuffer, metadata, attempt + 1);
      }

      console.error(`[Firebase] Upload failed after ${attempt} attempts:`, error.message);
      return null;
    }
  }

  /**
   * Upload multiple images in parallel with concurrency limit
   * @param {Array<{buffer: Buffer, metadata: Object}>} images - Array of images with metadata
   * @returns {Promise<Array<Object|null>>} - Array of diagram metadata (null for failures)
   */
  async uploadImagesInParallel(images) {
    const results = [];

    // Process in chunks to limit concurrency
    for (let i = 0; i < images.length; i += this.maxConcurrentUploads) {
      const chunk = images.slice(i, i + this.maxConcurrentUploads);
      
      const chunkPromises = chunk.map(({ buffer, metadata }) =>
        this.uploadImage(buffer, metadata).catch(error => {
          console.error('[Firebase] Upload error:', error.message);
          return null;
        })
      );

      const chunkResults = await Promise.allSettled(chunkPromises);
      
      // Extract values from settled promises
      const chunkValues = chunkResults.map(result => 
        result.status === 'fulfilled' ? result.value : null
      );

      results.push(...chunkValues);
    }

    return results;
  }

  /**
   * Clear session cache
   */
  clearCache() {
    this.uploadedHashes.clear();
  }

  /**
   * Sleep utility for retry delays
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Generate book hash from title
   * @param {string} bookTitle - Book title
   * @returns {string} - Short hash
   */
  static generateBookHash(bookTitle) {
    return crypto.createHash('md5').update(bookTitle).digest('hex').substring(0, 8);
  }
}

// Singleton instance
let uploaderInstance = null;

function getUploaderInstance() {
  if (!uploaderInstance) {
    uploaderInstance = new FirebaseImageUploader();
  }
  return uploaderInstance;
}

module.exports = {
  FirebaseImageUploader,
  getUploaderInstance
};
