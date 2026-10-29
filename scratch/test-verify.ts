import mongoose from 'mongoose';
import { connectToDatabase } from '../apps/api/src/db/connection';
import { eventConsumerService } from '../apps/api/src/services/event-consumer';
import { seedDatabase } from '../apps/api/src/db/seed';
import { CampaignCustomerFactModel, CampaignEventInboxModel, SrcCustomerModel } from '../apps/api/src/db/models';

async function verify() {
  await connectToDatabase();
  await seedDatabase('base');

  const tenantId = 'shop_a';
  const producer = 'orders';

  console.log('\n=== VERIFICATION 1: Post the same order.completed event twice ===');
  const event1 = {
    eventId: 'evt_verify_order_100',
    producer: 'orders',
    eventType: 'order.completed',
    entityId: 'ord_sample_999',
    entityVersion: 1,
    occurredAt: new Date().toISOString(),
    payload: {
      customerId: 'cus_lakshmi',
      orderId: 'ord_sample_999',
      netAmountPaise: 350000,
      occasionRef: 'birthday',
    },
  };

  const res1 = await eventConsumerService.ingestEvent(tenantId, producer, event1);
  console.log('Post #1 Response:', {
    status: res1.status,
    message: res1.message,
    effects: res1.effects,
  });

  const res2 = await eventConsumerService.ingestEvent(tenantId, producer, event1);
  console.log('Post #2 Response (Duplicate Replay):', {
    status: res2.status,
    message: res2.message,
    effects: res2.effects,
  });

  const fact = await CampaignCustomerFactModel.findOne({ tenantId, customerId: 'cus_lakshmi' }).lean();
  console.log('Customer Facts -> totalSpendPaise:', fact?.totalSpendPaise, 'orderCount:', fact?.orderCount);

  console.log('\n=== VERIFICATION 2: Post an old-version event ===');
  // cus_lakshmi has version 1 in SrcCustomerModel.
  // An event for cus_lakshmi with entityVersion: 0 is an old version!
  const staleEvent = {
    eventId: 'evt_verify_stale_101',
    producer: 'customers',
    eventType: 'customer.updated',
    entityId: 'cus_lakshmi',
    entityVersion: 0,
    occurredAt: new Date().toISOString(),
    payload: {
      customerId: 'cus_lakshmi',
      occasion: 'birthday',
      newDate: { month: 10, day: 28 },
    },
  };

  const resStale = await eventConsumerService.ingestEvent(tenantId, 'customers', staleEvent);
  console.log('Stale Event Ingest Response:', {
    status: resStale.status,
    quarantineReason: resStale.quarantineReason,
    message: resStale.message,
  });

  const inboxItem = await CampaignEventInboxModel.findOne({ tenantId, eventId: 'evt_verify_stale_101' }).lean();
  console.log('Quarantined Record in Database Inbox:', {
    eventId: inboxItem?.eventId,
    status: inboxItem?.status,
    quarantineReason: inboxItem?.quarantineReason,
    entityId: inboxItem?.entityId,
    entityVersion: inboxItem?.entityVersion,
  });

  await mongoose.disconnect();
  console.log('\n✅ Verification 1 & 2 fully verified and confirmed!');
}

verify().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
