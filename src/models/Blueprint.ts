import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IBlueprintSection {
  title: string;
  instructions?: string;
  marksPerQuestion?: number;
  questionCounts: Record<string, number>; // counts per question type
  difficultyDistribution?: { easy?: number; medium?: number; hard?: number };
}

export interface IBlueprint extends Document {
  name: string; // user friendly name
  examTitle: string;
  subject?: string;
  generalInstructions: string[];
  sections: IBlueprintSection[];
  owner: Types.ObjectId; // teacher/admin who created
  shared?: boolean; // if true visible to other teachers
}

const blueprintSectionSchema = new Schema<IBlueprintSection>(
  {
    title: { type: String, required: true },
    instructions: { type: String },
    marksPerQuestion: { type: Number },
    questionCounts: { type: Schema.Types.Mixed, required: true },
    difficultyDistribution: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const blueprintSchema = new Schema<IBlueprint>(
  {
    name: { type: String, required: true },
    examTitle: { type: String, required: true },
    subject: { type: String },
    generalInstructions: { type: [String], default: [] },
    sections: { type: [blueprintSectionSchema], required: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    shared: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model<IBlueprint>('Blueprint', blueprintSchema);