/**
 * Concurrency-limited batch runner with per-item retry. Used by batch
 * enhancement / classification / generation so a single failure never aborts
 * the whole job and throughput is bounded by NVIDIA_CONCURRENCY.
 */
import { aiConfig } from './config';

export interface BatchOptions {
  /** Max in-flight tasks. Defaults to NVIDIA_CONCURRENCY. */
  concurrency?: number;
  /** Retry attempts per item before recording a failure. Default 2. */
  retries?: number;
  /** Backoff base in ms between retries (exponential). Default 400. */
  backoffMs?: number;
  onProgress?: (completed: number, total: number) => void;
}

export interface BatchOutcome<R> {
  results: Array<R | undefined>;
  failures: Array<{ index: number; error: Error }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` over `items` with bounded concurrency. Each item is retried up to
 * `retries` times. Results preserve input order; failed items are `undefined`
 * in `results` and listed in `failures`.
 */
export async function runBatch<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options: BatchOptions = {},
): Promise<BatchOutcome<R>> {
  const concurrency = Math.max(
    1,
    options.concurrency ?? aiConfig.nvidia.concurrency,
  );
  const retries = Math.max(0, options.retries ?? 2);
  const backoffMs = options.backoffMs ?? 400;

  const results: Array<R | undefined> = new Array(items.length);
  const failures: Array<{ index: number; error: Error }> = [];
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      let lastErr: Error | undefined;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          results[i] = await fn(items[i], i);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          if (attempt < retries) await sleep(backoffMs * Math.pow(2, attempt));
        }
      }
      if (lastErr) failures.push({ index: i, error: lastErr });
      completed++;
      options.onProgress?.(completed, items.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length || 1) },
    () => worker(),
  );
  await Promise.all(workers);

  return { results, failures };
}
