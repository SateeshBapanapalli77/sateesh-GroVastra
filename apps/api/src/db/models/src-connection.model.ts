import mongoose, { Document, Schema } from 'mongoose';

export interface ISrcConnection extends Document {
  id: string;
  tenantId: string;
  phoneNumberId: string;
  wabaId: string;
  secretRef: string;
  graphApiVersion: string;
  status: string;
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SrcConnectionSchema = new Schema<ISrcConnection>(
  {
    id: {
      type: String,
      required: true,
      trim: true,
    },
    tenantId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    phoneNumberId: {
      type: String,
      required: true,
      trim: true,
    },
    wabaId: {
      type: String,
      required: true,
      trim: true,
    },
    secretRef: {
      type: String,
      required: true,
      trim: true,
    },
    graphApiVersion: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      default: 'ACTIVE',
      trim: true,
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
    collection: 'src_connections',
  }
);

// Compound unique index ensuring tenant isolation and connection lookup
SrcConnectionSchema.index({ tenantId: 1, id: 1 }, { unique: true });
SrcConnectionSchema.index({ tenantId: 1, status: 1 });

// Read-only to application code: block modification operations at schema layer
const forbiddenMutation = function () {
  throw new Error('src_connections is read-only to application code. Modifying connections is forbidden.');
};

SrcConnectionSchema.pre('updateOne', forbiddenMutation);
SrcConnectionSchema.pre('updateMany', forbiddenMutation);
SrcConnectionSchema.pre('findOneAndUpdate', forbiddenMutation);
SrcConnectionSchema.pre('replaceOne', forbiddenMutation);
SrcConnectionSchema.pre('deleteOne', forbiddenMutation);
SrcConnectionSchema.pre('deleteMany', forbiddenMutation);
SrcConnectionSchema.pre('findOneAndDelete', forbiddenMutation);

export const SrcConnectionModel =
  mongoose.models.SrcConnection || mongoose.model<ISrcConnection>('SrcConnection', SrcConnectionSchema);
