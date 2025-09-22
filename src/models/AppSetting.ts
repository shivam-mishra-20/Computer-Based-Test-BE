import { Schema, model, Document } from 'mongoose';

export interface IAppSetting extends Document {
  key: string;
  value: any;
  description?: string;
  updatedBy?: string;
  updatedAt: Date;
  createdAt: Date;
}

const AppSettingSchema = new Schema<IAppSetting>(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

export default model<IAppSetting>('AppSetting', AppSettingSchema);
