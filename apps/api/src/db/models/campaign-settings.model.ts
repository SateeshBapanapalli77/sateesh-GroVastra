import mongoose, { Document, Schema } from 'mongoose';
import {
  CampaignSettings,
  SendingHours,
  HolidayItem,
  MarketingCaps,
  PriorityAllowlistRanges,
  DEFAULT_CAMPAIGN_SETTINGS,
} from '@grovastra/shared';

export interface ICampaignSettings extends Document, Omit<CampaignSettings, 'id' | '_id'> {
  lastIdempotencyKey?: string;
  lastResponse?: Record<string, unknown>;
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SendingHoursSchema = new Schema<SendingHours>(
  {
    start: { type: String, required: true, default: '10:00' },
    end: { type: String, required: true, default: '19:00' },
  },
  { _id: false }
);

const HolidayItemSchema = new Schema<HolidayItem>(
  {
    date: { type: String, required: true },
    name: { type: String, required: true },
  },
  { _id: false }
);

const MarketingCapsSchema = new Schema<MarketingCaps>(
  {
    daily: { type: Number, required: true, default: 1, min: 0, max: 1 },
    weekly: { type: Number, required: true, default: 3, min: 0, max: 3 },
  },
  { _id: false }
);

const CampaignSettingsSchema = new Schema<ICampaignSettings>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    version: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    timezone: {
      type: String,
      required: true,
      default: DEFAULT_CAMPAIGN_SETTINGS.timezone,
      trim: true,
    },
    allowedSendingHours: {
      type: SendingHoursSchema,
      required: true,
      default: () => ({ ...DEFAULT_CAMPAIGN_SETTINGS.allowedSendingHours }),
    },
    blackoutDates: {
      type: [String],
      default: [],
    },
    holidays: {
      type: [HolidayItemSchema],
      default: () => [...DEFAULT_CAMPAIGN_SETTINGS.holidays],
    },
    marketingCaps: {
      type: MarketingCapsSchema,
      required: true,
      default: () => ({ ...DEFAULT_CAMPAIGN_SETTINGS.marketingCaps }),
    },
    serviceContactSpacingHours: {
      type: Number,
      required: true,
      default: DEFAULT_CAMPAIGN_SETTINGS.serviceContactSpacingHours,
      min: 1,
    },
    outageGraceHours: {
      type: Number,
      required: true,
      default: DEFAULT_CAMPAIGN_SETTINGS.outageGraceHours,
      min: 1,
    },
    resumePolicy: {
      type: String,
      required: true,
      default: 'FUTURE_ONLY',
      enum: ['FUTURE_ONLY'],
    },
    importPolicy: {
      type: String,
      required: true,
      default: 'FUTURE_ONLY',
      enum: ['FUTURE_ONLY'],
    },
    priorityAllowlistRanges: {
      type: Schema.Types.Mixed,
      required: true,
      default: () => ({ ...DEFAULT_CAMPAIGN_SETTINGS.priorityAllowlistRanges }),
    },
    defaultPhoneCountry: {
      type: String,
      required: true,
      default: 'IN',
      trim: true,
    },
    minDestinationVerification: {
      type: String,
      required: true,
      default: 'CONFIRMED_BY_STAFF',
      enum: ['UNVERIFIED', 'FORMAT_VALID', 'CONFIRMED_BY_STAFF', 'OTP_VERIFIED'],
    },
    bookingLinkUrl: {
      type: String,
      default: null,
      trim: true,
    },
    isPaused: {
      type: Boolean,
      required: true,
      default: false,
    },
    lastIdempotencyKey: {
      type: String,
      trim: true,
    },
    lastResponse: {
      type: Schema.Types.Mixed,
    },
    seedGroup: {
      type: String,
      default: 'core',
    },
    source: {
      type: String,
      default: 'MOCK',
    },
  },
  {
    timestamps: true,
    collection: 'campaignSettings',
  }
);

// Unique tenant scope constraint
CampaignSettingsSchema.index({ tenantId: 1 }, { unique: true });

export const CampaignSettingsModel =
  mongoose.models.CampaignSettings ||
  mongoose.model<ICampaignSettings>('CampaignSettings', CampaignSettingsSchema);
