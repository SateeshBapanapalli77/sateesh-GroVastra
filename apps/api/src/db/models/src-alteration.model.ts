/**
 * src_alterations Model — F30 Fitting / Alteration Campaign (Alteration Milestone Sequence)
 *
 * Stores authoritative boutique alteration & tailoring jobs and their production milestones.
 * Triggers stage-specific notifications (e.g. trial_ready, stitching).
 * Spec rule: "Do not imply the full outfit is ready when only a blouse or alteration stage is complete."
 *
 * Tenant isolation: every query MUST include { tenantId }.
 */
import mongoose, { Document, Schema } from 'mongoose';

export type AlterationStage =
  | 'RECEIVED'
  | 'CUTTING'
  | 'STITCHING'
  | 'TRIAL_READY'
  | 'COMPLETED'
  | 'CANCELLED';

export interface AlterationMilestoneRecord {
  milestoneId: string;
  stage: AlterationStage | string;
  reachedAt: Date;
  trialDate?: Date | null;
  notes?: string | null;
}

export interface ISrcAlteration extends Document {
  tenantId: string;
  jobId: string;
  orderId: string;
  customerId: string;
  branchId: string;
  garmentDescription: string;
  currentStage: AlterationStage | string;
  milestones: AlterationMilestoneRecord[];
  trialDate?: Date | null;
  readyDate?: Date | null;
  notes?: string | null;
  entityVersion: number;
  seedGroup?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const AlterationMilestoneSchema = new Schema<AlterationMilestoneRecord>(
  {
    milestoneId: { type: String, required: true, trim: true },
    stage: { type: String, required: true, trim: true },
    reachedAt: { type: Date, required: true },
    trialDate: { type: Date, default: null },
    notes: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const SrcAlterationSchema = new Schema<ISrcAlteration>(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    jobId: { type: String, required: true, trim: true },
    orderId: { type: String, required: true, trim: true, index: true },
    customerId: { type: String, required: true, trim: true, index: true },
    branchId: { type: String, required: true, trim: true },
    garmentDescription: { type: String, required: true, trim: true },
    currentStage: {
      type: String,
      required: true,
      enum: ['RECEIVED', 'CUTTING', 'STITCHING', 'TRIAL_READY', 'COMPLETED', 'CANCELLED'],
      default: 'RECEIVED',
      index: true,
    },
    milestones: { type: [AlterationMilestoneSchema], default: [] },
    trialDate: { type: Date, default: null },
    readyDate: { type: Date, default: null },
    notes: { type: String, default: null, trim: true },
    entityVersion: { type: Number, required: true, default: 1 },
    seedGroup: { type: String, default: null, index: true },
  },
  {
    timestamps: true,
    collection: 'src_alterations',
  }
);

SrcAlterationSchema.index({ tenantId: 1, jobId: 1 }, { unique: true });
SrcAlterationSchema.index({ tenantId: 1, currentStage: 1 });
SrcAlterationSchema.index({ tenantId: 1, customerId: 1, currentStage: 1 });

export const SrcAlterationModel =
  mongoose.models.SrcAlteration ||
  mongoose.model<ISrcAlteration>('SrcAlteration', SrcAlterationSchema);
