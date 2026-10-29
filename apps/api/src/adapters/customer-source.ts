import {
  SourceCustomer,
  SourceCustomerEvent,
  CustomerFilter,
  CampaignAudience,
} from '@grovastra/shared';
import { SrcCustomerModel, ISrcCustomer } from '../db/models/src-customer.model';
import { SrcCustomerEventModel, ISrcCustomerEvent } from '../db/models/src-customer-event.model';
import { compileSafeMongoQuery } from '../services/audience';
import { ForbiddenError } from '../errors/app-error';

/**
 * CustomerSource Adapter Interface (Spec p24)
 * The campaign engine code interacts strictly through this interface,
 * allowing real CRM/ERP adapters to replace the mock data layer later.
 */
export interface CustomerSource {
  getCustomerById(tenantId: string, customerId: string): Promise<SourceCustomer | null>;
  getCustomerByDestinationHash(tenantId: string, destinationHash: string): Promise<SourceCustomer | null>;
  listCustomers(
    tenantId: string,
    filter?: CustomerFilter,
    pagination?: { limit?: number; skip?: number }
  ): Promise<{ customers: SourceCustomer[]; total: number }>;
  getCustomerEvents(tenantId: string, customerId: string): Promise<SourceCustomerEvent[]>;
  getCustomersWithBirthday(tenantId: string, month: number, day: number): Promise<SourceCustomer[]>;
  getCustomersWithAnniversary(
    tenantId: string,
    month: number,
    day: number
  ): Promise<Array<{ customer: SourceCustomer; event: SourceCustomerEvent }>>;
  queryAudience(
    tenantId: string,
    options?: {
      branchIds?: string[];
      audience?: CampaignAudience | null;
      limit?: number;
    }
  ): Promise<SourceCustomer[]>;
}

/**
 * Transforms Mongoose customer doc to plain SourceCustomer object.
 */
