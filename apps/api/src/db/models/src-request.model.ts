import mongoose, { Document, Schema } from 'mongoose';

export type RequestStatus = 'OPEN' | 'FULFILLED' | 'CANCELLED' | 'EXPIRED';
export type RequestSource = 'CUSTOMER_DECLARED' | 'STAFF_ON_BEHALF' | 'MOCK';

export interface ISrcRequest extends Document {
  requestId: string;
  tenantId: string;
  customerId: string;
  branchId?: string | null;
  status: RequestStatus;
  source: RequestSource;
  declaredByCustomer: boolean;
  itemRef: {
    productId: string;
    variantId?: string | null;
  };
  conditions?: {
    size?: string | null;
    colourFamily?: string | null;
    weave?: string | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date | null;
  entityVersion: number;
  seedGroup?: string | null;
}

const ConditionsSchema = new Schema(
  {
    size: { type: String, default: null },
    colourFamily: { type: String, default: null },
    weave: { type: String, default: null },
  },
  { _id: false }
);

const ItemRefSchema = new Schema(
  {
    productId: { type: String, required: true, trim: true },
    variantId: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const SrcRequestSchema = new Schema<ISrcRequest>(
  {
    requestId: {
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
      required: true,
      trim: true,
      index: true,
    },
    branchId: {
      type: String,
      default: null,
      trim: true,
    },
    status: {
      type: String,
      enum: ['OPEN', 'FULFILLED', 'CANCELLED', 'EXPIRED'],
      default: 'OPEN',
      index: true,
    },
    source: {
      type: String,
      enum: ['CUSTOMER_DECLARED', 'STAFF_ON_BEHALF', 'MOCK'],
      default: 'MOCK',
    },
    declaredByCustomer: {
      type: Boolean,
      default: true,
    },
    itemRef: {
      type: ItemRefSchema,
      required: true,
    },
    conditions: {
      type: ConditionsSchema,
      default: null,
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    entityVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    seedGroup: {
      type: String,
      default: null,
      index: true,
    },
  },
  {
    timestamps: false, // We control updatedAt explicitly
    collection: 'src_requests',
  }
);

// Indexes
// UNIQUE {tenantId, requestId}
SrcRequestSchema.index({ tenantId: 1, requestId: 1 }, { unique: true });
// {tenantId, customerId, status}
SrcRequestSchema.index({ tenantId: 1, customerId: 1, status: 1 });
// {tenantId, 'itemRef.productId', status} — for stock.published fan-out
SrcRequestSchema.index({ tenantId: 1, 'itemRef.productId': 1, status: 1 });
// {tenantId, 'itemRef.productId', 'itemRef.variantId', status} — variant-level lookup
SrcRequestSchema.index({ tenantId: 1, 'itemRef.productId': 1, 'itemRef.variantId': 1, status: 1 });

export const SrcRequestModel =
  mongoose.models.SrcRequest || mongoose.model<ISrcRequest>('SrcRequest', SrcRequestSchema);
