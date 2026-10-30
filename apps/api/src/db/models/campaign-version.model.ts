import mongoose, { Document, Schema } from 'mongoose';
import {
  CampaignStep,
  CampaignTrigger,
  CampaignAudience,
  CampaignGoal,
  LEAP_DAY_POLICY,
  PREREQUISITE,
} from '@grovastra/shared';

export interface ICampaignVersion extends Document {
  tenantId: string;
  campaignId: string;
  version: number;
  name: string;
  industry: string;
  purpose: 'MARKETING';
  trigger: CampaignTrigger;
  timezone: string;
  audience: CampaignAudience;
  goal: CampaignGoal;
  steps: CampaignStep[];
  priority: number;
  resumePolicy: 'FUTURE_ONLY';
  importPolicy: 'FUTURE_ONLY';
  enabledBranches: string[];
  isPublished: boolean;
  bindingsSchemaVersion?: number;
  schemaVersion?: number;
  scope?: 'PER_CUSTOMER' | 'PER_CUSTOMER_PER_BRANCH';
  startAt?: Date | null;
  minFirstOrderNetPaise?: number;
  usefulForDays?: number;
  goalMode?: string;
  minAffinityScore?: number;
  requireItem?: boolean;
  activatedBy: string | null;
  activatedAt: Date | null;
  reviewFingerprint: string | null;
  nextEvaluationAt: Date | null;
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignStepSchema = new Schema<CampaignStep>(
  {
    stepId: {
      type: String,
      required: true,
      trim: true,
    },
    stepName: {
      type: String,
      trim: true,
    },
    offsetDays: {
      type: Number,
      required: false,
    },
    localTime: {
      type: String,
      required: false,
      trim: true,
    },
    delay: {
      value: { type: Number },
      unit: { type: String, enum: ['MINUTES', 'HOURS', 'DAYS'] },
    },
    outsideHoursPolicy: {
      type: String,
      enum: ['DEFER_NEXT_DAY', 'SKIP'],
    },
    maxDeferralHours: {
      type: Number,
      default: 24,
    },
    offerRef: {
      offerId: { type: String },
      version: { type: Number },
    },
    prerequisite: {
      type: String,
      enum: Object.values(PREREQUISITE),
      default: PREREQUISITE.NONE,
      required: true,
    },
    templateRef: {
      type: {
        id: { type: String, required: true },
        revision: { type: Number, required: true },
        language: { type: String, required: true },
      },
      default: null,
    },
    bindings: {
      type: Schema.Types.Mixed,
      default: {},
    },
    stopOnReply: {
      type: Boolean,
      default: true,
      required: true,
    },
    stopOnGoal: {
      type: Boolean,
      default: true,
      required: true,
    },
    maxLatenessMinutes: {
      type: Number,
      default: 120,
      required: true,
    },
  },
  { _id: false }
);

const TriggerSchema = new Schema(
  {
    type: { type: String, default: 'ANNUAL_DATE', required: true },
    field: { type: String, default: null },
    leapDayPolicy: {
      type: String,
      enum: Object.values(LEAP_DAY_POLICY),
      default: LEAP_DAY_POLICY.FEB_28,
    },
    thresholdDays: { type: Number, default: null },
    category: { type: String, default: null },
    ruleId: { type: String, default: null },
    anchor: { type: String, default: null },
    eventDelayAnchor: { type: String, default: null },
    occasionKind: { type: String, enum: ['GIFT', 'WEDDING'], default: null },
    fulfillmentLeadDays: { type: Number, default: null },
    milestone: { type: String, default: null },
    fulfilmentFilter: { type: String, default: null },
    usefulForDays: { type: Number, default: null },
    partialReadyTemplateRef: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const AudienceSchema = new Schema(
  {
    mode: { type: String, enum: ['ALL_ELIGIBLE', 'CUSTOM_RULES'], default: 'ALL_ELIGIBLE', required: true },
    rules: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const GoalSchema = new Schema(
  {
    type: { type: String, default: 'OCCASION_TAGGED_OR_STAFF_COMPLETED', required: true },
  },
  { _id: false }
);

const CampaignVersionSchema = new Schema<ICampaignVersion>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    campaignId: {
      type: String,
      required: true,
      trim: true,
    },
    version: {
      type: Number,
      required: true,
      default: 1,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    industry: {
      type: String,
      default: 'BOUTIQUE',
      required: true,
    },
    purpose: {
      type: String,
      default: 'MARKETING',
      required: true,
    },
    trigger: {
      type: TriggerSchema,
      required: true,
    },
    timezone: {
      type: String,
      default: 'Asia/Kolkata',
      required: true,
    },
    audience: {
      type: AudienceSchema,
      required: true,
    },
    goal: {
      type: GoalSchema,
      required: true,
    },
    steps: {
      type: [CampaignStepSchema],
      default: [],
    },
    priority: {
      type: Number,
      default: 80,
      required: true,
    },
    resumePolicy: {
      type: String,
      default: 'FUTURE_ONLY',
      required: true,
    },
    importPolicy: {
      type: String,
      default: 'FUTURE_ONLY',
      required: true,
    },
    enabledBranches: {
      type: [String],
      default: [],
    },
    isPublished: {
      type: Boolean,
      default: false,
      required: true,
      index: true,
    },
    bindingsSchemaVersion: {
      type: Number,
      default: 2,
    },
    schemaVersion: {
      type: Number,
      default: 1,
    },
    scope: {
      type: String,
      enum: ['PER_CUSTOMER', 'PER_CUSTOMER_PER_BRANCH'],
      default: 'PER_CUSTOMER',
    },
    startAt: {
      type: Date,
      default: null,
    },
    minFirstOrderNetPaise: {
      type: Number,
      default: 0,
    },
    usefulForDays: {
      type: Number,
      default: 14,
    },
    minAffinityScore: {
      type: Number,
      default: 0.0,
    },
    goalMode: {
      type: String,
      default: null,
    },
    requireItem: {
      type: Boolean,
      default: false,
    },
    milestone: {
      type: String,
      default: null,
    },
    fulfilmentFilter: {
      type: String,
      default: null,
    },
    partialReadyTemplateRef: {
      type: Schema.Types.Mixed,
      default: null,
    },
    activatedBy: {
      type: String,
      default: null,
    },
    activatedAt: {
      type: Date,
      default: null,
    },
    reviewFingerprint: {
      type: String,
      default: null,
    },
    nextEvaluationAt: {
      type: Date,
      default: null,
    },
    seedGroup: {
      type: String,
      default: null,
      index: true,
    },
    source: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'campaignVersions',
  }
);

// Spec p25 index: unique per tenant, campaign, and version
CampaignVersionSchema.index({ tenantId: 1, campaignId: 1, version: 1 }, { unique: true });

// Enforce immutability for published versions (Hard Rule 6, Spec p9)
CampaignVersionSchema.pre('save', function (next) {
  if (!this.isNew) {
    // If it was already published, any modification is strictly forbidden
    if (this.isPublished && !this.isModified('isPublished')) {
      return next(
        new Error(
          `Campaign version ${this.version} is published and immutable. Modifications are forbidden.`
        )
      );
    }
    // Cannot unpublish an already published version
    if (this.isModified('isPublished') && !this.isPublished) {
      return next(
        new Error(
          `Campaign version ${this.version} is published and immutable. Cannot unpublish a published version.`
        )
      );
    }
  }
  next();
});

// Guard against query-level updates targeting published versions
const queryImmutabilityGuard = async function (this: any) {
  const filter = this.getFilter ? this.getFilter() : {};
  const matchingDocs = await this.model.find(filter).lean();
  for (const doc of matchingDocs) {
    if ((doc as any).isPublished) {
      throw new Error(
        `Campaign version ${(doc as any).version} is published and immutable. Updates are forbidden.`
      );
    }
  }
};

CampaignVersionSchema.pre('updateOne', queryImmutabilityGuard);
CampaignVersionSchema.pre('updateMany', queryImmutabilityGuard);
CampaignVersionSchema.pre('findOneAndUpdate', queryImmutabilityGuard);
CampaignVersionSchema.pre('replaceOne', queryImmutabilityGuard);
CampaignVersionSchema.pre('findOneAndReplace', queryImmutabilityGuard);

export const CampaignVersionModel =
  mongoose.models.CampaignVersion ||
  mongoose.model<ICampaignVersion>('CampaignVersion', CampaignVersionSchema);


