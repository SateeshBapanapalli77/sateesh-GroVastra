import mongoose, { Document, Schema } from 'mongoose';
import { SourceCredit } from '@grovastra/shared';

export interface ISrcCredit extends Document {
  tenantId: string;
  creditId: string;
  customerId: string;
  type: 'POINTS' | 'CASHBACK';
  unit: 'POINTS' | 'PAISE';
  amount: number;
  originalAmount: number;
  issuedAt: Date;
  expiresAt: Date;
  status: 'ACTIVE' | 'REDEEMED' | 'EXPIRED' | 'REVOKED';
  reason: string;
  sourceOrderId?: string | null;
  entityVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const SrcCreditSchema = new Schema<ISrcCredit>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    creditId: {
      type: String,
      required: true,
      trim: true,
    },
    customerId: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['POINTS', 'CASHBACK'],
      required: true,
      default: 'CASHBACK',
    },
    unit: {
      type: String,
      enum: ['POINTS', 'PAISE'],
      required: true,
      default: 'PAISE',
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    originalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    issuedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'REDEEMED', 'EXPIRED', 'REVOKED'],
      required: true,
      default: 'ACTIVE',
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    sourceOrderId: {
      type: String,
      default: null,
      trim: true,
    },
    entityVersion: {
      type: Number,
      required: true,
      default: 1,
    },
  },
  {
    timestamps: true,
    collection: 'src_credits',
  }
);

// Indexes adhering to Spec Hard Rule 1 & Ledger Boundary:
// UNIQUE {tenantId, creditId}; {tenantId, customerId, status, expiresAt}; {tenantId, status, expiresAt}
SrcCreditSchema.index({ tenantId: 1, creditId: 1 }, { unique: true });
SrcCreditSchema.index({ tenantId: 1, customerId: 1, status: 1, expiresAt: 1 });
SrcCreditSchema.index({ tenantId: 1, status: 1, expiresAt: 1 });

export const SrcCreditModel =
  mongoose.models.SrcCredit || mongoose.model<ISrcCredit>('SrcCredit', SrcCreditSchema);
