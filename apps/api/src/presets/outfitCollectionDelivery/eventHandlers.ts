/**
 * Event Handlers for Outfit Collection / Delivery Campaign (F31)
 *
 * Handles domain events:
 * - fulfilment.updated (entityId = orderId)
 * - shipment.updated (entityId = shipmentId)
 *
 * Strict Spec Guarantees:
 * - Events are hints: re-reads authoritative source from mockFulfilmentSource.
 * - Older entityVersion never overwrites newer state.
 * - Duplicate courier events deduped by courierEventId.
 * - State transitions:
 *   - COLLECTED / DELIVERED / CANCELLED / RETURNED cancels unsent ready steps with ORDER_*
 *   - DELIVERED supersedes unsent DISPATCHED steps with STATUS_SUPERSEDED
 *   - REWORK cancels unsent ready steps with ORDER_IN_REWORK
 *   - Mode change PICKUP -> DELIVERY cancels unsent pickup steps with DELIVERY_ARRANGED
 *   - Shipment FAILED or RETURNED cancels unsent delivery steps with SHIPMENT_FAILED
 *   - Label creation alone is NOT dispatch (UNVERIFIED_SHIPMENT_EVENT)
 */

import {
  ICampaignEventInbox,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignModel,
  CampaignVersionModel,
} from '../../db/models';
import { mockFulfilmentSource } from '../../adapters/fulfilment-source';
import {
  enrollFulfilmentReady,
  enrollShipmentDispatched,
  enrollShipmentDelivered,
} from './enroller';
import {
  OUTFIT_COLLECTION_DELIVERY_ID,
  OUTFIT_COLLECTION_DELIVERY_ALIASES,
} from './definition';
import { SrcFulfilmentModel } from '../../db/models/src-fulfilment.model';

const MATCHING_PRESETS = [
  OUTFIT_COLLECTION_DELIVERY_ID,
  ...OUTFIT_COLLECTION_DELIVERY_ALIASES,
];

// Set of processed courierEventIds for deduplication
const processedCourierEvents = new Set<string>();

