import mongoose, { Document, Schema } from 'mongoose';
import { EventInboxStatus, EVENT_INBOX_STATUS } from '@grovastra/shared';

export interface ICampaignEventInbox extends Document {
  tenantId: string;
  producer: string;
  eventId: string;
  type: string;
  schemaVersion: number;
  entityId: string;
  entityVersion: number;
  customerId?: string | null;
  occurredAt: Date;
  receivedAt: Date;
  data: Record<string, unknown>;
  status: EventInboxStatus;
  outcome?: string | null;
  quarantineReason?: string | null;
  quarantineDetails?: Record<string, unknown> | null;
  processedAt?: Date | null;
  processedMarker?: {
    processedAt: Date;
    cursor?: number;
    effectsSummary?: string;
    affectedCount?: number;
  } | null;
  attempts: number;
  lastError?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignEventInboxSchema = new Schema<ICampaignEventInbox>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    producer: {
      type: String,
      required: true,
      trim: true,
    },
    eventId: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      required: true,
      trim: true,
    },
    schemaVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    entityId: {
      type: String,
      required: true,
      trim: true,
    },
    entityVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    customerId: {
      type: String,
      default: null,
      trim: true,
    },
    occurredAt: {
      type: Date,
      required: true,
    },
    receivedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    data: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
    status: {
      type: String,
      required: true,
      enum: Object.values(EVENT_INBOX_STATUS),
      default: EVENT_INBOX_STATUS.PENDING,
    },
    outcome: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    quarantineReason: {
      type: String,
      default: null,
      trim: true,
    },
    quarantineDetails: {
      type: Schema.Types.Mixed,
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    processedMarker: {
      type: Schema.Types.Mixed,
      default: null,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lastError: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'campaignEventInbox',
  }
);

// Indexes adhering to Spec Hard Rule 1 & Spec p25
// Unique compound index: {tenantId: 1, producer: 1, eventId: 1}
CampaignEventInboxSchema.index({ tenantId: 1, producer: 1, eventId: 1 }, { unique: true });
CampaignEventInboxSchema.index({ tenantId: 1, status: 1, receivedAt: 1 });
CampaignEventInboxSchema.index({ tenantId: 1, entityId: 1, occurredAt: -1 });
CampaignEventInboxSchema.index({ tenantId: 1, customerId: 1 });
CampaignEventInboxSchema.index({ tenantId: 1, createdAt: -1 });

export const CampaignEventInboxModel =
  mongoose.models.CampaignEventInbox ||
  mongoose.model<ICampaignEventInbox>('CampaignEventInbox', CampaignEventInboxSchema);
