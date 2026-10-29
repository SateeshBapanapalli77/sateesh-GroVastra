/**
 * REST routes for Fitting / Alteration Campaign (F30)
 *
 * Endpoints:
 * - GET /campaigns/:id/fitting-alteration/summary
 * - POST /campaigns/:id/fitting-alteration/preview
 * - POST /dev/fitting-alteration/trigger-appointment
 * - POST /dev/fitting-alteration/trigger-alteration
 */
import { Router, Request, Response } from 'express';
import {
  CampaignModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  SrcAppointmentModel,
  SrcAlterationModel,
} from '../../db/models';
import { authenticate, requireRole } from '../../middleware/auth';
import { mockAppointmentSource } from '../../adapters/appointment-source';
import { mockAlterationSource } from '../../adapters/alteration-source';
import { mockCustomerSource } from '../../adapters/customer-source';
import { matchFittingAppointment, matchAlterationMilestone } from './matching';
import { eventConsumerService } from '../../services/event-consumer/event-consumer.service';
import { clock } from '../../services/clock';

export const fittingAlterationRouter = Router();

/**
 * GET /campaigns/:id/fitting-alteration/summary
 */
fittingAlterationRouter.get(
  '/campaigns/:id/fitting-alteration/summary',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId;
    const campaignId = req.params.id;

    const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const [appointmentsCount, alterationsCount, enrollmentsCount, executionsCount] =
      await Promise.all([
        SrcAppointmentModel.countDocuments({
          tenantId,
          status: { $in: ['BOOKED', 'RESCHEDULED'] },
        }),
        SrcAlterationModel.countDocuments({
          tenantId,
          currentStage: { $nin: ['COMPLETED', 'CANCELLED'] },
        }),
        CampaignEnrollmentModel.countDocuments({ tenantId, campaignId }),
        CampaignExecutionModel.countDocuments({ tenantId, executionKey: { $regex: /:appointment_|:alteration_/ } }),
      ]);

    const upcomingAppointments = await mockAppointmentSource.listUpcomingAppointments(
      tenantId,
      clock.now()
    );

    res.json({
      campaignId,
      status: campaign.status,
      appointmentsCount,
      alterationsCount,
      enrollmentsCount,
      executionsCount,
      upcomingAppointments: upcomingAppointments.slice(0, 10),
    });
  }
);

/**
 * POST /campaigns/:id/fitting-alteration/preview
 */
fittingAlterationRouter.post(
  '/campaigns/:id/fitting-alteration/preview',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId;
    const { appointmentId, jobId, customerId } = req.body;

    if (!appointmentId && !jobId) {
      res.status(400).json({ error: 'Either appointmentId or jobId is required' });
      return;
    }

    if (appointmentId) {
      const appointment = await mockAppointmentSource.getAppointment(tenantId, appointmentId);
      if (!appointment) {
        res.status(404).json({ error: `Appointment '${appointmentId}' not found` });
        return;
      }
      const custId = customerId || appointment.customerId;
      const customer = await mockCustomerSource.getCustomerById(tenantId, custId);
      if (!customer) {
        res.status(404).json({ error: `Customer '${custId}' not found` });
        return;
      }
      const match = matchFittingAppointment(customer, appointment);
      res.json({
        type: 'APPOINTMENT',
        appointment,
        customer: { customerId: customer.customerId, firstName: customer.firstName },
        match,
      });
      return;
    }

    if (jobId) {
      const alteration = await mockAlterationSource.getAlteration(tenantId, jobId);
      if (!alteration) {
        res.status(404).json({ error: `Alteration '${jobId}' not found` });
        return;
      }
      const custId = customerId || alteration.customerId;
      const customer = await mockCustomerSource.getCustomerById(tenantId, custId);
      if (!customer) {
        res.status(404).json({ error: `Customer '${custId}' not found` });
        return;
      }
      const match = matchAlterationMilestone(customer, alteration);
      res.json({
        type: 'ALTERATION',
        alteration,
        customer: { customerId: customer.customerId, firstName: customer.firstName },
        match,
      });
      return;
    }
  }
);

/**
 * POST /dev/fitting-alteration/trigger-appointment
 */
fittingAlterationRouter.post(
  '/dev/fitting-alteration/trigger-appointment',
  authenticate,
  requireRole(['owner', 'admin']),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId;
    const { appointmentId, eventType = 'appointment.booked', data = {} } = req.body;

    if (!appointmentId) {
      res.status(400).json({ error: 'appointmentId is required' });
      return;
    }

    const eventResult = await eventConsumerService.ingestEvent({
      tenantId,
      producer: 'appointments',
      eventId: `evt_appt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: eventType,
      schemaVersion: 1,
      entityId: appointmentId,
      entityVersion: 1,
      occurredAt: clock.now(),
      receivedAt: clock.now(),
      data,
    });

    res.json({ success: true, eventResult });
  }
);

/**
 * POST /dev/fitting-alteration/trigger-alteration
 */
fittingAlterationRouter.post(
  '/dev/fitting-alteration/trigger-alteration',
  authenticate,
  requireRole(['owner', 'admin']),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId;
    const { jobId, eventType = 'alteration.stage_changed', data = {} } = req.body;

    if (!jobId) {
      res.status(400).json({ error: 'jobId is required' });
      return;
    }

    const eventResult = await eventConsumerService.ingestEvent({
      tenantId,
      producer: 'alterations',
      eventId: `evt_alt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: eventType,
      schemaVersion: 1,
      entityId: jobId,
      entityVersion: 1,
      occurredAt: clock.now(),
      receivedAt: clock.now(),
      data,
    });

    res.json({ success: true, eventResult });
  }
);
