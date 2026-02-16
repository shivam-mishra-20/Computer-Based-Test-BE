import mongoose, { Document, Schema, Model } from 'mongoose';

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

// Prevent model overwrite error with proper typing
const AutomationStatus: Model<IAutomationStatus> = (mongoose.models.AutomationStatus as Model<IAutomationStatus>) || 
  mongoose.model<IAutomationStatus>('AutomationStatus', AutomationStatusSchema);

export { IAutomationStatus };
export default AutomationStatus;
