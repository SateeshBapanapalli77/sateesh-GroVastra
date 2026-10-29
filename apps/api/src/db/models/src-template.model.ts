import mongoose, { Document, Schema } from 'mongoose';
import { TemplateCategory, TemplateSource, TemplateVariable } from '@grovastra/shared';

export interface ISrcTemplate extends Document {
  id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  status: string;
  bodyText: string | null;
  variables: TemplateVariable[];
  revision: number;
  sendable: boolean;
  source: TemplateSource;
  seedGroup?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const TemplateVariableSchema = new Schema<TemplateVariable>(
  {
    index: { type: Number, required: true },
    name: { type: String, required: true },
    type: { type: String, required: true },
    sample: { type: String, required: true },
  },
  { _id: false }
);

const SrcTemplateSchema = new Schema<ISrcTemplate>(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    language: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: ['MARKETING', 'UTILITY', 'UNKNOWN'],
      required: true,
    },
    status: {
      type: String,
      required: true,
      trim: true,
    },
    bodyText: {
      type: String,
      default: null,
    },
    variables: {
      type: [TemplateVariableSchema],
      default: [],
    },
    revision: {
      type: Number,
      required: true,
      default: 1,
    },
    sendable: {
      type: Boolean,
      required: true,
      default: false,
    },
    source: {
      type: String,
      enum: ['META_PROVIDED', 'DUMMY'],
      required: true,
    },
    seedGroup: {
      type: String,
      default: 'core',
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'src_templates',
  }
);

// Indexes
SrcTemplateSchema.index({ name: 1, language: 1, revision: 1 });
SrcTemplateSchema.index({ category: 1 });
SrcTemplateSchema.index({ sendable: 1 });
SrcTemplateSchema.index({ source: 1 });

// Read-only to application code: block modification operations at schema layer
const forbiddenMutation = function () {
  throw new Error('src_templates is read-only to application code. Modifying templates is forbidden.');
};

SrcTemplateSchema.pre('updateOne', forbiddenMutation);
SrcTemplateSchema.pre('updateMany', forbiddenMutation);
SrcTemplateSchema.pre('findOneAndUpdate', forbiddenMutation);
SrcTemplateSchema.pre('replaceOne', forbiddenMutation);
SrcTemplateSchema.pre('deleteOne', forbiddenMutation);
SrcTemplateSchema.pre('deleteMany', forbiddenMutation);
SrcTemplateSchema.pre('findOneAndDelete', forbiddenMutation);

export const SrcTemplateModel =
  mongoose.models.SrcTemplate || mongoose.model<ISrcTemplate>('SrcTemplate', SrcTemplateSchema);
