import mongoose, { Schema, Document } from 'mongoose';

/**
 * Vector-store row for the modular RAG layer (services/rag): one semantic
 * chunk of a knowledge graph with its embedding. Scoped per generation
 * (`scopeId`), TTL-expired alongside the graph cache. Exact cosine ranking
 * happens in-process over a scope's rows (tens to a few hundred per lecture);
 * an Atlas Vector Search index can replace that behind the same VectorStore
 * interface if a cross-document corpus ever exists.
 */
export interface IRagChunk extends Document {
  scopeId: string;
  chunkId: string;
  text: string;
  nodeIds: string[];
  embedding: number[];
  meta?: Record<string, any>;
  createdAt: Date;
  expiresAt: Date;
}

const ragChunkSchema = new Schema<IRagChunk>(
  {
    scopeId: { type: String, required: true, index: true },
    chunkId: { type: String, required: true },
    text: { type: String, required: true },
    nodeIds: [{ type: String }],
    embedding: { type: [Number], required: true },
    meta: { type: Schema.Types.Mixed },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90d, matches TeachingKnowledgeGraph
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ragChunkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ragChunkSchema.index({ scopeId: 1, chunkId: 1 }, { unique: true });

export default mongoose.model<IRagChunk>('RagChunk', ragChunkSchema);
