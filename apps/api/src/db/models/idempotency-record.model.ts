import mongoose, { Document, Schema } from 'mongoose';

export interface IIdempotencyRecord extends Document {
  tenantId: string;
  key: string;
  method: string;
  path: string;
  statusCode: number;
  responseBody: unknown;
  createdAt: Date;
}

const IdempotencyRecordSchema = new Schema<IIdempotencyRecord>(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
    key: {
      type: String,
      required: true,
      trim: true,
    },
    method: {
      type: String,
      required: true,
      trim: true,
    },
    path: {
      type: String,
      required: true,
      trim: true,
    },
    statusCode: {
      type: Number,
      required: true,
    },
    responseBody: {
      type: Schema.Types.Mixed,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 86400, // 24 hours TTL
    },
  },
  {
    timestamps: false,
    collection: 'idempotencyRecords',
  }
);

// Compound unique index ensuring idempotency per tenant and key
IdempotencyRecordSchema.index({ tenantId: 1, key: 1 }, { unique: true });

export const IdempotencyRecordModel =
  mongoose.models.IdempotencyRecord ||
  mongoose.model<IIdempotencyRecord>('IdempotencyRecord', IdempotencyRecordSchema);
