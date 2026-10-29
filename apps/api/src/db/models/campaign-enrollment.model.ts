import mongoose, { Document, Schema } from 'mongoose';
import { EnrollmentStatus, ENROLLMENT_STATUS } from '@grovastra/shared';

export interface ICampaignEnrollment extends Document {
  enrollmentId: string;
  enrollmentKey: string;
  tenantId: string;
  campaignId: string;
  campaignVersionId: string;
  campaignVersion: number;
  customerId: string;
  occurrenceId: string;
  sourceRef: {
    type: string;
    id: string;
    version: number;
  };
  occasionLocalDate: string;
  planRevision: number;
  status: EnrollmentStatus;
  replyHoldAt: Date | null;
  replyAttribution?: 'CAMPAIGN' | 'NOT_CAMPAIGN_CONSERVATIVE' | null;
  replyContextMessageId?: string | null;
  lastReplyHoldAt?: Date | null;
  holdResolvedAt?: Date | null;
  holdResolvedBy?: string | null;
  holdResolutionCause?: string | null;
  goalReachedAt: Date | null;
  goalEventId?: string | null;
  goalOrderRef?: string | null;
  goalSource?: string | null;
  orderRef?: string | null;
  matchExplanation: string;
  correctionGroupId: string | null;
  anchorAt?: Date | null;
  firstOrderId?: string | null;
  firstOrderNumber?: string | null;
  firstOrderNetPaise?: number | null;
  anchorOrderId?: string | null;
  anchorLineId?: string | null;
  anchorProductId?: string | null;
  anchorItemName?: string | null;
  scope?: 'PER_CUSTOMER' | 'PER_CUSTOMER_PER_BRANCH';
  creditId?: string | null;
  creditSnapshot?: {
    unit?: string;
    amount?: number;
    expiresAt?: Date;
    version?: number;
  } | null;
  destinationHash?: string | null;
  stopReason?: string | null;
  stoppedAt?: Date | null;
  exclusionReason?: string | null;
  needsStaffReview?: {
    reason: 'POSSIBLE_OPT_OUT' | 'POSSIBLE_WRONG_NUMBER';
    at: Date;
    messageId: string;
  } | null;
  eventId?: string | null;
  occasionKind?: 'GIFT' | 'WEDDING' | null;
  eventDateSnapshot?: string | null;
  dateHistory?: Array<{
    at: Date;
    oldDate: string;
    newDate: string;
    oldVersion: number;
    newVersion: number;
  }>;
  enquiryId?: string | null;
  itemRef?: {
    productId: string;
    variantId?: string | null;
  } | null;
  holdReason?: string | null;
  anchorHistory?: Array<{
    at: Date;
    oldAnchor: Date;
    newAnchor: Date;
    oldVersion: number;
    newVersion: number;
  }>;
  usefulForDays?: number;
  goalMode?: string;
  releaseId?: string | null;
  affinityScore?: number | null;
  matchSnapshot?: any;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignEnrollmentSchema = new Schema<ICampaignEnrollment>(
  {
    enrollmentId: {
      type: String,
      required: true,
      trim: true,
    },
    enrollmentKey: {
      type: String,
      required: true,
      trim: true,
    },
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
    campaignVersionId: {
      type: String,
      required: true,
      trim: true,
    },
    campaignVersion: {
      type: Number,
      required: true,
    },
    customerId: {
      type: String,
      required: true,
      trim: true,
    },
    occurrenceId: {
      type: String,
      required: true,
      trim: true,
    },
    sourceRef: {
      type: {
        type: String,
        default: null,
      },
      id: {
        type: String,
        default: null,
      },
      version: {
        type: Number,
        default: 1,
      },
    },
    occasionLocalDate: {
      type: String,
      default: null,
      trim: true,
    },
    planRevision: {
      type: Number,
      default: 1,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(ENROLLMENT_STATUS),
      default: ENROLLMENT_STATUS.ACTIVE,
      required: true,
    },
    replyHoldAt: {
      type: Date,
      default: null,
    },
    replyAttribution: {
      type: String,
      default: null,
      enum: ['CAMPAIGN', 'NOT_CAMPAIGN_CONSERVATIVE', null],
    },
    replyContextMessageId: {
      type: String,
      default: null,
      trim: true,
    },
    lastReplyHoldAt: {
      type: Date,
      default: null,
    },
    holdResolvedAt: {
      type: Date,
      default: null,
    },
    holdResolvedBy: {
      type: String,
      default: null,
      trim: true,
    },
    holdResolutionCause: {
      type: String,
      default: null,
      trim: true,
    },
    goalReachedAt: {
      type: Date,
      default: null,
    },
    goalEventId: {
      type: String,
      default: null,
      trim: true,
    },
    goalOrderRef: {
      type: String,
      default: null,
      trim: true,
    },
    goalSource: {
      type: String,
      default: null,
      trim: true,
    },
    orderRef: {
      type: String,
      default: null,
      trim: true,
    },
    matchExplanation: {
      type: String,
      default: '',
    },
    correctionGroupId: {
      type: String,
      default: null,
    },
    anchorAt: {
      type: Date,
      default: null,
    },
    firstOrderId: {
      type: String,
      default: null,
      trim: true,
    },
    firstOrderNumber: {
      type: String,
      default: null,
      trim: true,
    },
    firstOrderNetPaise: {
      type: Number,
      default: null,
    },
    anchorOrderId: {
      type: String,
      default: null,
      trim: true,
    },
    anchorLineId: {
      type: String,
      default: null,
      trim: true,
    },
    anchorProductId: {
      type: String,
      default: null,
      trim: true,
    },
    anchorItemName: {
      type: String,
      default: null,
      trim: true,
    },
    scope: {
      type: String,
      enum: ['PER_CUSTOMER', 'PER_CUSTOMER_PER_BRANCH'],
      default: 'PER_CUSTOMER',
    },
    creditId: {
      type: String,
      default: null,
      trim: true,
    },
    creditSnapshot: {
      type: Schema.Types.Mixed,
      default: null,
    },
    destinationHash: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    stopReason: {
      type: String,
      default: null,
      trim: true,
    },
    stoppedAt: {
      type: Date,
      default: null,
    },
    exclusionReason: {
      type: String,
      default: null,
      trim: true,
    },
    needsStaffReview: {
      type: Schema.Types.Mixed,
      default: null,
    },
    eventId: {
      type: String,
      default: null,
      trim: true,
    },
    occasionKind: {
      type: String,
      default: null,
      enum: ['GIFT', 'WEDDING', null],
    },
    eventDateSnapshot: {
      type: String,
      default: null,
      trim: true,
    },
    dateHistory: {
      type: [
        {
          _id: false,
          at: { type: Date, required: true },
          oldDate: { type: String, required: true },
          newDate: { type: String, required: true },
          oldVersion: { type: Number, required: true },
          newVersion: { type: Number, required: true },
        },
      ],
      default: [],
    },
    enquiryId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    itemRef: {
      type: Schema.Types.Mixed,
      default: null,
    },
    holdReason: {
      type: String,
      default: null,
      trim: true,
    },
    anchorHistory: {
      type: [
        {
          _id: false,
          at: { type: Date, required: true },
          oldAnchor: { type: Date, required: true },
          newAnchor: { type: Date, required: true },
          oldVersion: { type: Number, required: true },
          newVersion: { type: Number, required: true },
        },
      ],
      default: [],
    },
    usefulForDays: {
      type: Number,
      default: null,
    },
    goalMode: {
      type: String,
      default: null,
    },
    releaseId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    affinityScore: {
      type: Number,
      default: null,
    },
    matchSnapshot: {
      type: Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'campaignEnrollments',
  }
);

// Indexes strictly adhering to Spec p25, p18
// enrollmentKey = tenantId + campaignId + customerId + occurrenceId
CampaignEnrollmentSchema.index(
  { tenantId: 1, campaignId: 1, customerId: 1, occurrenceId: 1 },
  { unique: true }
);
CampaignEnrollmentSchema.index({ tenantId: 1, enrollmentId: 1 }, { unique: true });
CampaignEnrollmentSchema.index({ tenantId: 1, enrollmentKey: 1 }, { unique: true });
CampaignEnrollmentSchema.index({ tenantId: 1, campaignId: 1, status: 1, createdAt: -1 });
CampaignEnrollmentSchema.index({ tenantId: 1, customerId: 1 });

export const CampaignEnrollmentModel =
  mongoose.models.CampaignEnrollment ||
  mongoose.model<ICampaignEnrollment>('CampaignEnrollment', CampaignEnrollmentSchema);
