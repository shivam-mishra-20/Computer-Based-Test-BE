import mongoose, { Document, Schema } from 'mongoose';

export interface IHoliday extends Document {
  date: Date;
  name: string;
  type: 'holiday' | 'working'; // 'holiday' marks as off, 'working' marks a Sunday as working
  description?: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const holidaySchema = new Schema<IHoliday>({
  date: { 
    type: Date, 
    required: true, 
    // NOT `unique` — uniqueness is per organization, declared below as a
    // compound index. A fresh database therefore never builds the global one;
    // existing databases keep theirs until drop-legacy-global-indexes.ts runs,
    // which is what makes this safe to deploy before the migration.
    index: true 
  },
  name: { 
    type: String, 
    required: true 
  },
  type: { 
    type: String, 
    enum: ['holiday', 'working'], 
    required: true,
    default: 'holiday'
  },
  description: { 
    type: String 
  },
  createdBy: { 
    type: Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  }
}, { timestamps: true });

// Index for date range queries
//
// ── Tenant-scoped uniqueness ────────────────────────────────────────────────
// The legacy index below is globally unique, which on a shared database means
// this constraint spans every institute on the platform. The compound index is
// the replacement; the legacy one is removed by
// `scripts/safety/drop-legacy-global-indexes.ts` as a separate, supervised
// migration — create replacement, verify, only then remove.
// One holiday per DATE was platform-wide: the second institute to declare a
// holiday on 15 August could not save it.
holidaySchema.index({ orgId: 1, date: 1 }, { unique: true });
holidaySchema.index({ date: 1, type: 1 });

export default mongoose.model<IHoliday>('Holiday', holidaySchema);
