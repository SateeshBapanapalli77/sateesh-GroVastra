/**
 * Pure function to evaluate if an order is a qualifying order (Spec p14).
 *
 * Rules:
 * - paid === true
 * - status === 'COMPLETED'
 * - net > 0 where net = netPaise (or grossPaise - refundedPaise)
 * - Pending, unpaid, cancelled, net <= 0 never qualify.
 * - Partial refund keeps it while net > 0.
 * - Full refund (net <= 0 or status != 'COMPLETED') invalidates eligibility.
 */
export function isQualifyingOrder(order: {
  paid?: boolean;
  status?: string;
  netPaise?: number;
  grossPaise?: number | null;
  refundedPaise?: number | null;
}): boolean {
  if (!order) return false;

  // Must be paid
  if (order.paid !== true) return false;

  // Must have status COMPLETED
  const normalizedStatus = (order.status || '').toUpperCase();
  if (normalizedStatus !== 'COMPLETED') return false;

  // Net amount must be > 0
  let net = 0;
  if (order.netPaise !== undefined && order.netPaise !== null) {
    net = order.netPaise;
  } else if (order.grossPaise !== undefined && order.grossPaise !== null) {
    net = order.grossPaise - (order.refundedPaise || 0);
  }

  return net > 0;
}
