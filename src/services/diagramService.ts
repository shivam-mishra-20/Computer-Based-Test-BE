import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import sharp from 'sharp';
import { uploadToFirebase } from './firebaseService';

dotenv.config();

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

let genAI: GoogleGenerativeAI | null = null;

function getGemini() {
  if (!GOOGLE_API_KEY) return null;
  if (!genAI) genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
  return genAI;
}

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
  const g = getGemini();
  if (!g) {
    return {
      isRelevant: false,
      description: 'Gemini API not configured',
      altText: 'Diagram',
    };
  }

  try {
    const model = g.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    // Convert buffer to base64
    const base64Image = imageBuffer.toString('base64');
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

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType,
          data: base64Image,
        },
      },
      { text: prompt },
    ]);

    const responseText = result.response.text();
    let parsed: any;
    
    try {
      parsed = JSON.parse(responseText);
    } catch {
      const match = responseText.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Failed to parse diagram analysis');
      parsed = JSON.parse(match[0]);
    }

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
export async function extractDiagramsFromPdf(pdfBuffer: Buffer): Promise<ExtractedDiagram[]> {
  try {
    // Use pdf-parse to get page count and text
    const pdfParse = (await import('pdf-parse')).default as any;
    const pdfData = await pdfParse(pdfBuffer);
    
    const diagrams: ExtractedDiagram[] = [];
    
    // For PDF diagram extraction, we'll need to convert PDF pages to images
    // This is complex - we'll use Gemini's multimodal capabilities directly on the PDF
    const g = getGemini();
    if (!g) {
      console.warn('Gemini API not configured for diagram extraction');
      return [];
    }

    const model = g.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    const base64Pdf = pdfBuffer.toString('base64');

    // Ask Gemini to identify and describe all diagrams in the PDF
    const prompt = `Analyze this PDF document and identify ALL diagrams, charts, graphs, figures, illustrations, or mathematical diagrams.
For EACH diagram found, provide:
1. A detailed description of what the diagram shows
2. The approximate location/context (which question or section it relates to)
3. A concise alt text

Respond ONLY with valid JSON:
{
  "diagrams": [
    {
      "description": "detailed description",
      "questionContext": "related question text or section",
      "altText": "concise alt text"
    }
  ]
}`;

    try {
      const result = await model.generateContent([
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: base64Pdf,
          },
        },
        { text: prompt },
      ]);

      const responseText = result.response.text();
      let parsed: any;
      
      try {
        parsed = JSON.parse(responseText);
      } catch {
        const match = responseText.match(/\{[\s\S]*\}/);
        if (!match) {
          console.warn('Failed to parse diagram extraction response');
          return [];
        }
        parsed = JSON.parse(match[0]);
      }

      if (Array.isArray(parsed.diagrams)) {
        // Note: We're getting metadata but not actual image buffers from PDF
        // In production, you'd use a PDF-to-image library like pdf2pic or use Puppeteer
        for (const diag of parsed.diagrams) {
          diagrams.push({
            imageBuffer: Buffer.from(''), // Placeholder - would need actual extraction
            description: String(diag.description || ''),
            questionReference: String(diag.questionContext || ''),
            altText: String(diag.altText || 'Diagram'),
            isRelevant: true,
          });
        }
      }
    } catch (error) {
      console.error('Error extracting diagrams from PDF:', error);
    }

    return diagrams;
  } catch (error) {
    console.error('PDF diagram extraction failed:', error);
    return [];
  }
}

/**
 * Extracts diagrams from an image using Gemini Vision API
 * Can handle images containing multiple diagrams or question papers
 */
export async function extractDiagramsFromImage(imageBuffer: Buffer): Promise<ExtractedDiagram[]> {
  try {
    const g = getGemini();
    if (!g) {
      console.warn('Gemini API not configured for diagram extraction');
      return [];
    }

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
