// PDF diagram extraction using pdf-lib for embedded images
// Note: Full page rendering requires additional setup with canvas/pdfjs-dist
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { getUploaderInstance, FirebaseImageUploader } = require('./firebaseImageUploader');

/**
 * PDF Diagram Extraction Service
 * Handles both text-based and scanned PDFs
 */
class DiagramExtractorPDF {
  constructor(metadata) {
    this.metadata = metadata;
    this.uploader = getUploaderInstance();
    this.bookHash = FirebaseImageUploader.generateBookHash(metadata.title);
    this.dpi = 300; // High quality for scanned PDFs
  }

  /**
   * Extract images from text-based PDF
   * @param {Buffer} pdfBuffer - PDF file buffer
   * @param {number} pageNumber - Page number (1-indexed)
   * @returns {Promise<Array<Buffer>>} - Array of image buffers
   */
  async extractEmbeddedImages(pdfBuffer, pageNumber) {
    try {
      // Use pdf-lib to extract embedded images
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      const pages = pdfDoc.getPages();
      
      if (pageNumber > pages.length || pageNumber < 1) {
        console.warn(`[PDF Diagram] Invalid page number: ${pageNumber}`);
        return [];
      }

      // For now, return empty array - embedded image extraction is complex
      // Will be implemented in a future update with proper image detection
      console.warn('[PDF Diagram] Embedded image extraction not yet fully implemented');
      return [];

    } catch (error) {
      console.error('[PDF Diagram] Failed to extract embedded images:', error.message);
      return [];
    }
  }

  /**
   * Render PDF page as image (for scanned PDFs)
   * @param {Buffer} pdfBuffer - PDF file buffer
   * @param {number} pageNumber - Page number (1-indexed)
   * @returns {Promise<Buffer|null>} - Rendered page as PNG buffer
   */
  async renderPageAsImage(pdfBuffer, pageNumber) {
    try {
      // Note: pdfjs-dist v4.x rendering in Node.js requires additional setup
      // For now, we'll return null and rely on embedded image extraction
      console.warn('[PDF Diagram] Page rendering not yet fully implemented for Node.js');
      console.warn('[PDF Diagram] Will attempt to extract embedded images instead');
      return null;

    } catch (error) {
      console.error('[PDF Diagram] Failed to render page:', error.message);
      return null;
    }
  }

  /**
   * Detect and crop diagram regions from rendered page
   * Uses simple bounding box detection
   * @param {Buffer} pageImageBuffer - Full page image buffer
   * @returns {Promise<Array<Buffer>>} - Array of cropped diagram buffers
   */
  async detectAndCropDiagrams(pageImageBuffer) {
    try {
      const image = sharp(pageImageBuffer);
      const metadata = await image.metadata();

      // Simple approach: Split page into regions
      // For production, use computer vision libraries like opencv4nodejs
      
      const regions = [];
      const regionHeight = Math.floor(metadata.height / 3); // Divide into 3 sections

      for (let i = 0; i < 3; i++) {
        const top = i * regionHeight;
        const croppedBuffer = await image
          .extract({
            left: 0,
            top: top,
            width: metadata.width,
            height: regionHeight
          })
          .toBuffer();

        regions.push(croppedBuffer);
      }

      return regions;

    } catch (error) {
      console.error('[PDF Diagram] Failed to crop diagrams:', error.message);
      return [];
    }
  }

  /**
   * Extract diagram from PDF page (auto-detect type)
   * @param {Buffer} pdfBuffer - PDF file buffer
   * @param {number} pageNumber - Page number
   * @param {Object} questionContext - Question context
   * @returns {Promise<Object|null>} - Diagram metadata or null
   */
  async extractDiagramFromPage(pdfBuffer, pageNumber, questionContext) {
    try {
      // Try embedded images first (text-based PDF)
      let imageBuffers = await this.extractEmbeddedImages(pdfBuffer, pageNumber);

      // If no embedded images, render page (scanned PDF)
      if (imageBuffers.length === 0) {
        const renderedPage = await this.renderPageAsImage(pdfBuffer, pageNumber);
        if (renderedPage) {
          // Optionally detect and crop diagram regions
          imageBuffers = [renderedPage];
          // imageBuffers = await this.detectAndCropDiagrams(renderedPage);
        }
      }

      // If still no images, return null
      if (imageBuffers.length === 0) {
        return null;
      }

      // Upload first valid image (can be extended to handle multiple)
      const imageBuffer = imageBuffers[0];

      const diagramMetadata = await this.uploader.uploadImage(imageBuffer, {
        className: this.metadata.class || 'Unknown',
        subject: this.metadata.subject || 'General',
        bookHash: this.bookHash,
        chapter: questionContext.chapter || `page_${pageNumber}`,
        questionNumber: questionContext.questionNumber || '0',
        extension: 'png'
      });

      return diagramMetadata;

    } catch (error) {
      console.warn('[PDF Diagram] Extraction failed:', error.message);
      return null;
    }
  }

  /**
   * Batch extract diagrams from multiple pages
   * @param {Buffer} pdfBuffer - PDF file buffer
   * @param {Array<{pageNumber: number, questionContext: Object}>} pages
   * @returns {Promise<Array<Object|null>>}
   */
  async extractDiagramsInParallel(pdfBuffer, pages) {
    const extractionPromises = pages.map(({ pageNumber, questionContext }) =>
      this.extractDiagramFromPage(pdfBuffer, pageNumber, questionContext).catch(error => {
        console.error('[PDF Diagram] Parallel extraction error:', error.message);
        return null;
      })
    );

    const results = await Promise.allSettled(extractionPromises);
    return results.map(result => result.status === 'fulfilled' ? result.value : null);
  }
}

module.exports = DiagramExtractorPDF;
