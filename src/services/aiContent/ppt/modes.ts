/**
 * The PPT feature has exactly TWO modes (v6 simplification):
 *
 *   'generate' — Create a brand-new professional deck from a prompt, PDF,
 *                image, or teacher notes. The AI intelligently EXPANDS the
 *                material (examples, practice, activities, applications) to
 *                fill the requested slide count.
 *   'redesign' — Rebuild an uploaded PPT/PDF as a completely redesigned
 *                professional deck while PRESERVING the lecture flow, topic
 *                sequence, definitions, formulae, examples, questions and
 *                homework verbatim in meaning, and stripping visual noise
 *                (photos, handwriting, logos, watermarks, scanner marks).
 *
 * The four v4/v5 modes map onto these; the API keeps accepting the legacy
 * strings (old clients, old queued jobs, old history rows all stay valid).
 */
import type { PptMode } from '../../aiOrchestrator/interfaces';

const LEGACY_MODE_MAP: Record<string, PptMode> = {
  generate: 'generate',
  redesign: 'redesign',
  // v4/v5 legacy strings:
  smart_generator: 'generate',
  hybrid: 'generate',
  modernizer: 'redesign',
  teacher_enhancement: 'redesign',
};

export function normalizePptMode(raw: unknown): PptMode {
  return LEGACY_MODE_MAP[String(raw || '').trim()] || 'generate';
}

export const PPT_MODES: PptMode[] = ['generate', 'redesign'];
