import mongoose, { Document, Schema } from 'mongoose';

export type NotificationType = 'exam' | 'doubt' | 'announcement' | 'material' | 'schedule' | 'general';
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
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { 
    type: String, 
    enum: ['exam', 'doubt', 'announcement', 'material', 'schedule', 'general'], 
    required: true,
    index: true 
  },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  title: { type: String, required: true },
  message: { type: String, required: true },
  data: { type: Schema.Types.Mixed },
  read: { type: Boolean, default: false, index: true },
  actionUrl: { type: String },
}, { timestamps: true });

// Index for efficient queries
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

export default mongoose.model<INotification>('Notification', notificationSchema);
