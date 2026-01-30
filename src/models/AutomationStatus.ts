import mongoose, { Document, Schema } from 'mongoose';

export interface IAutomationStatus extends Document {
  isEnabled: boolean;
  currentlyRunning: boolean;
  lastRun?: Date;
  nextScheduledRun?: Date;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  schedule?: {
    cronExpression: string;
    enabled: boolean;
    lastModified: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const AutomationStatusSchema = new Schema<IAutomationStatus>(
  {
    isEnabled: { type: Boolean, default: false },
    currentlyRunning: { type: Boolean, default: false },
    lastRun: { type: Date },
    nextScheduledRun: { type: Date },
    totalRuns: { type: Number, default: 0 },
    successfulRuns: { type: Number, default: 0 },
    failedRuns: { type: Number, default: 0 },
    schedule: {
      cronExpression: { type: String },
      enabled: { type: Boolean, default: false },
      lastModified: { type: Date, default: Date.now }
    }
  },
  {
    timestamps: true
  }
);

// Prevent model overwrite error
export const AutomationStatus = mongoose.models.AutomationStatus || 
  mongoose.model<IAutomationStatus>('AutomationStatus', AutomationStatusSchema);

export default AutomationStatus;
