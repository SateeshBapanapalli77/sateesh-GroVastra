import { SrcRequestModel, ISrcRequest, RequestStatus } from '../db/models/src-request.model';

export interface SourceRequest {
  requestId: string;
  tenantId: string;
  customerId: string;
  branchId?: string | null;
  status: RequestStatus;
  source: string;
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
}

export interface RequestSource {
  getRequest(tenantId: string, requestId: string): Promise<SourceRequest | null>;
  listOpenByProductId(
    tenantId: string,
    productId: string,
    variantId?: string | null
  ): Promise<SourceRequest[]>;
  listOpenByCustomerId(tenantId: string, customerId: string): Promise<SourceRequest[]>;
  listAllOpen(tenantId: string): Promise<SourceRequest[]>;
}

export class MockRequestSource implements RequestSource {
  async getRequest(tenantId: string, requestId: string): Promise<SourceRequest | null> {
    const doc = await SrcRequestModel.findOne({ tenantId, requestId }).lean<any>();
    if (!doc) return null;
    return this.mapToSource(doc);
  }

  async listAllOpen(tenantId: string): Promise<SourceRequest[]> {
    const docs = await SrcRequestModel.find({ tenantId, status: 'OPEN' })
      .sort({ createdAt: 1 })
      .lean<any[]>();
    return docs.map((d) => this.mapToSource(d));
  }

  async listOpenByProductId(
    tenantId: string,
    productId: string,
    variantId?: string | null
  ): Promise<SourceRequest[]> {
    const query: any = {
      tenantId,
      status: 'OPEN',
    };
    if (productId) {
      query['itemRef.productId'] = productId;
    }

    // Narrow to specific variant only when variantId is provided
    if (variantId) {
      query.$or = [
        { 'itemRef.variantId': variantId },
        { 'itemRef.variantId': null },
      ];
    }

    const docs = await SrcRequestModel.find(query).sort({ createdAt: 1 }).lean<any[]>();
    return docs.map((d) => this.mapToSource(d));
  }

  async listOpenByCustomerId(tenantId: string, customerId: string): Promise<SourceRequest[]> {
    const docs = await SrcRequestModel.find({
      tenantId,
      customerId,
      status: 'OPEN',
    })
      .sort({ createdAt: -1 })
      .lean<any[]>();
    return docs.map((d) => this.mapToSource(d));
  }

  private mapToSource(doc: any): SourceRequest {
    return {
      requestId: doc.requestId,
      tenantId: doc.tenantId,
      customerId: doc.customerId,
      branchId: doc.branchId || null,
      status: doc.status,
      source: doc.source || 'MOCK',
      declaredByCustomer: Boolean(doc.declaredByCustomer),
      itemRef: {
        productId: doc.itemRef.productId,
        variantId: doc.itemRef.variantId || null,
      },
      conditions: doc.conditions
        ? {
            size: doc.conditions.size || null,
            colourFamily: doc.conditions.colourFamily || null,
            weave: doc.conditions.weave || null,
          }
        : null,
      createdAt: new Date(doc.createdAt),
      updatedAt: new Date(doc.updatedAt),
      expiresAt: doc.expiresAt ? new Date(doc.expiresAt) : null,
      entityVersion: doc.entityVersion || 1,
    };
  }
}

export const mockRequestSource = new MockRequestSource();