export async function handleFulfilmentEvent(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, entityId: orderId, type } = eventDoc;
  const payload = (eventDoc.data || (eventDoc as any).payload || {}) as Record<string, any>;

  const fulfilment = await mockFulfilmentSource.getFulfilment(tenantId, orderId);
  if (!fulfilment) {
    return {
      handler: type,
      orderId,
      outcome: 'QUARANTINED',
      reason: 'FULFILMENT_NOT_FOUND',
      reasonText: `Fulfilment for order '${orderId}' not found`,
    };
  }

  // Staleness check against entityVersion
  if (
    typeof eventDoc.entityVersion === 'number' &&
    typeof fulfilment.entityVersion === 'number' &&
    eventDoc.entityVersion < fulfilment.entityVersion
  ) {
    return {
      handler: type,
      orderId,
      outcome: 'IGNORED',
      reason: 'STALE_ENTITY_VERSION',
      reasonText: `Event entityVersion (${eventDoc.entityVersion}) is older than source (${fulfilment.entityVersion})`,
    };
  }

  // Handle Mode Change (e.g. changed to DELIVERY after ready enrollment)
  if (fulfilment.mode === 'DELIVERY') {
    const readyEnrs = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: { $regex: `^ready:${orderId}:` },
      status: 'ACTIVE',
    }).lean();

    for (const enr of readyEnrs) {
      // Find if campaign has PICKUP filter
      const campVer = await CampaignVersionModel.findOne({
        tenantId,
        campaignId: enr.campaignId,
        version: enr.campaignVersion,
      }).lean();

      if (!campVer || (campVer as any).fulfilmentFilter !== 'DELIVERY') {
        await CampaignExecutionModel.updateMany(
          {
            tenantId,
            enrollmentId: enr.enrollmentId,
            state: { $in: ['SCHEDULED', 'DEFERRED'] },
          },
          {
            $set: {
              state: 'CANCELLED',
              skipReason: 'DELIVERY_ARRANGED',
              cancellationReason: 'DELIVERY_ARRANGED',
            },
          }
        );
      }
    }
  }

  // Handle Order Status Transitions:
  // COLLECTED, DELIVERED, CANCELLED, RETURNED, REWORK
  if (fulfilment.status === 'COLLECTED') {
    const readyEnrs = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: { $regex: `^ready:${orderId}:` },
    }).lean();

    for (const enr of readyEnrs) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          state: { $in: ['SCHEDULED', 'DEFERRED'] },
        },
        {
          $set: {
            state: 'CANCELLED',
            skipReason: 'ORDER_COLLECTED',
            cancellationReason: 'ORDER_COLLECTED',
          },
        }
      );
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId: enr.enrollmentId },
        { $set: { status: 'COMPLETED' } }
      );
    }

    return {
      handler: type,
      orderId,
      outcome: 'CANCELLED',
      reason: 'ORDER_COLLECTED',
      cancelledEnrollments: readyEnrs.length,
    };
  }

  if (fulfilment.status === 'DELIVERED') {
    // Cancel unsent ready steps with ORDER_DELIVERED
    const readyEnrs = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: { $regex: `^ready:${orderId}:` },
    }).lean();

    for (const enr of readyEnrs) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          state: { $in: ['SCHEDULED', 'DEFERRED'] },
        },
        {
          $set: {
            state: 'CANCELLED',
            skipReason: 'ORDER_DELIVERED',
            cancellationReason: 'ORDER_DELIVERED',
          },
        }
      );
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId: enr.enrollmentId },
        { $set: { status: 'COMPLETED' } }
      );
    }

    // Cancel unsent DISPATCHED steps with STATUS_SUPERSEDED
    const dispatchEnrs = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: { $regex: `^dispatch:${orderId}:` },
    }).lean();

    for (const enr of dispatchEnrs) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          state: { $in: ['SCHEDULED', 'DEFERRED'] },
        },
        {
          $set: {
            state: 'CANCELLED',
            skipReason: 'STATUS_SUPERSEDED',
            cancellationReason: 'STATUS_SUPERSEDED',
          },
        }
      );
    }

    return {
      handler: type,
      orderId,
      outcome: 'CANCELLED',
      reason: 'ORDER_DELIVERED',
    };
  }

  if (fulfilment.status === 'CANCELLED') {
    const allEnrs = await CampaignEnrollmentModel.find({
      tenantId,
      $or: [
        { occurrenceId: { $regex: `^ready:${orderId}:` } },
        { occurrenceId: { $regex: `^dispatch:${orderId}:` } },
        { occurrenceId: { $regex: `^delivered:${orderId}:` } },
      ],
    }).lean();

    for (const enr of allEnrs) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          state: { $in: ['SCHEDULED', 'DEFERRED'] },
        },
        {
          $set: {
            state: 'CANCELLED',
            skipReason: 'ORDER_CANCELLED',
            cancellationReason: 'ORDER_CANCELLED',
          },
        }
      );
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId: enr.enrollmentId },
        { $set: { status: 'CANCELLED' } }
      );
    }

    return {
      handler: type,
      orderId,
      outcome: 'CANCELLED',
      reason: 'ORDER_CANCELLED',
      cancelledEnrollments: allEnrs.length,
    };
  }

  if (fulfilment.status === 'RETURNED') {
    const allEnrs = await CampaignEnrollmentModel.find({
      tenantId,
      $or: [
        { occurrenceId: { $regex: `^ready:${orderId}:` } },
        { occurrenceId: { $regex: `^dispatch:${orderId}:` } },
        { occurrenceId: { $regex: `^delivered:${orderId}:` } },
      ],
    }).lean();

    for (const enr of allEnrs) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          state: { $in: ['SCHEDULED', 'DEFERRED'] },
        },
        {
          $set: {
            state: 'CANCELLED',
            skipReason: 'ORDER_RETURNED',
            cancellationReason: 'ORDER_RETURNED',
          },
        }
      );
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId: enr.enrollmentId },
        { $set: { status: 'CANCELLED' } }
      );
    }

    return {
      handler: type,
      orderId,
      outcome: 'CANCELLED',
      reason: 'ORDER_RETURNED',
      cancelledEnrollments: allEnrs.length,
    };
  }

  if (fulfilment.status === 'REWORK') {
    const readyEnrs = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: { $regex: `^ready:${orderId}:` },
      status: 'ACTIVE',
    }).lean();

    for (const enr of readyEnrs) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          state: { $in: ['SCHEDULED', 'DEFERRED'] },
        },
        {
          $set: {
            state: 'CANCELLED',
            skipReason: 'ORDER_IN_REWORK',
            cancellationReason: 'ORDER_IN_REWORK',
          },
        }
      );
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId: enr.enrollmentId },
        { $set: { status: 'CANCELLED' } }
      );
    }

    return {
      handler: type,
      orderId,
      outcome: 'CANCELLED',
      reason: 'ORDER_IN_REWORK',
      cancelledEnrollments: readyEnrs.length,
    };
  }

  // Handle READY_FOR_COLLECTION or PARTIALLY_READY -> Enroll active campaigns
  if (
    fulfilment.status === 'READY_FOR_COLLECTION' ||
    fulfilment.status === 'PARTIALLY_READY'
  ) {
    const activeCampaigns = await CampaignModel.find({
      tenantId,
      presetId: { $in: MATCHING_PRESETS },
      status: 'ACTIVE',
    }).lean();

    if (activeCampaigns.length === 0) {
      return {
        handler: type,
        orderId,
        outcome: 'NOOP',
        reason: 'NO_ACTIVE_FULFILMENT_CAMPAIGNS',
      };
    }

    const results = [];
    for (const cmp of activeCampaigns) {
      const ver: any = await CampaignVersionModel.findOne({
        tenantId,
        campaignId: cmp.campaignId,
      }).sort({ version: -1 }).lean();
      const milestone = ver?.milestone || ver?.trigger?.milestone || 'OUTFIT_READY';
      if (milestone === 'OUTFIT_READY') {
        const res = await enrollFulfilmentReady(tenantId, cmp.campaignId, orderId);
        results.push({ campaignId: cmp.campaignId, ...res });
      }
    }

    return {
      handler: type,
      orderId,
      outcome: 'ENROLLED',
      results,
    };
  }

  return {
    handler: type,
    orderId,
    outcome: 'NOOP',
    status: fulfilment.status,
  };
}

