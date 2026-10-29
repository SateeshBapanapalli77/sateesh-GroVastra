import mongoose, { Document, Schema } from 'mongoose';

export interface ICampaignProviderEvent extends Document {
  eventId: string;
  tenantId: string;
  phoneNumberId: string;
  eventType: 'STATUS' | 'INBOUND_MESSAGE' | string;
  messageId: string;
  status?: string | null;
  timestamp: Date;
  recipientHash?: string | null;
  recipientMasked?: string | null;
  dedupeKey: string;
  rawPayload: Record<string, unknown>;
  correlatedExecutionId?: string | null;
  correlatedEnrollmentId?: string | null;
  replyAttribution?: 'CAMPAIGN' | 'NOT_CAMPAIGN_CONSERVATIVE' | null;
  processed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignProviderEventSchema = new Schema<ICampaignProviderEvent>(
  {
    eventId: {
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
    phoneNumberId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      trim: true,
      enum: ['STATUS', 'INBOUND_MESSAGE'],
    },
    messageId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      default: null,
      trim: true,
    },
    timestamp: {
      type: Date,
      required: true,
    },
    recipientHash: {
      type: String,
      default: null,
      trim: true,
    },
    recipientMasked: {
      type: String,
      default: null,
      trim: true,
    },
    dedupeKey: {
      type: String,
      required: true,
      trim: true,
    },
    rawPayload: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
    correlatedExecutionId: {
      type: String,
      default: null,
      trim: true,
    },
    correlatedEnrollmentId: {
      type: String,
      default: null,
      trim: true,
    },
    replyAttribution: {
      type: String,
      default: null,
      enum: ['CAMPAIGN', 'NOT_CAMPAIGN_CONSERVATIVE', null],
    },
    processed: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    collection: 'campaignProviderEvents',
  }
);

// Indexes adhering to Spec Hard Rule 1 & QA Matrix C10
// Deduplication per status event (messageId + status + timestamp) scoped strictly to tenant
CampaignProviderEventSchema.index({ tenantId: 1, dedupeKey: 1 }, { unique: true });
CampaignProviderEventSchema.index({ tenantId: 1, eventId: 1 }, { unique: true });
CampaignProviderEventSchema.index({ tenantId: 1, messageId: 1, status: 1 });
CampaignProviderEventSchema.index({ tenantId: 1, recipientHash: 1 });
CampaignProviderEventSchema.index({ tenantId: 1, createdAt: -1 });

export const CampaignProviderEventModel =
  mongoose.models.CampaignProviderEvent ||
  mongoose.model<ICampaignProviderEvent>('CampaignProviderEvent', CampaignProviderEventSchema);
