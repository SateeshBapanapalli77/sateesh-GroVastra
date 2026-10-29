import mongoose, { Document, Schema } from 'mongoose';
import { CheckpointStatus, CHECKPOINT_STATUS } from '@grovastra/shared';

export interface ICampaignCheckpoint extends Document {
  tenantId: string;
  campaignId: string;
  type: string;
  lastCustomerId: string | null;
  horizonStart: string;
  horizonEnd: string;
  status: CheckpointStatus;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  processedCount: number;
  enrolledCount: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignCheckpointSchema = new Schema<ICampaignCheckpoint>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    campaignId: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      default: 'CALENDAR_PLANNER',
      required: true,
      trim: true,
    },
    lastCustomerId: {
      type: String,
      default: null,
    },
    horizonStart: {
      type: String,
      trim: true,
    },
    horizonEnd: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(CHECKPOINT_STATUS),
      default: CHECKPOINT_STATUS.IDLE,
      required: true,
    },
    leaseToken: {
      type: String,
      default: null,
    },
    leaseExpiresAt: {
      type: Date,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    processedCount: {
      type: Number,
      default: 0,
    },
    enrolledCount: {
      type: Number,
      default: 0,
    },
    error: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'campaignCheckpoints',
  }
);

CampaignCheckpointSchema.index({ tenantId: 1, campaignId: 1, type: 1 }, { unique: true });
CampaignCheckpointSchema.index({ leaseExpiresAt: 1 });

export const CampaignCheckpointModel =
  mongoose.models.CampaignCheckpoint ||
  mongoose.model<ICampaignCheckpoint>('CampaignCheckpoint', CampaignCheckpointSchema);
