import { SourceOrder } from '@grovastra/shared';
import { SrcOrderModel, ISrcOrder } from '../db/models/src-order.model';
import { ForbiddenError } from '../errors/app-error';

/**
 * OrderSource Adapter Interface (Spec p24)
 * The campaign code interacts strictly through this interface,
 * allowing real order systems (Shopify, ERP, POS) to plug in later.
 */
export interface OrderSource {
  getOrderById(tenantId: string, orderId: string): Promise<SourceOrder | null>;
  getOrdersByCustomer(
    tenantId: string,
    customerId: string,
    filter?: { status?: string; occasionRef?: string }
  ): Promise<SourceOrder[]>;
  listOrders(
    tenantId: string,
    filter?: { customerId?: string; status?: string; paid?: boolean },
    pagination?: { limit?: number; skip?: number }
  ): Promise<{ orders: SourceOrder[]; total: number }>;
  listOrdersForCustomer(tenantId: string, customerId: string): Promise<SourceOrder[]>;
}

/**
 * Transforms Mongoose order doc to plain SourceOrder object.
 */
function toSourceOrder(doc: ISrcOrder): SourceOrder {
  return {
    id: doc._id.toString(),
    _id: doc._id.toString(),
    tenantId: doc.tenantId,
    orderId: doc.orderId,
    orderNumber: doc.orderNumber || doc.orderId,
    customerId: doc.customerId,
    status: doc.status,
    paid: doc.paid,
    netPaise: doc.netPaise,
    grossPaise: doc.grossPaise ?? doc.netPaise,
    refundedPaise: doc.refundedPaise ?? 0,
    occasionRef: doc.occasionRef,
    outfitRef: (doc as any).outfitRef || null,
    lines: (doc.lines || []).map((l: any) => ({
      lineId: l.lineId,
      itemRef: l.itemRef,
      productId: l.productId || l.itemRef || null,
      variantId: l.variantId || null,
      name: l.name,
      quantity: l.quantity ?? l.qty ?? 1,
      qty: l.qty ?? l.quantity ?? 1,
      returnedQty: l.returnedQty ?? 0,
      pricePaise: l.pricePaise,
      lineNetPaise: l.lineNetPaise !== undefined ? l.lineNetPaise : l.pricePaise,
    })),
    entityVersion: doc.entityVersion,
    completedAt: doc.completedAt,
    branchId: doc.branchId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Mock implementation of OrderSource backed by MongoDB src_orders.
 * Strictly guarantees tenant isolation on every single query (Hard Rule 1).
 */
export class MockOrderSource implements OrderSource {
  private validateTenant(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new ForbiddenError('Tenant ID is required for OrderSource operations');
    }
  }

  async getOrderById(tenantId: string, orderId: string): Promise<SourceOrder | null> {
    this.validateTenant(tenantId);
    const doc = await SrcOrderModel.findOne({ tenantId, orderId }).lean();
    return doc ? toSourceOrder(doc as unknown as ISrcOrder) : null;
  }

  async getOrdersByCustomer(
    tenantId: string,
    customerId: string,
    filter: { status?: string; occasionRef?: string } = {}
  ): Promise<SourceOrder[]> {
    this.validateTenant(tenantId);

    const query: Record<string, unknown> = { tenantId, customerId };
    if (filter.status) query.status = filter.status;
    if (filter.occasionRef) query.occasionRef = filter.occasionRef;

    const docs = await SrcOrderModel.find(query)
      .sort({ completedAt: -1, createdAt: -1 })
      .lean();

    return docs.map((d) => toSourceOrder(d as unknown as ISrcOrder));
  }

  async listOrdersForCustomer(tenantId: string, customerId: string): Promise<SourceOrder[]> {
    return this.getOrdersByCustomer(tenantId, customerId);
  }

  async listOrders(
    tenantId: string,
    filter: { customerId?: string; status?: string; paid?: boolean } = {},
    pagination: { limit?: number; skip?: number } = {}
  ): Promise<{ orders: SourceOrder[]; total: number }> {
    this.validateTenant(tenantId);

    const query: Record<string, unknown> = { tenantId };
    if (filter.customerId) query.customerId = filter.customerId;
    if (filter.status) query.status = filter.status;
    if (filter.paid !== undefined) query.paid = filter.paid;

    const limit = Math.min(pagination.limit || 50, 200);
    const skip = pagination.skip || 0;

    const [docs, total] = await Promise.all([
      SrcOrderModel.find(query)
        .sort({ completedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SrcOrderModel.countDocuments(query),
    ]);

    return {
      orders: docs.map((d) => toSourceOrder(d as unknown as ISrcOrder)),
      total,
    };
  }
}

export const mockOrderSource = new MockOrderSource();
