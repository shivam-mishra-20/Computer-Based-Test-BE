export interface RagIndexableChunk {
  chunkId: string;
  text: string;
  /** Knowledge-graph node ids this chunk grounds. */
  nodeIds: string[];
  meta?: Record<string, unknown>;
}

export interface RetrievedChunk extends RagIndexableChunk {
  score: number;
}
