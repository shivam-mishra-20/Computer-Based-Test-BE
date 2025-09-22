import { Schema, model, Types, Document } from 'mongoose';

export interface IAuditLog extends Document {
  userId: Types.ObjectId;
  action: string;
  resource?: string;
  meta?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true },
    resource: { type: String },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

export default model<IAuditLog>('AuditLog', AuditLogSchema);
