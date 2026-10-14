/**
 * Review buffer for Smart Import.
 *
 * Extracted questions are held here — NOT written to any question bank — until
 * the teacher reviews them and explicitly saves the ones they want
 * (POST /ai/save-questions, which writes the real Question bank). Extraction
 * produces a buffer keyed by batchId that GET /import-paper/batch/:batchId
 * serves; it expires after a review window and goes with the batch if the
 * batch is deleted.
 *
 * ── Where it lives ──────────────────────────────────────────────────────────
 * On the batch's own ImportBatch document (`previewData`, gzipped JSON, with
 * `previewExpiresAt`), so the poll can land on any worker, and a restart or
 * deploy in the middle of a review no longer loses the teacher's extraction.
 * No new collection: the batch record already exists for every import, and
 * the field is `select: false`, so no ordinary batch read ever carries it.
 *
 * A per-process copy is kept as well (write-through) for the same-worker poll.
 * If the database write fails, the import still works exactly as before this
 * change — from that process's memory only.
 */
import { Types } from 'mongoose';
import { gunzipSync, gzipSync } from 'zlib';
import { ImportBatch } from '../models/ImportedQuestion';

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
  /** 'extracted' for Smart Import; 'pending' for AI-generated questions (services/aiGenerationJobs). */
  status: 'extracted' | 'pending';
  questionNumber?: string | number;
  class?: string;
  board?: string;
  chapter?: string;
  section?: string;
  marks?: number;
}

interface Held {
  questions: PreviewQuestion[];
  expiresAt: number;
}

const store = new Map<string, Held>();

/** Review window: how long extracted questions stay available to review and save. */
export function previewTtlMs(): number {
  const hours = Number(process.env.IMPORT_PREVIEW_TTL_HOURS || 24);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
}

// A batch document must stay well under MongoDB's 16 MB limit.
const MAX_STORED_BYTES = 8 * 1024 * 1024;

function key(batchId: unknown): string {
  return String(batchId);
}

/** Assign a synthetic id so the frontend can select/key rows without a DB write. */
export function newPreviewId(): string {
  return new Types.ObjectId().toString();
}

export function encodePreview(questions: PreviewQuestion[]): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(questions), 'utf8'));
}

export function decodePreview(
  data: Buffer | { buffer?: ArrayBufferLike } | null | undefined,
): PreviewQuestion[] | null {
  if (!data) return null;
  const bytes = Buffer.isBuffer(data)
    ? data
    : Buffer.from((data as { buffer: ArrayBufferLike }).buffer);
  const parsed = JSON.parse(gunzipSync(bytes).toString('utf8'));
  return Array.isArray(parsed) ? (parsed as PreviewQuestion[]) : null;
}

/** Hold a batch's extracted questions for review: in this process, and on the batch record. */
export async function setPreview(
  batchId: unknown,
  questions: PreviewQuestion[],
): Promise<void> {
  const expiresAt = Date.now() + previewTtlMs();
  store.set(key(batchId), { questions, expiresAt });
  sweepMemory();
  try {
    const data = encodePreview(questions);
    if (data.length > MAX_STORED_BYTES) {
      console.warn(
        `[ImportPreview] ${key(batchId)}: ${data.length} bytes is too large to store; kept in this process only`,
      );
      return;
    }
    await ImportBatch.updateOne(
      { _id: batchId },
      { $set: { previewData: data, previewExpiresAt: new Date(expiresAt) } },
    );
    await sweepStored();
  } catch (error) {
    console.error(
      `[ImportPreview] ${key(batchId)}: could not store the preview — kept in this process only:`,
      (error as Error).message,
    );
  }
}

/** A batch's buffered questions, from this process or the batch record; null when none or expired. */
export async function getPreview(
  batchId: unknown,
): Promise<PreviewQuestion[] | null> {
  const held = store.get(key(batchId));
  if (held) {
    if (Date.now() <= held.expiresAt) return held.questions;
    store.delete(key(batchId));
  }
  if (!Types.ObjectId.isValid(String(batchId))) return null;
  const batch = await ImportBatch.findById(batchId)
    .select('+previewData previewExpiresAt')
    .lean();
  if (!batch?.previewData) return null;
  if (
    !batch.previewExpiresAt ||
    new Date(batch.previewExpiresAt).getTime() < Date.now()
  ) {
    await clearPreview(batchId);
    return null;
  }
  try {
    const questions = decodePreview(batch.previewData as unknown as Buffer);
    if (questions)
      store.set(key(batchId), {
        questions,
        expiresAt: new Date(batch.previewExpiresAt).getTime(),
      });
    return questions;
  } catch (error) {
    console.error(
      `[ImportPreview] ${key(batchId)}: stored preview is unreadable:`,
      (error as Error).message,
    );
    return null;
  }
}

/** Drop a batch's buffer everywhere (after save/discard, or once expired). */
export async function clearPreview(batchId: unknown): Promise<void> {
  store.delete(key(batchId));
  if (!Types.ObjectId.isValid(String(batchId))) return;
  try {
    await ImportBatch.updateOne(
      { _id: batchId },
      { $unset: { previewData: 1, previewExpiresAt: 1 } },
    );
  } catch (error) {
    console.error(
      `[ImportPreview] ${key(batchId)}: could not clear the stored preview:`,
      (error as Error).message,
    );
  }
}

// Expired buffers are reclaimed lazily, so a never-opened import can't hold
// memory or storage beyond its window.
function sweepMemory(): void {
  const now = Date.now();
  for (const [k, held] of store) {
    if (now > held.expiresAt) store.delete(k);
  }
}

async function sweepStored(): Promise<void> {
  await ImportBatch.updateMany(
    { previewExpiresAt: { $lt: new Date() } },
    { $unset: { previewData: 1, previewExpiresAt: 1 } },
  );
}
