import mongoose, { Document, Schema } from 'mongoose';
import { ExecutionState, EXECUTION_STATE, Prerequisite, PREREQUISITE } from '@grovastra/shared';

export interface ICampaignExecution extends Document {
  executionId: string;
  executionKey: string;
  tenantId: string;
  campaignId: string;
  enrollmentId: string;
  customerId?: string;
  stepId: string;
  stepName?: string;
  dueAt: Date;
  originalDueAt: Date;
  rawDueAt?: Date | null;
  adjustedDueAt?: Date | null;
  expiresAt: Date;
  latestUsefulAt?: Date | null;
  usefulUntilReason?: string | null;
  delaySpec?: {
    unit: 'HOURS' | 'DAYS';
    value: number;
  } | null;
  deferralReason?: string | null;
  offerRef?: {
    offerId: string;
    version?: number;
  } | null;
  selectionSnapshot?: {
    offerId: string;
    offerVersion: number;
    items: Array<{
      productId: string;
      variantId: string | null;
      regularPricePaise: number;
      offerPricePaise: number;
      entityVersion: number;
    }>;
    matchReasons: string[];
  } | null;
  creditRef?: {
    creditId: string;
    version?: number;
  } | null;
  orderRef?: string | null;
  relativeToAnchorHours?: number | null;
  localDate: string;
  localTime: string;
  timezone: string;
  planRevision: number;
  state: ExecutionState;
  skipReason: string | null;
  prerequisite: Prerequisite;
  templateRef?: {
    id: string;
    revision: number;
    language: string;
  } | null;
  deliveryIntentId: string | null;
  providerMessageId?: string | null;
  providerStatus?: string | null;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  readAt?: Date | null;
  failedAt?: Date | null;
  statusHistory?: Array<{
    status: string;
    timestamp: Date;
    providerMessageId?: string | null;
    raw?: any;
  }>;
  lastErrorCategory?: string | null;
  retryAt?: Date | null;
  attemptCount?: number;
  attempts?: Array<{
    attemptId: string;
    attemptNumber: number;
    attemptedAt: Date;
    state: string;
    providerMessageId?: string | null;
    errorCategory?: string | null;
    errorCode?: number | null;
    errorMessage?: string | null;
  }>;
  lease?: {
    token: string | null;
    until: Date | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

const CampaignExecutionSchema = new Schema<ICampaignExecution>(
  {
    executionId: {
      type: String,
      required: true,
      trim: true,
    },
    executionKey: {
      type: String,
      required: true,
      trim: true,
    },
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
    enrollmentId: {
      type: String,
      required: true,
      trim: true,
    },
    customerId: {
      type: String,
      trim: true,
      index: true,
    },
    stepId: {
      type: String,
      required: true,
      trim: true,
    },
    stepName: {
      type: String,
      trim: true,
    },
    dueAt: {
      type: Date,
      required: true,
    },
    originalDueAt: {
      type: Date,
      required: true,
    },
    rawDueAt: {
      type: Date,
      default: null,
    },
    adjustedDueAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    latestUsefulAt: {
      type: Date,
      default: null,
    },
    usefulUntilReason: {
      type: String,
      default: null,
    },
    delaySpec: {
      unit: { type: String, enum: ['HOURS', 'DAYS'] },
      value: { type: Number },
    },
    deferralReason: {
      type: String,
      default: null,
    },
    offerRef: {
      type: Schema.Types.Mixed,
      default: null,
    },
    selectionSnapshot: {
      type: Schema.Types.Mixed,
      default: null,
    },
    creditRef: {
      type: Schema.Types.Mixed,
      default: null,
    },
    orderRef: {
      type: String,
      default: null,
      trim: true,
    },
    relativeToAnchorHours: {
      type: Number,
      default: null,
    },
    localDate: {
      type: String,
      required: true,
      trim: true,
    },
    localTime: {
      type: String,
      required: true,
      trim: true,
    },
    timezone: {
      type: String,
      required: true,
      trim: true,
    },
    planRevision: {
      type: Number,
      default: 1,
      required: true,
    },
    state: {
      type: String,
      enum: Object.values(EXECUTION_STATE),
      default: EXECUTION_STATE.SCHEDULED,
      required: true,
    },
    skipReason: {
      type: String,
      default: null,
    },
    prerequisite: {
      type: String,
      enum: Object.values(PREREQUISITE),
      default: PREREQUISITE.NONE,
      required: true,
    },
    templateRef: {
      id: { type: String, trim: true },
      revision: { type: Number },
      language: { type: String, trim: true },
    },
    deliveryIntentId: {
      type: String,
      default: null,
    },
    providerMessageId: {
      type: String,
      default: null,
    },
    providerStatus: {
      type: String,
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    readAt: {
      type: Date,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
    statusHistory: [
      {
        status: { type: String, required: true },
        timestamp: { type: Date, required: true },
        providerMessageId: { type: String, default: null },
        raw: { type: Schema.Types.Mixed, default: null },
      },
    ],
    lastErrorCategory: {
      type: String,
      default: null,
    },
    retryAt: {
      type: Date,
      default: null,
    },
    attemptCount: {
      type: Number,
      default: 0,
    },
    attempts: [
      {
        attemptId: { type: String, required: true },
        attemptNumber: { type: Number, required: true },
        attemptedAt: { type: Date, default: Date.now },
        state: { type: String, required: true },
        providerMessageId: { type: String, default: null },
        errorCategory: { type: String, default: null },
        errorCode: { type: Number, default: null },
        errorMessage: { type: String, default: null },
      },
    ],
    lease: {
      token: { type: String, default: null },
      until: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
    collection: 'campaignExecutions',
  }
);

// Indexes strictly adhering to Spec p25, p18
// executionKey = enrollmentId + stableStepId
CampaignExecutionSchema.index({ tenantId: 1, enrollmentId: 1, stepId: 1 }, { unique: true });
CampaignExecutionSchema.index({ state: 1, dueAt: 1, _id: 1 });
CampaignExecutionSchema.index({ tenantId: 1, executionId: 1 }, { unique: true });
CampaignExecutionSchema.index({ tenantId: 1, executionKey: 1 }, { unique: true });
CampaignExecutionSchema.index({ tenantId: 1, campaignId: 1, state: 1, dueAt: 1 });
CampaignExecutionSchema.index({ tenantId: 1, providerMessageId: 1 });

export const CampaignExecutionModel =
  mongoose.models.CampaignExecution ||
  mongoose.model<ICampaignExecution>('CampaignExecution', CampaignExecutionSchema);
