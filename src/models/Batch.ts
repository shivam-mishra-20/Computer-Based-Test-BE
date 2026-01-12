import mongoose, { Document, Schema } from 'mongoose';

export interface IBatch extends Document {
  name: string;
  classLevels: string[];
  isDefault: boolean;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const batchSchema = new Schema<IBatch>({
  name: { type: String, required: true, unique: true },
  classLevels: [{ type: String, required: true }],
  isDefault: { type: Boolean, default: false },
  description: { type: String }
}, { timestamps: true });

// Index for efficient queries
batchSchema.index({ classLevels: 1 });

export default mongoose.model<IBatch>('Batch', batchSchema);
