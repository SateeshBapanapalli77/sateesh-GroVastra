import { SourceEnquiry } from '@grovastra/shared';
import { SrcEnquiryModel } from '../db/models/src-enquiry.model';

export interface EnquirySource {
  getEnquiry(tenant: string, enquiryId: string): Promise<SourceEnquiry | null>;
  listOpenByInteractionRange(
    tenant: string,
    fromInstant: Date,
    toInstant: Date,
    cursor?: string | null,
    limit?: number
  ): Promise<{ enquiries: SourceEnquiry[]; nextCursor: string | null }>;
  listForCustomer(tenant: string, customerId: string): Promise<SourceEnquiry[]>;
  listByCustomerId(tenant: string, customerId: string): Promise<SourceEnquiry[]>;
}

export class MockEnquirySource implements EnquirySource {
  async getEnquiry(tenant: string, enquiryId: string): Promise<SourceEnquiry | null> {
    const doc = await SrcEnquiryModel.findOne({ tenantId: tenant, enquiryId }).lean<any>();
    if (!doc) return null;
    return this.mapToSource(doc);
  }

  async listOpenByInteractionRange(
    tenant: string,
    fromInstant: Date,
    toInstant: Date,
    cursor?: string | null,
    limit = 50
  ): Promise<{ enquiries: SourceEnquiry[]; nextCursor: string | null }> {
    const query: any = {
      tenantId: tenant,
      status: 'OPEN',
      lastCustomerInteractionAt: { $gte: fromInstant, $lte: toInstant },
    };

    if (cursor) {
      query._id = { $gt: cursor };
    }

    const docs = await SrcEnquiryModel.find(query)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .lean<any[]>();

    let nextCursor: string | null = null;
    let results = docs;
    if (docs.length > limit) {
      results = docs.slice(0, limit);
      nextCursor = String(results[results.length - 1]._id);
    }

    return {
      enquiries: results.map((d) => this.mapToSource(d)),
      nextCursor,
    };
  }

  async listForCustomer(tenant: string, customerId: string): Promise<SourceEnquiry[]> {
    const docs = await SrcEnquiryModel.find({ tenantId: tenant, customerId })
      .sort({ lastCustomerInteractionAt: -1 })
      .lean<any[]>();
    return docs.map((d) => this.mapToSource(d));
  }

  async listByCustomerId(tenant: string, customerId: string): Promise<SourceEnquiry[]> {
    return this.listForCustomer(tenant, customerId);
  }

  private mapToSource(doc: any): SourceEnquiry {
    return {
      enquiryId: doc.enquiryId,
      tenantId: doc.tenantId,
      customerId: doc.customerId || null,
      branchId: doc.branchId || null,
      channel: doc.channel,
      status: doc.status,
      staffTakeover: Boolean(doc.staffTakeover),
      itemRef: doc.itemRef
        ? {
            productId: doc.itemRef.productId,
            variantId: doc.itemRef.variantId || null,
          }
        : null,
      createdAt: new Date(doc.createdAt),
      lastCustomerInteractionAt: new Date(doc.lastCustomerInteractionAt),
      updatedAt: new Date(doc.updatedAt),
      entityVersion: doc.entityVersion || 1,
      source: 'MOCK',
    };
  }
}

export const mockEnquirySource = new MockEnquirySource();
