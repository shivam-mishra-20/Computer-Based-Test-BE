/**
 * Retriever — the composition point: index chunks (embed → store) and
 * retrieve (embed query → cosine top-K over the scope → rerank → results).
 */
import RagChunk from '../../models/RagChunk';
import { embedTexts } from './nvidiaEmbeddings';
import { rerank } from './nvidiaReranker';
import type { RagIndexableChunk, RetrievedChunk } from './types';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Embed and persist a scope's chunks (idempotent per scopeId+chunkId). */
export async function indexChunks(scopeId: string, chunks: RagIndexableChunk[]): Promise<number> {
  if (!chunks.length) return 0;
  const embeddings = await embedTexts(chunks.map((c) => c.text), 'passage');

  const ops = chunks.map((c, i) => ({
    updateOne: {
      filter: { scopeId, chunkId: c.chunkId },
      update: {
        $set: {
          scopeId,
          chunkId: c.chunkId,
          text: c.text,
          nodeIds: c.nodeIds,
          embedding: embeddings[i],
          meta: c.meta,
        },
      },
      upsert: true,
    },
  }));
  await RagChunk.bulkWrite(ops, { ordered: false });
  return chunks.length;
}

/** Top-K chunks for a query within a scope: cosine shortlist → reranker. */
export async function retrieveChunks(
  scopeId: string,
  query: string,
  topK = 6,
): Promise<RetrievedChunk[]> {
  const rows = await RagChunk.find({ scopeId }).lean();
  if (!rows.length) return [];

  const [queryEmbedding] = await embedTexts([query], 'query');
  const scored: RetrievedChunk[] = rows
    // Vectors from a previous embedding model have a different dimension
    // (e.g. 1024 vs 2048 after the 2026-07 EOL swap) — comparing them is
    // meaningless. Skip stale rows; the scope re-indexes on regeneration.
    .filter((r) => (r.embedding || []).length === queryEmbedding.length)
    .map((r) => ({
      chunkId: r.chunkId,
      text: r.text,
      nodeIds: r.nodeIds || [],
      meta: r.meta,
      score: cosine(queryEmbedding, r.embedding || []),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(topK * 2, topK)); // wider shortlist for the reranker

  try {
    const reranked = await rerank(query, scored);
    return reranked.slice(0, topK);
  } catch (err: any) {
    console.warn(`[rag] reranker unavailable (${err?.message}) — using cosine order`);
    return scored.slice(0, topK);
  }
}

/** Node ids grounding a query, deduped, retrieval-ranked. */
export async function retrieveNodeIds(scopeId: string, query: string, topK = 6): Promise<string[]> {
  const chunks = await retrieveChunks(scopeId, query, topK);
  const ids: string[] = [];
  for (const c of chunks) {
    for (const id of c.nodeIds) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export async function deleteScope(scopeId: string): Promise<void> {
  await RagChunk.deleteMany({ scopeId }).catch(() => {});
}
