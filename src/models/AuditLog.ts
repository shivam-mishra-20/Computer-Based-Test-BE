import { Schema, model, Types, Document } from 'mongoose';

export interface IAuditLog extends Document {
  userId?: Types.ObjectId; // Made optional for system events
  action: string;
  status?: 'success' | 'failure'; // Added status
  entity?: string; // e.g., 'Attendance'
  entityId?: string;
  metadata?: Record<string, any>;
  errorMessage?: string;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' }, // Optional
    action: { type: String, required: true, index: true },
    status: { type: String, enum: ['success', 'failure'], index: true },
    entity: { type: String, index: true },
    entityId: { type: String },
    metadata: { type: Schema.Types.Mixed },
    errorMessage: { type: String }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// TTL Index to expire logs after 30 days
AuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default model<IAuditLog>('AuditLog', AuditLogSchema);
