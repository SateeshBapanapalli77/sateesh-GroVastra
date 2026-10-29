import mongoose, { Document, Schema } from 'mongoose';

export interface ICampaignTombstone extends Document {
  tenantId: string;
  type: 'ENROLLMENT' | 'EXECUTION';
  key: string;
  campaignId: string;
  customerId: string;
  occurrenceId?: string | null;
  stepId?: string | null;
  tombstonedAt: Date;
  originalId: string;
  retentionReason: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignTombstoneSchema = new Schema<ICampaignTombstone>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['ENROLLMENT', 'EXECUTION'],
      required: true,
      trim: true,
    },
    key: {
      type: String,
      required: true,
      trim: true,
    },
    campaignId: {
      type: String,
      required: true,
      trim: true,
    },
    customerId: {
      type: String,
      required: true,
      trim: true,
    },
    occurrenceId: {
      type: String,
      default: null,
      trim: true,
    },
    stepId: {
      type: String,
      default: null,
      trim: true,
    },
    tombstonedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    originalId: {
      type: String,
      required: true,
      trim: true,
    },
    retentionReason: {
      type: String,
      default: 'DATA_RETENTION_PRUNING',
      trim: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    collection: 'campaignTombstones',
  }
);

// Compound unique index ensuring logical-key uniqueness per tenant and type (Spec p18, p25, QA Matrix B18)
CampaignTombstoneSchema.index({ tenantId: 1, type: 1, key: 1 }, { unique: true });
CampaignTombstoneSchema.index({ tenantId: 1, campaignId: 1 });
CampaignTombstoneSchema.index({ tenantId: 1, customerId: 1 });
CampaignTombstoneSchema.index({ tenantId: 1, tombstonedAt: -1 });

export const CampaignTombstoneModel =
  mongoose.models.CampaignTombstone ||
  mongoose.model<ICampaignTombstone>('CampaignTombstone', CampaignTombstoneSchema);
