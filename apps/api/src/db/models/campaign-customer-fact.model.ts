import mongoose, { Document, Schema } from 'mongoose';

export interface ICampaignCustomerFact extends Document {
  tenantId: string;
  customerId: string;
  orderCount: number;
  totalSpendPaise: number;
  lastOrderAt?: Date | null;
  lastOrderId?: string | null;
  qualifyingOrderCount: number;
  firstQualifyingOrderId?: string | null;
  firstQualifyingOrderNumber?: string | null;
  firstQualifyingAt?: Date | null;
  firstQualifyingNetPaise?: number | null;
  secondQualifyingOrderId?: string | null;
  secondQualifyingAt?: Date | null;
  lastQualifyingOrderId?: string | null;
  lastQualifyingPurchaseOrderId?: string | null;
  lastQualifyingPurchaseAt?: Date | null;
  maxQualifyingOrderCountSeen: number;
  orderSourceVersion: number;
  aggregateVersion: number;
  authoritativeSourceVersions?: {
    customerVersion: number;
    orderVersion: number;
    preferencesVersion?: number;
  };
  nextEvaluationAt?: Date | null;
  categoryPurchases?: Record<string, { lastQualifyingOrderId: string; lastQualifyingPurchaseAt: Date }>;
  sourceVersion: number;
  rebuiltAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignCustomerFactSchema = new Schema<ICampaignCustomerFact>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    customerId: {
      type: String,
      required: true,
      trim: true,
    },
    orderCount: {
      type: Number,
      required: true,
      default: 0,
    },
    totalSpendPaise: {
      type: Number,
      required: true,
      default: 0,
    },
    lastOrderAt: {
      type: Date,
      default: null,
    },
    lastOrderId: {
      type: String,
      default: null,
      trim: true,
    },
    qualifyingOrderCount: {
      type: Number,
      required: true,
      default: 0,
    },
    firstQualifyingOrderId: {
      type: String,
      default: null,
      trim: true,
    },
    firstQualifyingOrderNumber: {
      type: String,
      default: null,
      trim: true,
    },
    firstQualifyingAt: {
      type: Date,
      default: null,
    },
    firstQualifyingNetPaise: {
      type: Number,
      default: null,
    },
    secondQualifyingOrderId: {
      type: String,
      default: null,
      trim: true,
    },
    secondQualifyingAt: {
      type: Date,
      default: null,
    },
    lastQualifyingPurchaseAt: {
      type: Date,
      default: null,
    },
    lastQualifyingOrderId: {
      type: String,
      default: null,
      trim: true,
    },
    lastQualifyingPurchaseOrderId: {
      type: String,
      default: null,
      trim: true,
    },
    maxQualifyingOrderCountSeen: {
      type: Number,
      required: true,
      default: 0,
    },
    orderSourceVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    aggregateVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    authoritativeSourceVersions: {
      customerVersion: { type: Number, default: 1 },
      orderVersion: { type: Number, default: 1 },
      preferencesVersion: { type: Number, default: 1 },
    },
    nextEvaluationAt: {
      type: Date,
      default: null,
    },
    categoryPurchases: {
      type: Schema.Types.Mixed,
      default: {},
    },
    sourceVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    rebuiltAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'campaignCustomerFacts',
  }
);

// Indexes adhering to Spec Hard Rule 1 & Spec p21
CampaignCustomerFactSchema.index({ tenantId: 1, customerId: 1 }, { unique: true });
CampaignCustomerFactSchema.index({ tenantId: 1, lastOrderAt: -1 });
CampaignCustomerFactSchema.index({ tenantId: 1, nextEvaluationAt: 1 });
CampaignCustomerFactSchema.index({ tenantId: 1, lastQualifyingPurchaseAt: 1 });
CampaignCustomerFactSchema.index({ tenantId: 1, qualifyingOrderCount: 1, firstQualifyingAt: 1 });

export const CampaignCustomerFactModel =
  mongoose.models.CampaignCustomerFact ||
  mongoose.model<ICampaignCustomerFact>('CampaignCustomerFact', CampaignCustomerFactSchema);
