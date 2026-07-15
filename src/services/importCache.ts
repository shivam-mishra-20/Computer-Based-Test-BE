/**
 * Import cache (Redis, reusing src/config/redis.ts) so the same PDF / identical
 * questions aren't reprocessed by the AI.
 *
 *  - File-level:  import:file:<sha256(buffer)>      → full enhanced result.
 *  - Block-level: import:q:<provider>:<sha256(text)> → enhanced result for one block.
 *
 * Redis failures degrade silently to a bounded in-memory Map (and never break an
 * import). Toggle with IMPORT_CACHE_ENABLED; TTL via IMPORT_CACHE_TTL_DAYS.
 */
import crypto from 'crypto';
import { redisClient } from '../config/redis';

export const importCacheEnabled =
  (process.env.IMPORT_CACHE_ENABLED ?? 'true').toLowerCase() !== 'false';

const TTL_SECONDS = Math.max(1, parseInt(process.env.IMPORT_CACHE_TTL_DAYS || '30', 10)) * 86400;

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ── bounded in-memory fallback ────────────────────────────────────────────────
const mem = new Map<string, { v: string; exp: number }>();
const MEM_MAX = 2000;

function memGet(k: string): string | null {
  const e = mem.get(k);
  if (!e) return null;
  if (e.exp < Date.now()) { mem.delete(k); return null; }
  return e.v;
}
function memSet(k: string, v: string): void {
  if (mem.size >= MEM_MAX) {
    const first = mem.keys().next().value;
    if (first) mem.delete(first);
  }
  mem.set(k, { v, exp: Date.now() + TTL_SECONDS * 1000 });
}

async function rawGet(key: string): Promise<string | null> {
  if (!importCacheEnabled) return null;
  try {
    const v = await redisClient.get(key);
    if (v != null) return v;
  } catch {
    /* fall through to memory */
  }
  return memGet(key);
}
async function rawSet(key: string, value: string): Promise<void> {
  if (!importCacheEnabled) return;
  try {
    await redisClient.set(key, value, 'EX', TTL_SECONDS);
    return;
  } catch {
    memSet(key, value);
  }
}

// ── file-level ────────────────────────────────────────────────────────────────
export async function getFileCache<T = any>(hash: string): Promise<T | null> {
  const raw = await rawGet(`import:file:${hash}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}
export async function setFileCache(hash: string, value: any): Promise<void> {
  try { await rawSet(`import:file:${hash}`, JSON.stringify(value)); } catch { /* ignore */ }
}

// ── block-level hooks (handed to the CJS enhancer) ────────────────────────────
export interface BlockCache {
  get(text: string): Promise<any | null>;
  set(text: string, value: any): Promise<void>;
}

export function makeBlockCache(provider: string): BlockCache {
  // BUMP THIS whenever enhancer prompts/logic change — the cache is keyed on
  // block-text hash only, so without a bump stale pre-fix results serve for the
  // 30d TTL. v2: fast model + gate-flag + /no_think. v3: option-value fix +
  // fidelity/keep-complete-question rules (Given: no longer skipped).
  // v4: explicit trailing-(Given:)-clause attachment example.
  // v5: quality model default + per-question parallel splitting (fidelity).
  // v6: verbatim-source stem (image path) + fast model (fidelity from source).
  // v7: keep pre-split verbatim blocks 1:1 (splitIntoChunks) + collapse stem.
  const ns = `import:q:v7:${provider || 'ollama'}:`;
  return {
    async get(text: string) {
      const raw = await rawGet(ns + sha256(text));
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async set(text: string, value: any) {
      try { await rawSet(ns + sha256(text), JSON.stringify(value)); } catch { /* ignore */ }
    },
  };
}
