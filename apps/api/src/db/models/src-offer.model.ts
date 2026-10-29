import mongoose, { Document, Schema } from 'mongoose';

export interface ISrcOffer extends Document {
  offerId: string;
  tenantId: string;
  kind: 'FLAT_AMOUNT_OFF_NEXT_PURCHASE' | 'SELECTED_STOCK';
  amountPaise?: number;
  name?: string;
  publishedAt?: Date | null;
  discount?: {
    type: 'PERCENT_OFF' | 'FLAT_OFF' | 'SPECIAL_PRICE';
    percent?: number;
    flatOffPaise?: number;
  };
  terms?: string;
  tags?: string[];
  branchIds?: string[];
  items?: Array<{
    productId: string;
    variantIds?: string[] | null;
    offerPricePaise?: number | null;
    position: number;
  }>;
  validFrom: Date;
  validUntil: Date;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'WITHDRAWN' | 'EXPIRED';
  version: number;
  entityVersion?: number;
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SrcOfferSchema = new Schema<ISrcOffer>(
  {
    offerId: {
      type: String,
      required: true,
      trim: true,
    },
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    kind: {
      type: String,
      enum: ['FLAT_AMOUNT_OFF_NEXT_PURCHASE', 'SELECTED_STOCK'],
      required: true,
      default: 'FLAT_AMOUNT_OFF_NEXT_PURCHASE',
    },
    amountPaise: { type: Number },
    validFrom: {
      type: Date,
      required: true,
    },
    validUntil: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'WITHDRAWN', 'EXPIRED'],
      required: true,
      default: 'ACTIVE',
    },
    name: { type: String, trim: true, maxlength: 60 },
    publishedAt: { type: Date, default: null },
    discount: {
      type: new Schema({
        type: { type: String, enum: ['PERCENT_OFF', 'FLAT_OFF', 'SPECIAL_PRICE'] },
        percent: Number,
        flatOffPaise: Number,
      }, { _id: false }),
    },
    terms: { type: String, trim: true, maxlength: 120 },
    tags: { type: [String], default: [] },
    branchIds: { type: [String], default: [] },
    items: {
      type: [new Schema({
        productId: { type: String, required: true },
        variantIds: { type: [String], default: null },
        offerPricePaise: { type: Number, default: null },
        position: { type: Number, required: true },
      }, { _id: false })],
      default: undefined,
    },
    version: {
      type: Number,
      required: true,
      default: 1,
    },
    entityVersion: {
      type: Number,
      default: 1,
    },
    seedGroup: {
      type: String,
      default: 'welcome',
      index: true,
    },
    source: {
      type: String,
      default: 'MOCK',
    },
  },
  {
    timestamps: true,
    collection: 'src_offers',
  }
);

// Indexes adhering to Spec Hard Rule 1
SrcOfferSchema.index({ tenantId: 1, offerId: 1 }, { unique: true });
SrcOfferSchema.index({ tenantId: 1, kind: 1, status: 1, publishedAt: 1 });

export const SrcOfferModel =
  mongoose.models.SrcOffer || mongoose.model<ISrcOffer>('SrcOffer', SrcOfferSchema);
