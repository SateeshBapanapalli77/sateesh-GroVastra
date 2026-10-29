import { CampaignCustomerFactModel, ICampaignCustomerFact } from '../../db/models/campaign-customer-fact.model';
import { SrcOrderModel } from '../../db/models/src-order.model';
import { SrcCustomerModel } from '../../db/models/src-customer.model';
import { logger } from '../../logger';

export class CustomerFactsService {
  /**
   * Recomputes/projects campaignCustomerFacts for a single customer strictly from
   * source orders and customer profile (Spec p14, p21).
   */
  async recomputeCustomerFacts(
    tenantId: string,
    customerId: string,
    thresholdDays: number = 90
  ): Promise<ICampaignCustomerFact> {
    if (!customerId || typeof customerId !== 'string' || !customerId.trim()) {
      return null as any;
    }
    // 1. Fetch customer and all their orders
    const [customer, orders] = await Promise.all([
      SrcCustomerModel.findOne({ tenantId, customerId }).lean<any>(),
      SrcOrderModel.find({ tenantId, customerId }).sort({ completedAt: 1, createdAt: 1 }).lean(),
    ]);

    const orderCount = orders.length;

    // Total spend: paid orders with positive netPaise
    const totalSpendPaise = orders
      .filter((o) => o.paid && o.status === 'COMPLETED' && o.netPaise > 0)
      .reduce((acc, o) => acc + (o.netPaise || 0), 0);

    const firstOrder = orders[0];
    const lastOrder = orders[orders.length - 1];

    const firstOrderAt = firstOrder?.completedAt || firstOrder?.createdAt || null;
    const lastOrderAt = lastOrder?.completedAt || lastOrder?.createdAt || null;
    const lastOrderId = lastOrder?.orderId || null;

    // Existing fact to preserve monotonic maxQualifyingOrderCountSeen
    const existingFact = await CampaignCustomerFactModel.findOne({ tenantId, customerId }).lean();
    const prevMax = (existingFact as any)?.maxQualifyingOrderCountSeen || 0;

    // Compute qualifying order facts (Spec p14)
    const { computeOrderFacts } = await import('../../presets/_shared/orderTrigger/orderFacts');
    const orderFacts = computeOrderFacts(orders, prevMax);

    let nextEvaluationAt: Date | null = null;
    const categoryPurchases: Record<string, { lastQualifyingOrderId: string; lastQualifyingPurchaseAt: Date }> = {};

    if (orderFacts.qualifyingOrders.length > 0) {
      if (orderFacts.lastQualifyingPurchaseAt) {
        nextEvaluationAt = new Date(orderFacts.lastQualifyingPurchaseAt.getTime() + thresholdDays * 24 * 60 * 60 * 1000);
      }

      // Track category purchases if lines or items contain category
      for (const qOrder of orderFacts.qualifyingOrders) {
        const orderDate = qOrder.completedAt || qOrder.createdAt || new Date();
        for (const line of qOrder.lines || []) {
          const cat = (line as any).category || (line as any).itemCategory || (line as any).itemRef;
          if (cat) {
            categoryPurchases[cat] = {
              lastQualifyingOrderId: qOrder.orderId,
              lastQualifyingPurchaseAt: orderDate,
            };
          }
        }
      }
    }

    const latestOrderEntityVersion = lastOrder?.entityVersion || 1;
    const customerVersion = customer?.version || 1;

    const factDoc = await CampaignCustomerFactModel.findOneAndUpdate(
      { tenantId, customerId },
      {
        $set: {
          orderCount,
          totalSpendPaise,
          firstOrderAt,
          lastOrderAt,
          lastOrderId,
          qualifyingOrderCount: orderFacts.qualifyingOrderCount,
          firstQualifyingOrderId: orderFacts.firstQualifyingOrderId,
          firstQualifyingOrderNumber: orderFacts.firstQualifyingOrderNumber,
          firstQualifyingAt: orderFacts.firstQualifyingAt,
          firstQualifyingNetPaise: orderFacts.firstQualifyingNetPaise,
          secondQualifyingOrderId: orderFacts.secondQualifyingOrderId,
          secondQualifyingAt: orderFacts.secondQualifyingAt,
          lastQualifyingPurchaseAt: orderFacts.lastQualifyingPurchaseAt,
          lastQualifyingOrderId: orderFacts.lastQualifyingOrderId,
          lastQualifyingPurchaseOrderId: orderFacts.lastQualifyingOrderId, // alias for backwards compatibility
          maxQualifyingOrderCountSeen: orderFacts.maxQualifyingOrderCountSeen,
          orderSourceVersion: latestOrderEntityVersion,
          nextEvaluationAt,
          categoryPurchases,
          sourceVersion: latestOrderEntityVersion,
          rebuiltAt: new Date(),
          authoritativeSourceVersions: {
            customerVersion,
            orderVersion: latestOrderEntityVersion,
            preferencesVersion: 1,
          },
        },
        $inc: {
          aggregateVersion: 1,
        },
      },
      { upsert: true, new: true }
    );

    return factDoc!;
  }

  /**
   * Rebuilds campaignCustomerFacts for all customers belonging to a tenant.
   * Fully rebuildable from orders and customers (Spec p14, p21).
   */
  async rebuildAllCustomerFacts(
    tenantId: string,
    thresholdDays: number = 90
  ): Promise<{ customerCount: number; rebuiltCount: number }> {
    const customerIds = await SrcCustomerModel.distinct('customerId', { tenantId });
    const orderCustomerIds = await SrcOrderModel.distinct('customerId', { tenantId });

    const allCustomerIds = Array.from(new Set([...customerIds, ...orderCustomerIds]))
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    let rebuiltCount = 0;

    for (const cId of allCustomerIds) {
      await this.recomputeCustomerFacts(tenantId, cId, thresholdDays);
      rebuiltCount++;
    }

    logger.info(
      { tenantId, customerCount: allCustomerIds.length, rebuiltCount },
      'Rebuilt campaignCustomerFacts for tenant'
    );

    return {
      customerCount: allCustomerIds.length,
      rebuiltCount,
    };
  }
}

export const customerFactsService = new CustomerFactsService();
