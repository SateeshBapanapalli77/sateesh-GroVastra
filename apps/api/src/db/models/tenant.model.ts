import mongoose, { Document, Schema } from 'mongoose';

export interface ITenant extends Document {
  tenantId: string;
  name: string;
  status: 'active' | 'suspended';
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const TenantSchema = new Schema<ITenant>(
  {
    tenantId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
      index: true,
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
    collection: 'tenants',
  }
);

export const TenantModel = mongoose.models.Tenant || mongoose.model<ITenant>('Tenant', TenantSchema);
