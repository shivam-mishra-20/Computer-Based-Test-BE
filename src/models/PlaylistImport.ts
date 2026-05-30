import mongoose, { Document, Schema } from 'mongoose';

export interface IPlaylistImport extends Document {
  courseId: mongoose.Types.ObjectId;
  playlistId: string;
  playlistTitle: string;
  playlistDescription: string;
  playlistThumbnail: string;
  channelId: string;
  channelName: string;
  totalVideos: number;
  importedVideoCount: number;
  lastSyncedAt: Date;
  syncStatus: 'idle' | 'syncing' | 'error';
  syncError?: string;
  autoSync: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const playlistImportSchema = new Schema<IPlaylistImport>(
  {
    courseId: { type: Schema.Types.ObjectId, ref: 'Course', required: true, unique: true },
    playlistId: { type: String, required: true, index: true },
    playlistTitle: { type: String, required: true },
    playlistDescription: { type: String, default: '' },
    playlistThumbnail: { type: String, default: '' },
    channelId: { type: String, default: '' },
    channelName: { type: String, default: '' },
    totalVideos: { type: Number, default: 0 },
    importedVideoCount: { type: Number, default: 0 },
    lastSyncedAt: { type: Date, default: Date.now },
    syncStatus: { type: String, enum: ['idle', 'syncing', 'error'], default: 'idle' },
    syncError: { type: String },
    autoSync: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model<IPlaylistImport>('PlaylistImport', playlistImportSchema);
