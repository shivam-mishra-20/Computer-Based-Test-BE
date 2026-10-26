import mongoose, { Document, Schema } from 'mongoose';

export type NotificationType = 'exam' | 'doubt' | 'announcement' | 'material' | 'schedule' | 'general' | 'attendance' | 'leave' | 'homework';
export type NotificationPriority = 'low' | 'medium' | 'high';

export interface INotification extends Document {
  userId: mongoose.Types.ObjectId;
  type: NotificationType;
  priority: NotificationPriority;
  title: string;
  message: string;
  data?: any;
  read: boolean;
  actionUrl?: string;
  /** When this notification was handed to push delivery (services/pushDelivery) — set once, so it is pushed once. */
  pushedAt?: Date | null;
  /** Which delivery call claimed it. */
  pushClaim?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { 
    type: String, 
    enum: ['exam', 'doubt', 'announcement', 'material', 'schedule', 'general', 'attendance', 'leave', 'homework'], 
    required: true,
    index: true 
  },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  title: { type: String, required: true },
  message: { type: String, required: true },
  data: { type: Schema.Types.Mixed },
  read: { type: Boolean, default: false, index: true },
  actionUrl: { type: String },
  pushedAt: { type: Date, default: null },
  pushClaim: { type: String, default: null },
}, { timestamps: true });

// Index for efficient queries
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

export default mongoose.model<INotification>('Notification', notificationSchema);
