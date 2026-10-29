import { SourceOffer } from '@grovastra/shared';
import { SrcOfferModel, ISrcOffer } from '../db/models/src-offer.model';
import { ForbiddenError } from '../errors/app-error';
import { clock } from '../services/clock';

/**
 * OfferSource Adapter Interface (Spec p16)
 * The campaign engine NEVER creates or modifies offers.
 * Steps reference real, valid offers owned by another module.
 */
export interface OfferSource {
  getOfferById(tenantId: string, offerId: string): Promise<SourceOffer | null>;
  listActiveOffers(tenantId: string, atInstant?: Date): Promise<SourceOffer[]>;
  getOffer(tenantId: string, offerId: string): Promise<SourceOffer | null>;
  listActiveByPublishedRange(
    tenantId: string,
    from: Date,
    to: Date,
    cursor?: string | null,
    limit?: number
  ): Promise<{ offers: SourceOffer[]; nextCursor: string | null }>;
}

export function toSourceOffer(doc: ISrcOffer): SourceOffer {
  return {
    id: doc._id.toString(),
    _id: doc._id.toString(),
    offerId: doc.offerId,
    tenantId: doc.tenantId,
    kind: doc.kind,
    amountPaise: doc.amountPaise ?? 0,
    name: doc.name,
    publishedAt: doc.publishedAt,
    discount: doc.discount,
    terms: doc.terms,
    tags: doc.tags,
    branchIds: doc.branchIds,
    items: doc.items,
    validFrom: doc.validFrom,
    validUntil: doc.validUntil,
    status: doc.status,
    version: doc.entityVersion ?? doc.version,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class MockOfferSource implements OfferSource {
  private validateTenant(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new ForbiddenError('Tenant ID is required for OfferSource operations');
    }
  }

  async getOfferById(tenantId: string, offerId: string): Promise<SourceOffer | null> {
    this.validateTenant(tenantId);
    const doc = await SrcOfferModel.findOne({ tenantId, offerId });
    return doc ? toSourceOffer(doc) : null;
  }

  async getOffer(tenantId: string, offerId: string): Promise<SourceOffer | null> {
    return this.getOfferById(tenantId, offerId);
  }

  async listActiveOffers(tenantId: string, atInstant?: Date): Promise<SourceOffer[]> {
    this.validateTenant(tenantId);
    const now = atInstant || clock.now();
    const docs = await SrcOfferModel.find({
      tenantId,
      status: 'ACTIVE',
      validFrom: { $lte: now },
      validUntil: { $gte: now },
    }).sort({ validUntil: 1 });

    return docs.map(toSourceOffer);
  }

  async listActiveByPublishedRange(
    tenantId: string,
    from: Date,
    to: Date,
    cursor?: string | null,
    limit = 100
  ): Promise<{ offers: SourceOffer[]; nextCursor: string | null }> {
    const query: Record<string, unknown> = {
      tenantId,
      kind: 'SELECTED_STOCK',
      status: 'ACTIVE',
      publishedAt: { $gte: from, $lte: to },
    };
    if (cursor) query.offerId = { $gt: cursor };
    const docs = await SrcOfferModel.find(query).sort({ offerId: 1 }).limit(limit + 1).lean<ISrcOffer[]>();
    const hasMore = docs.length > limit;
    const rows = hasMore ? docs.slice(0, limit) : docs;
    return { offers: rows.map((doc) => toSourceOffer(doc)), nextCursor: hasMore ? rows[rows.length - 1].offerId : null };
  }
}

export const mockOfferSource = new MockOfferSource();
