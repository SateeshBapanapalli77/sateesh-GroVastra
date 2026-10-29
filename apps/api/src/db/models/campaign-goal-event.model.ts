import mongoose, { Document, Schema } from 'mongoose';

export interface ICampaignGoalEvent extends Document {
  goalEventId: string;
  tenantId: string;
  enrollmentId?: string | null;
  occurrence?: string | null;
  customerId?: string | null;
  campaignId?: string | null;
  source: string;
  orderRef?: string | null;
  cause?: string | null;
  supportingRecord?: string | null;
  recordedBy: string;
  at: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignGoalEventSchema = new Schema<ICampaignGoalEvent>(
  {
    goalEventId: {
      type: String,
      required: true,
      trim: true,
    },
    tenantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    enrollmentId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    occurrence: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    customerId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    campaignId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    source: {
      type: String,
      required: true,
      trim: true,
      default: 'STAFF_MANUAL',
    },
    orderRef: {
      type: String,
      default: null,
      trim: true,
    },
    cause: {
      type: String,
      default: null,
      trim: true,
    },
    supportingRecord: {
      type: String,
      default: null,
      trim: true,
    },
    recordedBy: {
      type: String,
      required: true,
      trim: true,
    },
    at: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    collection: 'campaignGoalEvents',
  }
);

// Indexes adhering to Spec p25, Hard Rule 1
CampaignGoalEventSchema.index({ tenantId: 1, goalEventId: 1 }, { unique: true });
CampaignGoalEventSchema.index({ tenantId: 1, enrollmentId: 1 });
CampaignGoalEventSchema.index({ tenantId: 1, occurrence: 1 });
CampaignGoalEventSchema.index({ tenantId: 1, customerId: 1 });
CampaignGoalEventSchema.index({ tenantId: 1, at: -1 });

export const CampaignGoalEventModel =
  mongoose.models.CampaignGoalEvent ||
  mongoose.model<ICampaignGoalEvent>('CampaignGoalEvent', CampaignGoalEventSchema);
