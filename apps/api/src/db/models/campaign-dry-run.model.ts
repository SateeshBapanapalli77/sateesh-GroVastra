import mongoose, { Document, Schema } from 'mongoose';
import {
  SampleRecipientPlan,
  ExcludedSample,
} from '@grovastra/shared';

export interface ICampaignDryRun extends Document {
  dryRunId: string;
  tenantId: string;
  campaignId: string;
  draftVersion: number;
  draftFingerprint: string;
  counts: {
    scanned: number;
    eligible: number;
    excluded: number;
  };
  reasonBreakdown: Record<string, number>;
  variableBreakdown?: {
    ok: number;
    usedFallback: number;
    skippedMissing: number;
    skippedTooLong: number;
  };
  samplePlans: SampleRecipientPlan[];
  excludedSamples: ExcludedSample[];
  evaluatedAt: Date;
  evaluatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignDryRunSchema = new Schema<ICampaignDryRun>(
  {
    dryRunId: {
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
    draftVersion: {
      type: Number,
      required: true,
    },
    draftFingerprint: {
      type: String,
      required: true,
      trim: true,
    },
    counts: {
      scanned: { type: Number, required: true, default: 0 },
      eligible: { type: Number, required: true, default: 0 },
      excluded: { type: Number, required: true, default: 0 },
    },
    reasonBreakdown: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
    variableBreakdown: {
      type: Schema.Types.Mixed,
      required: false,
      default: { ok: 0, usedFallback: 0, skippedMissing: 0, skippedTooLong: 0 },
    },
    samplePlans: {
      type: Schema.Types.Mixed,
      required: true,
      default: [],
    },
    excludedSamples: {
      type: Schema.Types.Mixed,
      required: true,
      default: [],
    },
    evaluatedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    evaluatedBy: {
      type: String,
      trim: true,
    },
  },
  {
    collection: 'campaignDryRuns',
    timestamps: true,
  }
);

// Compound Unique Index on { tenantId, dryRunId } (Spec p25, Hard Rule 1)
CampaignDryRunSchema.index({ tenantId: 1, dryRunId: 1 }, { unique: true });

// Query index for latest dry runs per campaign
CampaignDryRunSchema.index({ tenantId: 1, campaignId: 1, evaluatedAt: -1 });

// Query index for fingerprint lookup
CampaignDryRunSchema.index({ tenantId: 1, draftFingerprint: 1 });

export const CampaignDryRunModel =
  mongoose.models.CampaignDryRun ||
  mongoose.model<ICampaignDryRun>('CampaignDryRun', CampaignDryRunSchema);
