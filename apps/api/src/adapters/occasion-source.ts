import {
  OccasionKind,
  OccasionStatus,
  OccasionSourceType,
  OccasionCategory,
} from '@grovastra/shared';

export interface OccasionRecord {
  id: string;
  _id: string;
  tenantId: string;
  customerId: string;
  eventId: string;
  type: string;
  kind: OccasionKind;
  eventDate?: {
    year: number;
    month: number;
    day: number;
  };
  eventDateKey?: string;
  month: number;
  day: number;
  label?: string | null;
  recipientLabel?: string | null;
  budgetPaise?: number | null;
  categories: OccasionCategory[];
  status: OccasionStatus;
  declaredByCustomer: boolean;
  declaredAt?: Date | null;
  source: OccasionSourceType;
  entityVersion: number;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OccasionSource {
  getOccasion(tenantId: string, eventId: string): Promise<OccasionRecord | null>;
  listOccasionsByDateRange(
    tenantId: string,
    kind: 'GIFT' | 'WEDDING',
    fromDateKey: string,
    toDateKey: string,
    cursor?: string,
    limit?: number
  ): Promise<{ occasions: OccasionRecord[]; nextCursor?: string }>;
  listForCustomer(tenantId: string, customerId: string): Promise<OccasionRecord[]>;
}

// Re-export mock occasion source as the default occasionSource implementation
import { mockOccasionSource } from '../dev/mock/mock-occasion-source';
export { mockOccasionSource };
export const occasionSource: OccasionSource = mockOccasionSource;
