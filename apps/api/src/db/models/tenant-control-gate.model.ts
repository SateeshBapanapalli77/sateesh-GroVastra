import mongoose, { Document, Schema } from 'mongoose';

export interface ITenantControlGate extends Document {
  tenantId: string;
  isPaused: boolean;
  pauseGeneration: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const TenantControlGateSchema = new Schema<ITenantControlGate>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    isPaused: {
      type: Boolean,
      default: false,
      required: true,
    },
    pauseGeneration: {
      type: Number,
      default: 0,
      required: true,
    },
    version: {
      type: Number,
      default: 1,
      required: true,
    },
  },
  {
    timestamps: true,
    collection: 'tenantControlGates',
  }
);

// Unique tenant control gate per tenant
TenantControlGateSchema.index({ tenantId: 1 }, { unique: true });

export const TenantControlGateModel =
  mongoose.models.TenantControlGate ||
  mongoose.model<ITenantControlGate>('TenantControlGate', TenantControlGateSchema);
