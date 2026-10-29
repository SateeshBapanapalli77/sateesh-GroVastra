/**
 * src_appointments Model — F30 Fitting / Alteration Campaign (Fitting Appointment Sequence)
 *
 * Stores authoritative boutique fitting, measurement, and styling appointments.
 * Engine plans booking confirmation and D-1 reminder, recomputing on reschedule
 * and cancelling on appointment cancellation or completion (QA Matrix A17).
 *
 * Tenant isolation: every query MUST include { tenantId }.
 */
import mongoose, { Document, Schema } from 'mongoose';

export type AppointmentStatus = 'BOOKED' | 'RESCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
export type AppointmentServiceType = 'FITTING' | 'MEASUREMENT' | 'BRIDAL_TRIAL' | 'STYLING' | 'ALTERATION_CHECK';

export interface ISrcAppointment extends Document {
  tenantId: string;
  appointmentId: string;
  customerId: string;
  branchId: string;
  serviceType: AppointmentServiceType | string;
  scheduledAt: Date;
  status: AppointmentStatus;
  rescheduledFrom?: Date | null;
  rescheduledAt?: Date | null;
  stylistName?: string | null;
  notes?: string | null;
  entityVersion: number;
  seedGroup?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SrcAppointmentSchema = new Schema<ISrcAppointment>(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    appointmentId: { type: String, required: true, trim: true },
    customerId: { type: String, required: true, trim: true, index: true },
    branchId: { type: String, required: true, trim: true },
    serviceType: {
      type: String,
      required: true,
      trim: true,
      default: 'FITTING',
    },
    scheduledAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      required: true,
      enum: ['BOOKED', 'RESCHEDULED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'],
      default: 'BOOKED',
      index: true,
    },
    rescheduledFrom: { type: Date, default: null },
    rescheduledAt: { type: Date, default: null },
    stylistName: { type: String, default: null, trim: true },
    notes: { type: String, default: null, trim: true },
    entityVersion: { type: Number, required: true, default: 1 },
    seedGroup: { type: String, default: null, index: true },
  },
  {
    timestamps: true,
    collection: 'src_appointments',
  }
);

SrcAppointmentSchema.index({ tenantId: 1, appointmentId: 1 }, { unique: true });
SrcAppointmentSchema.index({ tenantId: 1, status: 1, scheduledAt: 1 });
SrcAppointmentSchema.index({ tenantId: 1, customerId: 1, status: 1 });

export const SrcAppointmentModel =
  mongoose.models.SrcAppointment ||
  mongoose.model<ISrcAppointment>('SrcAppointment', SrcAppointmentSchema);
