import mongoose, { Document, Schema } from 'mongoose';

export interface IBranch extends Document {
  tenantId: string;
  branchId: string;
  name: string;
  isMain: boolean;
  status: string;
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const BranchSchema = new Schema<IBranch>(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    branchId: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    isMain: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      default: 'active',
      trim: true,
    },
    seedGroup: {
      type: String,
      default: 'core',
    },
    source: {
      type: String,
      default: 'MOCK',
    },
  },
  {
    timestamps: true,
    collection: 'branches',
  }
);

// Compound index guaranteeing uniqueness per tenant and fast branch lookup
BranchSchema.index({ tenantId: 1, branchId: 1 }, { unique: true });

export const BranchModel = mongoose.models.Branch || mongoose.model<IBranch>('Branch', BranchSchema);
