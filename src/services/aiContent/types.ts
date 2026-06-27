/**
 * Shared types for the AI Content Generator. Kept provider-agnostic — the
 * structured JSON shapes here are what the generation model must return and what
 * the renderers (pptxgenjs / paper HTML) consume.
 */

export type AiFeature = 'ppt' | 'question_paper' | 'notes' | 'worksheet';
export type AiSource = 'prompt' | 'pdf' | 'pptx' | 'docx' | 'image';

/** A single uploaded file (multer memoryStorage shape). */
export interface UploadFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size?: number;
}

// ── PPT ─────────────────────────────────────────────────────────────────────

export type SlideLayout =
  | 'title'
  | 'content'
  | 'objectives'
  | 'quiz'
  | 'summary';

export interface Slide {
  layout: SlideLayout;
  title: string;
  /** Bullet points / body lines. */
  bullets?: string[];
  /** Optional speaker notes. */
  notes?: string;
  /** Quiz slides: questions with options + answer. */
  quiz?: {
    question: string;
    options?: string[];
    answer?: string;
  }[];
}

export interface SlideDeck {
  title: string;
  subtitle?: string;
  theme?: string;
  slides: Slide[];
}

export interface PptOptions {
  prompt?: string;
  subject?: string;
  className?: string;
  board?: string;
  chapter?: string;
  language?: string;
  numSlides?: number;
  theme?: string;
  style?: string;
  audience?: string;
  includeQuiz?: boolean;
  includeObjectives?: boolean;
  includeSummary?: boolean;
}

// ── Question paper ──────────────────────────────────────────────────────────
// Shape intentionally mirrors models/Paper so we can reuse utils/paperExport.

export interface PaperQuestion {
  text: string;
  options?: { text: string }[];
  explanation?: string;
}

export interface PaperSection {
  title: string;
  instructions?: string;
  marksPerQuestion?: number;
  questions: PaperQuestion[];
}

export interface PaperJSON {
  examTitle: string;
  subject?: string;
  totalMarks?: number;
  meta?: { durationMins?: number };
  generalInstructions?: string[];
  sections: PaperSection[];
}

export interface PaperOptions {
  prompt?: string;
  subject?: string;
  className?: string;
  board?: string;
  chapter?: string;
  marks?: number;
  language?: string;
  /** e.g. { easy: 30, medium: 50, hard: 20 } — percentages. */
  difficulty?: { easy?: number; medium?: number; hard?: number };
  questionTypes?: string[];
}

/** Result of rendering: bytes + naming + mime for storage/download. */
export interface RenderedArtifact {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  ext: string;
}
