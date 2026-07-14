/**
 * NVIDIA embeddings client (OpenAI-compatible /embeddings endpoint on the
 * API Catalog). Retrieval-tuned models take an `input_type` of 'passage'
 * (indexing) or 'query' (searching) — required for the nv-embedqa family.
 */
// Default swapped 2026-07-12: llama-3.2-nv-embedqa-1b-v2 reached end of life
// (HTTP 410 Gone) — llama-nemotron-embed-1b-v2 probed alive (2048-dim).
const EMBED_MODEL = () => process.env.NVIDIA_MODEL_EMBEDDING || 'nvidia/llama-nemotron-embed-1b-v2';
const BASE_URL = () => process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const TIMEOUT_MS = () => Number(process.env.EMBEDDING_TIMEOUT_MS || 60000);
const BATCH_SIZE = 32; // catalog endpoints reject oversized input arrays

export async function embedTexts(
  texts: string[],
  inputType: 'passage' | 'query',
): Promise<number[][]> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY is not set');
  if (!texts.length) return [];

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => t.slice(0, 8000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
    const started = Date.now();
    try {
      const res = await fetch(`${BASE_URL()}/embeddings`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: EMBED_MODEL(),
          input: batch,
          input_type: inputType,
          truncate: 'END',
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Embeddings HTTP ${res.status}: ${body.slice(0, 160)}`);
      }
      const json: any = await res.json();
      const rows: any[] = Array.isArray(json?.data) ? json.data : [];
      if (rows.length !== batch.length) {
        throw new Error(`Embeddings returned ${rows.length} vectors for ${batch.length} inputs`);
      }
      rows.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
      for (const row of rows) out.push((row?.embedding as number[]) || []);
      console.log(
        `[rag] embedded ${batch.length} ${inputType}(s) via ${EMBED_MODEL()} in ${Date.now() - started}ms`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}
