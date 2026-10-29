import { OccasionSource, OccasionRecord } from '../../adapters/occasion-source';
import { SrcCustomerEventModel, ISrcCustomerEvent } from '../../db/models/src-customer-event.model';
import { ForbiddenError } from '../../errors/app-error';

export function toOccasionRecord(doc: ISrcCustomerEvent): OccasionRecord {
  return {
    id: doc._id.toString(),
    _id: doc._id.toString(),
    tenantId: doc.tenantId,
    customerId: doc.customerId,
    eventId: doc.eventId,
    type: doc.type || 'anniversary',
    kind: doc.kind || (doc.type === 'anniversary' ? 'ANNIVERSARY' : 'GIFT'),
    eventDate: doc.eventDate,
    eventDateKey: doc.eventDateKey,
    month: doc.month,
    day: doc.day,
    label: doc.label || null,
    recipientLabel: doc.recipientLabel || null,
    budgetPaise: doc.budgetPaise !== undefined ? doc.budgetPaise : null,
    categories: doc.categories || [],
    status: doc.status || 'ACTIVE',
    declaredByCustomer: doc.declaredByCustomer !== undefined ? doc.declaredByCustomer : true,
    declaredAt: doc.declaredAt || doc.createdAt,
    source: doc.source || 'CUSTOMER_DECLARED',
    entityVersion: doc.entityVersion || doc.version || 1,
    version: doc.version || 1,
    deletedAt: doc.deletedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class MockOccasionSource implements OccasionSource {
  private validateTenant(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new ForbiddenError('Tenant ID is required for OccasionSource operations');
    }
  }

  async getOccasion(tenantId: string, eventId: string): Promise<OccasionRecord | null> {
    this.validateTenant(tenantId);
    const doc = await SrcCustomerEventModel.findOne({ tenantId, eventId }).lean();
    return doc ? toOccasionRecord(doc as unknown as ISrcCustomerEvent) : null;
  }

  async listOccasionsByDateRange(
    tenantId: string,
    kind: 'GIFT' | 'WEDDING',
    fromDateKey: string,
    toDateKey: string,
    cursor?: string,
    limit: number = 50
  ): Promise<{ occasions: OccasionRecord[]; nextCursor?: string }> {
    this.validateTenant(tenantId);
    const query: any = {
      tenantId,
      kind,
      status: 'ACTIVE',
      eventDateKey: { $gte: fromDateKey, $lte: toDateKey },
      deletedAt: null,
    };

    if (cursor) {
      query.eventId = { $gt: cursor };
    }

    const docs = await SrcCustomerEventModel.find(query)
      .sort({ eventDateKey: 1, eventId: 1 })
      .limit(limit + 1)
      .lean();

    let nextCursor: string | undefined = undefined;
    let results = docs;
    if (docs.length > limit) {
      results = docs.slice(0, limit);
      nextCursor = results[results.length - 1].eventId;
    }

    return {
      occasions: results.map((d) => toOccasionRecord(d as unknown as ISrcCustomerEvent)),
      nextCursor,
    };
  }

  async listForCustomer(tenantId: string, customerId: string): Promise<OccasionRecord[]> {
    this.validateTenant(tenantId);
    const docs = await SrcCustomerEventModel.find({
      tenantId,
      customerId,
      deletedAt: null,
    })
      .sort({ eventDateKey: 1, eventId: 1 })
      .lean();

    return docs.map((d) => toOccasionRecord(d as unknown as ISrcCustomerEvent));
  }
}

export const mockOccasionSource = new MockOccasionSource();
