const path = require('path');
const { getUploaderInstance, FirebaseImageUploader } = require('./firebaseImageUploader');

/**
 * EPUB Diagram Extraction Service
 * Extracts images from EPUB zip structure and uploads to Firebase Storage
 */
class DiagramExtractorEPUB {
  constructor(zip, metadata) {
    this.zip = zip;
    this.metadata = metadata;
    this.uploader = getUploaderInstance();
    this.bookHash = FirebaseImageUploader.generateBookHash(metadata.title);
  }

  /**
   * Extract diagram from element and siblings
   * @param {CheerioStatic} $ - Cheerio instance
   * @param {CheerioElement} element - Current element
   * @param {Object} questionContext - Question context (number, chapter)
   * @returns {Promise<Object|null>} - Diagram metadata or null
   */
  async extractDiagram($, element, questionContext) {
    try {
      // Search for <img> tag in current element
      let img = $(element).find('img').first();
      
      // If not found, check next 3 siblings
      if (!img.length) {
        let sibling = $(element).next();
        for (let i = 0; i < 3 && sibling.length; i++) {
          img = sibling.find('img').first();
          if (img.length) break;
          sibling = sibling.next();
        }
      }

      // No image found
      if (!img.length) {
        return null;
      }

      // Get image source path
      const imgSrc = img.attr('src') || img.attr('data-src') || img.attr('xlink:href');
      if (!imgSrc) {
        return null;
      }

      // Extract image as buffer from EPUB zip
      const imageBuffer = await this.extractImageBuffer(imgSrc);
      if (!imageBuffer) {
        return null;
      }

      // Get extension from path
      const extension = path.extname(imgSrc).replace('.', '') || 'png';

      // Upload to Firebase Storage
      const diagramMetadata = await this.uploader.uploadImage(imageBuffer, {
        className: this.metadata.class || 'Unknown',
        subject: this.metadata.subject || 'General',
        bookHash: this.bookHash,
        chapter: questionContext.chapter || 'general',
        questionNumber: questionContext.questionNumber || '0',
        extension: extension
      });

      return diagramMetadata;

    } catch (error) {
      console.warn('[EPUB Diagram] Extraction failed:', error.message);
      return null;
    }
  }

  /**
   * Extract image buffer from EPUB zip
   * @param {string} imagePath - Relative image path
   * @returns {Promise<Buffer|null>} - Image buffer or null
   */
  async extractImageBuffer(imagePath) {
    try {
      if (!this.zip) {
        console.warn('[EPUB Diagram] Zip not available');
        return null;
      }

      // Normalize path (remove leading ./ or ../)
      let normalizedPath = imagePath.replace(/^\.\.?\//, '');

      // Try direct match first
      let imageFile = this.zip.file(normalizedPath);

      // If not found, try case-insensitive search
      if (!imageFile) {
        const allFiles = [];
        this.zip.forEach((relativePath, file) => {
          if (!file.dir && relativePath.toLowerCase().endsWith(normalizedPath.toLowerCase())) {
            allFiles.push(file);
          }
        });

        if (allFiles.length > 0) {
          imageFile = allFiles[0];
        }
      }

      // Still not found
      if (!imageFile) {
        console.warn(`[EPUB Diagram] Image not found in zip: ${imagePath}`);
        return null;
      }

      // Read as buffer (not base64)
      const imageBuffer = await imageFile.async('nodebuffer');
      return imageBuffer;

    } catch (error) {
      console.warn(`[EPUB Diagram] Failed to extract buffer for ${imagePath}:`, error.message);
      return null;
    }
  }

  /**
   * Extract multiple diagrams in parallel
   * @param {Array<Object>} diagramContexts - Array of { $, element, questionContext }
   * @returns {Promise<Array<Object|null>>}
   */
  async extractDiagramsInParallel(diagramContexts) {
    const extractionPromises = diagramContexts.map(({ $, element, questionContext }) =>
      this.extractDiagram($, element, questionContext).catch(error => {
        console.error('[EPUB Diagram] Parallel extraction error:', error.message);
        return null;
      })
    );

    const results = await Promise.allSettled(extractionPromises);
    return results.map(result => result.status === 'fulfilled' ? result.value : null);
  }

  /**
   * Batch upload images (used for bulk processing)
   * @param {Array<{buffer: Buffer, context: Object}>} images
   * @returns {Promise<Array<Object|null>>}
   */
  async batchUploadImages(images) {
    const uploadData = images.map(({ buffer, context }) => ({
      buffer,
      metadata: {
        className: this.metadata.class || 'Unknown',
        subject: this.metadata.subject || 'General',
        bookHash: this.bookHash,
        chapter: context.chapter || 'general',
        questionNumber: context.questionNumber || '0',
        extension: context.extension || 'png'
      }
    }));

    return await this.uploader.uploadImagesInParallel(uploadData);
  }
}

module.exports = DiagramExtractorEPUB;
