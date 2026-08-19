import mongoose, { Document, Schema } from 'mongoose';

export interface IFileMetadata extends Document {
  /**
   * Legacy rows hold a full public URL here. New rows hold the SAME value as
   * `storagePath`, so nothing reading `url` breaks — but the read path signs a
   * tenant path rather than handing it out.
   */
  url: string;
  storagePath: string;
  /** Which module owns the file. Closed vocabulary — see core/storage/paths.ts. */
  module?: string;
  /** The record the file belongs to, when there is one. */
  entityType?: string;
  entityId?: string;
  /**
   * `private` — under organizations/{orgId}/, readable only via a signed URL.
   * `legacy-public` — uploaded before the tenant scheme; the object carries a
   * public ACL that only a supervised production migration can remove.
   */
  visibility?: 'private' | 'legacy-public';
  fileName: string;
  fileType: string;
  fileSize: number;
  uploadedBy: mongoose.Types.ObjectId;
  relatedDoubtId?: mongoose.Types.ObjectId;
  relatedMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const fileMetadataSchema = new Schema<IFileMetadata>({
  url: { type: String, required: true },
  // NOT globally unique. Two organizations may legitimately hold objects whose
  // paths differ only by their orgId segment, and a global constraint on a
  // storage path is the same defect P8 found in batches.name and
  // appsettings.key — see the compound index below.
  storagePath: { type: String, required: true, index: true },
  module: { type: String, index: true },
  entityType: { type: String, index: true },
  entityId: { type: String, index: true },
  visibility: { type: String, enum: ['private', 'legacy-public'], default: 'private', index: true },
  fileName: { type: String, required: true },
  fileType: { type: String, required: true },
  fileSize: { type: Number, required: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  relatedDoubtId: { type: Schema.Types.ObjectId, ref: 'Doubt', index: true },
  relatedMessageId: { type: String, index: true },
}, { timestamps: true });

// Compound index for efficient queries
fileMetadataSchema.index({ relatedDoubtId: 1, createdAt: -1 });
fileMetadataSchema.index({ uploadedBy: 1, createdAt: -1 });
// Uniqueness is per organization. `orgId` comes from the tenancy plugin.
fileMetadataSchema.index({ orgId: 1, storagePath: 1 }, { unique: true });
fileMetadataSchema.index({ orgId: 1, module: 1, entityId: 1, createdAt: -1 });

export default mongoose.model<IFileMetadata>('FileMetadata', fileMetadataSchema);
