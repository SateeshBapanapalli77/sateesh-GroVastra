import mongoose, { Document, Schema } from 'mongoose';

export type SeasonStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'COMPLETED';

export interface ISrcSeason extends Document {
  tenantId: string;
  seasonId: string;
  name: string;
  festivalDate: Date;
  releaseId?: string | null;
  collectionId?: string | null;
  description?: string | null;
  validFrom: Date;
  validUntil: Date;
  status: SeasonStatus;
  branchIds?: string[];
  entityVersion: number;
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SrcSeasonSchema = new Schema<ISrcSeason>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    seasonId: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    festivalDate: {
      type: Date,
      required: true,
    },
    releaseId: {
      type: String,
      default: null,
      trim: true,
    },
    collectionId: {
      type: String,
      default: null,
      trim: true,
    },
    description: {
      type: String,
      default: null,
      trim: true,
    },
    validFrom: {
      type: Date,
      required: true,
    },
    validUntil: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'CANCELLED', 'COMPLETED'],
      default: 'ACTIVE',
      required: true,
    },
    branchIds: {
      type: [String],
      default: [],
    },
    entityVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    seedGroup: {
      type: String,
      default: null,
      index: true,
    },
    source: {
      type: String,
      default: 'MOCK',
    },
  },
  {
    timestamps: true,
    collection: 'src_seasons',
  }
);

// Unique compound index: tenantId + seasonId
SrcSeasonSchema.index({ tenantId: 1, seasonId: 1 }, { unique: true });
// Query active seasons by tenant
SrcSeasonSchema.index({ tenantId: 1, status: 1, festivalDate: 1 });

export const SrcSeasonModel =
  mongoose.models.SrcSeason || mongoose.model<ISrcSeason>('SrcSeason', SrcSeasonSchema);
