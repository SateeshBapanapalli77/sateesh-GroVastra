import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { PRODUCT_CATEGORIES, COLOUR_FAMILIES, WEAVES } from '@grovastra/shared';
import { SrcProductModel } from '../db/models/src-product.model';
import { ValidationError, NotFoundError } from '../errors/app-error';

export const mockProductDevRouter = Router();

// Dev-only guard: 404 in production
mockProductDevRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dev endpoints not available in production' } });
  }
  next();
});

/**
 * Dev-only: POST /dev/mock-products & /api/v1/dev/mock-products
 * Validates category, colourFamily, weave against controlled constants.
 * Unknown controlled values -> 422 PRODUCT_ATTRIBUTE_UNKNOWN.
 */
mockProductDevRouter.post(
  ['/dev/mock-products', '/api/v1/dev/mock-products'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || req.body?.tenantId || 'shop_a';
      const {
        productId: customProductId,
        name,
        category,
        status = 'ACTIVE',
        colourFamily,
        weave,
        pricePaise = 0,
        variants = [],
      } = req.body;

      if (!name || typeof name !== 'string') {
        throw new ValidationError('Product name is required');
      }

      // Validation 1: Category
      if (!category || !PRODUCT_CATEGORIES.includes(category.toLowerCase() as any)) {
        return res.status(422).json({
          error: 'PRODUCT_ATTRIBUTE_UNKNOWN',
          field: 'category',
          value: category,
          allowedValues: PRODUCT_CATEGORIES,
          message: `Unknown product category '${category}'`,
        });
      }

      // Validation 2: Colour Family (if provided)
      if (colourFamily && !COLOUR_FAMILIES.includes(colourFamily.toLowerCase() as any)) {
        return res.status(422).json({
          error: 'PRODUCT_ATTRIBUTE_UNKNOWN',
          field: 'colourFamily',
          value: colourFamily,
          allowedValues: COLOUR_FAMILIES,
          message: `Unknown colour family '${colourFamily}'`,
        });
      }

      // Validation 3: Weave (if provided)
      if (weave && !WEAVES.includes(weave.toLowerCase() as any)) {
        return res.status(422).json({
          error: 'PRODUCT_ATTRIBUTE_UNKNOWN',
          field: 'weave',
          value: weave,
          allowedValues: WEAVES,
          message: `Unknown weave '${weave}'`,
        });
      }

      const productId = customProductId || `prod_${crypto.randomUUID().slice(0, 10)}`;
      const normVariants =
        Array.isArray(variants) && variants.length > 0
          ? variants.map((v: any, idx: number) => ({
              variantId: v.variantId || `var_${idx + 1}`,
              label: v.label || `Standard`,
              sellableQty: Math.max(0, Number(v.sellableQty ?? 1)),
              version: 1,
            }))
          : [
              {
                variantId: 'var_std',
                label: 'Standard',
                sellableQty: 5,
                version: 1,
              },
            ];

      const product = await (SrcProductModel as any).collection.insertOne({
        tenantId,
        productId,
        name,
        category: category.toLowerCase(),
        colourFamily: colourFamily ? colourFamily.toLowerCase() : null,
        weave: weave ? weave.toLowerCase() : null,
        pricePaise: Number(pricePaise || 0),
        status,
        entityVersion: 1,
        variants: normVariants,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const createdDoc = await SrcProductModel.findOne({ tenantId, productId }).lean();
      res.status(201).json(createdDoc || { productId, name, category, status });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Dev-only: POST /dev/mock-products/:productId/variants/:variantId/stock & /api/v1/dev/mock-products/:productId/variants/:variantId/stock
 * Updates sellableQty on the variant.
 */
mockProductDevRouter.post(
  [
    '/dev/mock-products/:productId/variants/:variantId/stock',
    '/api/v1/dev/mock-products/:productId/variants/:variantId/stock',
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || (req.body && req.body.tenantId) || 'shop_a';
      const { productId, variantId } = req.params;
      const { sellableQty } = req.body;

      if (sellableQty === undefined || typeof sellableQty !== 'number' || sellableQty < 0) {
        throw new ValidationError('sellableQty must be a non-negative number');
      }

      const product = await SrcProductModel.findOne({ tenantId, productId });
      if (!product) {
        throw new NotFoundError(`Product '${productId}' not found`);
      }

      const variant = (product.variants || []).find((v: any) => v.variantId === variantId);
      if (!variant) {
        throw new NotFoundError(`Variant '${variantId}' not found on product '${productId}'`);
      }

      variant.sellableQty = sellableQty;
      const nextVersion = (product.entityVersion || 1) + 1;

      await (SrcProductModel as any).collection.updateOne(
        { tenantId, productId, 'variants.variantId': variantId },
        {
          $set: {
            'variants.$.sellableQty': sellableQty,
            entityVersion: nextVersion,
            updatedAt: new Date(),
          },
        }
      );

      res.status(200).json({
        ok: true,
        productId,
        variantId,
        sellableQty,
        entityVersion: nextVersion,
      });
    } catch (err) {
      next(err);
    }
  }
);
