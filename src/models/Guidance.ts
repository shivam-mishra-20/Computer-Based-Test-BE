import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IGuidance extends Document {
  subject?: string;
  topic?: string;
  instructions: string; // free-form system prompt additions / dos & don'ts
  owner: Types.ObjectId; // admin user creating this
  isActive: boolean;
}

const guidanceSchema = new Schema<IGuidance>(
  {
    subject: { type: String, index: true },
    topic: { type: String, index: true },
    instructions: { type: String, required: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

guidanceSchema.index({ subject: 1, topic: 1, isActive: 1 });

export default mongoose.model<IGuidance>('Guidance', guidanceSchema);
