import mongoose, { Document, Schema } from 'mongoose';
import { EnquiryChannel, EnquiryStatus } from '@grovastra/shared';

export interface ISrcEnquiry extends Document {
  enquiryId: string;
  tenantId: string;
  customerId?: string | null;
  branchId?: string | null;
  channel: EnquiryChannel;
  status: EnquiryStatus;
  staffTakeover: boolean;
  itemRef?: {
    productId: string;
    variantId?: string | null;
  } | null;
  createdAt: Date;
  lastCustomerInteractionAt: Date;
  updatedAt: Date;
  entityVersion: number;
  source: 'MOCK';
  seedGroup?: string | null;
}

const ItemRefSchema = new Schema(
  {
    productId: { type: String, required: true, trim: true },
    variantId: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const SrcEnquirySchema = new Schema<ISrcEnquiry>(
  {
    enquiryId: {
      type: String,
      required: true,
      trim: true,
    },
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    customerId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    branchId: {
      type: String,
      default: null,
      trim: true,
    },
    channel: {
      type: String,
      enum: ['IN_STORE', 'PHONE', 'WHATSAPP', 'OTHER'],
      default: 'IN_STORE',
    },
    status: {
      type: String,
      enum: ['OPEN', 'RESOLVED', 'CLOSED', 'CANCELLED', 'DELETED'],
      default: 'OPEN',
      index: true,
    },
    staffTakeover: {
      type: Boolean,
      default: false,
    },
    itemRef: {
      type: ItemRefSchema,
      default: null,
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    lastCustomerInteractionAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    updatedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    entityVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    source: {
      type: String,
      default: 'MOCK',
    },
    seedGroup: {
      type: String,
      default: 'unresolved-enquiry',
      index: true,
    },
  },
  {
    timestamps: false, // We control updatedAt and lastCustomerInteractionAt explicitly
    collection: 'src_enquiries',
  }
);

// Indexes (Spec F23 Part 1)
// UNIQUE {tenantId, enquiryId}
SrcEnquirySchema.index({ tenantId: 1, enquiryId: 1 }, { unique: true });
// {tenantId, status, lastCustomerInteractionAt}
SrcEnquirySchema.index({ tenantId: 1, status: 1, lastCustomerInteractionAt: 1 });
// {tenantId, customerId, status}
SrcEnquirySchema.index({ tenantId: 1, customerId: 1, status: 1 });

export const SrcEnquiryModel =
  mongoose.models.SrcEnquiry || mongoose.model<ISrcEnquiry>('SrcEnquiry', SrcEnquirySchema);
