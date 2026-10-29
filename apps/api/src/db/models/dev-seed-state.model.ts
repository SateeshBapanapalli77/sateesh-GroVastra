import mongoose, { Document, Schema } from 'mongoose';

export interface IDevSeedState extends Document {
  tenantId: string;
  liveOwner: string | null;
  appliedScenarios: string[];
  appliedAt: Date;
}

const DevSeedStateSchema = new Schema<IDevSeedState>(
  {
    tenantId: { type: String, required: true },
    liveOwner: { type: String, default: null },
    appliedScenarios: { type: [String], default: [] },
    appliedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    collection: 'dev_seedState',
  }
);

DevSeedStateSchema.index({ tenantId: 1 }, { unique: true });

export const DevSeedStateModel =
  mongoose.models.DevSeedState || mongoose.model<IDevSeedState>('DevSeedState', DevSeedStateSchema);
