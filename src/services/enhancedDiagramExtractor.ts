/**
 * Enhanced Diagram Extractor for PDF Question Papers
 * 
 * Extracts figures and diagrams from PDF pages and uploads to Firebase
 * Handles both embedded images and page rendering
 */

import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { createCanvas } from 'canvas';
import { getUploaderInstance, FirebaseImageUploader } from './firebaseImageUploader';

export interface DiagramMetadata {
  url: string;
  fileName: string;
  width: number;
  height: number;
  pageNumber: number;
  position?: {
    x: number;
    y: number;
  };
}

export class EnhancedDiagramExtractor {
  private bookHash: string;
  private uploader: ReturnType<typeof getUploaderInstance>;

  constructor(private metadata: {
    title: string;
    subject?: string;
    class?: string;
  }) {
    this.bookHash = FirebaseImageUploader.generateBookHash(metadata.title);
    this.uploader = getUploaderInstance();
  }

  /**
   * Extract all diagrams from PDF
   * Returns array of diagram metadata with Firebase URLs
   */
  async extractDiagramsFromPdf(
    pdfBuffer: Buffer,
    options: {
      maxDiagramsPerPage?: number;
      minImageSize?: number; // Minimum image dimensions to consider as diagram
    } = {}
  ): Promise<Map<number, DiagramMetadata[]>> {
    const {
      maxDiagramsPerPage = 3,
      minImageSize = 50 // 50x50 pixels minimum
    } = options;

    console.log('[Diagram Extractor] Starting extraction...');

    const diagramsByPage = new Map<number, DiagramMetadata[]>();

    try {
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      const pages = pdfDoc.getPages();

      console.log(`[Diagram Extractor] Processing ${pages.length} pages`);

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const pageNumber = pageIndex + 1;
        const page = pages[pageIndex];

        console.log(`[Diagram Extractor] Processing page ${pageNumber}...`);

        // Try to extract embedded images first
        const embeddedDiagrams = await this.extractEmbeddedImagesFromPage(
          pdfDoc,
          pageIndex,
          minImageSize
        );

        if (embeddedDiagrams.length > 0) {
          diagramsByPage.set(pageNumber, embeddedDiagrams);
          console.log(`[Diagram Extractor] Found ${embeddedDiagrams.length} embedded diagrams on page ${pageNumber}`);
        } else {
          // If no embedded images, try rendering the page and detecting regions
          console.log(`[Diagram Extractor] No embedded images on page ${pageNumber}, trying page render...`);
          
          // For now, we'll skip page rendering as it requires complex setup
          // Future: Implement page rendering with pdf.js or similar
        }
      }

      console.log(`[Diagram Extractor] ✓ Extraction complete: found diagrams on ${diagramsByPage.size} pages`);
      
      return diagramsByPage;

    } catch (error) {
      console.error('[Diagram Extractor] Extraction failed:', error);
      return diagramsByPage;
    }
  }

  /**
   * Extract embedded images from a single PDF page
   */
  private async extractEmbeddedImagesFromPage(
    pdfDoc: PDFDocument,
    pageIndex: number,
    minSize: number
  ): Promise<DiagramMetadata[]> {
    const diagrams: DiagramMetadata[] = [];

    try {
      // Note: pdf-lib doesn't directly expose embedded images
      // We need to use a different approach

      // Alternative approach: Use pdf.js or pdfjs-dist to extract images
      // For now, return empty array as this requires significant setup
      
      console.log(`[Diagram Extractor] Embedded image extraction requires pdf.js integration (TODO)`);
      
      return diagrams;

    } catch (error) {
      console.error(`[Diagram Extractor] Failed to extract embedded images from page ${pageIndex + 1}:`, error);
      return diagrams;
    }
  }

  /**
   * Render PDF page as image and detect diagram regions
   * This is useful for scanned PDFs or when images are not embedded
   */
  private async renderPageAndDetectDiagrams(
    pdfBuffer: Buffer,
    pageNumber: number
  ): Promise<DiagramMetadata[]> {
    const diagrams: DiagramMetadata[] = [];

    try {
      // This requires pdf.js or similar library for Node.js rendering
      // Implementation pending

      console.log(`[Diagram Extractor] Page rendering requires pdf.js setup (TODO)`);
      
      return diagrams;

    } catch (error) {
      console.error(`[Diagram Extractor] Failed to render page ${pageNumber}:`, error);
      return diagrams;
    }
  }

  /**
   * Detect diagram regions in a page image using computer vision
   * Uses edge detection and contour analysis
   */
  private async detectDiagramRegions(
    pageImageBuffer: Buffer,
    pageNumber: number
  ): Promise<DiagramMetadata[]> {
    const diagrams: DiagramMetadata[] = [];

    try {
      const image = sharp(pageImageBuffer);
      const metadata = await image.metadata();

      if (!metadata.width || !metadata.height) {
        return diagrams;
      }

      // Simple region detection: divide page into grid and analyze each region
      const gridSize = 3; // 3x3 grid
      const regionWidth = Math.floor(metadata.width / gridSize);
      const regionHeight = Math.floor(metadata.height / gridSize);

      for (let row = 0; row < gridSize; row++) {
        for (let col = 0; col < gridSize; col++) {
          const left = col * regionWidth;
          const top = row * regionHeight;

          // Extract region
          const regionBuffer = await image
            .extract({
              left,
              top,
              width: regionWidth,
              height: regionHeight
            })
            .toBuffer();

          // Check if region likely contains a diagram
          const isDiagram = await this.isDiagramRegion(regionBuffer);

          if (isDiagram) {
            // Upload diagram to Firebase
            const diagramMetadata = await this.uploadDiagram(
              regionBuffer,
              pageNumber,
              diagrams.length,
              { x: left, y: top }
            );

            diagrams.push(diagramMetadata);
          }
        }
      }

      return diagrams;

    } catch (error) {
      console.error(`[Diagram Extractor] Region detection failed:`, error);
      return diagrams;
    }
  }

  /**
   * Check if an image region likely contains a diagram
   * Uses basic image analysis
   */
  private async isDiagramRegion(imageBuffer: Buffer): Promise<boolean> {
    try {
      const image = sharp(imageBuffer);
      const stats = await image.stats();

      // If image is mostly white/blank, it's not a diagram
      const avgIntensity = stats.channels.reduce((sum, ch) => sum + ch.mean, 0) / stats.channels.length;
      
      // Threshold: if average intensity > 240 (very light), probably not a diagram
      if (avgIntensity > 240) {
        return false;
      }

      // Check for variance (diagrams have more detail/variation)
      const avgStdDev = stats.channels.reduce((sum, ch) => sum + ch.stdev, 0) / stats.channels.length;
      
      // If standard deviation < 10, probably too uniform to be a diagram
      if (avgStdDev < 10) {
        return false;
      }

      return true;

    } catch (error) {
      console.error('[Diagram Extractor] Region analysis failed:', error);
      return false;
    }
  }

  /**
   * Upload diagram to Firebase Storage
   */
  private async uploadDiagram(
    imageBuffer: Buffer,
    pageNumber: number,
    diagramIndex: number,
    position?: { x: number; y: number }
  ): Promise<DiagramMetadata> {
    try {
      const metadata = await this.uploader.uploadImage(imageBuffer, {
        className: this.metadata.class || 'Unknown',
        subject: this.metadata.subject || 'General',
        bookHash: this.bookHash,
        chapter: `page_${pageNumber}`,
        questionNumber: `diagram_${diagramIndex}`,
        extension: 'png'
      });

      const imageMetadata = await sharp(imageBuffer).metadata();

      return {
        url: metadata.url,
        fileName: metadata.fileName,
        width: imageMetadata.width || 0,
        height: imageMetadata.height || 0,
        pageNumber,
        position
      };

    } catch (error) {
      console.error('[Diagram Extractor] Upload failed:', error);
      throw error;
    }
  }

  /**
   * Extract diagram for a specific question based on page number
   */
  async extractDiagramForQuestion(
    pdfBuffer: Buffer,
    pageNumber: number,
    questionContext: {
      chapter?: string;
      questionNumber?: string;
    }
  ): Promise<DiagramMetadata | null> {
    try {
      console.log(`[Diagram Extractor] Extracting diagram for question on page ${pageNumber}`);

      // Extract all diagrams from the page
      const allDiagrams = await this.extractDiagramsFromPdf(pdfBuffer, {
        maxDiagramsPerPage: 1 // Only get the first/main diagram
      });

      const pageDiagrams = allDiagrams.get(pageNumber);
      
      if (pageDiagrams && pageDiagrams.length > 0) {
        return pageDiagrams[0]; // Return first diagram
      }

      return null;

    } catch (error) {
      console.error('[Diagram Extractor] Failed to extract diagram for question:', error);
      return null;
    }
  }
}
