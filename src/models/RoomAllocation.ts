import mongoose, { Document, Schema } from 'mongoose';

// ── Fixed rooms ────────────────────────────────────────────────────────────────
// The institute has 11 physical exam rooms. There is intentionally NO room
// management module — the set is a fixed constant and is the single source of
// truth shared by the API (validation) and the admin UI (via GET /rooms).
export const ROOMS: string[] = [
  'Room 1',
  'Room 2',
  'Room 3',
  'Room 4',
  'Room 5',
  'Room 6',
  'Room 7',
  'Room 8',
  'Room 9',
  'Room 10',
  'Room 11',
];

// Seating strength (capacity) per room. A room may never hold more students
// than its strength. Defaults to 20; the listed rooms differ.
export const ROOM_CAPACITY: Record<string, number> = {
  'Room 1': 18,
  'Room 2': 20,
  'Room 3': 20,
  'Room 4': 20,
  'Room 5': 20,
  'Room 6': 20,
  'Room 7': 20,
  'Room 8': 18,
  'Room 9': 14,
  'Room 10': 10,
  'Room 11': 20,
};

export const roomCapacity = (room: string): number => ROOM_CAPACITY[room] ?? 0;

export type RoomAllocationStatus = 'draft' | 'published';

// One student → one room. Student identity fields are snapshotted at save time
// so the export / admit card stays stable even if the student record changes.
export interface IRoomAssignment {
  studentId: mongoose.Types.ObjectId;
  studentName: string;
  empCode?: string; // Student code — used as the Roll No.
  classLevel?: string;
  batch?: string;
  room: string; // one of ROOMS
}

// Snapshot of who-was-in-which-room at the last publish, so a re-publish can
// notify ONLY the students whose room actually changed.
export interface IPublishedRoom {
  studentId: string;
  room: string;
}

export interface IRoomAllocation extends Document {
  date: string; // yyyy-mm-dd — one allocation per exam DATE (spans all tests/classes that day)
  status: RoomAllocationStatus;
  assignments: IRoomAssignment[];
  lastPublishedRooms: IPublishedRoom[];
  publishedAt?: Date;
  publishedBy?: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const roomAssignmentSchema = new Schema<IRoomAssignment>(
  {
    studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    studentName: { type: String, required: true, trim: true },
    empCode: { type: String, trim: true },
    classLevel: { type: String, trim: true },
    batch: { type: String, trim: true },
    room: { type: String, required: true, enum: ROOMS },
  },
  { _id: false }
);

const publishedRoomSchema = new Schema<IPublishedRoom>(
  {
    studentId: { type: String, required: true },
    room: { type: String, required: true },
  },
  { _id: false }
);

const roomAllocationSchema = new Schema<IRoomAllocation>(
  {
    date: {
      type: String,
      required: true,
      unique: true, // exactly one allocation document per exam date
      index: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    status: {
      type: String,
      enum: ['draft', 'published'],
      default: 'draft',
      index: true,
    },
    assignments: { type: [roomAssignmentSchema], default: [] },
    lastPublishedRooms: { type: [publishedRoomSchema], default: [] },
    publishedAt: { type: Date },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Fast lookup of "is this student allocated on this date" for the student view.
roomAllocationSchema.index({ date: 1, 'assignments.studentId': 1 });

const RoomAllocation = mongoose.model<IRoomAllocation>('RoomAllocation', roomAllocationSchema);

export default RoomAllocation;
