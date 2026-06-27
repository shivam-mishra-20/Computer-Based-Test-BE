/**
 * In-memory import progress tracker.
 *
 * Lets the (now background) import pipeline report live stage / counts while the
 * frontend polls GET /import-paper/batch/:batchId. The computed snapshot is
 * merged into that response — NO database schema change.
 *
 * State is per-process. With clustering, the import runs in one worker; the GET
 * for the same batch usually lands on a worker that may not hold the live state,
 * so the route falls back to the persisted batch counters (which we also update
 * periodically). For the common single-process dev/prod setup this is exact.
 */

export type ImportStage =
  | 'queued'
  | 'extracting'
  | 'parsing'
  | 'enhancing'
  | 'validating'
  | 'saving'
  | 'completed'
  | 'failed';

interface ProgressState {
  stage: ImportStage;
  processed: number;
  total: number;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

export interface ProgressSnapshot {
  stage: ImportStage;
  processed: number;
  total: number;
  processingProgress: number; // 0-100
  elapsedSeconds: number;
  questionsPerSecond: number;
  etaSeconds: number | null;
  error?: string;
}

const STAGE_LABEL: Record<ImportStage, string> = {
  queued: 'Queued',
  extracting: 'Extracting text',
  parsing: 'Parsing questions',
  enhancing: 'AI enhancement',
  validating: 'Validating',
  saving: 'Saving',
  completed: 'Completed',
  failed: 'Failed',
};

export function stageLabel(stage: ImportStage): string {
  return STAGE_LABEL[stage] || stage;
}

const store = new Map<string, ProgressState>();
// How long to keep a terminal (completed/failed) snapshot so the UI can read it.
const TERMINAL_TTL_MS = 5 * 60 * 1000;

function key(batchId: unknown): string {
  return String(batchId);
}

export function initProgress(batchId: unknown): void {
  const now = Date.now();
  store.set(key(batchId), { stage: 'queued', processed: 0, total: 0, startedAt: now, updatedAt: now });
}

export function setStage(batchId: unknown, stage: ImportStage): void {
  const s = store.get(key(batchId));
  if (!s) return;
  s.stage = stage;
  s.updatedAt = Date.now();
}

export function setTotal(batchId: unknown, total: number): void {
  const s = store.get(key(batchId));
  if (!s) return;
  s.total = Math.max(0, total | 0);
  s.updatedAt = Date.now();
}

export function incProcessed(batchId: unknown, n = 1): void {
  const s = store.get(key(batchId));
  if (!s) return;
  s.processed += n;
  if (s.total && s.processed > s.total) s.processed = s.total;
  s.updatedAt = Date.now();
}

export function setProcessed(batchId: unknown, processed: number): void {
  const s = store.get(key(batchId));
  if (!s) return;
  s.processed = Math.max(0, processed | 0);
  s.updatedAt = Date.now();
}

function scheduleClear(batchId: unknown): void {
  const k = key(batchId);
  setTimeout(() => store.delete(k), TERMINAL_TTL_MS).unref?.();
}

export function completeProgress(batchId: unknown): void {
  const s = store.get(key(batchId));
  if (!s) return;
  s.stage = 'completed';
  if (s.total) s.processed = s.total;
  s.updatedAt = Date.now();
  scheduleClear(batchId);
}

export function failProgress(batchId: unknown, error?: string): void {
  const s = store.get(key(batchId));
  if (!s) return;
  s.stage = 'failed';
  s.error = error;
  s.updatedAt = Date.now();
  scheduleClear(batchId);
}

export function clearProgress(batchId: unknown): void {
  store.delete(key(batchId));
}

/** Computed snapshot for the API response. Returns null if no live state. */
export function getProgress(batchId: unknown): ProgressSnapshot | null {
  const s = store.get(key(batchId));
  if (!s) return null;

  const elapsedMs = Math.max(1, s.updatedAt - s.startedAt);
  const elapsedSeconds = elapsedMs / 1000;
  const questionsPerSecond = s.processed > 0 ? s.processed / elapsedSeconds : 0;

  let processingProgress = 0;
  let etaSeconds: number | null = null;
  if (s.stage === 'completed') {
    processingProgress = 100;
    etaSeconds = 0;
  } else if (s.total > 0) {
    processingProgress = Math.min(99, Math.round((s.processed / s.total) * 100));
    const remaining = Math.max(0, s.total - s.processed);
    etaSeconds = questionsPerSecond > 0 ? Math.round(remaining / questionsPerSecond) : null;
  }

  return {
    stage: s.stage,
    processed: s.processed,
    total: s.total,
    processingProgress,
    elapsedSeconds: Math.round(elapsedSeconds),
    questionsPerSecond: Math.round(questionsPerSecond * 100) / 100,
    etaSeconds,
    error: s.error,
  };
}
