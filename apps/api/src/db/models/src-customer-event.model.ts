import mongoose, { Document, Schema } from 'mongoose';
import {
  OCCASION_KIND,
  OCCASION_STATUS,
  OCCASION_SOURCE,
  OCCASION_CATEGORIES,
  OccasionKind,
  OccasionStatus,
  OccasionSourceType,
  OccasionCategory,
} from '@grovastra/shared';

export interface ISrcCustomerEvent extends Document {
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
  eventDateKey?: string; // "YYYY-MM-DD"
  month: number;
  day: number;
  label?: string;
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
  seedGroup?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SrcCustomerEventSchema = new Schema<ISrcCustomerEvent>(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    customerId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    eventId: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      default: 'anniversary',
      trim: true,
    },
    kind: {
      type: String,
      enum: Object.values(OCCASION_KIND),
      default: OCCASION_KIND.ANNIVERSARY,
      trim: true,
    },
    eventDate: {
      year: { type: Number },
      month: { type: Number },
      day: { type: Number },
    },
    eventDateKey: {
      type: String,
      trim: true,
    },
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    day: {
      type: Number,
      required: true,
      min: 1,
      max: 31,
    },
    label: {
      type: String,
      trim: true,
    },
    recipientLabel: {
      type: String,
      trim: true,
      default: null,
    },
    budgetPaise: {
      type: Number,
      default: null,
    },
    categories: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: Object.values(OCCASION_STATUS),
      default: OCCASION_STATUS.ACTIVE,
    },
    declaredByCustomer: {
      type: Boolean,
      default: true,
    },
    declaredAt: {
      type: Date,
      default: Date.now,
    },
    source: {
      type: String,
      enum: Object.values(OCCASION_SOURCE),
      default: OCCASION_SOURCE.CUSTOMER_DECLARED,
    },
    entityVersion: {
      type: Number,
      default: 1,
    },
    version: {
      type: Number,
      default: 1,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    seedGroup: {
      type: String,
      default: 'core',
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'src_customerEvents',
  }
);

// Pre-save hook to ensure eventDateKey and month/day synchronization
SrcCustomerEventSchema.pre('save', function (next) {
  if (this.eventDate && this.eventDate.year && this.eventDate.month && this.eventDate.day) {
    const y = this.eventDate.year.toString().padStart(4, '0');
    const m = this.eventDate.month.toString().padStart(2, '0');
    const d = this.eventDate.day.toString().padStart(2, '0');
    this.eventDateKey = `${y}-${m}-${d}`;
    this.month = this.eventDate.month;
    this.day = this.eventDate.day;
  } else if (this.month && this.day && !this.eventDateKey) {
    const m = this.month.toString().padStart(2, '0');
    const d = this.day.toString().padStart(2, '0');
    this.eventDateKey = `XXXX-${m}-${d}`;
  }
  next();
});

// Indexes (Spec F22 Part 1)
SrcCustomerEventSchema.index({ tenantId: 1, eventId: 1 }, { unique: true });
SrcCustomerEventSchema.index({ tenantId: 1, customerId: 1, status: 1, eventDateKey: 1 });
SrcCustomerEventSchema.index({ tenantId: 1, kind: 1, status: 1, eventDateKey: 1 });
SrcCustomerEventSchema.index({ tenantId: 1, customerId: 1 });
SrcCustomerEventSchema.index({ tenantId: 1, month: 1, day: 1 });

export const SrcCustomerEventModel =
  mongoose.models.SrcCustomerEvent ||
  mongoose.model<ISrcCustomerEvent>('SrcCustomerEvent', SrcCustomerEventSchema);
