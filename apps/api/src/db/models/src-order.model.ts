import mongoose, { Document, Schema } from 'mongoose';
import { OrderLine } from '@grovastra/shared';

export interface ISrcOrder extends Document {
  tenantId: string;
  orderId: string;
  orderNumber?: string | null;
  customerId?: string | null;
  status: string;
  paid: boolean;
  netPaise: number;
  grossPaise?: number | null;
  refundedPaise?: number | null;
  occasionRef?: string | null;
  enquiryRef?: string | null;
  outfitRef?: string | null;
  lines: OrderLine[];
  entityVersion: number;
  completedAt: Date | null;
  branchId?: string;
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const OrderLineSchema = new Schema<OrderLine>(
  {
    lineId: { type: String, required: true },
    itemRef: { type: String, required: false, default: '' },
    name: { type: String, required: false, default: '' },
    quantity: { type: Number, default: 1 },
    qty: { type: Number, default: 1 },
    pricePaise: { type: Number, default: 0 },
    lineNetPaise: { type: Number, default: 0 },
    returnedQty: { type: Number, default: 0 },
    productId: { type: String, default: null, trim: true },
    variantId: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const SrcOrderSchema = new Schema<ISrcOrder>(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    orderId: {
      type: String,
      required: true,
      trim: true,
    },
    orderNumber: {
      type: String,
      default: null,
      trim: true,
    },
    customerId: {
      type: String,
      required: false,
      default: null,
      index: true,
      trim: true,
    },
    status: {
      type: String,
      required: true,
      trim: true,
      default: 'COMPLETED',
    },
    paid: {
      type: Boolean,
      required: true,
      default: false,
    },
    netPaise: {
      type: Number,
      required: true,
      default: 0,
    },
    grossPaise: {
      type: Number,
      default: null,
    },
    refundedPaise: {
      type: Number,
      default: 0,
    },
    occasionRef: {
      type: String,
      default: null,
      trim: true,
    },
    enquiryRef: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    outfitRef: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    lines: {
      type: [OrderLineSchema],
      default: [],
    },
    entityVersion: {
      type: Number,
      default: 1,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    branchId: {
      type: String,
      trim: true,
    },
    seedGroup: {
      type: String,
      default: 'core',
      index: true,
    },
    source: {
      type: String,
      default: 'MOCK',
    },
  },
  {
    timestamps: true,
    collection: 'src_orders',
  }
);

// Indexes
SrcOrderSchema.index({ tenantId: 1, orderId: 1 }, { unique: true });
SrcOrderSchema.index({ tenantId: 1, customerId: 1 });
SrcOrderSchema.index({ tenantId: 1, occasionRef: 1 });
SrcOrderSchema.index({ tenantId: 1, enquiryRef: 1 });
SrcOrderSchema.index({ tenantId: 1, outfitRef: 1 });
SrcOrderSchema.index({ tenantId: 1, completedAt: -1 });
SrcOrderSchema.index({ tenantId: 1, status: 1, completedAt: -1 });

export const SrcOrderModel =
  mongoose.models.SrcOrder || mongoose.model<ISrcOrder>('SrcOrder', SrcOrderSchema);
