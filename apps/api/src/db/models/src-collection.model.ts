/**
 * src_collections Model — F26 Matching Collection
 *
 * Stores owner-published catalogue releases. Each `collection.published` event
 * upserts a record here. A `collection.withdrawn` event sets status → WITHDRAWN.
 *
 * Released collection contains:
 *   - items[]: [{productId, variantId?, name, category, sellableQtyAfter}]
 *   - metadata (title, description, previewImageUrl)
 *   - status: ACTIVE | WITHDRAWN
 *   - publishedAt / withdrawnAt
 *
 * Tenant isolation: every query MUST include {tenantId}.
 */
import mongoose, { Document, Schema } from 'mongoose';

export type CollectionStatus = 'ACTIVE' | 'WITHDRAWN';

export interface CollectionItem {
  productId: string;
  variantId?: string | null;
  name: string;
  /** Normalised category from PRODUCT_CATEGORIES (lower-cased) */
  category?: string | null;
  /** Colour family of the item (lower-cased) */
  colourFamily?: string | null;
  /** Weave type of the item (lower-cased) */
  weave?: string | null;
  /** Size attribute (from product variant, lower-cased) */
  size?: string | null;
  /** Sellable qty at time of publication */
  sellableQtyAfter?: number;
  /** Price in minor units (paise) */
  pricePaise?: number;
}

export interface ISrcCollection extends Document {
  tenantId: string;
  releaseId: string;
  title?: string | null;
  description?: string | null;
  previewImageUrl?: string | null;
  branchId?: string | null;
  status: CollectionStatus;
  /** Item categories represented in this collection (de-duped) */
  categories: string[];
  items: CollectionItem[];
  publishedAt: Date;
  withdrawnAt?: Date | null;
  entityVersion: number;
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const CollectionItemSchema = new Schema<CollectionItem>(
  {
    productId: { type: String, required: true, trim: true },
    variantId: { type: String, default: null, trim: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, default: null, trim: true },
    colourFamily: { type: String, default: null, trim: true },
    weave: { type: String, default: null, trim: true },
    size: { type: String, default: null, trim: true },
    sellableQtyAfter: { type: Number, default: 0 },
    pricePaise: { type: Number, default: 0 },
  },
  { _id: false }
);

const SrcCollectionSchema = new Schema<ISrcCollection>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    releaseId: {
      type: String,
      required: true,
      trim: true,
    },
    title: {
      type: String,
      default: null,
      trim: true,
    },
    description: {
      type: String,
      default: null,
      trim: true,
    },
    previewImageUrl: {
      type: String,
      default: null,
      trim: true,
    },
    branchId: {
      type: String,
      default: null,
      trim: true,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'WITHDRAWN'],
      default: 'ACTIVE',
      required: true,
    },
    categories: {
      type: [String],
      default: [],
    },
    items: {
      type: [CollectionItemSchema],
      default: [],
    },
    publishedAt: {
      type: Date,
      required: true,
    },
    withdrawnAt: {
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
    source: {
      type: String,
      default: 'MOCK',
    },
  },
  {
    timestamps: true,
    collection: 'src_collections',
  }
);

// Tenant + release unique identity
SrcCollectionSchema.index({ tenantId: 1, releaseId: 1 }, { unique: true });
// Query active releases by tenant
SrcCollectionSchema.index({ tenantId: 1, status: 1, publishedAt: -1 });
// Query by tenant + branch
SrcCollectionSchema.index({ tenantId: 1, branchId: 1, status: 1 });
// Query by category relevance (for fan-out selection)
SrcCollectionSchema.index({ tenantId: 1, categories: 1, status: 1 });

export const SrcCollectionModel =
  mongoose.models.SrcCollection ||
  mongoose.model<ISrcCollection>('SrcCollection', SrcCollectionSchema);
