import mongoose, { Document, Schema } from 'mongoose';

export type ContactLedgerStatus = 'RESERVED' | 'ACCEPTED' | 'UNKNOWN' | 'RELEASED';
export type ContactLedgerPurpose = 'MARKETING' | 'SERVICE';

export interface ICampaignContactLedgerEntry {
  executionId: string;
  campaignId: string;
  purpose: ContactLedgerPurpose;
  reservedAt: Date;
  status: ContactLedgerStatus;
  releasedAt?: Date | null;
  releaseReason?: string | null;
  updatedAt: Date;
}

export interface IDestinationHealth {
  status: 'OK' | 'UNDELIVERABLE';
  reason?: string | null;
  lastFailureAt?: Date | null;
  failureCount: number;
  source?: 'PROVIDER_STATUS' | 'STAFF' | 'CUSTOMER_REPLY' | null;
  clearedAt?: Date | null;
}

export interface ICampaignContactGate extends Document {
  tenantId: string;
  destinationHash: string;
  version: number;
  health: IDestinationHealth;
  ledger: ICampaignContactLedgerEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const DestinationHealthSchema = new Schema<IDestinationHealth>(
  {
    status: {
      type: String,
      enum: ['OK', 'UNDELIVERABLE'],
      default: 'OK',
      required: true,
    },
    reason: { type: String, default: null },
    lastFailureAt: { type: Date, default: null },
    failureCount: { type: Number, default: 0 },
    source: {
      type: String,
      enum: ['PROVIDER_STATUS', 'STAFF', 'CUSTOMER_REPLY'],
      default: null,
    },
    clearedAt: { type: Date, default: null },
  },
  { _id: false }
);

const CampaignContactLedgerEntrySchema = new Schema<ICampaignContactLedgerEntry>(
  {
    executionId: {
      type: String,
      required: true,
      trim: true,
    },
    campaignId: {
      type: String,
      required: true,
      trim: true,
    },
    purpose: {
      type: String,
      enum: ['MARKETING', 'SERVICE'],
      default: 'MARKETING',
      required: true,
    },
    reservedAt: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['RESERVED', 'ACCEPTED', 'UNKNOWN', 'RELEASED'],
      default: 'RESERVED',
      required: true,
    },
    releasedAt: {
      type: Date,
      default: null,
    },
    releaseReason: {
      type: String,
      default: null,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const CampaignContactGateSchema = new Schema<ICampaignContactGate>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    destinationHash: {
      type: String,
      required: true,
      trim: true,
    },
    version: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    ledger: {
      type: [CampaignContactLedgerEntrySchema],
      default: [],
    },
    health: {
      type: DestinationHealthSchema,
      default: () => ({ status: 'OK', failureCount: 0 }),
    },
  },
  {
    timestamps: true,
    collection: 'campaignContactGates',
  }
);

// Spec p25: db.campaignContactGates.createIndex({ tenantId: 1, destinationHash: 1 }, { unique: true });
CampaignContactGateSchema.index({ tenantId: 1, destinationHash: 1 }, { unique: true });
CampaignContactGateSchema.index({ tenantId: 1, 'health.status': 1 });

export const CampaignContactGateModel =
  mongoose.models.CampaignContactGate ||
  mongoose.model<ICampaignContactGate>('CampaignContactGate', CampaignContactGateSchema);
