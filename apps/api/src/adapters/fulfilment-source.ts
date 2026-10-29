import {
  SrcFulfilmentModel,
  ISrcFulfilment,
  ISrcShipment,
  FulfilmentMode,
  FulfilmentStatus,
  ReadinessKind,
  ShipmentStatus,
} from '../db/models/src-fulfilment.model';
import { ForbiddenError } from '../errors/app-error';

export interface SourceShipment {
  shipmentId: string;
  carrier: string;
  carrierName: string;
  trackingRef: string | null;
  status: ShipmentStatus;
  verified: boolean;
  lastCourierEventId?: string | null;
  dispatchedAt?: Date | null;
  deliveredAt?: Date | null;
  entityVersion: number;
}

export interface SourceFulfilment {
  orderId: string;
  tenantId: string;
  customerId?: string | null;
  branchId?: string | null;
  orderNumber: string;
  mode: FulfilmentMode;
  status: FulfilmentStatus;
  readinessKind: ReadinessKind;
  readinessVersion: number;
  readyAt: Date | null;
  collectedAt?: Date | null;
  reworkReason?: string | null;
  entityVersion: number;
  shipments: SourceShipment[];
}

export function toSourceFulfilment(doc: ISrcFulfilment): SourceFulfilment {
  return {
    orderId: doc.orderId,
    tenantId: doc.tenantId,
    customerId: doc.customerId,
    branchId: doc.branchId,
    orderNumber: doc.orderNumber,
    mode: doc.mode,
    status: doc.status,
    readinessKind: doc.readinessKind,
    readinessVersion: doc.readinessVersion,
    readyAt: doc.readyAt,
    collectedAt: doc.collectedAt,
    reworkReason: doc.reworkReason,
    entityVersion: doc.entityVersion || 1,
    shipments: (doc.shipments || []).map((s) => ({
      shipmentId: s.shipmentId,
      carrier: s.carrier,
      carrierName: s.carrierName,
      trackingRef: s.trackingRef,
      status: s.status,
      verified: s.verified,
      lastCourierEventId: s.lastCourierEventId,
      dispatchedAt: s.dispatchedAt,
      deliveredAt: s.deliveredAt,
      entityVersion: s.entityVersion || 1,
    })),
  };
}

export interface FulfilmentSource {
  getFulfilment(tenantId: string, orderId: string): Promise<SourceFulfilment | null>;
  listByStatusChangedRange(
    tenantId: string,
    from: Date,
    to: Date,
    cursor?: string,
    limit?: number
  ): Promise<{ items: SourceFulfilment[]; nextCursor?: string }>;
  listShipments(tenantId: string, orderId: string): Promise<SourceShipment[]>;
}

export class MockFulfilmentSource implements FulfilmentSource {
  private validateTenant(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new ForbiddenError('Tenant ID is required for FulfilmentSource operations');
    }
  }

  async getFulfilment(tenantId: string, orderId: string): Promise<SourceFulfilment | null> {
    this.validateTenant(tenantId);
    const doc = await SrcFulfilmentModel.findOne({ tenantId, orderId }).lean();
    return doc ? toSourceFulfilment(doc as unknown as ISrcFulfilment) : null;
  }

  async listByStatusChangedRange(
    tenantId: string,
    from: Date,
    to: Date,
    cursor?: string,
    limit: number = 50
  ): Promise<{ items: SourceFulfilment[]; nextCursor?: string }> {
    this.validateTenant(tenantId);
    const query: any = {
      tenantId,
      $or: [
        { readyAt: { $gte: from, $lte: to } },
        { collectedAt: { $gte: from, $lte: to } },
        { updatedAt: { $gte: from, $lte: to } },
        { 'shipments.dispatchedAt': { $gte: from, $lte: to } },
        { 'shipments.deliveredAt': { $gte: from, $lte: to } },
      ],
    };

    if (cursor) {
      query._id = { $gt: cursor };
    }

    const docs = await SrcFulfilmentModel.find(query)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .lean();

    const hasMore = docs.length > limit;
    const items = (hasMore ? docs.slice(0, limit) : docs).map((d) =>
      toSourceFulfilment(d as unknown as ISrcFulfilment)
    );
    const nextCursor = hasMore ? String(docs[limit - 1]._id) : undefined;

    return { items, nextCursor };
  }

  async listShipments(tenantId: string, orderId: string): Promise<SourceShipment[]> {
    this.validateTenant(tenantId);
    const doc: any = await SrcFulfilmentModel.findOne({ tenantId, orderId }, { shipments: 1 }).lean();
    if (!doc || !doc.shipments) return [];
    return (doc.shipments as ISrcShipment[]).map((s) => ({
      shipmentId: s.shipmentId,
      carrier: s.carrier,
      carrierName: s.carrierName,
      trackingRef: s.trackingRef,
      status: s.status,
      verified: s.verified,
      lastCourierEventId: s.lastCourierEventId,
      dispatchedAt: s.dispatchedAt,
      deliveredAt: s.deliveredAt,
      entityVersion: s.entityVersion || 1,
    }));
  }
}

export const mockFulfilmentSource = new MockFulfilmentSource();
