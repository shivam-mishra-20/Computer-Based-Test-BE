import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * A public test series — an ordered programme of papers.
 *
 * Kept as its own collection rather than a string field on PublicTest because a
 * series is a browsable object in its own right: it has a title, a description,
 * its own discovery filters and its own detail screen. Papers point back at it
 * via `PublicTest.seriesId` + `orderInSeries`.
 *
 * `paperCount` is denormalised so the discovery list can show "12 papers"
 * without counting a second collection per row.
 */

export type PublicSeriesStatus = 'draft' | 'published' | 'archived';

export interface IPublicTestSeries extends Document {
  title: string;
  description?: string;

  board: string[];
  classLevel?: string;
  subject?: string;
  exam?: string;

  status: PublicSeriesStatus;
  paperCount: number;

  createdBy: Types.ObjectId;
  duplicatedFrom?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const seriesSchema = new Schema<IPublicTestSeries>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String },

    board: [{ type: String }],
    classLevel: { type: String, index: true },
    subject: { type: String, index: true },
    exam: { type: String, index: true },

    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
      index: true,
    },
    paperCount: { type: Number, default: 0 },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    duplicatedFrom: { type: Schema.Types.ObjectId, ref: 'PublicTestSeries' },
  },
  { timestamps: true },
);

seriesSchema.index({ status: 1, classLevel: 1, subject: 1 });
seriesSchema.index({ status: 1, createdAt: -1 });
seriesSchema.index({ title: 'text', description: 'text' });

export default mongoose.model<IPublicTestSeries>('PublicTestSeries', seriesSchema);
