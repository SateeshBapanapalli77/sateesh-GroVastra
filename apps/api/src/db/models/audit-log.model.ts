import mongoose, { Document, Schema } from 'mongoose';

export interface IAuditLog extends Document {
  tenantId: string;
  userId?: string;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    userId: {
      type: String,
      index: true,
      trim: true,
    },
    action: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    ip: {
      type: String,
      trim: true,
    },
    userAgent: {
      type: String,
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
  },
  {
    // Append-only: disable automatic updatedAt
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'auditLog',
  }
);

// Fast chronological ordering per tenant
AuditLogSchema.index({ tenantId: 1, createdAt: -1 });

// Strictly forbid modifications or deletions at schema layer
const forbiddenMutation = function () {
  throw new Error('AuditLog is strictly append-only. Update and delete operations are forbidden.');
};

AuditLogSchema.pre('updateOne', forbiddenMutation);
AuditLogSchema.pre('updateMany', forbiddenMutation);
AuditLogSchema.pre('findOneAndUpdate', forbiddenMutation);
AuditLogSchema.pre('deleteOne', forbiddenMutation);
AuditLogSchema.pre('deleteMany', forbiddenMutation);
AuditLogSchema.pre('findOneAndDelete', forbiddenMutation);

export const AuditLogModel =
  mongoose.models.AuditLog || mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