function toSourceCustomer(doc: ISrcCustomer): SourceCustomer {
  return {
    id: doc._id.toString(),
    _id: doc._id.toString(),
    tenantId: doc.tenantId,
    customerId: doc.customerId,
    firstName: doc.firstName,
    destination: {
      encryptedPhone: doc.destination.encryptedPhone,
      destinationHash: doc.destination.destinationHash,
      masked: doc.destination.masked,
      verified: doc.destination.verified,
      version: doc.destination.version,
    },
    birthday: doc.birthday ? { month: doc.birthday.month, day: doc.birthday.day } : null,
    consent: {
      marketingOptIn: doc.consent.marketingOptIn,
      channelSuppressed: doc.consent.channelSuppressed,
    },
    preferences: doc.preferences ? {
      weave: doc.preferences.weave,
      budgetMaxPaise: doc.preferences.budgetMaxPaise,
      size: doc.preferences.size,
      colour: doc.preferences.colour,
    } : {},
    tags: doc.tags || [],
    status: doc.status,
    branchId: doc.branchId,
    deletedAt: doc.deletedAt,
    version: doc.version,
    language: doc.language,
    isLive: doc.isLive,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Transforms Mongoose event doc to plain SourceCustomerEvent object.
 */
function toSourceCustomerEvent(doc: ISrcCustomerEvent): SourceCustomerEvent {
  return {
    id: doc._id.toString(),
    _id: doc._id.toString(),
    tenantId: doc.tenantId,
    customerId: doc.customerId,
    eventId: doc.eventId,
    type: doc.type,
    month: doc.month,
    day: doc.day,
    label: doc.label,
    version: doc.version,
    deletedAt: doc.deletedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Mock implementation of CustomerSource backed by MongoDB src_customers and src_customerEvents.
 * Strictly guarantees tenant isolation on every single query (Hard Rule 1).
 */
export class MockCustomerSource implements CustomerSource {
  private validateTenant(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new ForbiddenError('Tenant ID is required for CustomerSource operations');
    }
  }

  async getCustomerById(tenantId: string, customerId: string): Promise<SourceCustomer | null> {
    this.validateTenant(tenantId);
    const doc = await SrcCustomerModel.findOne({ tenantId, customerId }).lean();
    return doc ? toSourceCustomer(doc as unknown as ISrcCustomer) : null;
  }

  async getCustomerByDestinationHash(
    tenantId: string,
    destinationHash: string
  ): Promise<SourceCustomer | null> {
    this.validateTenant(tenantId);
    const doc = await SrcCustomerModel.findOne({
      tenantId,
      'destination.destinationHash': destinationHash,
    }).lean();
    return doc ? toSourceCustomer(doc as unknown as ISrcCustomer) : null;
  }

  async listCustomers(
    tenantId: string,
    filter: CustomerFilter = {},
    pagination: { limit?: number; skip?: number } = {}
  ): Promise<{ customers: SourceCustomer[]; total: number }> {
    this.validateTenant(tenantId);

    const query: Record<string, unknown> = { tenantId };

    if (!filter.includeDeleted) {
      query.deletedAt = null;
    }

    if (filter.status) {
      query.status = filter.status;
    }

    if (filter.marketingOptIn !== undefined) {
      query['consent.marketingOptIn'] = filter.marketingOptIn;
    }

    if (filter.channelSuppressed !== undefined) {
      query['consent.channelSuppressed'] = filter.channelSuppressed;
    }

    if (filter.branchId) {
      query.branchId = filter.branchId;
    }

    if (filter.isLive !== undefined) {
      query.isLive = filter.isLive;
    }

    if (filter.hasBirthday === true) {
      query.birthday = { $ne: null };
    } else if (filter.hasBirthday === false) {
      query.birthday = null;
    }

    if (filter.birthdayMonth !== undefined) {
      query['birthday.month'] = filter.birthdayMonth;
    }

    if (filter.birthdayDay !== undefined) {
      query['birthday.day'] = filter.birthdayDay;
    }

    if (filter.search) {
      const sanitized = filter.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { firstName: { $regex: sanitized, $options: 'i' } },
        { 'destination.masked': { $regex: sanitized, $options: 'i' } },
        { customerId: { $regex: sanitized, $options: 'i' } },
      ];
    }

    if (filter.afterCustomerId && filter.afterCustomerId.trim() !== '') {
      query.customerId = { $gt: filter.afterCustomerId.trim() };
    }

    const limit = Math.min(pagination.limit || 50, 200);
    const skip = pagination.skip || 0;
    const sort =
      filter.afterCustomerId !== undefined
        ? { customerId: 1 }
        : { isLive: -1, createdAt: -1 };

    const [docs, total] = await Promise.all([
      SrcCustomerModel.find(query)
        .sort(sort as any)
        .skip(skip)
        .limit(limit)
        .lean(),
      SrcCustomerModel.countDocuments(query),
    ]);

    return {
      customers: docs.map((d) => toSourceCustomer(d as unknown as ISrcCustomer)),
      total,
    };
  }

  async getCustomerEvents(tenantId: string, customerId: string): Promise<SourceCustomerEvent[]> {
    this.validateTenant(tenantId);
    const docs = await SrcCustomerEventModel.find({
      tenantId,
      customerId,
      deletedAt: null,
    })
      .sort({ month: 1, day: 1 })
      .lean();

    return docs.map((d) => toSourceCustomerEvent(d as unknown as ISrcCustomerEvent));
  }

  async getCustomersWithBirthday(
    tenantId: string,
    month: number,
    day: number
  ): Promise<SourceCustomer[]> {
    this.validateTenant(tenantId);
    const docs = await SrcCustomerModel.find({
      tenantId,
      'birthday.month': month,
      'birthday.day': day,
      deletedAt: null,
      status: 'ACTIVE',
    }).lean();

    return docs.map((d) => toSourceCustomer(d as unknown as ISrcCustomer));
  }

  async getCustomersWithAnniversary(
    tenantId: string,
    month: number,
    day: number
  ): Promise<Array<{ customer: SourceCustomer; event: SourceCustomerEvent }>> {
    this.validateTenant(tenantId);

    const eventDocs = await SrcCustomerEventModel.find({
      tenantId,
      month,
      day,
      deletedAt: null,
    }).lean();

    if (eventDocs.length === 0) {
      return [];
    }

    const customerIds = [...new Set(eventDocs.map((e) => e.customerId))];
    const customerDocs = await SrcCustomerModel.find({
      tenantId,
      customerId: { $in: customerIds },
      deletedAt: null,
      status: 'ACTIVE',
    }).lean();

    const customerMap = new Map<string, SourceCustomer>();
    for (const c of customerDocs) {
      customerMap.set(c.customerId, toSourceCustomer(c as unknown as ISrcCustomer));
    }

    const results: Array<{ customer: SourceCustomer; event: SourceCustomerEvent }> = [];
    for (const e of eventDocs) {
      const cust = customerMap.get(e.customerId);
      if (cust) {
        results.push({
          customer: cust,
          event: toSourceCustomerEvent(e as unknown as ISrcCustomerEvent),
        });
      }
    }

    return results;
  }

  async queryAudience(
    tenantId: string,
    options: {
      branchIds?: string[];
      audience?: CampaignAudience | null;
      limit?: number;
    } = {}
  ): Promise<SourceCustomer[]> {
    this.validateTenant(tenantId);
    const query = compileSafeMongoQuery({
      tenantId,
      branchIds: options.branchIds,
      audience: options.audience,
    });

    const limit = Math.min(options.limit || 500, 1000);
    const docs = await SrcCustomerModel.find(query)
      .sort({ isLive: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    return docs.map((d) => toSourceCustomer(d as unknown as ISrcCustomer));
  }
}

export const mockCustomerSource = new MockCustomerSource();
