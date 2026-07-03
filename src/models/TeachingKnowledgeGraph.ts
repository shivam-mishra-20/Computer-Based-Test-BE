import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Cache/store for the structured content a source document (or prompt) yields
 * once run through Knowledge Extraction (see services/aiOrchestrator). Keyed by
 * contentHash so re-uploading an identical file skips the three most expensive
 * pipeline stages (document processing, vision analysis, extraction) entirely.
 *
 * Deliberately a separate collection from AiGeneration: one graph can back
 * multiple generations (different modes/themes over the same source), and it
 * keeps AiGeneration's list view (`.select('-contentJSON')`) cheap. The `graph`
 * field holds a TeachingKnowledgeGraph (see services/aiOrchestrator/interfaces)
 * — a feature-agnostic domain asset other AI features may read in future
 * (question paper, notes, worksheet), not just PPT generation.
 */
export interface ITeachingKnowledgeGraph extends Document {
  contentHash: string;
  ownerId: Types.ObjectId;
  sourceMeta: {
    originalName?: string;
    mimeType?: string;
    usedVision: boolean;
  };
  graph: Record<string, any>;
  visionClassifications?: Record<string, any>;
  createdAt: Date;
  expiresAt: Date;
}

const teachingKnowledgeGraphSchema = new Schema<ITeachingKnowledgeGraph>(
  {
    // NOT globally unique on its own — the cache is scoped per-teacher (see
    // class doc comment), so the same source content hashed by two different
    // owners must be able to coexist as two separate cache rows. The compound
    // index below is what actually enforces "at most one cached graph per
    // owner per content hash."
    contentHash: { type: String, required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sourceMeta: {
      _id: false,
      originalName: { type: String },
      mimeType: { type: String },
      usedVision: { type: Boolean, default: false },
    },
    graph: { type: Schema.Types.Mixed, required: true },
    visionClassifications: { type: Schema.Types.Mixed },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90d
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// TTL index — Mongo removes the doc automatically once expiresAt passes.
teachingKnowledgeGraphSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Enforces "at most one cached graph per owner per content hash" — compound,
// not a single-field unique on contentHash, so two different teachers who
// happen to hash to the same value (e.g. an identical generic prompt) get
// independent cache rows instead of one silently overwriting the other's.
teachingKnowledgeGraphSchema.index({ contentHash: 1, ownerId: 1 }, { unique: true });

export default mongoose.model<ITeachingKnowledgeGraph>(
  'TeachingKnowledgeGraph',
  teachingKnowledgeGraphSchema,
);
