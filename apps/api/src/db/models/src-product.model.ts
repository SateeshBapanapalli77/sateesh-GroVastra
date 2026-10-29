import mongoose, { Document, Schema } from 'mongoose';
import { ProductStatus, ProductVariant } from '@grovastra/shared';

export interface ISrcProduct extends Document {
  tenantId: string;
  productId: string;
  name: string;
  category?: string;
  colourFamily?: string | null;
  weave?: string | null;
  pricePaise?: number;
  status: ProductStatus;
  entityVersion: number;
  variants: ProductVariant[];
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProductVariantSchema = new Schema<ProductVariant>(
  {
    variantId: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    sellableQty: { type: Number, required: true, min: 0, default: 0 },
    version: { type: Number, required: true, default: 1 },
    // F26: optional per-variant attributes for size/colour matching
    attributes: {
      type: new Schema({
        size: { type: String, default: undefined, trim: true },
        colourFamily: { type: String, default: undefined, trim: true },
      }, { _id: false }),
      default: undefined,
    },
  },
  { _id: false }
);


const SrcProductSchema = new Schema<ISrcProduct>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    productId: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    colourFamily: {
      type: String,
      default: null,
      trim: true,
    },
    weave: {
      type: String,
      default: null,
      trim: true,
    },
    pricePaise: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'DISCONTINUED'],
      default: 'ACTIVE',
      index: true,
    },
    entityVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    variants: {
      type: [ProductVariantSchema],
      default: [],
    },
    seedGroup: {
      type: String,
      default: null,
      index: true,
    },
    source: {
      type: String,
      default: 'MOCK',
    },
  },
  {
    timestamps: true,
    collection: 'src_products',
  }
);

// Indexes (Spec F23 & F24 Part 1)
// UNIQUE {tenantId, productId}
SrcProductSchema.index({ tenantId: 1, productId: 1 }, { unique: true });
SrcProductSchema.index({ tenantId: 1, category: 1, status: 1 });

export const SrcProductModel =
  mongoose.models.SrcProduct || mongoose.model<ISrcProduct>('SrcProduct', SrcProductSchema);
