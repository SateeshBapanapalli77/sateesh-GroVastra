import { ProductStatus, SourceProduct } from '@grovastra/shared';
import { SrcProductModel } from '../db/models/src-product.model';

export interface ProductVariantResult {
  productId: string;
  variantId: string | null;
  displayName: string;
  status: ProductStatus;
  sellableQty: number;
  entityVersion: number;
  isSellable: boolean;
}

export interface ProductSource {
  getProduct(tenant: string, productId: string): Promise<SourceProduct | null>;
  getProductById?(tenant: string, productId: string): Promise<SourceProduct | null>;
  listByCategories(
    tenant: string,
    categories: string[],
    cursor?: string | null,
    limit?: number,
    status?: string
  ): Promise<{ products: SourceProduct[]; nextCursor: string | null }>;
  getVariant(
    tenant: string,
    productId: string,
    variantId?: string | null
  ): Promise<ProductVariantResult | null>;
}

export class MockProductSource implements ProductSource {
  async getProductById(tenant: string, productId: string): Promise<SourceProduct | null> {
    return this.getProduct(tenant, productId);
  }

  async getProduct(tenant: string, productId: string): Promise<SourceProduct | null> {
    const doc = await SrcProductModel.findOne({ tenantId: tenant, productId }).lean<any>();
    if (!doc) return null;
    return {
      tenantId: doc.tenantId,
      productId: doc.productId,
      name: doc.name,
      category: doc.category,
      colourFamily: doc.colourFamily,
      weave: doc.weave,
      pricePaise: doc.pricePaise || 0,
      status: doc.status,
      entityVersion: doc.entityVersion || 1,
      variants: doc.variants || [],
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  async listByCategories(
    tenant: string,
    categories: string[],
    cursor?: string | null,
    limit: number = 50,
    status?: string
  ): Promise<{ products: SourceProduct[]; nextCursor: string | null }> {
    const query: any = { tenantId: tenant };
    if (categories && categories.length > 0) {
      query.category = { $in: categories };
    }
    if (status) {
      query.status = status;
    }
    if (cursor) {
      query.productId = { $gt: cursor };
    }

    const docs = await SrcProductModel.find(query)
      .sort({ productId: 1 })
      .limit(limit + 1)
      .lean<any[]>();

    const hasMore = docs.length > limit;
    const results = hasMore ? docs.slice(0, limit) : docs;
    const nextCursor = hasMore ? results[results.length - 1].productId : null;

    return {
      products: results.map((d) => ({
        tenantId: d.tenantId,
        productId: d.productId,
        name: d.name,
        category: d.category,
        colourFamily: d.colourFamily,
        weave: d.weave,
        pricePaise: d.pricePaise || 0,
        status: d.status,
        entityVersion: d.entityVersion || 1,
        variants: d.variants || [],
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      nextCursor,
    };
  }

  async getVariant(
    tenant: string,
    productId: string,
    variantId?: string | null
  ): Promise<ProductVariantResult | null> {
    const doc = await SrcProductModel.findOne({ tenantId: tenant, productId }).lean<any>();
    if (!doc) return null;

    const isProductActive = doc.status === 'ACTIVE';

    if (variantId) {
      const variant = (doc.variants || []).find((v: any) => v.variantId === variantId);
      if (!variant) return null;

      const sellableQty = Math.max(0, Number(variant.sellableQty) || 0);
      const isSellable = isProductActive && sellableQty > 0;
      const displayName = variant.label ? `${doc.name} - ${variant.label}` : doc.name;

      return {
        productId: doc.productId,
        variantId: variant.variantId,
        displayName,
        status: doc.status,
        sellableQty,
        entityVersion: doc.entityVersion || 1,
        isSellable,
      };
    }

    // null variantId: product is sellable if ANY variant has sellableQty > 0
    const variants = doc.variants || [];
    const totalSellable = variants.reduce(
      (sum: number, v: any) => sum + Math.max(0, Number(v.sellableQty) || 0),
      0
    );
    const hasAnySellableVariant = variants.some(
      (v: any) => Math.max(0, Number(v.sellableQty) || 0) > 0
    );
    const isSellable = isProductActive && hasAnySellableVariant;

    return {
      productId: doc.productId,
      variantId: null,
      displayName: doc.name,
      status: doc.status,
      sellableQty: totalSellable,
      entityVersion: doc.entityVersion || 1,
      isSellable,
    };
  }
}

export const mockProductSource = new MockProductSource();
