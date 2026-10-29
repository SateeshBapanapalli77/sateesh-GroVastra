import { isQualifyingOrder } from './qualifying';

export interface ComputedOrderFacts {
  qualifyingOrderCount: number;
  firstQualifyingOrderId: string | null;
  firstQualifyingOrderNumber: string | null;
  firstQualifyingAt: Date | null;
  firstQualifyingNetPaise: number | null;
  secondQualifyingOrderId: string | null;
  secondQualifyingAt: Date | null;
  lastQualifyingOrderId: string | null;
  lastQualifyingPurchaseAt: Date | null;
  maxQualifyingOrderCountSeen: number;
  qualifyingOrders: any[];
}

/**
 * Computes qualifying order facts for a customer from their sorted orders list (Spec p14).
 * Enforces monotonic maxQualifyingOrderCountSeen (once >= 2, customer is never eligible for bring-back).
 */
export function computeOrderFacts(orders: any[], previousMaxSeen = 0): ComputedOrderFacts {
  // Sort orders by completedAt ascending, fallback createdAt
  const sorted = [...orders].sort((a, b) => {
    const timeA = new Date(a.completedAt || a.createdAt || 0).getTime();
    const timeB = new Date(b.completedAt || b.createdAt || 0).getTime();
    return timeA - timeB;
  });

  const qualifyingOrders = sorted.filter((o) => isQualifyingOrder(o));
  const qualifyingOrderCount = qualifyingOrders.length;

  const everCompletedCount = sorted.filter(
    (o) =>
      o.paid === true &&
      o.completedAt != null &&
      ((o.grossPaise || 0) > 0 || (o.netPaise || 0) > 0 || (o.refundedPaise || 0) > 0 || o.status === 'REFUNDED')
  ).length;

  const maxQualifyingOrderCountSeen = Math.max(previousMaxSeen, qualifyingOrderCount, everCompletedCount);

  const firstQualifying = qualifyingOrders[0] || null;
  const secondQualifying = qualifyingOrders[1] || null;
  const lastQualifying = qualifyingOrders[qualifyingOrders.length - 1] || null;

  const firstQualifyingNetPaise = firstQualifying
    ? firstQualifying.netPaise !== undefined && firstQualifying.netPaise !== null
      ? firstQualifying.netPaise
      : (firstQualifying.grossPaise || 0) - (firstQualifying.refundedPaise || 0)
    : null;

  return {
    qualifyingOrderCount,
    firstQualifyingOrderId: firstQualifying?.orderId || null,
    firstQualifyingOrderNumber: firstQualifying?.orderNumber || firstQualifying?.orderId || null,
    firstQualifyingAt: firstQualifying ? new Date(firstQualifying.completedAt || firstQualifying.createdAt) : null,
    firstQualifyingNetPaise,
    secondQualifyingOrderId: secondQualifying?.orderId || null,
    secondQualifyingAt: secondQualifying ? new Date(secondQualifying.completedAt || secondQualifying.createdAt) : null,
    lastQualifyingOrderId: lastQualifying?.orderId || null,
    lastQualifyingPurchaseAt: lastQualifying ? new Date(lastQualifying.completedAt || lastQualifying.createdAt) : null,
    maxQualifyingOrderCountSeen,
    qualifyingOrders,
  };
}
