import mongoose, { Document, Schema } from 'mongoose';

export interface ICampaignControlGate extends Document {
  tenantId: string;
  campaignId: string;
  pauseGeneration: number;
  version: number;
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignControlGateSchema = new Schema<ICampaignControlGate>(
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
    pauseGeneration: {
      type: Number,
      default: 0,
      required: true,
    },
    version: {
      type: Number,
      default: 1,
      required: true,
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
    collection: 'campaignControlGates',
  }
);

// Unique campaign control gate per tenant and campaign
CampaignControlGateSchema.index({ tenantId: 1, campaignId: 1 }, { unique: true });

export const CampaignControlGateModel =
  mongoose.models.CampaignControlGate ||
  mongoose.model<ICampaignControlGate>('CampaignControlGate', CampaignControlGateSchema);
