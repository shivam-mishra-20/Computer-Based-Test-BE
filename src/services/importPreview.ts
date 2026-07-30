/**
 * In-memory review buffer for Smart Import.
 *
 * Extracted questions are held here — NOT persisted — until the teacher reviews
 * them and explicitly saves the ones they want (POST /ai/save-questions, which
 * writes the real Question bank). This is the deliberate "nothing hits the DB
 * until manual save" flow: extraction produces a buffer keyed by batchId that
 * GET /import-paper/batch/:batchId serves; the buffer self-expires after a review
 * window and is dropped once the teacher saves or discards.
 *
 * Per-process, like importProgress: the import runs in one worker and the poll
 * for the same batch normally lands on it too. If it doesn't (cluster/restart),
 * the buffer isn't found and the teacher re-imports — the accepted trade-off for
 * never touching the database before an explicit save.
 */
import { Types } from 'mongoose';

export interface PreviewQuestion {
  _id: string;
  text: string;
  type: string;
  subject?: string;
  topic?: string;
  difficulty?: string;
  options?: Array<{ text: string; isCorrect: boolean }>;
  correctAnswerText?: string;
  integerAnswer?: number;
  assertion?: string;
  reason?: string;
  assertionIsTrue?: boolean;
  reasonIsTrue?: boolean;
  reasonExplainsAssertion?: boolean;
  diagramUrl?: string;
  confidence: number;
  needsReview: boolean;
  status: 'extracted';
  questionNumber?: string | number;
  class?: string;
  board?: string;
  chapter?: string;
  section?: string;
  marks?: number;
}

interface Buffer {
  questions: PreviewQuestion[];
  at: number;
}

const store = new Map<string, Buffer>();
// Review window: how long extracted questions stay available for the teacher to
// review + save before the buffer is reclaimed.
const TTL_MS = 30 * 60 * 1000;

function key(batchId: unknown): string {
  return String(batchId);
}

/** Assign a synthetic id so the frontend can select/key rows without a DB write. */
export function newPreviewId(): string {
  return new Types.ObjectId().toString();
}

/** Hold a batch's extracted questions in memory for review. */
export function setPreview(batchId: unknown, questions: PreviewQuestion[]): void {
  store.set(key(batchId), { questions, at: Date.now() });
  sweep();
}

/** Fetch a batch's buffered questions (null if none / expired). */
export function getPreview(batchId: unknown): PreviewQuestion[] | null {
  const b = store.get(key(batchId));
  if (!b) return null;
  if (Date.now() - b.at > TTL_MS) { store.delete(key(batchId)); return null; }
  return b.questions;
}

/** Drop a batch's buffer (after save/discard). */
export function clearPreview(batchId: unknown): void {
  store.delete(key(batchId));
}

// Lazily evict expired buffers so a never-polled import can't leak memory.
function sweep(): void {
  const now = Date.now();
  for (const [k, b] of store) {
    if (now - b.at > TTL_MS) store.delete(k);
  }
}
