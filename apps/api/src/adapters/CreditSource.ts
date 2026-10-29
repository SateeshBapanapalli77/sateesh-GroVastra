import { SourceCredit } from '@grovastra/shared';
import { SrcCreditModel, ISrcCredit } from '../db/models/src-credit.model';
import { ForbiddenError } from '../errors/app-error';

export interface CreditSource {
  getCredit(tenantId: string, creditId: string): Promise<SourceCredit | null>;
  listCreditsForCustomer(
    tenantId: string,
    customerId: string,
    filter?: { status?: string; reason?: string }
  ): Promise<SourceCredit[]>;
  listExpiringCredits(
    tenantId: string,
    windowStart: Date,
    windowEnd: Date,
    pagination?: { limit?: number; afterCreditId?: string }
  ): Promise<{ credits: SourceCredit[]; nextCursor?: string }>;
}

function toSourceCredit(doc: ISrcCredit): SourceCredit {
  return {
    id: doc._id.toString(),
    _id: doc._id.toString(),
    tenantId: doc.tenantId,
    creditId: doc.creditId,
    customerId: doc.customerId,
    type: doc.type,
    unit: doc.unit,
    amount: doc.amount,
    originalAmount: doc.originalAmount,
    issuedAt: doc.issuedAt,
    expiresAt: doc.expiresAt,
    status: doc.status,
    reason: doc.reason,
    sourceOrderId: doc.sourceOrderId,
    entityVersion: doc.entityVersion,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class MockCreditSource implements CreditSource {
  private validateTenant(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new ForbiddenError('Tenant ID is required for CreditSource operations');
    }
  }

  async getCredit(tenantId: string, creditId: string): Promise<SourceCredit | null> {
    this.validateTenant(tenantId);
    const doc = await SrcCreditModel.findOne({ tenantId, creditId }).lean();
    return doc ? toSourceCredit(doc as unknown as ISrcCredit) : null;
  }

  async listCreditsForCustomer(
    tenantId: string,
    customerId: string,
    filter: { status?: string; reason?: string } = {}
  ): Promise<SourceCredit[]> {
    this.validateTenant(tenantId);

    const query: Record<string, unknown> = { tenantId, customerId };
    if (filter.status) query.status = filter.status;
    if (filter.reason) query.reason = filter.reason;

    const docs = await SrcCreditModel.find(query)
      .sort({ expiresAt: 1, createdAt: -1 })
      .lean();

    return docs.map((d) => toSourceCredit(d as unknown as ISrcCredit));
  }

  async listExpiringCredits(
    tenantId: string,
    windowStart: Date,
    windowEnd: Date,
    pagination: { limit?: number; afterCreditId?: string } = {}
  ): Promise<{ credits: SourceCredit[]; nextCursor?: string }> {
    this.validateTenant(tenantId);

    const limit = Math.min(pagination.limit || 50, 200);
    const query: Record<string, unknown> = {
      tenantId,
      status: 'ACTIVE',
      expiresAt: { $gte: windowStart, $lte: windowEnd },
    };

    if (pagination.afterCreditId) {
      query.creditId = { $gt: pagination.afterCreditId };
    }

    const docs = await SrcCreditModel.find(query)
      .sort({ creditId: 1 })
      .limit(limit + 1)
      .lean();

    const hasMore = docs.length > limit;
    const results = hasMore ? docs.slice(0, limit) : docs;
    const nextCursor = hasMore ? results[results.length - 1].creditId : undefined;

    return {
      credits: results.map((d) => toSourceCredit(d as unknown as ISrcCredit)),
      nextCursor,
    };
  }
}

export const mockCreditSource = new MockCreditSource();
