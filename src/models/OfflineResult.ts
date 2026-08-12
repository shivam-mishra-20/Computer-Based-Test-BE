import mongoose, { Document, Schema } from 'mongoose';

export interface IOfflineResult extends Document {
  class: string;
  name: string;
  batch?: string;
  subject: string;
  marks: number;
  outOf: number;
  remarks?: string;
  testDate: string; // Store as yyyy-mm-dd format
  createdAt: Date;
  updatedAt?: Date;
}

const offlineResultSchema = new Schema<IOfflineResult>(
  {
    class: { 
      type: String, 
      required: true, 
      index: true,
      trim: true 
    },
    name: { 
      type: String, 
      required: true, 
      index: true,
      trim: true 
    },
    batch: { 
      type: String, 
      index: true,
      trim: true 
    },
    subject: { 
      type: String, 
      required: true,
      index: true,
      trim: true 
    },
    marks: { 
      type: Number, 
      required: true,
      min: 0 
    },
    outOf: { 
      type: Number, 
      required: true,
      min: 1 
    },
    remarks: { 
      type: String,
      trim: true 
    },
    testDate: { 
      type: String, 
      required: true,
      // Indexed below as { testDate: -1 } — the order results are actually
      // sorted in. Declaring `index: true` here as well made Mongoose warn
      // about a duplicate index on every boot.
      match: /^\d{4}-\d{2}-\d{2}$/ // Validate yyyy-mm-dd format
    },
    createdAt: { 
      type: Date, 
      default: Date.now,
      // Indexed below as { createdAt: -1 } — see testDate above.
    },
    updatedAt: { 
      type: Date 
    }
  },
  {
    timestamps: false // We manage these manually to match web app behavior
  }
);

// Compound indexes for efficient queries
offlineResultSchema.index({ name: 1, class: 1 });
offlineResultSchema.index({ class: 1, batch: 1 });
offlineResultSchema.index({ testDate: -1 });
offlineResultSchema.index({ createdAt: -1 });

// Virtual for percentage calculation
offlineResultSchema.virtual('percentage').get(function() {
  return this.outOf > 0 ? (this.marks / this.outOf) * 100 : 0;
});

// Ensure virtuals are included in JSON
offlineResultSchema.set('toJSON', { virtuals: true });
offlineResultSchema.set('toObject', { virtuals: true });

const OfflineResult = mongoose.model<IOfflineResult>('OfflineResult', offlineResultSchema);

export default OfflineResult;
