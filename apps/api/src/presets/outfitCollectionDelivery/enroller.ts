import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignModel,
  CampaignVersionModel,
  CampaignContactGateModel,
} from '../../db/models';
import { mockFulfilmentSource } from '../../adapters/fulfilment-source';
import { mockCustomerSource } from '../../adapters/customer-source';
import { campaignSettingsService } from '../../services/campaign-settings.service';
import {
  matchFulfilmentOrder,
  matchShipmentDispatched,
  matchShipmentDelivered,
} from './matching';
import { OUTFIT_COLLECTION_DELIVERY_DEFINITION } from './definition';
import { delayTiming, formatDateOnly, formatTimeOnly } from '../_shared/eventDelay/delayTiming';
import { clock } from '../../services/clock';

export interface EnrollFulfilmentResult {
  enrolled: boolean;
  enrollmentId?: string;
  occurrenceId?: string;
  reason?: string;
  reasonText?: string;
}

export async function enrollFulfilmentReady(
  tenantId: string,
  campaignId: string,
  orderId: string,
  options?: { now?: Date; allowPast?: boolean }
): Promise<EnrollFulfilmentResult> {
  const now = options?.now || clock.now();

  const fulfilment = await mockFulfilmentSource.getFulfilment(tenantId, orderId);
  if (!fulfilment) {
    return {
      enrolled: false,
      reason: 'FULFILMENT_NOT_FOUND',
      reasonText: `Fulfilment for order '${orderId}' not found`,
    };
  }

  if (!fulfilment.customerId) {
    return {
      enrolled: false,
      reason: 'NO_CUSTOMER_RECORD',
      reasonText: 'Fulfilment record has no associated customerId',
    };
  }

  const customer = await mockCustomerSource.getCustomerById(tenantId, fulfilment.customerId);
  if (!customer) {
    return {
      enrolled: false,
      reason: 'CUSTOMER_NOT_FOUND',
      reasonText: `Customer '${fulfilment.customerId}' not found`,
    };
  }

  const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
  if (!campaign || campaign.status !== 'ACTIVE') {
    return {
      enrolled: false,
      reason: 'CAMPAIGN_NOT_ACTIVE',
      reasonText: 'Campaign is not active',
    };
  }

  const versionDoc: any =
    (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: typeof campaign.draftVersion === 'number' ? campaign.draftVersion : 1,
    }).lean()) ||
    (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
    }).sort({ version: -1 }).lean());

  const milestone = versionDoc?.milestone || versionDoc?.trigger?.milestone || 'OUTFIT_READY';
  if (milestone !== 'OUTFIT_READY') {
    return {
      enrolled: false,
      reason: 'MILESTONE_MISMATCH',
      reasonText: `Campaign milestone is ${milestone}, expected OUTFIT_READY`,
    };
  }

  const settings = await campaignSettingsService.getSettings(tenantId);
  const timezone = versionDoc?.timezone || settings?.timezone || 'Asia/Kolkata';

  const matchRes = matchFulfilmentOrder(customer, fulfilment, {
    fulfilmentFilter: versionDoc?.fulfilmentFilter || versionDoc?.trigger?.fulfilmentFilter || 'PICKUP',
    partialReadyTemplateRef: versionDoc?.partialReadyTemplateRef || versionDoc?.trigger?.partialReadyTemplateRef,
    now,
  });

  if (!matchRes.eligible) {
    return {
      enrolled: false,
      reason: matchRes.reason,
      reasonText: matchRes.reasonText,
    };
  }

  // FUTURE_ONLY policy check: if readyAt was before campaign activation, skip
  if (!options?.allowPast && campaign.activatedAt && fulfilment.readyAt) {
    if (new Date(fulfilment.readyAt).getTime() < new Date(campaign.activatedAt).getTime()) {
      return {
        enrolled: false,
        reason: 'FUTURE_ONLY_SKIPPED',
        reasonText: 'Order was marked ready before campaign activation',
      };
    }
  }

  const occurrenceId = `ready:${orderId}:${fulfilment.readinessVersion}`;
  const enrollmentKey = `${tenantId}:${campaignId}:${fulfilment.customerId}:${occurrenceId}`;

  // Check if a higher or equal readinessVersion already enrolled
  const existingEnrollment = await CampaignEnrollmentModel.findOne({
    tenantId,
    campaignId,
    occurrenceId,
  });

  if (existingEnrollment) {
    return {
      enrolled: false,
      reason: 'ALREADY_ENROLLED',
      reasonText: `Occurrence '${occurrenceId}' is already enrolled`,
      enrollmentId: existingEnrollment.enrollmentId,
      occurrenceId,
    };
  }

  const enrollmentId = `enr_ful_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const enrollment = await CampaignEnrollmentModel.create({
    tenantId,
    campaignId,
    enrollmentId,
    enrollmentKey,
    campaignVersionId: versionDoc?.version || 1,
    campaignVersion: versionDoc?.version || 1,
    customerId: fulfilment.customerId,
    occurrenceId,
    status: 'ACTIVE',
    dateHistory: [],
    metadata: {
      orderId,
      orderNumber: fulfilment.orderNumber,
      readinessVersion: fulfilment.readinessVersion,
      readinessKind: fulfilment.readinessKind,
      readyAt: fulfilment.readyAt,
    },
  });

  // Steps to schedule
  const allSteps: any[] = versionDoc?.steps || OUTFIT_COLLECTION_DELIVERY_DEFINITION.defaults?.steps || [];
  const stepsToSchedule = matchRes.isPartial
    ? [allSteps[0]] // Partial readiness: step 1 ONLY, never reminder steps
    : allSteps;

  const anchorAt = fulfilment.readyAt ? new Date(fulfilment.readyAt) : now;
  const usefulForDays = versionDoc?.usefulForDays || 14;
  const usefulUntilLimit = new Date(anchorAt.getTime() + usefulForDays * 24 * 60 * 60 * 1000);

  for (const step of stepsToSchedule) {
    const executionKey = `${enrollment.enrollmentId}:${step.stepId}`;
    const delayMinutes = step.delay?.unit === 'DAYS' ? (step.delay.value || 0) * 1440 : (step.offsetDays || 0) * 1440;
    const rawDueAt = new Date(anchorAt.getTime() + delayMinutes * 60 * 1000);

    const timing = delayTiming({
      rawDueAt,
      timezone,
      outsideHoursPolicy: step.outsideHoursPolicy || 'DEFER_NEXT_DAY',
      maxDeferralHours: step.maxDeferralHours || 16,
      allowedSendingHours: settings?.allowedSendingHours || { start: '10:00', end: '19:00' },
    });

    let state = 'SCHEDULED';
    let skipReason: string | undefined;

    // Check elapsed steps
    if (timing.adjustedDueAt.getTime() < now.getTime()) {
      state = 'SKIPPED';
      skipReason = 'SKIPPED_ELAPSED';
    }

    const maxLatenessMinutes = step.maxLatenessMinutes || 360;
    const latenessLimit = new Date(timing.adjustedDueAt.getTime() + maxLatenessMinutes * 60 * 1000);
    const expiresAt = new Date(Math.min(latenessLimit.getTime(), usefulUntilLimit.getTime()));

    // Template ref: if partial ready, use partialReadyTemplateRef
    const templateRef = matchRes.isPartial && versionDoc?.partialReadyTemplateRef
      ? versionDoc.partialReadyTemplateRef
      : step.templateRef;

    const executionId = `exe_ful_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await CampaignExecutionModel.create({
      tenantId,
      campaignId,
      executionId,
      executionKey,
      enrollmentId: enrollment.enrollmentId,
      stepId: step.stepId,
      stepName: step.stepName,
      dueAt: timing.adjustedDueAt,
      originalDueAt: rawDueAt,
      rawDueAt: rawDueAt,
      adjustedDueAt: timing.adjustedDueAt,
      deferralReason: timing.deferralReason,
      expiresAt,
      localDate: formatDateOnly(timing.adjustedDueAt, timezone),
      localTime: formatTimeOnly(timing.adjustedDueAt, timezone),
      timezone,
      planRevision: 1,
      state,
      skipReason,
      templateRef,
      selectionSnapshot: {
        orderId,
        orderNumber: fulfilment.orderNumber,
        mode: fulfilment.mode,
        status: fulfilment.status,
        readinessVersion: fulfilment.readinessVersion,
      },
      attemptCount: 0,
      attempts: [],
    });
  }

  return {
    enrolled: true,
    enrollmentId: enrollment.enrollmentId,
    occurrenceId,
  };
}

