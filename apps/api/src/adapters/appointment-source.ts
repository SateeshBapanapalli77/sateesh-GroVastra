import {
  SrcAppointmentModel,
  ISrcAppointment,
  AppointmentStatus,
  AppointmentServiceType,
} from '../db/models/src-appointment.model';
import { ForbiddenError } from '../errors/app-error';

export interface SourceAppointment {
  appointmentId: string;
  tenantId: string;
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
}

export function toSourceAppointment(doc: ISrcAppointment): SourceAppointment {
  return {
    appointmentId: doc.appointmentId,
    tenantId: doc.tenantId,
    customerId: doc.customerId,
    branchId: doc.branchId,
    serviceType: doc.serviceType,
    scheduledAt: doc.scheduledAt,
    status: doc.status,
    rescheduledFrom: doc.rescheduledFrom,
    rescheduledAt: doc.rescheduledAt,
    stylistName: doc.stylistName,
    notes: doc.notes,
    entityVersion: doc.entityVersion || 1,
  };
}

export interface AppointmentSource {
  getAppointment(tenantId: string, appointmentId: string): Promise<SourceAppointment | null>;
  listUpcomingAppointments(
    tenantId: string,
    fromInstant?: Date,
    toInstant?: Date
  ): Promise<SourceAppointment[]>;
}

export class MockAppointmentSource implements AppointmentSource {
  private validateTenant(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new ForbiddenError('Tenant ID is required for AppointmentSource operations');
    }
  }

  async getAppointment(tenantId: string, appointmentId: string): Promise<SourceAppointment | null> {
    this.validateTenant(tenantId);
    const doc = await SrcAppointmentModel.findOne({ tenantId, appointmentId }).lean();
    return doc ? toSourceAppointment(doc as unknown as ISrcAppointment) : null;
  }

  async listUpcomingAppointments(
    tenantId: string,
    fromInstant?: Date,
    toInstant?: Date
  ): Promise<SourceAppointment[]> {
    this.validateTenant(tenantId);
    const filter: Record<string, unknown> = {
      tenantId,
      status: { $in: ['BOOKED', 'RESCHEDULED'] },
    };
    if (fromInstant || toInstant) {
      const scheduledAtQuery: Record<string, unknown> = {};
      if (fromInstant) scheduledAtQuery.$gte = fromInstant;
      if (toInstant) scheduledAtQuery.$lte = toInstant;
      filter.scheduledAt = scheduledAtQuery;
    }
    const docs = await SrcAppointmentModel.find(filter)
      .sort({ scheduledAt: 1 })
      .lean();
    return docs.map((d) => toSourceAppointment(d as unknown as ISrcAppointment));
  }
}

export const mockAppointmentSource = new MockAppointmentSource();
