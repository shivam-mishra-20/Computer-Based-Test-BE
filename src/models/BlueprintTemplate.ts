import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * A saved Lecture Blueprint STRUCTURE a teacher reuses across lectures — the
 * section skeleton (kinds, slide counts, depth/question settings), not the
 * lecture-specific content: knowledgeNodeIds are stripped on save, and
 * concept-section titles get overwritten with the new lecture's actual topics
 * when the template is applied (blueprintPlanner.applyTemplate).
 */
export interface IBlueprintTemplate extends Document {
  ownerId: Types.ObjectId;
  name: string;
  blueprint: Record<string, any>; // LectureBlueprint (content-agnostic form)
  createdAt: Date;
  updatedAt: Date;
}

const blueprintTemplateSchema = new Schema<IBlueprintTemplate>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    blueprint: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

blueprintTemplateSchema.index({ ownerId: 1, createdAt: -1 });

export default mongoose.model<IBlueprintTemplate>('BlueprintTemplate', blueprintTemplateSchema);
