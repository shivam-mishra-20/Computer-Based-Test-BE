const pdfjsLib = require('pdfjs-dist/legacy/build/pdf');
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
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      const pages = pdfDoc.getPages();
      
      if (pageNumber > pages.length || pageNumber < 1) {
        console.warn(`[PDF Diagram] Invalid page number: ${pageNumber}`);
        return [];
      }

      const page = pages[pageNumber - 1];
      const images = [];

      // Extract embedded images from page
      const pageDict = page.node;
      const resources = pageDict.get(pdfjsLib.PDFName.get('Resources'));
      
      if (resources && resources.has(pdfjsLib.PDFName.get('XObject'))) {
        const xObjects = resources.get(pdfjsLib.PDFName.get('XObject'));
        
        for (const [name, xObject] of Object.entries(xObjects)) {
          if (xObject.get(pdfjsLib.PDFName.get('Subtype')).name === 'Image') {
            // Extract image data
            const imageData = xObject.getStream();
            images.push(Buffer.from(imageData));
          }
        }
      }

      return images;

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
      // Load PDF document
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBuffer),
        useSystemFonts: true
      });

      const pdfDocument = await loadingTask.promise;

      if (pageNumber > pdfDocument.numPages || pageNumber < 1) {
        console.warn(`[PDF Diagram] Invalid page number: ${pageNumber}`);
        return null;
      }

      // Get page
      const page = await pdfDocument.getPage(pageNumber);

      // Calculate viewport at high DPI
      const scale = this.dpi / 72; // 72 DPI is default
      const viewport = page.getViewport({ scale });

      // Create canvas
      const canvas = require('canvas').createCanvas(
        viewport.width,
        viewport.height
      );
      const context = canvas.getContext('2d');

      // Render page to canvas
      const renderContext = {
        canvasContext: context,
        viewport: viewport
      };

      await page.render(renderContext).promise;

      // Convert canvas to buffer
      const imageBuffer = canvas.toBuffer('image/png');

      return imageBuffer;

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
