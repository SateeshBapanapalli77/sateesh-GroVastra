import { SrcEventModel, ISrcEvent, StoreEventStatus, StoreEventType, StoreEventVenue } from '../db/models/src-event.model';
import { ForbiddenError } from '../errors/app-error';
import { clock } from '../services/clock';

export interface SourceEvent {
  eventId: string;
  tenantId: string;
  title: string;
  eventType: StoreEventType;
  venue: StoreEventVenue;
  city: string;
  startDate: Date;
  endDate: Date;
  capacity?: number | null;
  registeredCount: number;
  rsvpLinkUrl?: string | null;
  targetCities?: string[];
  targetBranches?: string[];
  categories?: string[];
  status: StoreEventStatus;
  entityVersion: number;
  publishedAt?: Date | null;
}

export function toSourceEvent(doc: ISrcEvent): SourceEvent {
  return {
    eventId: doc.eventId,
    tenantId: doc.tenantId,
    title: doc.title,
    eventType: doc.eventType,
    venue: doc.venue,
    city: doc.city,
    startDate: doc.startDate,
    endDate: doc.endDate,
    capacity: doc.capacity,
    registeredCount: doc.registeredCount || 0,
    rsvpLinkUrl: doc.rsvpLinkUrl,
    targetCities: doc.targetCities || [],
    targetBranches: doc.targetBranches || [],
    categories: doc.categories || [],
    status: doc.status,
    entityVersion: doc.entityVersion || 1,
    publishedAt: doc.publishedAt,
  };
}

export interface EventSource {
  getEvent(tenantId: string, eventId: string): Promise<SourceEvent | null>;
  listUpcomingEvents(tenantId: string, atInstant?: Date): Promise<SourceEvent[]>;
}

export class MockEventSource implements EventSource {
  private validateTenant(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new ForbiddenError('Tenant ID is required for EventSource operations');
    }
  }

  async getEvent(tenantId: string, eventId: string): Promise<SourceEvent | null> {
    this.validateTenant(tenantId);
    const doc = await SrcEventModel.findOne({ tenantId, eventId }).lean();
    if (!doc) return null;
    return toSourceEvent(doc as any);
  }

  async listUpcomingEvents(tenantId: string, atInstant?: Date): Promise<SourceEvent[]> {
    this.validateTenant(tenantId);
    const now = atInstant || clock.now();
    const docs = await SrcEventModel.find({
      tenantId,
      status: { $in: ['ACTIVE', 'FULL'] },
      endDate: { $gte: now },
    }).sort({ startDate: 1 }).lean();

    return docs.map((doc) => toSourceEvent(doc as any));
  }
}

export const mockEventSource = new MockEventSource();
