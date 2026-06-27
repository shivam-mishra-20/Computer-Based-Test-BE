import sharp from 'sharp';
import { uploadToFirebase } from './firebaseService';
import { ai, parseObject } from '../ai';

export interface ExtractedDiagram {
  imageBuffer: Buffer;
  imageUrl?: string; // Firebase URL after upload
  description: string;
  questionReference?: string; // Question text this diagram belongs to
  altText: string;
  isRelevant: boolean; // Whether it's actually a diagram/chart vs decorative
}

export interface DiagramExtractionResult {
  diagrams: ExtractedDiagram[];
  textContent: string;
}

/**
 * Analyzes if an image buffer contains a diagram, chart, or illustration
 * using Gemini Vision API
 */
async function analyzeDiagramRelevance(imageBuffer: Buffer): Promise<{
  isRelevant: boolean;
  description: string;
  altText: string;
}> {
  try {
    const mimeType = await detectImageMimeType(imageBuffer);

    const prompt = `Analyze this image and determine:
1. Is this a diagram, chart, graph, illustration, or mathematical figure that would be relevant to an exam question? (not just decorative borders or headers)
2. If relevant, provide a detailed description of what it shows
3. Provide a concise alt text (max 100 chars)

Respond ONLY with valid JSON in this exact format:
{
  "isRelevant": boolean,
  "description": "detailed description if relevant, empty string if not",
  "altText": "concise description"
}`;

    const responseText = await ai.visionText(prompt, [{ data: imageBuffer, mimeType }], {
      label: 'diagram-relevance',
      maxTokens: 1024,
    });
    const parsed: any = parseObject(responseText);

    return {
      isRelevant: !!parsed.isRelevant,
      description: String(parsed.description || ''),
      altText: String(parsed.altText || 'Diagram').slice(0, 100),
    };
  } catch (error) {
    console.error('Error analyzing diagram relevance:', error);
    return {
      isRelevant: true, // Assume relevant if analysis fails
      description: 'Diagram or illustration',
      altText: 'Diagram',
    };
  }
}

/**
 * Detects MIME type from image buffer
 */
async function detectImageMimeType(buffer: Buffer): Promise<string> {
  try {
    const metadata = await sharp(buffer).metadata();
    const format = metadata.format;
    
    const mimeMap: Record<string, string> = {
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      svg: 'image/svg+xml',
    };
    
    return mimeMap[format || ''] || 'image/png';
  } catch {
    return 'image/png'; // Default fallback
  }
}

/**
 * Extracts diagrams from a PDF by converting pages to images
 * and using Gemini Vision to identify relevant diagrams
 */
export async function extractDiagramsFromPdf(_pdfBuffer: Buffer): Promise<ExtractedDiagram[]> {
  // The NVIDIA vision model operates on images, not raw PDF bytes, so automatic
  // PDF diagram extraction is not performed here. Diagrams from PDFs are attached
  // manually during review (consistent with the text-only extraction policy).
  // Per-image diagram analysis still works via extractDiagramsFromImage().
  console.warn('[Diagram] PDF diagram auto-extraction is disabled (vision model is image-only).');
  return [];
}

/**
 * Extracts diagrams from an image using Gemini Vision API
 * Can handle images containing multiple diagrams or question papers
 */
export async function extractDiagramsFromImage(imageBuffer: Buffer): Promise<ExtractedDiagram[]> {
  try {
    // First, check if this image contains relevant diagrams
    const analysis = await analyzeDiagramRelevance(imageBuffer);
    
    if (!analysis.isRelevant) {
      return [];
    }

    // Optimize image quality
    const optimizedBuffer = await sharp(imageBuffer)
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();

    const diagram: ExtractedDiagram = {
      imageBuffer: optimizedBuffer,
      description: analysis.description,
      altText: analysis.altText,
      isRelevant: true,
    };

    return [diagram];
  } catch (error) {
    console.error('Image diagram extraction failed:', error);
    return [];
  }
}

/**
 * Uploads extracted diagrams to Firebase and returns URLs
 */
export async function uploadDiagramsToFirebase(diagrams: ExtractedDiagram[]): Promise<ExtractedDiagram[]> {
  const updatedDiagrams: ExtractedDiagram[] = [];

  for (let i = 0; i < diagrams.length; i++) {
    const diagram = diagrams[i];
    
    if (diagram.imageBuffer.length === 0) {
      updatedDiagrams.push(diagram);
      continue;
    }

    try {
      const fileName = `diagrams/diagram_${Date.now()}_${i}.jpg`;
      const url = await uploadToFirebase(diagram.imageBuffer, fileName, 'image/jpeg');
      
      updatedDiagrams.push({
        ...diagram,
        imageUrl: url,
      });
    } catch (error) {
      console.error('Failed to upload diagram to Firebase:', error);
      updatedDiagrams.push(diagram);
    }
  }

  return updatedDiagrams;
}

/**
 * Main function to process a document and extract all diagrams
 */
export async function processDocumentForDiagrams(
  buffer: Buffer,
  type: 'pdf' | 'image',
  uploadToStorage = true
): Promise<ExtractedDiagram[]> {
  let diagrams: ExtractedDiagram[] = [];

  if (type === 'pdf') {
    diagrams = await extractDiagramsFromPdf(buffer);
  } else {
    diagrams = await extractDiagramsFromImage(buffer);
  }

  // Filter only relevant diagrams
  diagrams = diagrams.filter((d) => d.isRelevant);

  // Upload to Firebase if requested
  if (uploadToStorage && diagrams.length > 0) {
    diagrams = await uploadDiagramsToFirebase(diagrams);
  }

  return diagrams;
}
