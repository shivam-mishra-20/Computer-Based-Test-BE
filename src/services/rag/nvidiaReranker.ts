/**
 * NVIDIA reranker client. The reranking NIMs live on ai.api.nvidia.com with
 * the model id baked into the invoke URL (dots become underscores), e.g.
 *   https://ai.api.nvidia.com/v1/retrieval/nvidia/llama-3_2-nv-rerankqa-1b-v2/reranking
 * NVIDIA_RERANK_URL overrides the whole URL if the pattern ever changes.
 *
 * Reranking is an ACCURACY refinement, never a dependency: any failure
 * returns the input order untouched (caller logs a warning).
 */
import type { RetrievedChunk } from './types';

const RERANK_MODEL = () => process.env.NVIDIA_MODEL_RERANK || 'nvidia/llama-3.2-nv-rerankqa-1b-v2';
const TIMEOUT_MS = () => Number(process.env.RERANK_TIMEOUT_MS || 45000);

function rerankUrl(): string {
  if (process.env.NVIDIA_RERANK_URL) return process.env.NVIDIA_RERANK_URL;
  const model = RERANK_MODEL();
  const [org, ...rest] = model.split('/');
  const slug = rest.join('/').replace(/\./g, '_');
  return `https://ai.api.nvidia.com/v1/retrieval/${org}/${slug}/reranking`;
}

export async function rerank(query: string, chunks: RetrievedChunk[]): Promise<RetrievedChunk[]> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey || chunks.length <= 1) return chunks;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
  const started = Date.now();
  try {
    const res = await fetch(rerankUrl(), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: RERANK_MODEL(),
        query: { text: query.slice(0, 2000) },
        passages: chunks.map((c) => ({ text: c.text.slice(0, 4000) })),
        truncate: 'END',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Rerank HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
    const json: any = await res.json();
    const rankings: any[] = Array.isArray(json?.rankings) ? json.rankings : [];
    if (!rankings.length) throw new Error('Rerank returned no rankings');

    const ordered: RetrievedChunk[] = [];
    for (const r of rankings) {
      const idx = Number(r?.index);
      if (Number.isFinite(idx) && chunks[idx]) {
        ordered.push({ ...chunks[idx], score: Number(r?.logit ?? chunks[idx].score) });
      }
    }
    console.log(`[rag] reranked ${chunks.length} chunks via ${RERANK_MODEL()} in ${Date.now() - started}ms`);
    return ordered.length ? ordered : chunks;
  } finally {
    clearTimeout(timer);
  }
}
