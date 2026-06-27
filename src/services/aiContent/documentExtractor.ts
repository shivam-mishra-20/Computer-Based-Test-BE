/**
 * Turns an uploaded file into plain text for the generation model.
 *
 *   image (png/jpg/jpeg/webp) → Vision model (ai.visionText)
 *   pdf                        → pdf-parse text; falls back to Vision when sparse
 *   docx / pptx                → unzip (adm-zip) + pull text runs from the XML
 *
 * Prompt-only generation never calls this — the controller skips it when no
 * file is present, per spec.
 */
import AdmZip from 'adm-zip';
import {
  extractTextFromPdf,
  extractTextFromImage,
} from '../aiService';
import type { UploadFile } from './types';

export interface ExtractionResult {
  text: string;
  usedVision: boolean;
}

const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

function extOf(name: string): string {
  return (name.toLowerCase().split('.').pop() || '').trim();
}

/** Collect inner text of repeated XML tags, e.g. <w:t>…</w:t> or <a:t>…</a:t>. */
function textFromTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    if (t.trim()) out.push(t);
  }
  return out.join(' ');
}

function extractDocx(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) return '';
  const xml = entry.getData().toString('utf8');
  // <w:p> are paragraphs; join runs with spaces, paragraphs with newlines.
  return xml
    .split(/<w:p[ >]/)
    .map((p) => textFromTag(p, 'w:t'))
    .filter(Boolean)
    .join('\n')
    .slice(0, 200_000);
}

function extractPptx(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  const slides = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
  return slides
    .map((e, i) => {
      const xml = e.getData().toString('utf8');
      const text = textFromTag(xml, 'a:t');
      return text ? `--- Slide ${i + 1} ---\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 200_000);
}

export async function extractFromUpload(
  file: UploadFile,
): Promise<ExtractionResult> {
  const ext = extOf(file.originalname);
  const mime = (file.mimetype || '').toLowerCase();

  // Images → Vision model
  if (IMAGE_MIMES.has(mime) || ['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
    const text = await extractTextFromImage(file.buffer, true);
    return { text, usedVision: true };
  }

  // PDF → text; sparse/scanned PDFs fall back to Vision OCR of the first page
  if (mime === 'application/pdf' || ext === 'pdf') {
    let text = '';
    try {
      text = await extractTextFromPdf(file.buffer);
    } catch {
      text = '';
    }
    if (text.trim().length >= 80) {
      return { text, usedVision: false };
    }
    // Scanned PDF — Vision can read raw image bytes but not PDF bytes; surface a
    // clear, actionable error rather than generating from nothing.
    throw new Error(
      'This PDF appears to be scanned/has no selectable text. Please upload images of the pages or a text-based PDF.',
    );
  }

  // DOCX
  if (
    mime.includes('wordprocessingml') ||
    ext === 'docx'
  ) {
    const text = extractDocx(file.buffer);
    if (!text.trim()) throw new Error('Could not read any text from the DOCX file.');
    return { text, usedVision: false };
  }

  // PPTX
  if (
    mime.includes('presentationml') ||
    ext === 'pptx'
  ) {
    const text = extractPptx(file.buffer);
    if (!text.trim()) throw new Error('Could not read any text from the PPTX file.');
    return { text, usedVision: false };
  }

  throw new Error(`Unsupported file type: ${file.originalname}`);
}
