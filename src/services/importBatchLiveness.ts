/**
 * Liveness for Smart Import batches.
 *
 * An import runs in the process that accepted the upload (fire-and-forget from
 * QuestionImportService.startImport); its live progress is in that process's
 * memory and the batch record only learns the outcome at the end. A restart or
 * deploy mid-import therefore left the record at 'processing' for good, and
 * the page polled it forever.
 *
 * While an import runs, its process beats on the record (`heartbeatAt`). A
 * 'processing' batch whose beat is older than the stale window — and which this
 * process is not running — is reported failed with code INTERRUPTED the next
 * time anyone reads it. Records from before the beat existed fall back to
 * `updatedAt`, so batches already stuck in production are released too.
 *
 * AI generation jobs share the record type but keep their own liveness
 * (services/aiGenerationJobs); they are excluded here.
 */
import { ImportBatch } from '../models/ImportedQuestion';
import { refundForSubject } from '../core/subscriptions/usage';

const setting = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
export const importHeartbeatMs = () => setting('IMPORT_HEARTBEAT_MS', 20_000);
/** No beat for this long means the process running the import is gone. */
export const importStaleMs = () => setting('IMPORT_STALE_MS', 120_000);

export const INTERRUPTED_IMPORT_MESSAGE =
  'Processing was interrupted (the server restarted). Nothing was saved — please upload the file again.';

/**
 * Beat on a batch while its import runs. Call inside the uploading request,
 * so the writes carry that request's tenant context. Returns the stop function.
 */
export function startImportHeartbeat(batchId: unknown): () => void {
  const beat = setInterval(() => {
    ImportBatch.updateOne({ _id: batchId, status: 'processing' }, { $set: { heartbeatAt: new Date() } }).catch((error) =>
      console.error(`[Import ${String(batchId)}] heartbeat failed:`, (error as Error).message),
    );
  }, importHeartbeatMs());
  beat.unref?.();
  return () => clearInterval(beat);
}

/**
 * Mark the matching stale batches interrupted. `filter` narrows to the
 * caller's own batches (it is ANDed with the stale rule); `isLive` says
 * whether this process is still running a batch. Returns how many changed.
 */
export async function reconcileInterruptedImports(
  filter: Record<string, unknown>,
  isLive: (batchId: string) => boolean,
): Promise<number> {
  const cutoff = new Date(Date.now() - importStaleMs());
  const stale = await ImportBatch.find({
    $and: [
      filter,
      { kind: { $ne: 'ai-generate' } },
      { status: { $in: ['processing', 'uploading'] } },
      { $or: [{ heartbeatAt: { $lt: cutoff } }, { heartbeatAt: { $exists: false }, updatedAt: { $lt: cutoff } }] },
    ],
  })
    .select('_id status heartbeatAt')
    .lean();

  let changed = 0;
  for (const batch of stale) {
    if (isLive(String(batch._id))) continue;
    // Conditional on the beat we saw: a batch that beat in the meantime is alive.
    const result = await ImportBatch.updateOne(
      {
        _id: batch._id,
        status: batch.status,
        ...(batch.heartbeatAt ? { heartbeatAt: batch.heartbeatAt } : { heartbeatAt: { $exists: false } }),
      },
      {
        $set: {
          status: 'failed',
          errorCode: 'INTERRUPTED',
          errorMessage: INTERRUPTED_IMPORT_MESSAGE,
          processingCompleted: new Date(),
        },
        $push: { processingErrors: { error: INTERRUPTED_IMPORT_MESSAGE, timestamp: new Date() } },
      },
    );
    // An AI generation job interrupted here produced nothing: not counted
    // against the plan. A no-op for batches that reserved no usage.
    if (result.modifiedCount === 1) await refundForSubject('ImportBatch', batch._id, 'job interrupted');
    changed += result.modifiedCount;
  }
  return changed;
}
