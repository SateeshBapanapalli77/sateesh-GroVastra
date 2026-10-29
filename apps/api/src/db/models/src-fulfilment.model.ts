import mongoose, { Document, Schema } from 'mongoose';

export type FulfilmentMode = 'PICKUP' | 'DELIVERY';

export type FulfilmentStatus =
  | 'NOT_READY'
  | 'PARTIALLY_READY'
  | 'READY_FOR_COLLECTION'
  | 'COLLECTED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'REWORK'
  | 'RETURNED';

export type ReadinessKind = 'FULL' | 'PARTIAL' | null;

export type ShipmentStatus =
  | 'NONE'
  | 'LABEL_CREATED'
  | 'DISPATCHED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'FAILED'
  | 'RETURNED';

export interface ISrcShipment {
  shipmentId: string;
  carrier: string;
  carrierName: string;
  trackingRef: string | null;
  status: ShipmentStatus;
  verified: boolean;
  lastCourierEventId?: string | null;
  dispatchedAt?: Date | null;
  deliveredAt?: Date | null;
  entityVersion: number;
}

export interface ISrcFulfilment extends Document {
  tenantId: string;
  orderId: string;
  customerId?: string | null;
  branchId?: string | null;
  orderNumber: string;
  mode: FulfilmentMode;
  status: FulfilmentStatus;
  readinessKind: ReadinessKind;
  readinessVersion: number;
  readyAt: Date | null;
  collectedAt?: Date | null;
  reworkReason?: string | null;
  entityVersion: number;
  shipments: ISrcShipment[];
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SrcShipmentSchema = new Schema<ISrcShipment>(
  {
    shipmentId: { type: String, required: true },
    carrier: { type: String, required: true, trim: true },
    carrierName: { type: String, required: true, trim: true },
    trackingRef: { type: String, default: null, trim: true },
    status: {
      type: String,
      required: true,
      enum: [
        'NONE',
        'LABEL_CREATED',
        'DISPATCHED',
        'IN_TRANSIT',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'FAILED',
        'RETURNED',
      ],
      default: 'NONE',
    },
    verified: { type: Boolean, default: false },
    lastCourierEventId: { type: String, default: null, trim: true },
    dispatchedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    entityVersion: { type: Number, default: 1 },
  },
  { _id: false }
);

const SrcFulfilmentSchema = new Schema<ISrcFulfilment>(
  {
    tenantId: { type: String, required: true, index: true, trim: true },
    orderId: { type: String, required: true, trim: true },
    customerId: { type: String, default: null, index: true, trim: true },
    branchId: { type: String, default: null, trim: true },
    orderNumber: { type: String, required: true, trim: true },
    mode: { type: String, required: true, enum: ['PICKUP', 'DELIVERY'], default: 'PICKUP' },
    status: {
      type: String,
      required: true,
      enum: [
        'NOT_READY',
        'PARTIALLY_READY',
        'READY_FOR_COLLECTION',
        'COLLECTED',
        'DELIVERED',
        'CANCELLED',
        'REWORK',
        'RETURNED',
      ],
      default: 'NOT_READY',
    },
    readinessKind: { type: String, enum: ['FULL', 'PARTIAL', null], default: null },
    readinessVersion: { type: Number, required: true, default: 0 },
    readyAt: { type: Date, default: null },
    collectedAt: { type: Date, default: null },
    reworkReason: { type: String, default: null, trim: true },
    entityVersion: { type: Number, required: true, default: 1 },
    shipments: { type: [SrcShipmentSchema], default: [] },
    seedGroup: { type: String, default: null },
    source: { type: String, default: 'MOCK' },
  },
  {
    timestamps: true,
    collection: 'src_fulfilments',
  }
);

SrcFulfilmentSchema.index({ tenantId: 1, orderId: 1 }, { unique: true });
SrcFulfilmentSchema.index({ tenantId: 1, status: 1, readyAt: 1 });
SrcFulfilmentSchema.index({ tenantId: 1, 'shipments.status': 1, 'shipments.dispatchedAt': 1 });

export const SrcFulfilmentModel =
  mongoose.models.SrcFulfilment ||
  mongoose.model<ISrcFulfilment>('SrcFulfilment', SrcFulfilmentSchema);
