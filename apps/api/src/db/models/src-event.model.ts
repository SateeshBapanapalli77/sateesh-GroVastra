/**
 * src_events Model — F29 Exhibition / Trunk Show
 *
 * Stores authoritative store events, exhibitions, trunk shows, and boutique pop-ups.
 * The campaign engine is purely an event-driven consumer: event publication and RSVP
 * registrations happen externally.
 *
 * Tenant isolation: every query MUST include { tenantId }.
 */
import mongoose, { Document, Schema } from 'mongoose';

export type StoreEventStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'FULL' | 'CANCELLED' | 'COMPLETED';
export type StoreEventType = 'EXHIBITION' | 'TRUNK_SHOW' | 'POPUP' | 'STORE_EVENT';

export interface StoreEventVenue {
  name: string;
  address?: string | null;
  city: string;
  googleMapsUrl?: string | null;
}

export interface ISrcEvent extends Document {
  tenantId: string;
  eventId: string;
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
  seedGroup?: string | null;
  publishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const StoreEventVenueSchema = new Schema<StoreEventVenue>(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, default: null, trim: true },
    city: { type: String, required: true, trim: true },
    googleMapsUrl: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const SrcEventSchema = new Schema<ISrcEvent>(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    eventId: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    eventType: {
      type: String,
      enum: ['EXHIBITION', 'TRUNK_SHOW', 'POPUP', 'STORE_EVENT'],
      default: 'EXHIBITION',
    },
    venue: { type: StoreEventVenueSchema, required: true },
    city: { type: String, required: true, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    capacity: { type: Number, default: null },
    registeredCount: { type: Number, default: 0 },
    rsvpLinkUrl: { type: String, default: null, trim: true },
    targetCities: { type: [String], default: [] },
    targetBranches: { type: [String], default: [] },
    categories: { type: [String], default: [] },
    status: {
      type: String,
      enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'FULL', 'CANCELLED', 'COMPLETED'],
      default: 'DRAFT',
      index: true,
    },
    entityVersion: { type: Number, default: 1 },
    seedGroup: { type: String, default: null, trim: true },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

SrcEventSchema.index({ tenantId: 1, eventId: 1 }, { unique: true });
SrcEventSchema.index({ tenantId: 1, status: 1, startDate: 1 });

export const SrcEventModel =
  mongoose.models.SrcEvent || mongoose.model<ISrcEvent>('SrcEvent', SrcEventSchema, 'src_events');
