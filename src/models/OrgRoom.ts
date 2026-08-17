import mongoose, { Document, Schema } from 'mongoose';

/**
 * A physical exam room, per organization.
 *
 * Replaces `ROOMS` and `ROOM_CAPACITY` in `models/RoomAllocation.ts`, whose own
 * comment states the problem plainly: "The institute has 11 physical exam
 * rooms." A school with four rooms, or forty, or rooms named "Hall A" cannot
 * use the offline-test module at all.
 *
 * `capacity` carries the same meaning as the old `ROOM_CAPACITY` map — the
 * seating strength a room may never exceed.
 */

export interface IOrgRoom extends Document {
  orgId: string;
  branchId?: string | null;
  name: string;
  capacity: number;
  order: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const orgRoomSchema = new Schema<IOrgRoom>(
  {
    name: { type: String, required: true, trim: true },
    // Defaults to 20, matching the legacy comment: "Defaults to 20; the listed
    // rooms differ."
    capacity: { type: Number, required: true, default: 20, min: 0 },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

orgRoomSchema.index({ orgId: 1, name: 1 }, { unique: true });
orgRoomSchema.index({ orgId: 1, order: 1 });

export default mongoose.model<IOrgRoom>('OrgRoom', orgRoomSchema);