export async function enrollShipmentDispatched(
  tenantId: string,
  campaignId: string,
  orderId: string,
  shipmentId: string,
  options?: { now?: Date; allowPast?: boolean }
): Promise<EnrollFulfilmentResult> {
  const now = options?.now || clock.now();

  const fulfilment = await mockFulfilmentSource.getFulfilment(tenantId, orderId);
  if (!fulfilment) {
    return { enrolled: false, reason: 'FULFILMENT_NOT_FOUND' };
  }

  const shipment = fulfilment.shipments.find((s) => s.shipmentId === shipmentId);
  if (!shipment) {
    return { enrolled: false, reason: 'SHIPMENT_NOT_FOUND' };
  }

  if (!fulfilment.customerId) {
    return { enrolled: false, reason: 'NO_CUSTOMER_RECORD' };
  }

  const customer = await mockCustomerSource.getCustomerById(tenantId, fulfilment.customerId);
  if (!customer) {
    return { enrolled: false, reason: 'CUSTOMER_NOT_FOUND' };
  }

  const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
  if (!campaign || campaign.status !== 'ACTIVE') {
    return { enrolled: false, reason: 'CAMPAIGN_NOT_ACTIVE' };
  }

  const versionDoc: any =
    (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: typeof campaign.draftVersion === 'number' ? campaign.draftVersion : 1,
    }).lean()) ||
    (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
    }).sort({ version: -1 }).lean());

  const milestone = versionDoc?.milestone || versionDoc?.trigger?.milestone || 'DISPATCHED';
  if (milestone !== 'DISPATCHED') {
    return { enrolled: false, reason: 'MILESTONE_MISMATCH' };
  }

  const matchRes = matchShipmentDispatched(customer, fulfilment, shipment, {
    fulfilmentFilter: versionDoc?.fulfilmentFilter || versionDoc?.trigger?.fulfilmentFilter || 'DELIVERY',
  });

  if (!matchRes.eligible) {
    return { enrolled: false, reason: matchRes.reason, reasonText: matchRes.reasonText };
  }

  const occurrenceId = `dispatch:${orderId}:${shipmentId}`;
  const enrollmentKey = `${tenantId}:${campaignId}:${fulfilment.customerId}:${occurrenceId}`;

  const existing = await CampaignEnrollmentModel.findOne({ tenantId, campaignId, occurrenceId });
  if (existing) {
    return { enrolled: false, reason: 'ALREADY_ENROLLED', enrollmentId: existing.enrollmentId, occurrenceId };
  }

  const settings = await campaignSettingsService.getSettings(tenantId);
  const timezone = versionDoc?.timezone || settings?.timezone || 'Asia/Kolkata';

  const enrollmentId = `enr_dsp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const enrollment = await CampaignEnrollmentModel.create({
    tenantId,
    campaignId,
    enrollmentId,
    enrollmentKey,
    campaignVersionId: versionDoc?.version || 1,
    campaignVersion: versionDoc?.version || 1,
    customerId: fulfilment.customerId,
    occurrenceId,
    status: 'ACTIVE',
    dateHistory: [],
    metadata: {
      orderId,
      orderNumber: fulfilment.orderNumber,
      shipmentId,
      carrier: shipment.carrier,
      trackingRef: shipment.trackingRef,
      dispatchedAt: shipment.dispatchedAt,
    },
  });

  const allSteps: any[] = versionDoc?.steps || [];
  const step = allSteps[0] || {
    stepId: 'dispatched_notice',
    stepName: 'Dispatched Notice',
    templateRef: { id: 'tpl_fulfil_dispatched', revision: 1, language: 'en' },
    maxLatenessMinutes: 240,
  };

  const anchorAt = shipment.dispatchedAt ? new Date(shipment.dispatchedAt) : now;
  const executionKey = `${enrollment.enrollmentId}:${step.stepId}`;
  const timing = delayTiming({
    rawDueAt: anchorAt,
    timezone,
    outsideHoursPolicy: step.outsideHoursPolicy || 'DEFER_NEXT_DAY',
    maxDeferralHours: step.maxDeferralHours || 16,
    allowedSendingHours: settings?.allowedSendingHours || { start: '10:00', end: '19:00' },
  });

  const executionId = `exe_dsp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  await CampaignExecutionModel.create({
    tenantId,
    campaignId,
    executionId,
    executionKey,
    enrollmentId: enrollment.enrollmentId,
    stepId: step.stepId,
    stepName: step.stepName,
    dueAt: timing.adjustedDueAt,
    originalDueAt: anchorAt,
    rawDueAt: anchorAt,
    adjustedDueAt: timing.adjustedDueAt,
    deferralReason: timing.deferralReason,
    expiresAt: new Date(timing.adjustedDueAt.getTime() + (step.maxLatenessMinutes || 240) * 60 * 1000),
    localDate: formatDateOnly(timing.adjustedDueAt, timezone),
    localTime: formatTimeOnly(timing.adjustedDueAt, timezone),
    timezone,
    planRevision: 1,
    state: timing.adjustedDueAt.getTime() < now.getTime() ? 'SKIPPED' : 'SCHEDULED',
    skipReason: timing.adjustedDueAt.getTime() < now.getTime() ? 'SKIPPED_ELAPSED' : undefined,
    templateRef: step.templateRef,
    selectionSnapshot: {
      orderId,
      orderNumber: fulfilment.orderNumber,
      shipmentId,
      carrier: shipment.carrier,
      carrierName: shipment.carrierName,
      trackingRef: shipment.trackingRef,
    },
    attemptCount: 0,
    attempts: [],
  });

  return {
    enrolled: true,
    enrollmentId: enrollment.enrollmentId,
    occurrenceId,
  };
}

