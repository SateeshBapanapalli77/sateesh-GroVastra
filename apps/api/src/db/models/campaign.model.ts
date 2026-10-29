import mongoose, { Document, Schema } from 'mongoose';
import { CampaignStatus, CAMPAIGN_STATUS } from '@grovastra/shared';

export interface ICampaign extends Document {
  campaignId: string;
  tenantId: string;
  name: string;
  presetId: string;
  status: CampaignStatus;
  activeVersionId: string | null;
  draftVersion: number;
  pauseGeneration: number;
  enabledBranches: string[];
  startAt: Date | null;
  activatedAt: Date | null;
  endAt: Date | null;
  nextEvaluationAt?: Date | null;
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignSchema = new Schema<ICampaign>(
  {
    campaignId: {
      type: String,
      required: true,
      trim: true,
    },
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 100,
    },
    presetId: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(CAMPAIGN_STATUS),
      default: CAMPAIGN_STATUS.DRAFT,
      required: true,
    },
    activeVersionId: {
      type: String,
      default: null,
    },
    draftVersion: {
      type: Number,
      default: 1,
      required: true,
    },
    pauseGeneration: {
      type: Number,
      default: 0,
      required: true,
    },
    enabledBranches: {
      type: [String],
      default: [],
    },
    startAt: {
      type: Date,
      default: null,
    },
    activatedAt: {
      type: Date,
      default: null,
    },
    endAt: {
      type: Date,
      default: null,
    },
    nextEvaluationAt: {
      type: Date,
      default: null,
    },
    seedGroup: {
      type: String,
      default: null,
      index: true,
    },
    source: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'campaigns',
  }
);

// Unique campaign per tenant
CampaignSchema.index({ tenantId: 1, campaignId: 1 }, { unique: true });
CampaignSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

export const CampaignModel =
  mongoose.models.Campaign || mongoose.model<ICampaign>('Campaign', CampaignSchema);
