/**
 * Modular RAG for AI features — currently consumed ONLY by the PPT pipeline,
 * deliberately feature-agnostic so notes/worksheets/question tools can reuse
 * it later:
 *
 *   Semantic chunks → NVIDIA embeddings → Mongo-backed vector store →
 *   Retriever (cosine top-K) → NVIDIA reranker → grounding node ids
 *
 * Design notes, honestly stated:
 *  - The vector store persists embeddings in MongoDB and ranks by exact
 *    cosine similarity in-process. A single lecture's knowledge graph is tens
 *    of chunks (≤ ~300), where exact search is faster AND more accurate than
 *    any ANN index — Atlas Vector Search can be swapped in behind the same
 *    VectorStore interface when a cross-document corpus ever exists.
 *  - Every component degrades gracefully: embeddings unavailable → indexing
 *    is skipped with a warning and generation falls back to the blueprint's
 *    own grounding; reranker unavailable → cosine order stands.
 *  - Model ids and endpoints are env-driven (NVIDIA_MODEL_EMBEDDING,
 *    NVIDIA_MODEL_RERANK, NVIDIA_RERANK_URL) — nothing hardcoded.
 */
export { embedTexts } from './nvidiaEmbeddings';
export { rerank } from './nvidiaReranker';
export { indexChunks, retrieveNodeIds, deleteScope } from './retriever';
export type { RagIndexableChunk, RetrievedChunk } from './types';
