import { SourceCustomer } from '@grovastra/shared';
import { SourceFulfilment, SourceShipment } from '../../adapters/fulfilment-source';
import { clock } from '../../services/clock';

export interface FulfilmentMatchingResult {
  eligible: boolean;
  reason?: string;
  reasonText?: string;
  isPartial?: boolean;
}

export function matchFulfilmentOrder(
  customer: SourceCustomer,
  fulfilment: SourceFulfilment,
  options?: {
    fulfilmentFilter?: 'PICKUP' | 'DELIVERY' | 'ANY';
    partialReadyTemplateRef?: any;
    now?: Date;
  }
): FulfilmentMatchingResult {
  // 1. Customer account integrity
  if (customer.status === 'DELETED' || (customer as any).deletedAt) {
    return {
      eligible: false,
      reason: 'CUSTOMER_DELETED',
      reasonText: 'Customer record is deleted',
    };
  }

  // 2. Channel suppression
  if (customer.consent?.channelSuppressed || (customer as any).channelSuppressed) {
    return {
      eligible: false,
      reason: 'CHANNEL_SUPPRESSED',
      reasonText: 'Customer is channel-suppressed',
    };
  }

  // 2.5. Unverified destination
  if (customer.destination && customer.destination.verified === false) {
    return {
      eligible: false,
      reason: 'UNVERIFIED_DESTINATION',
      reasonText: 'Customer destination phone is unverified',
    };
  }

  // 3. Mode check (Spec p15: "IF DELIVERY IS ARRANGED, DO NOT SEND PICKUP INSTRUCTIONS")
  const filter = options?.fulfilmentFilter || 'PICKUP';
  if (filter === 'PICKUP' && fulfilment.mode === 'DELIVERY') {
    return {
      eligible: false,
      reason: 'DELIVERY_ARRANGED',
      reasonText: 'Delivery is arranged for this order; pickup instructions are not sent',
    };
  }

  // 4. Status check: must not be in terminal/rework status
  if (['COLLECTED', 'DELIVERED', 'CANCELLED', 'REWORK', 'RETURNED'].includes(fulfilment.status)) {
    return {
      eligible: false,
      reason: `ORDER_${fulfilment.status}`,
      reasonText: `Order is already in state '${fulfilment.status}'`,
    };
  }

  // 5. Readiness verification
  if (fulfilment.status === 'READY_FOR_COLLECTION' && fulfilment.readinessKind === 'FULL') {
    if (fulfilment.readinessVersion < 1) {
      return {
        eligible: false,
        reason: 'READINESS_VERSION_INVALID',
        reasonText: 'Order readiness version must be at least 1',
      };
    }
    return { eligible: true };
  }

  // Partial readiness handling
  if (fulfilment.status === 'PARTIALLY_READY' || fulfilment.readinessKind === 'PARTIAL') {
    if (options?.partialReadyTemplateRef) {
      return { eligible: true, isPartial: true };
    }
    return {
      eligible: false,
      reason: 'PARTIAL_READY_NOT_ALLOWED',
      reasonText: 'Partial readiness requires an explicitly configured partialReadyTemplateRef',
    };
  }

  return {
    eligible: false,
    reason: 'NOT_READY_FOR_COLLECTION',
    reasonText: `Order status '${fulfilment.status}' is not ready for collection`,
  };
}

export function matchShipmentDispatched(
  customer: SourceCustomer,
  fulfilment: SourceFulfilment,
  shipment: SourceShipment,
  options?: {
    fulfilmentFilter?: 'PICKUP' | 'DELIVERY' | 'ANY';
  }
): FulfilmentMatchingResult {
  // 1. Customer account integrity
  if (customer.status === 'DELETED' || (customer as any).deletedAt) {
    return {
      eligible: false,
      reason: 'CUSTOMER_DELETED',
      reasonText: 'Customer record is deleted',
    };
  }

  // 2. Channel suppression
  if ((customer as any).channelSuppressed) {
    return {
      eligible: false,
      reason: 'CHANNEL_SUPPRESSED',
      reasonText: 'Customer is channel-suppressed',
    };
  }

  // 3. Mode check
  const filter = options?.fulfilmentFilter || 'DELIVERY';
  if (filter === 'DELIVERY' && fulfilment.mode === 'PICKUP') {
    return {
      eligible: false,
      reason: 'PICKUP_ARRANGED',
      reasonText: 'Order is configured for store pickup, not courier dispatch',
    };
  }

  // 4. Order status
  if (['CANCELLED', 'RETURNED'].includes(fulfilment.status)) {
    return {
      eligible: false,
      reason: `ORDER_${fulfilment.status}`,
      reasonText: `Order is ${fulfilment.status}`,
    };
  }

  // 5. Verified dispatch (Spec p15: "LABEL CREATION ALONE IS NOT DISPATCH; trigger on VERIFIED dispatched events")
  if (shipment.status !== 'DISPATCHED' || !shipment.verified) {
    return {
      eligible: false,
      reason: 'UNVERIFIED_SHIPMENT_EVENT',
      reasonText: `Shipment status is '${shipment.status}' (verified: ${shipment.verified}); dispatch notice requires verified DISPATCHED status`,
    };
  }

  return { eligible: true };
}

export function matchShipmentDelivered(
  customer: SourceCustomer,
  fulfilment: SourceFulfilment,
  shipment: SourceShipment
): FulfilmentMatchingResult {
  // 1. Customer account integrity
  if (customer.status === 'DELETED' || (customer as any).deletedAt) {
    return {
      eligible: false,
      reason: 'CUSTOMER_DELETED',
      reasonText: 'Customer record is deleted',
    };
  }

  // 2. Channel suppression
  if ((customer as any).channelSuppressed) {
    return {
      eligible: false,
      reason: 'CHANNEL_SUPPRESSED',
      reasonText: 'Customer is channel-suppressed',
    };
  }

  // 3. Verified delivery
  if (shipment.status !== 'DELIVERED' || !shipment.verified) {
    return {
      eligible: false,
      reason: 'UNVERIFIED_SHIPMENT_EVENT',
      reasonText: `Shipment status is '${shipment.status}' (verified: ${shipment.verified}); delivery notice requires verified DELIVERED status`,
    };
  }

  return { eligible: true };
}