export async function handleShipmentEvent(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, entityId: shipmentId, type } = eventDoc;
  const payload = (eventDoc.data || (eventDoc as any).payload || {}) as Record<string, any>;
  const orderId = payload.orderId;

  // Courier event deduplication
  const courierEventId = payload.courierEventId || payload.lastCourierEventId;
  if (courierEventId) {
    const dedupeKey = `${tenantId}:${shipmentId}:${courierEventId}`;
    if (processedCourierEvents.has(dedupeKey)) {
      return {
        handler: type,
        shipmentId,
        outcome: 'IGNORED',
        reason: 'DUPLICATE_COURIER_EVENT',
        courierEventId,
      };
    }
    processedCourierEvents.add(dedupeKey);
  }

  // Re-read authoritative fulfilment and shipment record
  let fulfilment = orderId
    ? await mockFulfilmentSource.getFulfilment(tenantId, orderId)
    : null;

  if (!fulfilment) {
    const raw = await SrcFulfilmentModel.findOne({
      tenantId,
      'shipments.shipmentId': shipmentId,
    }).lean();
    if (raw) {
      fulfilment = raw as any;
    }
  }

  if (!fulfilment) {
    return {
      handler: type,
      shipmentId,
      outcome: 'QUARANTINED',
      reason: 'SHIPMENT_INVALID',
      reasonText: `Fulfilment for shipment '${shipmentId}' not found`,
    };
  }

  const shipment = fulfilment.shipments?.find((s) => s.shipmentId === shipmentId);
  if (!shipment) {
    return {
      handler: type,
      shipmentId,
      outcome: 'QUARANTINED',
      reason: 'SHIPMENT_NOT_FOUND',
      reasonText: `Shipment '${shipmentId}' not found in order '${fulfilment.orderId}'`,
    };
  }

  // Check shipment entityVersion staleness
  if (
    typeof eventDoc.entityVersion === 'number' &&
    typeof shipment.entityVersion === 'number' &&
    eventDoc.entityVersion < shipment.entityVersion
  ) {
    return {
      handler: type,
      shipmentId,
      outcome: 'IGNORED',
      reason: 'STALE_SHIPMENT_VERSION',
      reasonText: `Shipment entityVersion (${eventDoc.entityVersion}) is older than source (${shipment.entityVersion})`,
    };
  }

  // Handle shipment FAILED or RETURNED
  if (shipment.status === 'FAILED' || shipment.status === 'RETURNED') {
    const enrs = await CampaignEnrollmentModel.find({
      tenantId,
      $or: [
        { occurrenceId: `dispatch:${fulfilment.orderId}:${shipmentId}` },
        { occurrenceId: `delivered:${fulfilment.orderId}:${shipmentId}` },
      ],
      status: 'ACTIVE',
    }).lean();

    for (const enr of enrs) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          state: { $in: ['SCHEDULED', 'DEFERRED'] },
        },
        {
          $set: {
            state: 'CANCELLED',
            skipReason: 'SHIPMENT_FAILED',
            cancellationReason: 'SHIPMENT_FAILED',
          },
        }
      );
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId: enr.enrollmentId },
        { $set: { status: 'CANCELLED' } }
      );
    }

    return {
      handler: type,
      shipmentId,
      outcome: 'CANCELLED',
      reason: 'SHIPMENT_FAILED',
    };
  }

  // Unverified events or non-triggering status (e.g. LABEL_CREATED alone is NOT dispatch)
  if (!shipment.verified) {
    return {
      handler: type,
      shipmentId,
      outcome: 'IGNORED',
      reason: 'UNVERIFIED_SHIPMENT_EVENT',
      reasonText: 'Shipment event is unverified by courier',
    };
  }

  // Handle verified DELIVERED
  if (shipment.status === 'DELIVERED') {
    // Supersede any pending DISPATCHED steps for this shipment
    const dispatchEnrs = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: `dispatch:${fulfilment.orderId}:${shipmentId}`,
    }).lean();

    for (const enr of dispatchEnrs) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          state: { $in: ['SCHEDULED', 'DEFERRED'] },
        },
        {
          $set: {
            state: 'CANCELLED',
            skipReason: 'STATUS_SUPERSEDED',
            cancellationReason: 'STATUS_SUPERSEDED',
          },
        }
      );
    }

    const activeCampaigns = await CampaignModel.find({
      tenantId,
      presetId: { $in: MATCHING_PRESETS },
      status: 'ACTIVE',
    }).lean();

    const results = [];
    for (const cmp of activeCampaigns) {
      const ver: any = await CampaignVersionModel.findOne({
        tenantId,
        campaignId: cmp.campaignId,
      }).sort({ version: -1 }).lean();

      const milestone = ver?.milestone || ver?.trigger?.milestone;
      if (milestone === 'DELIVERED') {
        const res = await enrollShipmentDelivered(
          tenantId,
          cmp.campaignId,
          fulfilment.orderId,
          shipmentId
        );
        results.push({ campaignId: cmp.campaignId, ...res });
      }
    }

    return {
      handler: type,
      shipmentId,
      outcome: 'ENROLLED',
      results,
    };
  }

  // Handle verified DISPATCHED
  if (shipment.status === 'DISPATCHED') {
    // If order or shipment is already delivered, out-of-order DISPATCHED is ignored
    if (shipment.deliveredAt || fulfilment.status === 'DELIVERED') {
      return {
        handler: type,
        shipmentId,
        outcome: 'IGNORED',
        reason: 'STATUS_SUPERSEDED',
        reasonText: 'Out-of-order DISPATCHED event arriving after DELIVERED',
      };
    }

    const activeCampaigns = await CampaignModel.find({
      tenantId,
      presetId: { $in: MATCHING_PRESETS },
      status: 'ACTIVE',
    }).lean();

    const results = [];
    for (const cmp of activeCampaigns) {
      const ver: any = await CampaignVersionModel.findOne({
        tenantId,
        campaignId: cmp.campaignId,
      }).sort({ version: -1 }).lean();

      const milestone = ver?.milestone || ver?.trigger?.milestone;
      if (milestone === 'DISPATCHED') {
        const res = await enrollShipmentDispatched(
          tenantId,
          cmp.campaignId,
          fulfilment.orderId,
          shipmentId
        );
        results.push({ campaignId: cmp.campaignId, ...res });
      }
    }

    return {
      handler: type,
      shipmentId,
      outcome: 'ENROLLED',
      results,
    };
  }

  return {
    handler: type,
    shipmentId,
    outcome: 'IGNORED',
    reason: 'UNVERIFIED_SHIPMENT_EVENT',
    status: shipment.status,
  };
}
