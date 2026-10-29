import mongoose, { Document, Schema } from 'mongoose';
import { DELIVERY_INTENT_STATE, DeliveryIntentState } from '@grovastra/shared';

export interface ICampaignDeliveryIntent extends Document {
  deliveryIntentId: string;
  tenantId: string;
  campaignId: string;
  enrollmentId: string;
  executionId: string;
  deliveryKey: string;
  connectionId: string;
  recipientVersion: number;
  encryptedRecipient: string;
  maskedRecipient: string;
  templateRef: {
    id: string;
    revision: number;
    language: string;
  };
  parameters: Record<string, string | number> | Array<{ index: number; text: string }>;
  payloadHash: string;
  hashVersion?: number;
  selectionSnapshot?: any;
  state: DeliveryIntentState | string;
  attemptId: string;
  providerMessageId?: string | null;
  failureReason?: string | null;
  lastErrorCategory?: string | null;
  retryAt?: Date | null;
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
  createdAt: Date;
  updatedAt: Date;
}

const CampaignDeliveryIntentSchema = new Schema<ICampaignDeliveryIntent>(
  {
    deliveryIntentId: {
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
    executionId: {
      type: String,
      required: true,
      trim: true,
    },
    deliveryKey: {
      type: String,
      required: true,
      trim: true,
    },
    connectionId: {
      type: String,
      required: true,
      trim: true,
    },
    recipientVersion: {
      type: Number,
      required: true,
    },
    encryptedRecipient: {
      type: String,
      required: true,
    },
    maskedRecipient: {
      type: String,
      required: true,
      trim: true,
    },
    templateRef: {
      id: { type: String, required: true, trim: true },
      revision: { type: Number, required: true },
      language: { type: String, required: true, trim: true },
    },
    parameters: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
    payloadHash: {
      type: String,
      required: true,
      trim: true,
    },
    hashVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    selectionSnapshot: {
      type: Schema.Types.Mixed,
      default: null,
    },
    state: {
      type: String,
      required: true,
      default: DELIVERY_INTENT_STATE.PREPARED_DRY,
    },
    attemptId: {
      type: String,
      required: true,
      trim: true,
    },
    providerMessageId: {
      type: String,
      default: null,
    },
    failureReason: {
      type: String,
      default: null,
    },
    lastErrorCategory: {
      type: String,
      default: null,
    },
    retryAt: {
      type: Date,
      default: null,
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
  },
  {
    timestamps: true,
    collection: 'campaignDeliveryIntents',
  }
);

// Spec p25, p18: Unique index on (tenantId, executionId)
CampaignDeliveryIntentSchema.index({ tenantId: 1, executionId: 1 }, { unique: true });
CampaignDeliveryIntentSchema.index({ tenantId: 1, deliveryIntentId: 1 }, { unique: true });
CampaignDeliveryIntentSchema.index({ tenantId: 1, campaignId: 1, state: 1 });
CampaignDeliveryIntentSchema.index({ tenantId: 1, providerMessageId: 1 });

// Immutability guard for frozen payload fields
// Once created, frozen payload fields (recipientVersion, exact template revision, parameters, payloadHash, deliveryKey = executionId) must NEVER be rewritten (Spec p19, p20)
const FROZEN_FIELDS = [
  'recipientVersion',
  'encryptedRecipient',
  'templateRef',
  'parameters',
  'payloadHash',
  'deliveryKey',
  'executionId',
  'tenantId',
  'campaignId',
  'enrollmentId',
];

CampaignDeliveryIntentSchema.pre('save', function (next) {
  if (!this.isNew) {
    for (const field of FROZEN_FIELDS) {
      if (this.isModified(field)) {
        return next(
          new Error(`Field '${field}' on CampaignDeliveryIntent is frozen and immutable.`)
        );
      }
    }
  }
  next();
});

const queryIntentGuard = function (this: any) {
  const update = this.getUpdate ? this.getUpdate() : null;
  if (!update) return;
  const modifiedKeys = Object.keys(update.$set || update);
  for (const field of FROZEN_FIELDS) {
    if (modifiedKeys.includes(field) || modifiedKeys.some((k: string) => k.startsWith(`${field}.`))) {
      throw new Error(`Field '${field}' on CampaignDeliveryIntent is frozen and immutable.`);
    }
  }
};

CampaignDeliveryIntentSchema.pre('updateOne', queryIntentGuard);
CampaignDeliveryIntentSchema.pre('updateMany', queryIntentGuard);
CampaignDeliveryIntentSchema.pre('findOneAndUpdate', queryIntentGuard);

export const CampaignDeliveryIntentModel =
  mongoose.models.CampaignDeliveryIntent ||
  mongoose.model<ICampaignDeliveryIntent>('CampaignDeliveryIntent', CampaignDeliveryIntentSchema);
