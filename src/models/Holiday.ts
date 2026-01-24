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
    unique: true,
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
holidaySchema.index({ date: 1, type: 1 });

export default mongoose.model<IHoliday>('Holiday', holidaySchema);