export async function enrollShipmentDelivered(
  tenantId: string,
  campaignId: string,
  orderId: string,
  shipmentId: string,
  options?: { now?: Date; allowPast?: boolean }
): Promise<EnrollFulfilmentResult> {
  const now = options?.now || clock.now();

  const fulfilment = await mockFulfilmentSource.getFulfilment(tenantId, orderId);
  if (!fulfilment) {
    return { enrolled: false, reason: 'FULFILMENT_NOT_FOUND' };
  }

  const shipment = fulfilment.shipments.find((s) => s.shipmentId === shipmentId);
  if (!shipment) {
    return { enrolled: false, reason: 'SHIPMENT_NOT_FOUND' };
  }

  if (!fulfilment.customerId) {
    return { enrolled: false, reason: 'NO_CUSTOMER_RECORD' };
  }

  const customer = await mockCustomerSource.getCustomerById(tenantId, fulfilment.customerId);
  if (!customer) {
    return { enrolled: false, reason: 'CUSTOMER_NOT_FOUND' };
  }

  const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
  if (!campaign || campaign.status !== 'ACTIVE') {
    return { enrolled: false, reason: 'CAMPAIGN_NOT_ACTIVE' };
  }

  const versionDoc: any =
    (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: typeof campaign.draftVersion === 'number' ? campaign.draftVersion : 1,
    }).lean()) ||
    (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
    }).sort({ version: -1 }).lean());

  const milestone = versionDoc?.milestone || versionDoc?.trigger?.milestone || 'DELIVERED';
  if (milestone !== 'DELIVERED') {
    return { enrolled: false, reason: 'MILESTONE_MISMATCH' };
  }

  const matchRes = matchShipmentDelivered(customer, fulfilment, shipment);
  if (!matchRes.eligible) {
    return { enrolled: false, reason: matchRes.reason, reasonText: matchRes.reasonText };
  }

  const occurrenceId = `delivered:${orderId}:${shipmentId}`;
  const enrollmentKey = `${tenantId}:${campaignId}:${fulfilment.customerId}:${occurrenceId}`;

  const existing = await CampaignEnrollmentModel.findOne({ tenantId, campaignId, occurrenceId });
  if (existing) {
    return { enrolled: false, reason: 'ALREADY_ENROLLED', enrollmentId: existing.enrollmentId, occurrenceId };
  }

  const settings = await campaignSettingsService.getSettings(tenantId);
  const timezone = versionDoc?.timezone || settings?.timezone || 'Asia/Kolkata';

  const enrollmentId = `enr_dlv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const enrollment = await CampaignEnrollmentModel.create({
    tenantId,
    campaignId,
    enrollmentId,
    enrollmentKey,
    campaignVersionId: versionDoc?.version || 1,
    campaignVersion: versionDoc?.version || 1,
    customerId: fulfilment.customerId,
    occurrenceId,
    status: 'ACTIVE',
    dateHistory: [],
    metadata: {
      orderId,
      orderNumber: fulfilment.orderNumber,
      shipmentId,
      carrier: shipment.carrier,
      trackingRef: shipment.trackingRef,
      deliveredAt: shipment.deliveredAt,
    },
  });

  const allSteps: any[] = versionDoc?.steps || [];
  const step = allSteps[0] || {
    stepId: 'delivered_notice',
    stepName: 'Delivered Notice',
    templateRef: { id: 'tpl_fulfil_delivered', revision: 1, language: 'en' },
    maxLatenessMinutes: 240,
  };

  const anchorAt = shipment.deliveredAt ? new Date(shipment.deliveredAt) : now;
  const executionKey = `${enrollment.enrollmentId}:${step.stepId}`;
  const timing = delayTiming({
    rawDueAt: anchorAt,
    timezone,
    outsideHoursPolicy: step.outsideHoursPolicy || 'DEFER_NEXT_DAY',
    maxDeferralHours: step.maxDeferralHours || 16,
    allowedSendingHours: settings?.allowedSendingHours || { start: '10:00', end: '19:00' },
  });

  const executionId = `exe_dlv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  await CampaignExecutionModel.create({
    tenantId,
    campaignId,
    executionId,
    executionKey,
    enrollmentId: enrollment.enrollmentId,
    stepId: step.stepId,
    stepName: step.stepName,
    dueAt: timing.adjustedDueAt,
    originalDueAt: anchorAt,
    rawDueAt: anchorAt,
    adjustedDueAt: timing.adjustedDueAt,
    deferralReason: timing.deferralReason,
    expiresAt: new Date(timing.adjustedDueAt.getTime() + (step.maxLatenessMinutes || 240) * 60 * 1000),
    localDate: formatDateOnly(timing.adjustedDueAt, timezone),
    localTime: formatTimeOnly(timing.adjustedDueAt, timezone),
    timezone,
    planRevision: 1,
    state: timing.adjustedDueAt.getTime() < now.getTime() ? 'SKIPPED' : 'SCHEDULED',
    skipReason: timing.adjustedDueAt.getTime() < now.getTime() ? 'SKIPPED_ELAPSED' : undefined,
    templateRef: step.templateRef,
    selectionSnapshot: {
      orderId,
      orderNumber: fulfilment.orderNumber,
      shipmentId,
      carrier: shipment.carrier,
      carrierName: shipment.carrierName,
      trackingRef: shipment.trackingRef,
    },
    attemptCount: 0,
    attempts: [],
  });

  return {
    enrolled: true,
    enrollmentId: enrollment.enrollmentId,
    occurrenceId,
  };
}
