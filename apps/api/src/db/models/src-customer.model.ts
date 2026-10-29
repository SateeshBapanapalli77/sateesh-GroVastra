import mongoose, { Document, Schema } from 'mongoose';
import { DateOnly, CustomerDestination, CustomerConsent, CustomerPreferences } from '@grovastra/shared';

export interface ISrcCustomer extends Document {
  tenantId: string;
  customerId: string;
  firstName: string;
  destination: CustomerDestination;
  birthday: DateOnly | null;
  consent: CustomerConsent;
  preferences: CustomerPreferences;
  tags: string[];
  status: string;
  branchId: string;
  deletedAt: Date | null;
  version: number;
  language: string;
  isLive: boolean;
  needsStaffReview?: {
    reason: 'POSSIBLE_OPT_OUT' | 'POSSIBLE_WRONG_NUMBER';
    at: Date;
    messageId: string;
  } | null;
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const DateOnlySchema = new Schema<DateOnly>(
  {
    month: { type: Number, required: true, min: 1, max: 12 },
    day: { type: Number, required: true, min: 1, max: 31 },
  },
  { _id: false }
);

const DestinationSchema = new Schema<CustomerDestination>(
  {
    encryptedPhone: { type: String, required: false, default: '' },
    destinationHash: { type: String, required: false, default: '', index: true },
    masked: { type: String, required: false, default: '' },
    verified: { type: Boolean, default: false },
    version: { type: Number, default: 1 },
    verificationLevel: {
      type: String,
      enum: ['UNVERIFIED', 'FORMAT_VALID', 'CONFIRMED_BY_STAFF', 'OTP_VERIFIED'],
      default: function (this: any) {
        return this?.verified ? 'CONFIRMED_BY_STAFF' : 'UNVERIFIED';
      },
    },
    verifiedAt: { type: Date, default: null },
    verificationMethod: {
      type: String,
      enum: ['COUNTER_READBACK', 'DOUBLE_ENTRY', 'OTP', 'IMPORTED', 'MOCK'],
      default: null,
    },
  },
  { _id: false, strict: false }
);

const ConsentSchema = new Schema<CustomerConsent>(
  {
    marketingOptIn: { type: Boolean, default: true },
    channelSuppressed: { type: Boolean, default: false },
    consentCapturedAt: { type: Date, default: null },
    consentSource: {
      type: String,
      enum: ['COUNTER_FORM', 'VERBAL_RECORDED', 'QR', 'IMPORTED', 'MOCK'],
      default: null,
    },
  },
  { _id: false }
);

const PreferencesSchema = new Schema<CustomerPreferences>(
  {
    // Existing single-value fields (kept for backwards compatibility)
    weave: { type: String, trim: true },
    budgetMaxPaise: { type: Number },
    size: { type: String, trim: true },
    colour: { type: String, trim: true },
    // F26 additive array fields
    weaves: { type: [String], default: undefined },
    colourFamilies: { type: [String], default: undefined },
    sizes: { type: [String], default: undefined },
    categories: { type: [String], default: undefined },
    // F26 provenance
    source: {
      type: String,
      enum: ['CUSTOMER_DECLARED', 'STAFF_RECORDED', 'IMPORTED', 'MOCK', 'INFERRED'],
      default: undefined,
    },
    preferencesVersion: { type: Number, default: undefined },
    updatedAt: { type: Date, default: undefined },
  },
  { _id: false }
);


const SrcCustomerSchema = new Schema<ISrcCustomer>(
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
      trim: true,
    },
    firstName: {
      type: String,
      default: '',
    },
    destination: {
      type: DestinationSchema,
      required: true,
    },
    birthday: {
      type: DateOnlySchema,
      default: null,
    },
    consent: {
      type: ConsentSchema,
      required: true,
      default: () => ({ marketingOptIn: true, channelSuppressed: false }),
    },
    preferences: {
      type: PreferencesSchema,
      default: () => ({}),
    },
    tags: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      default: 'ACTIVE',
      trim: true,
    },
    branchId: {
      type: String,
      required: true,
      trim: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    version: {
      type: Number,
      default: 1,
    },
    language: {
      type: String,
      default: 'en',
      trim: true,
    },
    isLive: {
      type: Boolean,
      default: false,
    },
    needsStaffReview: {
      type: Schema.Types.Mixed,
      default: null,
    },
    seedGroup: {
      type: String,
      default: 'core',
      index: true,
    },
    source: {
      type: String,
      default: 'MOCK',
    },
  },
  {
    timestamps: true,
    collection: 'src_customers',
  }
);

// Indexes enforcing tenant isolation and fast lookups
SrcCustomerSchema.index({ tenantId: 1, customerId: 1 }, { unique: true });
SrcCustomerSchema.index({ tenantId: 1, 'destination.destinationHash': 1 });
SrcCustomerSchema.index({ tenantId: 1, 'birthday.month': 1, 'birthday.day': 1 });
SrcCustomerSchema.index({ tenantId: 1, branchId: 1 });
SrcCustomerSchema.index({ tenantId: 1, status: 1 });
SrcCustomerSchema.index({ tenantId: 1, isLive: 1 });

export const SrcCustomerModel =
  mongoose.models.SrcCustomer || mongoose.model<ISrcCustomer>('SrcCustomer', SrcCustomerSchema);
