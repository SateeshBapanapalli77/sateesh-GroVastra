'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { AppShell } from '../../components/AppShell';
import { useAuth } from '../../context/AuthContext';
import { useRouter } from 'next/navigation';
import {
  Clock,
  RefreshCw,
  Database,
  Radio,
  CheckCircle2,
  AlertCircle,
  ShieldAlert,
  Zap,
  Wrench,
  Terminal,
  Calendar,
  Layers,
  ArrowRight,
  Shield,
  Send,
  Inbox,
  Eye,
  Sparkles,
  Copy,
  FileText,
  X,
  History,
  Gift,
  HelpCircle,
  ShoppingBag,
} from 'lucide-react';
import type { ClockStatus } from '@grovastra/shared';

const API_BASE = 'http://localhost:4000';

const EVENT_PRESETS: Record<string, {
  name: string;
  producer: string;
  eventType: string;
  entityId: string;
  entityVersion: number;
  payload: Record<string, any>;
}> = {
  'order.completed': {
    name: 'order.completed — Completed Order (4,500 INR, Birthday occasion)',
    producer: 'orders',
    eventType: 'order.completed',
    entityId: 'ord_dev_101',
    entityVersion: 1,
    payload: {
      customerId: 'cus_lakshmi',
      orderId: 'ord_dev_101',
      netAmountPaise: 450000,
      occasionRef: 'birthday',
    },
  },
  'order.cancelled': {
    name: 'order.cancelled — Order Cancelled (Deducts Spend Fact)',
    producer: 'orders',
    eventType: 'order.cancelled',
    entityId: 'ord_dev_101',
    entityVersion: 2,
    payload: {
      customerId: 'cus_lakshmi',
      orderId: 'ord_dev_101',
      netAmountPaise: 450000,
    },
  },
  'date.same_year': {
    name: 'customer.updated — Date Change (Same Year Replan unsent executions)',
    producer: 'customers',
    eventType: 'customer.updated',
    entityId: 'cus_lakshmi',
    entityVersion: 2,
    payload: {
      customerId: 'cus_lakshmi',
      occasion: 'birthday',
      newDate: { month: 10, day: 28 },
      previousDate: { month: 10, day: 25 },
      isSameYear: true,
    },
  },
  'date.across_years': {
    name: 'customer.updated — Date Change (Across Years Re-evaluate Future-Only)',
    producer: 'customers',
    eventType: 'customer.updated',
    entityId: 'cus_lakshmi',
    entityVersion: 2,
    payload: {
      customerId: 'cus_lakshmi',
      occasion: 'birthday',
      newDate: { month: 3, day: 15 },
      previousDate: { month: 11, day: 20 },
      isSameYear: false,
    },
  },
  'preference.opt_out': {
    name: 'preference.changed — Marketing Opt-Out (Cancels Promo Steps)',
    producer: 'crm',
    eventType: 'preference.changed',
    entityId: 'cus_lakshmi',
    entityVersion: 2,
    payload: {
      customerId: 'cus_lakshmi',
      preferenceType: 'MARKETING_OPT_OUT',
      effective: true,
    },
  },
  'preference.suppressed': {
    name: 'preference.changed — Channel Suppressed (Cancels All Pending Steps)',
    producer: 'crm',
    eventType: 'preference.changed',
    entityId: 'cus_lakshmi',
    entityVersion: 2,
    payload: {
      customerId: 'cus_lakshmi',
      preferenceType: 'CHANNEL_SUPPRESSED',
      effective: true,
    },
  },
  'customer.deleted': {
    name: 'customer.deleted — Customer Erasure (Permanent Cancellation)',
    producer: 'customers',
    eventType: 'customer.deleted',
    entityId: 'cus_lakshmi',
    entityVersion: 2,
    payload: {
      customerId: 'cus_lakshmi',
    },
  },
  'stale.version': {
    name: 'stale.version — Stale Entity Version (Quarantine: STALE_ENTITY_VERSION)',
    producer: 'orders',
    eventType: 'order.completed',
    entityId: 'ord_dev_stale_1',
    entityVersion: 0,
    payload: {
      customerId: 'cus_lakshmi',
      orderId: 'ord_dev_stale_1',
      netAmountPaise: 100000,
    },
  },
  'occasion.saved_wedding': {
    name: 'occasion.saved — Wedding Occasion Saved (D-45 & D-21)',
    producer: 'occasions',
    eventType: 'occasion.saved',
    entityId: 'evt_dev_wed_01',
    entityVersion: 1,
    payload: {
      customerId: 'cus_lakshmi',
      eventId: 'evt_dev_wed_01',
      kind: 'WEDDING',
      eventDate: '2026-12-15',
      declaredByCustomer: true,
      budgetPaise: 5000000,
      categories: ['bridal_saree', 'gold_jewelry'],
      recipientLabel: null,
    },
  },
  'occasion.saved_gift': {
    name: 'occasion.saved — Gift Occasion Saved (D-10 & D-3)',
    producer: 'occasions',
    eventType: 'occasion.saved',
    entityId: 'evt_dev_gift_01',
    entityVersion: 1,
    payload: {
      customerId: 'cus_lakshmi',
      eventId: 'evt_dev_gift_01',
      kind: 'GIFT',
      eventDate: '2026-11-20',
      declaredByCustomer: true,
      budgetPaise: 1500000,
      categories: ['silk_shawl'],
      recipientLabel: 'Mom',
    },
  },
  'occasion.postpone': {
    name: 'occasion.saved — Postpone Occasion (+30 days)',
    producer: 'occasions',
    eventType: 'occasion.saved',
    entityId: 'evt_dev_wed_01',
    entityVersion: 2,
    payload: {
      customerId: 'cus_lakshmi',
      eventId: 'evt_dev_wed_01',
      kind: 'WEDDING',
      eventDate: '2027-01-15',
      declaredByCustomer: true,
    },
  },
  'occasion.cancelled': {
    name: 'occasion.cancelled — Cancel Occasion',
    producer: 'occasions',
    eventType: 'occasion.cancelled',
    entityId: 'evt_dev_wed_01',
    entityVersion: 3,
    payload: {
      customerId: 'cus_lakshmi',
      eventId: 'evt_dev_wed_01',
      reason: 'User cancelled occasion in Dev Tools',
    },
  },
  'occasion.completed': {
    name: 'occasion.completed — Complete Occasion',
    producer: 'occasions',
    eventType: 'occasion.completed',
    entityId: 'evt_dev_wed_01',
    entityVersion: 4,
    payload: {
      customerId: 'cus_lakshmi',
      eventId: 'evt_dev_wed_01',
    },
  },
  'enquiry.saved': {
    name: 'enquiry.saved — New Open Customer Enquiry (+24h & +72h Nudges)',
    producer: 'enquiries',
    eventType: 'enquiry.saved',
    entityId: 'enq_dev_101',
    entityVersion: 1,
    payload: {
      enquiryId: 'enq_dev_101',
      customerId: 'cus_lakshmi',
      channel: 'IN_STORE',
      status: 'OPEN',
      staffTakeover: false,
      itemRef: {
        productId: 'prod_kanjivaram_silk',
        variantId: 'var_gold_border',
      },
      createdAt: '2026-10-25T10:00:00.000Z',
      lastCustomerInteractionAt: '2026-10-25T10:00:00.000Z',
    },
  },
  'enquiry.interaction': {
    name: 'enquiry.saved — Customer Interaction Moved (+24h Replan from New Anchor)',
    producer: 'enquiries',
    eventType: 'enquiry.saved',
    entityId: 'enq_dev_101',
    entityVersion: 2,
    payload: {
      enquiryId: 'enq_dev_101',
      customerId: 'cus_lakshmi',
      channel: 'IN_STORE',
      status: 'OPEN',
      staffTakeover: false,
      itemRef: {
        productId: 'prod_kanjivaram_silk',
        variantId: 'var_gold_border',
      },
      createdAt: '2026-10-25T10:00:00.000Z',
      lastCustomerInteractionAt: '2026-10-25T15:30:00.000Z',
    },
  },
  'enquiry.resolved': {
    name: 'enquiry.resolved — Enquiry Resolved by Staff (Stops Unsent Steps)',
    producer: 'enquiries',
    eventType: 'enquiry.resolved',
    entityId: 'enq_dev_101',
    entityVersion: 3,
    payload: {
      enquiryId: 'enq_dev_101',
      status: 'RESOLVED',
    },
  },
  'enquiry.deleted': {
    name: 'enquiry.deleted — Enquiry Deleted (Cancels Remaining Steps)',
    producer: 'enquiries',
    eventType: 'enquiry.deleted',
    entityId: 'enq_dev_101',
    entityVersion: 4,
    payload: {
      enquiryId: 'enq_dev_101',
      status: 'DELETED',
    },
  },
  'unknown.schema': {
    name: 'unknown.schema — Unknown Schema (Quarantine: UNKNOWN_SCHEMA)',
    producer: 'orders',
    eventType: 'unknown.custom.unregistered',
    entityId: 'ent_unknown_1',
    entityVersion: 1,
    payload: {
      unrecognizedField: 'invalid_data',
    },
  },
};

export default function DevToolsPage() {
  const { user } = useAuth();
  const router = useRouter();

  const [clockStatus, setClockStatus] = useState<ClockStatus | null>(null);
  const [clockLoading, setClockLoading] = useState(false);
  const [customOffsetHours, setCustomOffsetHours] = useState('24');

  // Mock Occasions CRM state
  const [mockOccCustomer, setMockOccCustomer] = useState('cus_lakshmi');
  const [mockOccEventId, setMockOccEventId] = useState(`evt_mock_${Date.now()}`);
  const [mockOccKind, setMockOccKind] = useState<'WEDDING' | 'GIFT'>('WEDDING');
  const [mockOccDate, setMockOccDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 45);
    return d.toISOString().split('T')[0];
  });
  const [mockOccRecipientLabel, setMockOccRecipientLabel] = useState('Mom');
  const [mockOccBudgetPaise, setMockOccBudgetPaise] = useState('5000000');
  const [mockOccCategories, setMockOccCategories] = useState('bridal_saree, gold_jewelry');
  const [mockOccDeclaredByCustomer, setMockOccDeclaredByCustomer] = useState(true);
  const [mockOccLoading, setMockOccLoading] = useState(false);
  const [mockOccResult, setMockOccResult] = useState<any | null>(null);
  const [mockOccError, setMockOccError] = useState<string | null>(null);

  const handleMockOccasionAction = async (action: 'create' | 'postpone' | 'cancel' | 'delete' | 'complete') => {
    setMockOccLoading(true);
    setMockOccResult(null);
    setMockOccError(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('grovastra_auth_token') : null;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      let url = `${API_BASE}/dev/mock-occasions`;
      let body: any = {};

      if (action === 'create') {
        body = {
          customerId: mockOccCustomer,
          eventId: mockOccEventId,
          kind: mockOccKind,
          eventDate: mockOccDate,
          recipientLabel: mockOccKind === 'GIFT' ? mockOccRecipientLabel : null,
          budgetPaise: mockOccBudgetPaise ? parseInt(mockOccBudgetPaise, 10) : undefined,
          categories: mockOccCategories ? mockOccCategories.split(',').map((s) => s.trim()).filter(Boolean) : [],
          declaredByCustomer: mockOccDeclaredByCustomer,
        };
      } else {
        url = `${API_BASE}/dev/mock-occasions/${encodeURIComponent(mockOccEventId)}/${action}`;
        if (action === 'postpone') {
          const cur = new Date(mockOccDate);
          cur.setDate(cur.getDate() + 30);
          const newDate = cur.toISOString().split('T')[0];
          body = { newDate };
          setMockOccDate(newDate);
        } else if (action === 'cancel') {
          body = { reason: 'User requested cancellation in Dev Tools' };
        } else if (action === 'delete') {
          body = {};
        } else if (action === 'complete') {
          body = {};
        }
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      }
      setMockOccResult({ action, ...data });
    } catch (err: unknown) {
      setMockOccError(err instanceof Error ? err.message : 'Mock occasion operation failed');
    } finally {
      setMockOccLoading(false);
    }
  };

  // Mock Enquiries CRM state
  const [mockEnqId, setMockEnqId] = useState(`enq_mock_${Date.now()}`);
  const [mockEnqCustomer, setMockEnqCustomer] = useState('cus_lakshmi');
  const [mockEnqChannel, setMockEnqChannel] = useState<'IN_STORE' | 'PHONE' | 'WHATSAPP' | 'OTHER'>('IN_STORE');
  const [mockEnqProductId, setMockEnqProductId] = useState('prod_kanjivaram_silk');
  const [mockEnqVariantId, setMockEnqVariantId] = useState('var_gold_border');
  const [mockEnqTakeover, setMockEnqTakeover] = useState(false);
  const [mockEnqLoading, setMockEnqLoading] = useState(false);
  const [mockEnqResult, setMockEnqResult] = useState<any | null>(null);
  const [mockEnqError, setMockEnqError] = useState<string | null>(null);

  const handleMockEnquiryAction = async (action: 'create' | 'interaction' | 'staff-edit' | 'takeover' | 'resolve' | 'delete') => {
    setMockEnqLoading(true);
    setMockEnqResult(null);
    setMockEnqError(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('grovastra_auth_token') : null;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      let url = `${API_BASE}/dev/mock-enquiries`;
      let body: any = {};

      if (action === 'create') {
        body = {
          enquiryId: mockEnqId.trim(),
          customerId: mockEnqCustomer.trim() || undefined,
          channel: mockEnqChannel,
          staffTakeover: mockEnqTakeover,
          itemRef: mockEnqProductId.trim()
            ? {
                productId: mockEnqProductId.trim(),
                variantId: mockEnqVariantId.trim() || null,
              }
            : null,
        };
      } else {
        url = `${API_BASE}/dev/mock-enquiries/${encodeURIComponent(mockEnqId.trim())}/${action}`;
        if (action === 'interaction') {
          body = { at: new Date().toISOString() };
        } else if (action === 'takeover') {
          const nextTakeover = !mockEnqTakeover;
          body = { value: nextTakeover };
          setMockEnqTakeover(nextTakeover);
        } else if (action === 'resolve') {
          body = { status: 'RESOLVED' };
        } else {
          body = {};
        }
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      }
      setMockEnqResult({ action, ...data });
    } catch (err: unknown) {
      setMockEnqError(err instanceof Error ? err.message : 'Mock enquiry operation failed');
    } finally {
      setMockEnqLoading(false);
    }
  };

  // Mock Products & Stock state (F24 Complete Outfit Attributes)
  const [mockProdId, setMockProdId] = useState('prod_kanjivaram_silk');
  const [mockProdName, setMockProdName] = useState('Kanjivaram Pure Silk Saree');
  const [mockProdCategory, setMockProdCategory] = useState('saree');
  const [mockProdColourFamily, setMockProdColourFamily] = useState('red');
  const [mockProdWeave, setMockProdWeave] = useState('silk');
  const [mockProdPriceInr, setMockProdPriceInr] = useState('4500');
  const [mockProdVariantId, setMockProdVariantId] = useState('var_gold_border');
  const [mockProdVariantLabel, setMockProdVariantLabel] = useState('Gold Zari Border');
  const [mockProdStock, setMockProdStock] = useState('10');
  const [mockProdLoading, setMockProdLoading] = useState(false);
  const [mockProdResult, setMockProdResult] = useState<any | null>(null);
  const [mockProdError, setMockProdError] = useState<string | null>(null);

  // Order Line Return tool state (F24 returns)
  const [returnOrderId, setReturnOrderId] = useState('order_saree_01');
  const [returnLineId, setReturnLineId] = useState('line_saree_01');
  const [returnQty, setReturnQty] = useState('1');
  const [returnLoading, setReturnLoading] = useState(false);
  const [returnResult, setReturnResult] = useState<any | null>(null);
  const [returnError, setReturnError] = useState<string | null>(null);

  const handleMockProductAction = async (action: 'create' | 'stock') => {
    setMockProdLoading(true);
    setMockProdResult(null);
    setMockProdError(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('grovastra_auth_token') : null;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      let url = `${API_BASE}/dev/mock-products`;
      let body: any = {};

      if (action === 'create') {
        body = {
          productId: mockProdId.trim(),
          name: mockProdName.trim(),
          category: mockProdCategory.trim() || undefined,
          colourFamily: mockProdColourFamily.trim() || undefined,
          weave: mockProdWeave.trim() || undefined,
          pricePaise: Math.round((parseFloat(mockProdPriceInr) || 0) * 100),
          status: 'ACTIVE',
          variants: [
            {
              variantId: mockProdVariantId.trim(),
              label: mockProdVariantLabel.trim(),
              sellableQty: parseInt(mockProdStock, 10) || 0,
              version: 1,
            },
          ],
        };
      } else {
        url = `${API_BASE}/dev/mock-products/${encodeURIComponent(mockProdId.trim())}/variants/${encodeURIComponent(mockProdVariantId.trim())}/stock`;
        body = { sellableQty: parseInt(mockProdStock, 10) || 0 };
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      }
      setMockProdResult({ action, ...data });
    } catch (err: unknown) {
      setMockProdError(err instanceof Error ? err.message : 'Mock product operation failed');
    } finally {
      setMockProdLoading(false);
    }
  };

  const handleOrderLineReturn = async () => {
    setReturnLoading(true);
    setReturnResult(null);
    setReturnError(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('grovastra_auth_token') : null;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      const res = await fetch(`${API_BASE}/dev/mock-orders/${encodeURIComponent(returnOrderId.trim())}/lines/${encodeURIComponent(returnLineId.trim())}/return`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ qty: parseInt(returnQty, 10) || 1 }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      }
      setReturnResult(data);
    } catch (err: unknown) {
      setReturnError(err instanceof Error ? err.message : 'Order line return failed');
    } finally {
      setReturnLoading(false);
    }
  };

  // Re-seed state
  const [selectedScenario, setSelectedScenario] = useState('base');
  const [seedLoading, setSeedLoading] = useState(false);
  const [seedResult, setSeedResult] = useState<{
    message?: string;
    summary?: {
      shopACount: number;
      shopBCount: number;
      liveCount: number;
      eventsCount: number;
      ordersCount: number;
    };
  } | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);

  // Worker execution state
  const [workerLoading, setWorkerLoading] = useState(false);
  const [workerResult, setWorkerResult] = useState<any | null>(null);

  // Domain Event Poster state (Spec p20, p24, p25)
  const [eventPresetKey, setEventPresetKey] = useState('order.completed');
  const [eventProducer, setEventProducer] = useState('orders');
  const [eventId, setEventId] = useState(`evt_dev_${Date.now()}`);
  const [eventType, setEventType] = useState('order.completed');
  const [entityId, setEntityId] = useState('ord_dev_101');
  const [entityVersion, setEntityVersion] = useState('1');
  const [eventPayloadJson, setEventPayloadJson] = useState(
    JSON.stringify(EVENT_PRESETS['order.completed'].payload, null, 2)
  );
  const [eventPosting, setEventPosting] = useState(false);
  const [eventResult, setEventResult] = useState<any | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);

  // Replay 5x state (Spec B02 idempotency)
  const [replayRunning, setReplayRunning] = useState(false);
  const [replayResults, setReplayResults] = useState<any[] | null>(null);

  // Quarantined Events state (Spec p24, p29)
  const [quarantinedEvents, setQuarantinedEvents] = useState<any[]>([]);
  const [quarantinedTotal, setQuarantinedTotal] = useState(0);
  const [quarantinedLoading, setQuarantinedLoading] = useState(false);
  const [selectedQuarantineItem, setSelectedQuarantineItem] = useState<any | null>(null);

  // Fetch Clock Status
  const fetchClock = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/clock`, { cache: 'no-store' });
      if (res.status === 403) {
        // Disabled in production
        router.push('/403');
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setClockStatus(data);
      }
    } catch (e) {
      console.error('Failed to fetch clock:', e);
    }
  }, [router]);

  useEffect(() => {
    fetchClock();
    const interval = setInterval(fetchClock, 3000);
    return () => clearInterval(interval);
  }, [fetchClock]);

  // Apply Clock Offset
  const handleApplyOffset = async (offsetMs: number) => {
    setClockLoading(true);
    try {
      const currentOffset = clockStatus?.offsetMs || 0;
      const res = await fetch(`${API_BASE}/admin/clock/offset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMs: currentOffset + offsetMs }),
      });
      if (res.ok) {
        const data = await res.json();
        setClockStatus(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setClockLoading(false);
    }
  };

  // Reset Clock Offset
  const handleResetOffset = async () => {
    setClockLoading(true);
    try {
      const res = await fetch(`${API_BASE}/admin/clock/reset`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setClockStatus(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setClockLoading(false);
    }
  };

  // Set Custom Offset in Hours
  const handleApplyCustomHours = async () => {
    const hours = parseFloat(customOffsetHours);
    if (isNaN(hours)) return;
    setClockLoading(true);
    try {
      const offsetMs = Math.round(hours * 3600 * 1000);
      const res = await fetch(`${API_BASE}/admin/clock/offset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMs }),
      });
      if (res.ok) {
        const data = await res.json();
        setClockStatus(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setClockLoading(false);
    }
  };

  // Trigger Re-seed
  const handleReSeed = async () => {
    setSeedLoading(true);
    setSeedResult(null);
    setSeedError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: selectedScenario }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData?.error?.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setSeedResult(data);
    } catch (err: unknown) {
      setSeedError(err instanceof Error ? err.message : 'Failed to re-seed database');
    } finally {
      setSeedLoading(false);
    }
  };

  // Trigger Worker Cycle
  const handleRunWorkerCycle = async () => {
    setWorkerLoading(true);
    setWorkerResult(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('grovastra_auth_token') : null;
      const res = await fetch('/api/worker/cycle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ batchSize: 50 }),
      });
      if (res.ok) {
        const data = await res.json();
        setWorkerResult(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setWorkerLoading(false);
    }
  };

  // Fetch Quarantined Events (Spec p24, p29)
  const fetchQuarantinedEvents = useCallback(async () => {
    setQuarantinedLoading(true);
    try {
      const res = await fetch('/api/internal/campaign-events/quarantine?limit=25', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setQuarantinedEvents(data.events || []);
        setQuarantinedTotal(data.total || 0);
      }
    } catch (e) {
      console.error('Failed to fetch quarantined events:', e);
    } finally {
      setQuarantinedLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQuarantinedEvents();
  }, [fetchQuarantinedEvents]);

  // Handle Preset Change
  const handleSelectPreset = (key: string) => {
    setEventPresetKey(key);
    const preset = EVENT_PRESETS[key];
    if (preset) {
      setEventProducer(preset.producer);
      setEventType(preset.eventType);
      setEntityId(preset.entityId);
      setEntityVersion(String(preset.entityVersion));
      setEventPayloadJson(JSON.stringify(preset.payload, null, 2));
      setEventId(`evt_${preset.producer}_${Date.now()}`);
      setEventResult(null);
      setEventError(null);
      setReplayResults(null);
    }
  };

  const handleGenerateNewEventId = () => {
    setEventId(`evt_${eventProducer}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
  };

  // Post Single Event
  const handlePostEvent = async () => {
    setEventPosting(true);
    setEventResult(null);
    setEventError(null);
    setReplayResults(null);
    try {
      let parsedPayload: Record<string, unknown> = {};
      try {
        parsedPayload = JSON.parse(eventPayloadJson);
      } catch {
        throw new Error('Invalid JSON payload syntax');
      }

      const body = {
        eventId: eventId.trim(),
        producer: eventProducer.trim(),
        eventType: eventType.trim(),
        entityId: entityId.trim(),
        entityVersion: Number(entityVersion) || 1,
        occurredAt: new Date().toISOString(),
        payload: parsedPayload,
      };

      const res = await fetch('/api/internal/campaign-events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Producer-Id': eventProducer.trim(),
        },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      setEventResult(data);
      if (data.status === 'QUARANTINED') {
        fetchQuarantinedEvents();
      }
    } catch (err: unknown) {
      setEventError(err instanceof Error ? err.message : 'Failed to post event');
    } finally {
      setEventPosting(false);
    }
  };

  // Replay 5x Sequential (Idempotency Test Spec B02)
  const handleReplay5x = async () => {
    setReplayRunning(true);
    setEventResult(null);
    setEventError(null);
    setReplayResults(null);
    try {
      let parsedPayload: Record<string, unknown> = {};
      try {
        parsedPayload = JSON.parse(eventPayloadJson);
      } catch {
        throw new Error('Invalid JSON payload syntax');
      }

      const fixedEventId = eventId.trim();
      const fixedOccurredAt = new Date().toISOString();
      const runs = [];

      for (let attempt = 1; attempt <= 5; attempt++) {
        const body = {
          eventId: fixedEventId,
          producer: eventProducer.trim(),
          eventType: eventType.trim(),
          entityId: entityId.trim(),
          entityVersion: Number(entityVersion) || 1,
          occurredAt: fixedOccurredAt,
          payload: parsedPayload,
        };

        const res = await fetch('/api/internal/campaign-events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Producer-Id': eventProducer.trim(),
          },
          body: JSON.stringify(body),
        });

        const data = await res.json();
        runs.push({
          attempt,
          status: data.status,
          success: data.success,
          message: data.message,
          quarantineReason: data.quarantineReason,
          effects: data.effects,
        });
      }

      setReplayResults(runs);
      fetchQuarantinedEvents();
    } catch (err: unknown) {
      setEventError(err instanceof Error ? err.message : 'Replay test failed');
    } finally {
      setReplayRunning(false);
    }
  };

  // Production Guard (Hidden in production)
  if (process.env.NODE_ENV === 'production' || clockStatus?.isProduction) {
    return (
      <AppShell>
        <div style={{ padding: 48, textAlign: 'center' }}>
          <ShieldAlert size={48} color="var(--accent-rose)" style={{ margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#fff' }}>Dev Tools Disabled</h2>
          <p style={{ color: 'var(--text-secondary)' }}>Dev tools and simulation endpoints are strictly disabled in production mode.</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        {/* Header */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--accent-amber)',
              }}
            >
              Developer Administration
            </span>
            <span
              style={{
                fontSize: '0.7rem',
                padding: '2px 8px',
                borderRadius: 4,
                background: 'rgba(245, 158, 11, 0.15)',
                color: 'var(--accent-amber)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                fontWeight: 700,
              }}
            >
              DEV / TEST ONLY
            </span>
          </div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', margin: 0 }}>
            Developer Controls & Time Travel
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', maxWidth: 700, marginTop: 4 }}>
            Control the engine&apos;s injectable clock for campaign trigger simulation and reset the database with specific mock test scenarios.
          </p>
        </div>

        {/* Section 1: Injectable Clock & Time Travel Control */}
        <div className="glass-panel" style={{ padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: 'rgba(99, 102, 241, 0.15)',
                  border: '1px solid rgba(99, 102, 241, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Clock size={20} color="var(--accent-indigo)" />
              </div>
              <div>
                <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                  Injectable Engine Clock (Spec p3, p18)
                </h2>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Controls serverNow across all campaign evaluators, worker claims, and occasion checks
                </div>
              </div>
            </div>

            <span
              id="dev-clock-badge"
              style={{
                padding: '4px 10px',
                borderRadius: 20,
                fontSize: '0.75rem',
                fontWeight: 700,
                backgroundColor: clockStatus?.isDevOffsetActive
                  ? 'rgba(245, 158, 11, 0.15)'
                  : 'rgba(16, 185, 129, 0.15)',
                color: clockStatus?.isDevOffsetActive ? 'var(--accent-amber)' : 'var(--accent-emerald)',
                border: `1px solid ${
                  clockStatus?.isDevOffsetActive ? 'rgba(245, 158, 11, 0.3)' : 'rgba(16, 185, 129, 0.3)'
                }`,
              }}
            >
              {clockStatus?.isDevOffsetActive ? 'OFFSET ACTIVE (TIME SHIFTED)' : 'REAL-TIME UTC'}
            </span>
          </div>

          {/* Current Clock Displays */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 24 }}>
            <div style={{ padding: 16, borderRadius: 10, background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Effective Engine Time (ISO UTC)</div>
              <div id="clock-display-iso" className="font-mono" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', marginTop: 6 }}>
                {clockStatus?.now || '—'}
              </div>
            </div>

            <div style={{ padding: 16, borderRadius: 10, background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Local Formatted Time</div>
              <div id="clock-display-local" style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--accent-cyan)', marginTop: 6 }}>
                {clockStatus ? new Date(clockStatus.now).toLocaleString() : '—'}
              </div>
            </div>

            <div style={{ padding: 16, borderRadius: 10, background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Applied Offset (ms / hours)</div>
              <div id="clock-display-offset" className="font-mono" style={{ fontSize: '1.05rem', fontWeight: 700, color: clockStatus?.offsetMs ? 'var(--accent-amber)' : 'var(--text-muted)', marginTop: 6 }}>
                {clockStatus?.offsetMs ? `${clockStatus.offsetMs} ms (${(clockStatus.offsetMs / 3600000).toFixed(1)} hrs)` : '0 ms'}
              </div>
            </div>
          </div>

          {/* Time Travel Quick Controls */}
          <div>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Quick Time Travel Adjustments:
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                id="btn-clock-plus-1h"
                onClick={() => handleApplyOffset(3600 * 1000)}
                disabled={clockLoading}
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '8px 14px' }}
              >
                +1 Hour
              </button>
              <button
                id="btn-clock-plus-1d"
                onClick={() => handleApplyOffset(86400 * 1000)}
                disabled={clockLoading}
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '8px 14px' }}
              >
                +1 Day
              </button>
              <button
                id="btn-clock-plus-7d"
                onClick={() => handleApplyOffset(7 * 86400 * 1000)}
                disabled={clockLoading}
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '8px 14px' }}
              >
                +7 Days (1 Week)
              </button>
              <button
                id="btn-clock-minus-1d"
                onClick={() => handleApplyOffset(-86400 * 1000)}
                disabled={clockLoading}
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '8px 14px' }}
              >
                -1 Day
              </button>
              <button
                id="btn-clock-reset"
                onClick={handleResetOffset}
                disabled={clockLoading || !clockStatus?.isDevOffsetActive}
                className="btn btn-secondary"
                style={{
                  fontSize: '0.8rem',
                  padding: '8px 14px',
                  color: 'var(--accent-rose)',
                  borderColor: clockStatus?.isDevOffsetActive ? 'rgba(244, 63, 94, 0.4)' : 'var(--border-color)',
                }}
              >
                Reset to UTC Real-Time
              </button>
            </div>
          </div>

          {/* Custom Offset Form */}
          <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid rgba(255, 255, 255, 0.05)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Set exact offset in hours:</span>
            <input
              id="input-clock-custom-hours"
              type="number"
              value={customOffsetHours}
              onChange={(e) => setCustomOffsetHours(e.target.value)}
              className="input-field"
              style={{ width: 100, fontSize: '0.85rem' }}
            />
            <button
              id="btn-clock-apply-custom"
              onClick={handleApplyCustomHours}
              disabled={clockLoading}
              className="btn btn-secondary"
              style={{ fontSize: '0.8rem', padding: '8px 14px' }}
            >
              Apply Exact Hours
            </button>
          </div>
        </div>

        {/* Section 2: Campaign Worker Process (Spec p19, p25) */}
        <div className="glass-panel" style={{ padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: 'rgba(99, 102, 241, 0.15)',
                  border: '1px solid rgba(99, 102, 241, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Zap size={20} color="var(--accent-indigo)" />
              </div>
              <div>
                <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                  Campaign Worker Engine (Spec p19, p25, Feature 9)
                </h2>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Claims due SCHEDULED/DEFERRED executions, evaluates Reason Precedence (Spec p33), resolves late-bound parameters, and freezes immutable delivery intents
                </div>
              </div>
            </div>

            <button
              onClick={handleRunWorkerCycle}
              disabled={workerLoading}
              className="btn btn-primary"
              style={{
                fontSize: '0.85rem',
                padding: '10px 20px',
                background: 'linear-gradient(135deg, var(--accent-indigo), var(--accent-cyan))',
                fontWeight: 700,
              }}
            >
              <RefreshCw size={15} className={workerLoading ? 'animate-spin' : ''} />
              {workerLoading ? 'Evaluating Due Steps...' : 'Run Worker Evaluation Cycle'}
            </button>
          </div>

          {workerResult && (
            <div
              style={{
                padding: 18,
                borderRadius: 10,
                background: 'rgba(99, 102, 241, 0.08)',
                border: '1px solid rgba(99, 102, 241, 0.25)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#c7d2fe', fontSize: '0.9rem', marginBottom: 12 }}>
                <CheckCircle2 size={16} color="var(--accent-emerald)" /> Worker Cycle Summary
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
                <div style={{ background: 'rgba(0,0,0,0.25)', padding: '10px 12px', borderRadius: 8 }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Claimed</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff' }}>{workerResult.claimedCount ?? 0}</div>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.25)', padding: '10px 12px', borderRadius: 8 }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Frozen / Dispatched</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-emerald)' }}>{workerResult.dispatchedCount ?? 0}</div>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.25)', padding: '10px 12px', borderRadius: 8 }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Skipped</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fbbf24' }}>{workerResult.skippedCount ?? 0}</div>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.25)', padding: '10px 12px', borderRadius: 8 }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Cancelled</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-rose)' }}>{workerResult.cancelledCount ?? 0}</div>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.25)', padding: '10px 12px', borderRadius: 8 }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Blocked</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fb923c' }}>{workerResult.blockedCount ?? 0}</div>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.25)', padding: '10px 12px', borderRadius: 8 }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Deferred</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#38bdf8' }}>{workerResult.deferredCount ?? 0}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Section 3: Database Re-Seed Engine */}
        <div className="glass-panel" style={{ padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: 'rgba(16, 185, 129, 0.15)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Database size={20} color="var(--accent-emerald)" />
            </div>
            <div>
              <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                Seed Pipeline & Scenario Engine (CLI: seed:base, seed:scenario)
              </h2>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>
                Cleans and atomically re-seeds tenants, mock customers, anniversaries, and orders with AES phone encryption
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', marginBottom: 20 }}>
            <div style={{ flex: '1 1 280px' }}>
              <label htmlFor="select-seed-scenario" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Select Test Scenario:
              </label>
              <select
                id="select-seed-scenario"
                value={selectedScenario}
                onChange={(e) => setSelectedScenario(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              >
                <option value="base">base — Standard ~40 customers, core edge cases & orders</option>
                <option value="unresolved-enquiry">unresolved-enquiry — Unresolved enquiry follow-up scenario with products, variants & interaction anchors</option>
                <option value="gift-wedding">gift-wedding — Wedding and gift reminders with lead time skips and reschedules</option>
                <option value="birthday-today">birthday-today — Sets customer birthday to TODAY for immediate test</option>
                <option value="feb29">feb29 — Leap year boundary testing</option>
                <option value="household-collision">household-collision — Multiple records sharing one phone</option>
                <option value="opt-out">opt-out — Consent withdrawal and suppression gates</option>
              </select>
            </div>

            <button
              id="btn-trigger-reseed"
              onClick={handleReSeed}
              disabled={seedLoading}
              className="btn btn-primary"
              style={{
                padding: '10px 20px',
                fontSize: '0.875rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <RefreshCw size={15} className={seedLoading ? 'animate-spin' : ''} />
              {seedLoading ? 'Seeding Database...' : 'Run Re-Seed Now'}
            </button>
          </div>

          {/* Seed Result Feedback Box */}
          {seedResult && (
            <div
              id="seed-result-box"
              style={{
                padding: 18,
                borderRadius: 10,
                background: 'rgba(16, 185, 129, 0.08)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle2 size={18} color="var(--accent-emerald)" />
                <span style={{ fontWeight: 700, color: '#fff', fontSize: '0.9rem' }}>
                  {seedResult.message}
                </span>
              </div>

              {seedResult.summary && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                  <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255, 255, 255, 0.03)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Shop A Customers</div>
                    <div id="seed-summary-shop-a" style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff', marginTop: 2 }}>
                      {seedResult.summary.shopACount}
                    </div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255, 255, 255, 0.03)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Shop B Customers</div>
                    <div id="seed-summary-shop-b" style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff', marginTop: 2 }}>
                      {seedResult.summary.shopBCount}
                    </div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255, 255, 255, 0.03)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Live Allowlist Customers</div>
                    <div id="seed-summary-live" style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-emerald)', marginTop: 2 }}>
                      {seedResult.summary.liveCount}
                    </div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255, 255, 255, 0.03)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Saved Events & Anniversaries</div>
                    <div id="seed-summary-events" style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-amber)', marginTop: 2 }}>
                      {seedResult.summary.eventsCount}
                    </div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255, 255, 255, 0.03)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Seeded Orders</div>
                    <div id="seed-summary-orders" style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-cyan)', marginTop: 2 }}>
                      {seedResult.summary.ordersCount}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {seedError && (
            <div
              style={{
                padding: 16,
                borderRadius: 10,
                background: 'rgba(244, 63, 94, 0.1)',
                border: '1px solid rgba(244, 63, 94, 0.3)',
                color: 'var(--accent-rose)',
                fontSize: '0.85rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 4 }}>
                <AlertCircle size={16} /> Seed Failed
              </div>
              <div>{seedError}</div>
            </div>
          )}

          {/* Configuration Hint Callout */}
          <div
            style={{
              marginTop: 20,
              padding: 16,
              borderRadius: 8,
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-color)',
              fontSize: '0.8rem',
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 700, color: '#fff', marginBottom: 4 }}>
              How to add your verified live number to LIVE_CUSTOMER_PHONES:
            </div>
            <div>
              1. Add your real WhatsApp phone number to <code className="font-mono">LIVE_CUSTOMER_PHONES</code> in your root <code className="font-mono">.env</code> file (e.g. <code className="font-mono">LIVE_CUSTOMER_PHONES=919876543210</code>).
            </div>
            <div>
              2. Click <strong>Run Re-Seed Now</strong> above. Your number will be encrypted with AES-256-GCM and given the &ldquo;🟢 LIVE TEST&rdquo; badge in the customer directory.
            </div>
          </div>
        </div>

        {/* Section 4: Domain Event Ingestion & Replay Tester (Spec p20, p24, p25) */}
        <div className="glass-panel" style={{ padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: 'rgba(168, 85, 247, 0.15)',
                  border: '1px solid rgba(168, 85, 247, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Terminal size={20} color="#c084fc" />
              </div>
              <div>
                <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                  Domain Event Ingestion &amp; Replay Tester (Spec p20, p24, p25)
                </h2>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Simulate upstream CRM/order domain events, test deduplication and outbox idempotency, and observe change semantics (date replans, marketing opt-outs, and customer deletions).
                </div>
              </div>
            </div>

            <span
              style={{
                padding: '4px 10px',
                borderRadius: 20,
                fontSize: '0.75rem',
                fontWeight: 700,
                backgroundColor: 'rgba(168, 85, 247, 0.15)',
                color: '#c084fc',
                border: '1px solid rgba(168, 85, 247, 0.3)',
              }}
            >
              INBOX DEDUPE &amp; OUTBOX CONSUMER
            </span>
          </div>

          {/* Preset Selector */}
          <div style={{ marginBottom: 20, padding: 16, borderRadius: 8, background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-color)' }}>
            <label htmlFor="select-event-preset" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 700, color: '#c7d2fe', marginBottom: 6 }}>
              Select Domain Event Scenario Preset:
            </label>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                id="select-event-preset"
                value={eventPresetKey}
                onChange={(e) => handleSelectPreset(e.target.value)}
                className="input-field"
                style={{ flex: '1 1 320px', fontSize: '0.85rem' }}
              >
                {Object.entries(EVENT_PRESETS).map(([key, item]) => (
                  <option key={key} value={key}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => handleSelectPreset(eventPresetKey)}
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '8px 14px' }}
              >
                <RefreshCw size={14} /> Reload Preset
              </button>
            </div>
          </div>

          {/* Event Form Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Producer Family (e.g. orders, customers, crm)
              </label>
              <input
                id="input-event-producer"
                type="text"
                value={eventProducer}
                onChange={(e) => setEventProducer(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Event Type
              </label>
              <input
                id="input-event-type"
                type="text"
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Entity ID
              </label>
              <input
                id="input-event-entity-id"
                type="text"
                value={entityId}
                onChange={(e) => setEntityId(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Entity Version
              </label>
              <input
                id="input-event-entity-version"
                type="number"
                value={entityVersion}
                onChange={(e) => setEntityVersion(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>
          </div>

          {/* Event ID with generator */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
              Unique Event ID (Spec p25: deduplication key = tenantId + producer + eventId)
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                id="input-event-id"
                type="text"
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                className="input-field font-mono"
                style={{ flex: 1, fontSize: '0.85rem' }}
              />
              <button
                type="button"
                onClick={handleGenerateNewEventId}
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '8px 14px' }}
              >
                <Sparkles size={14} /> New Unique ID
              </button>
            </div>
          </div>

          {/* Payload JSON */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
              Payload Data (JSON format)
            </label>
            <textarea
              id="textarea-event-payload"
              rows={6}
              value={eventPayloadJson}
              onChange={(e) => setEventPayloadJson(e.target.value)}
              className="input-field font-mono"
              style={{ width: '100%', fontSize: '0.82rem', lineHeight: 1.4 }}
            />
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 20 }}>
            <button
              id="btn-post-event"
              onClick={handlePostEvent}
              disabled={eventPosting || replayRunning}
              className="btn btn-primary"
              style={{
                padding: '10px 22px',
                fontSize: '0.875rem',
                fontWeight: 700,
                background: 'linear-gradient(135deg, #a855f7, #6366f1)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Send size={15} className={eventPosting ? 'animate-spin' : ''} />
              {eventPosting ? 'Ingesting Event...' : 'Post Domain Event'}
            </button>

            <button
              id="btn-replay-event-5x"
              onClick={handleReplay5x}
              disabled={eventPosting || replayRunning}
              className="btn btn-secondary"
              style={{
                padding: '10px 20px',
                fontSize: '0.875rem',
                fontWeight: 700,
                borderColor: 'rgba(168, 85, 247, 0.4)',
                color: '#c084fc',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <History size={15} className={replayRunning ? 'animate-spin' : ''} />
              {replayRunning ? 'Testing 5x Replay...' : 'Replay 5x (Idempotency Test)'}
            </button>
          </div>

          {/* Single Event Result Visualizer */}
          {eventResult && (
            <div
              id="event-poster-response-box"
              style={{
                padding: 18,
                borderRadius: 10,
                background: eventResult.status === 'QUARANTINED'
                  ? 'rgba(245, 158, 11, 0.08)'
                  : eventResult.status === 'DUPLICATE'
                  ? 'rgba(6, 182, 212, 0.08)'
                  : 'rgba(16, 185, 129, 0.08)',
                border: `1px solid ${
                  eventResult.status === 'QUARANTINED'
                    ? 'rgba(245, 158, 11, 0.3)'
                    : eventResult.status === 'DUPLICATE'
                    ? 'rgba(6, 182, 212, 0.3)'
                    : 'rgba(16, 185, 129, 0.3)'
                }`,
                marginBottom: 16,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CheckCircle2
                    size={18}
                    color={
                      eventResult.status === 'QUARANTINED'
                        ? 'var(--accent-amber)'
                        : eventResult.status === 'DUPLICATE'
                        ? 'var(--accent-cyan)'
                        : 'var(--accent-emerald)'
                    }
                  />
                  <span style={{ fontWeight: 800, color: '#fff', fontSize: '0.95rem' }}>
                    {eventResult.message || 'Event Ingested'}
                  </span>
                </div>

                <span
                  style={{
                    padding: '3px 10px',
                    borderRadius: 12,
                    fontSize: '0.75rem',
                    fontWeight: 800,
                    backgroundColor:
                      eventResult.status === 'QUARANTINED'
                        ? 'rgba(245, 158, 11, 0.2)'
                        : eventResult.status === 'DUPLICATE'
                        ? 'rgba(6, 182, 212, 0.2)'
                        : 'rgba(16, 185, 129, 0.2)',
                    color:
                      eventResult.status === 'QUARANTINED'
                        ? 'var(--accent-amber)'
                        : eventResult.status === 'DUPLICATE'
                        ? 'var(--accent-cyan)'
                        : 'var(--accent-emerald)',
                  }}
                >
                  STATUS: {eventResult.status}
                </span>
              </div>

              {eventResult.quarantineReason && (
                <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(245, 158, 11, 0.15)', color: 'var(--accent-amber)', fontSize: '0.8rem', fontWeight: 600 }}>
                  Quarantine Reason: <code className="font-mono">{eventResult.quarantineReason}</code>
                </div>
              )}

              {eventResult.effects && Object.keys(eventResult.effects).length > 0 && (
                <div style={{ marginTop: 10, fontSize: '0.8rem' }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Applied Change Effects:</div>
                  <pre
                    className="font-mono"
                    style={{
                      background: 'rgba(0, 0, 0, 0.3)',
                      padding: 10,
                      borderRadius: 6,
                      fontSize: '0.78rem',
                      color: '#a5f3fc',
                      margin: 0,
                      overflowX: 'auto',
                    }}
                  >
                    {JSON.stringify(eventResult.effects, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* 5x Replay Results Table (Spec B02) */}
          {replayResults && (
            <div
              id="event-replay-results-box"
              style={{
                padding: 18,
                borderRadius: 10,
                background: 'rgba(168, 85, 247, 0.08)',
                border: '1px solid rgba(168, 85, 247, 0.3)',
                marginBottom: 16,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <History size={18} color="#c084fc" />
                  <span style={{ fontWeight: 800, color: '#fff', fontSize: '0.95rem' }}>
                    Replay 5x Test Results (Spec B02: Idempotent Execution)
                  </span>
                </div>
                <span
                  style={{
                    padding: '3px 10px',
                    borderRadius: 12,
                    fontSize: '0.75rem',
                    fontWeight: 800,
                    background: 'rgba(16, 185, 129, 0.2)',
                    color: 'var(--accent-emerald)',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                  }}
                >
                  ✓ Spec B02 Verified
                </span>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)', textAlign: 'left', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '8px 10px' }}>Attempt</th>
                      <th style={{ padding: '8px 10px' }}>Status</th>
                      <th style={{ padding: '8px 10px' }}>Outcome / Message</th>
                      <th style={{ padding: '8px 10px' }}>State Effect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {replayResults.map((run, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                        <td style={{ padding: '8px 10px', fontWeight: 700, color: '#fff' }}>
                          #{run.attempt}
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: 4,
                              fontSize: '0.75rem',
                              fontWeight: 700,
                              background:
                                run.status === 'PROCESSED'
                                  ? 'rgba(16, 185, 129, 0.2)'
                                  : run.status === 'DUPLICATE'
                                  ? 'rgba(6, 182, 212, 0.2)'
                                  : 'rgba(245, 158, 11, 0.2)',
                              color:
                                run.status === 'PROCESSED'
                                  ? 'var(--accent-emerald)'
                                  : run.status === 'DUPLICATE'
                                  ? 'var(--accent-cyan)'
                                  : 'var(--accent-amber)',
                            }}
                          >
                            {run.status}
                          </span>
                        </td>
                        <td style={{ padding: '8px 10px', color: 'var(--text-secondary)' }}>
                          {run.message}
                        </td>
                        <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>
                          {run.status === 'PROCESSED' ? (
                            <span style={{ color: 'var(--accent-emerald)' }}>State Updated Once</span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>No-Op (Deduplicated)</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {eventError && (
            <div
              style={{
                padding: 16,
                borderRadius: 10,
                background: 'rgba(244, 63, 94, 0.1)',
                border: '1px solid rgba(244, 63, 94, 0.3)',
                color: 'var(--accent-rose)',
                fontSize: '0.85rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 4 }}>
                <AlertCircle size={16} /> Ingestion Error
              </div>
              <div>{eventError}</div>
            </div>
          )}
        </div>

        {/* Section 6: Mock Occasions CRM Control Panel */}
        <div id="mock-occasions-panel" className="glass-panel" style={{ padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: 'rgba(236, 72, 153, 0.15)',
                  border: '1px solid rgba(236, 72, 153, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Gift size={20} color="#ec4899" />
              </div>
              <div>
                <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                  Mock Occasions CRM Control Panel (Spec F22, Block G)
                </h2>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Directly dispatch occasion lifecycles (create, postpone, cancel, delete, complete) to trigger wedding and gift campaign enrollments, lead-time replanning, and goal cancellations.
                </div>
              </div>
            </div>

            <span
              style={{
                padding: '4px 10px',
                borderRadius: 20,
                fontSize: '0.75rem',
                fontWeight: 700,
                backgroundColor: 'rgba(236, 72, 153, 0.15)',
                color: '#f472b6',
                border: '1px solid rgba(236, 72, 153, 0.3)',
              }}
            >
              OCCASION ENGINE (F22)
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Customer ID
              </label>
              <input
                id="input-mock-occ-customer"
                type="text"
                value={mockOccCustomer}
                onChange={(e) => setMockOccCustomer(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Event ID
              </label>
              <input
                id="input-mock-occ-event-id"
                type="text"
                value={mockOccEventId}
                onChange={(e) => setMockOccEventId(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Occasion Kind
              </label>
              <select
                id="select-mock-occ-kind"
                value={mockOccKind}
                onChange={(e) => setMockOccKind(e.target.value as 'WEDDING' | 'GIFT')}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              >
                <option value="WEDDING">WEDDING (Lead time: 21d, D-45 & D-21)</option>
                <option value="GIFT">GIFT (Lead time: 2d, D-10 & D-3)</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Event Date (YYYY-MM-DD)
              </label>
              <input
                id="input-mock-occ-date"
                type="date"
                value={mockOccDate}
                onChange={(e) => setMockOccDate(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            {mockOccKind === 'GIFT' && (
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                  Recipient Label
                </label>
                <input
                  id="input-mock-occ-recipient"
                  type="text"
                  value={mockOccRecipientLabel}
                  onChange={(e) => setMockOccRecipientLabel(e.target.value)}
                  placeholder="e.g. Mom, Best Friend"
                  className="input-field"
                  style={{ width: '100%', fontSize: '0.85rem' }}
                />
              </div>
            )}

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Budget (Paise)
              </label>
              <input
                id="input-mock-occ-budget"
                type="number"
                value={mockOccBudgetPaise}
                onChange={(e) => setMockOccBudgetPaise(e.target.value)}
                placeholder="e.g. 5000000 for 50,000 INR"
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div style={{ gridColumn: 'span 2' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Categories (comma-separated)
              </label>
              <input
                id="input-mock-occ-categories"
                type="text"
                value={mockOccCategories}
                onChange={(e) => setMockOccCategories(e.target.value)}
                placeholder="e.g. bridal_saree, gold_jewelry"
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
            <input
              id="checkbox-mock-occ-declared"
              type="checkbox"
              checked={mockOccDeclaredByCustomer}
              onChange={(e) => setMockOccDeclaredByCustomer(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: '#ec4899', cursor: 'pointer' }}
            />
            <label htmlFor="checkbox-mock-occ-declared" style={{ fontSize: '0.85rem', color: '#fff', cursor: 'pointer' }}>
              Declared by customer (<code className="font-mono" style={{ fontSize: '0.78rem' }}>declaredByCustomer: true</code> gate)
            </label>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              id="btn-mock-occ-create"
              type="button"
              onClick={() => handleMockOccasionAction('create')}
              disabled={mockOccLoading}
              className="btn btn-primary"
              style={{ background: 'linear-gradient(135deg, #ec4899, #d946ef)', fontSize: '0.85rem', padding: '9px 18px' }}
            >
              <Send size={14} /> Create Occasion
            </button>
            <button
              id="btn-mock-occ-postpone"
              type="button"
              onClick={() => handleMockOccasionAction('postpone')}
              disabled={mockOccLoading}
              className="btn btn-secondary"
              style={{ fontSize: '0.85rem', padding: '9px 16px', color: 'var(--accent-amber)', borderColor: 'rgba(245, 158, 11, 0.4)' }}
            >
              <History size={14} /> Postpone (+30 Days)
            </button>
            <button
              id="btn-mock-occ-cancel"
              type="button"
              onClick={() => handleMockOccasionAction('cancel')}
              disabled={mockOccLoading}
              className="btn btn-secondary"
              style={{ fontSize: '0.85rem', padding: '9px 16px', color: 'var(--accent-rose)', borderColor: 'rgba(244, 63, 94, 0.4)' }}
            >
              <X size={14} /> Cancel Occasion
            </button>
            <button
              id="btn-mock-occ-complete"
              type="button"
              onClick={() => handleMockOccasionAction('complete')}
              disabled={mockOccLoading}
              className="btn btn-secondary"
              style={{ fontSize: '0.85rem', padding: '9px 16px', color: 'var(--accent-emerald)', borderColor: 'rgba(16, 185, 129, 0.4)' }}
            >
              <CheckCircle2 size={14} /> Complete Occasion
            </button>
            <button
              id="btn-mock-occ-delete"
              type="button"
              onClick={() => handleMockOccasionAction('delete')}
              disabled={mockOccLoading}
              className="btn btn-secondary"
              style={{ fontSize: '0.85rem', padding: '9px 16px', color: '#94a3b8' }}
            >
              Delete Occasion
            </button>
          </div>

          {mockOccResult && (
            <div
              id="mock-occ-result-box"
              style={{
                marginTop: 18,
                padding: 16,
                borderRadius: 8,
                background: 'rgba(236, 72, 153, 0.08)',
                border: '1px solid rgba(236, 72, 153, 0.3)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#f472b6', fontSize: '0.85rem', marginBottom: 8 }}>
                <CheckCircle2 size={16} /> Action '{mockOccResult.action}' completed successfully
              </div>
              <pre
                className="font-mono"
                style={{
                  margin: 0,
                  fontSize: '0.78rem',
                  color: '#e2e8f0',
                  background: 'rgba(0,0,0,0.3)',
                  padding: 10,
                  borderRadius: 6,
                  overflowX: 'auto',
                }}
              >
                {JSON.stringify(mockOccResult, null, 2)}
              </pre>
            </div>
          )}

          {mockOccError && (
            <div
              id="mock-occ-error-box"
              style={{
                marginTop: 18,
                padding: 16,
                borderRadius: 8,
                background: 'rgba(244, 63, 94, 0.1)',
                border: '1px solid rgba(244, 63, 94, 0.3)',
                color: 'var(--accent-rose)',
                fontSize: '0.85rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 4 }}>
                <AlertCircle size={16} /> Error
              </div>
              <div>{mockOccError}</div>
            </div>
          )}
        </div>

        {/* Section 7: Mock Enquiries Control Panel (Spec F23, Block G) */}
        <div id="mock-enquiries-panel" className="glass-panel" style={{ padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: 'rgba(56, 189, 248, 0.15)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <HelpCircle size={20} color="#38bdf8" />
              </div>
              <div>
                <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                  Mock Enquiries Control Panel (Spec F23, Block G)
                </h2>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Simulate external enquiry lifecycles: create enquiries, customer interactions (anchor moves), staff edits (updatedAt only), takeover holds, and staff resolution.
                </div>
              </div>
            </div>

            <span
              style={{
                padding: '4px 10px',
                borderRadius: 20,
                fontSize: '0.75rem',
                fontWeight: 700,
                backgroundColor: 'rgba(56, 189, 248, 0.15)',
                color: '#38bdf8',
                border: '1px solid rgba(56, 189, 248, 0.3)',
              }}
            >
              ENQUIRY ENGINE (F23)
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Enquiry ID
              </label>
              <input
                id="input-mock-enq-id"
                type="text"
                value={mockEnqId}
                onChange={(e) => setMockEnqId(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Customer ID
              </label>
              <input
                id="input-mock-enq-customer"
                type="text"
                value={mockEnqCustomer}
                onChange={(e) => setMockEnqCustomer(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Channel
              </label>
              <select
                id="select-mock-enq-channel"
                value={mockEnqChannel}
                onChange={(e) => setMockEnqChannel(e.target.value as any)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              >
                <option value="IN_STORE">IN_STORE</option>
                <option value="PHONE">PHONE</option>
                <option value="WHATSAPP">WHATSAPP</option>
                <option value="OTHER">OTHER</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Product ID
              </label>
              <input
                id="input-mock-enq-product"
                type="text"
                value={mockEnqProductId}
                onChange={(e) => setMockEnqProductId(e.target.value)}
                placeholder="e.g. prod_kanjivaram_silk"
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Variant ID (Optional)
              </label>
              <input
                id="input-mock-enq-variant"
                type="text"
                value={mockEnqVariantId}
                onChange={(e) => setMockEnqVariantId(e.target.value)}
                placeholder="e.g. var_gold_border"
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
            <input
              id="checkbox-mock-enq-takeover"
              type="checkbox"
              checked={mockEnqTakeover}
              onChange={(e) => setMockEnqTakeover(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: '#38bdf8', cursor: 'pointer' }}
            />
            <label htmlFor="checkbox-mock-enq-takeover" style={{ fontSize: '0.85rem', color: '#fff', cursor: 'pointer' }}>
              Staff takeover active (<code className="font-mono" style={{ fontSize: '0.78rem' }}>staffTakeover: true</code> holds enrollment)
            </label>
          </div>

          {/* Enquiry Action Buttons */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              id="btn-mock-enq-create"
              type="button"
              onClick={() => handleMockEnquiryAction('create')}
              disabled={mockEnqLoading}
              className="btn btn-primary"
              style={{ background: 'linear-gradient(135deg, #0284c7, #38bdf8)', fontSize: '0.85rem', padding: '9px 18px' }}
            >
              <Send size={14} /> Create Mock Enquiry
            </button>
            <button
              id="btn-mock-enq-interaction"
              type="button"
              onClick={() => handleMockEnquiryAction('interaction')}
              disabled={mockEnqLoading}
              className="btn btn-secondary"
              style={{ fontSize: '0.85rem', padding: '9px 16px', color: 'var(--accent-cyan)', borderColor: 'rgba(56, 189, 248, 0.4)' }}
            >
              <History size={14} /> Customer Interaction (+now)
            </button>
            <button
              id="btn-mock-enq-staff-edit"
              type="button"
              onClick={() => handleMockEnquiryAction('staff-edit')}
              disabled={mockEnqLoading}
              className="btn btn-secondary"
              style={{ fontSize: '0.85rem', padding: '9px 16px', color: 'var(--text-secondary)' }}
            >
              Staff Edit (updatedAt only)
            </button>
            <button
              id="btn-mock-enq-takeover"
              type="button"
              onClick={() => handleMockEnquiryAction('takeover')}
              disabled={mockEnqLoading}
              className="btn btn-secondary"
              style={{ fontSize: '0.85rem', padding: '9px 16px', color: 'var(--accent-amber)', borderColor: 'rgba(245, 158, 11, 0.4)' }}
            >
              Toggle Takeover ({mockEnqTakeover ? 'Set False' : 'Set True'})
            </button>
            <button
              id="btn-mock-enq-resolve"
              type="button"
              onClick={() => handleMockEnquiryAction('resolve')}
              disabled={mockEnqLoading}
              className="btn btn-secondary"
              style={{ fontSize: '0.85rem', padding: '9px 16px', color: 'var(--accent-emerald)', borderColor: 'rgba(16, 185, 129, 0.4)' }}
            >
              <CheckCircle2 size={14} /> Resolve Enquiry
            </button>
            <button
              id="btn-mock-enq-delete"
              type="button"
              onClick={() => handleMockEnquiryAction('delete')}
              disabled={mockEnqLoading}
              className="btn btn-secondary"
              style={{ fontSize: '0.85rem', padding: '9px 16px', color: 'var(--accent-rose)' }}
            >
              Delete Enquiry
            </button>
          </div>

          {mockEnqResult && (
            <div
              id="mock-enq-result-box"
              style={{
                marginTop: 18,
                padding: 16,
                borderRadius: 8,
                background: 'rgba(56, 189, 248, 0.08)',
                border: '1px solid rgba(56, 189, 248, 0.3)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#38bdf8', fontSize: '0.85rem', marginBottom: 8 }}>
                <CheckCircle2 size={16} /> Action '{mockEnqResult.action}' completed successfully
              </div>
              <pre
                className="font-mono"
                style={{
                  margin: 0,
                  fontSize: '0.78rem',
                  color: '#e2e8f0',
                  background: 'rgba(0,0,0,0.3)',
                  padding: 10,
                  borderRadius: 6,
                  overflowX: 'auto',
                }}
              >
                {JSON.stringify(mockEnqResult, null, 2)}
              </pre>
            </div>
          )}

          {mockEnqError && (
            <div
              id="mock-enq-error-box"
              style={{
                marginTop: 18,
                padding: 16,
                borderRadius: 8,
                background: 'rgba(244, 63, 94, 0.1)',
                border: '1px solid rgba(244, 63, 94, 0.3)',
                color: 'var(--accent-rose)',
                fontSize: '0.85rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 4 }}>
                <AlertCircle size={16} /> Error
              </div>
              <div>{mockEnqError}</div>
            </div>
          )}
        </div>

        {/* Section 8: Mock Products & Sellable Inventory Control Panel (Spec F23, Block G) */}
        <div id="mock-products-panel" className="glass-panel" style={{ padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: 'rgba(16, 185, 129, 0.15)',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ShoppingBag size={20} color="#10b981" />
              </div>
              <div>
                <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                  Mock Products &amp; Sellable Inventory (Spec F23, Block G)
                </h2>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Manage boutique catalogue items and variant sellable quantities. Products with sellableQty = 0 or status = DISCONTINUED trigger ITEM_UNAVAILABLE dispatch skips without reserving stock.
                </div>
              </div>
            </div>

            <span
              style={{
                padding: '4px 10px',
                borderRadius: 20,
                fontSize: '0.75rem',
                fontWeight: 700,
                backgroundColor: 'rgba(16, 185, 129, 0.15)',
                color: '#34d399',
                border: '1px solid rgba(16, 185, 129, 0.3)',
              }}
            >
              PRODUCT &amp; STOCK (F23)
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Product ID
              </label>
              <input
                id="input-mock-prod-id"
                type="text"
                value={mockProdId}
                onChange={(e) => setMockProdId(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Product Name
              </label>
              <input
                id="input-mock-prod-name"
                type="text"
                value={mockProdName}
                onChange={(e) => setMockProdName(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Category (F24 Outfit)
              </label>
              <select
                id="select-mock-prod-category"
                value={mockProdCategory}
                onChange={(e) => setMockProdCategory(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              >
                <option value="saree">saree (Anchor)</option>
                <option value="blouse">blouse (Complement)</option>
                <option value="dupatta">dupatta (Complement)</option>
                <option value="accessories">accessories (Complement)</option>
                <option value="petticoat">petticoat (Complement)</option>
                <option value="jewellery">jewellery (Complement)</option>
                <option value="lehenga">lehenga</option>
                <option value="kurta">kurta</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Colour Family
              </label>
              <select
                id="select-mock-prod-colour"
                value={mockProdColourFamily}
                onChange={(e) => setMockProdColourFamily(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              >
                <option value="red">red</option>
                <option value="gold">gold (Neutral)</option>
                <option value="silver">silver (Neutral)</option>
                <option value="beige">beige (Neutral)</option>
                <option value="black">black (Neutral)</option>
                <option value="white">white (Neutral)</option>
                <option value="green">green</option>
                <option value="blue">blue</option>
                <option value="yellow">yellow</option>
                <option value="purple">purple</option>
                <option value="pink">pink</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Weave / Fabric
              </label>
              <input
                id="input-mock-prod-weave"
                type="text"
                value={mockProdWeave}
                onChange={(e) => setMockProdWeave(e.target.value)}
                placeholder="e.g. silk, cotton, zari"
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Price (₹ INR)
              </label>
              <input
                id="input-mock-prod-price"
                type="number"
                min={0}
                step={50}
                value={mockProdPriceInr}
                onChange={(e) => setMockProdPriceInr(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Variant ID
              </label>
              <input
                id="input-mock-prod-variant-id"
                type="text"
                value={mockProdVariantId}
                onChange={(e) => setMockProdVariantId(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Variant Label
              </label>
              <input
                id="input-mock-prod-variant-label"
                type="text"
                value={mockProdVariantLabel}
                onChange={(e) => setMockProdVariantLabel(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Sellable Quantity
              </label>
              <input
                id="input-mock-prod-stock"
                type="number"
                min={0}
                value={mockProdStock}
                onChange={(e) => setMockProdStock(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            </div>
          </div>

          {/* Product Action Buttons */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              id="btn-mock-prod-create"
              type="button"
              onClick={() => handleMockProductAction('create')}
              disabled={mockProdLoading}
              className="btn btn-primary"
              style={{ background: 'linear-gradient(135deg, #059669, #10b981)', fontSize: '0.85rem', padding: '9px 18px' }}
            >
              <Send size={14} /> Create / Update Product
            </button>
            <button
              id="btn-mock-prod-stock"
              type="button"
              onClick={() => handleMockProductAction('stock')}
              disabled={mockProdLoading}
              className="btn btn-secondary"
              style={{ fontSize: '0.85rem', padding: '9px 16px', color: 'var(--accent-emerald)', borderColor: 'rgba(16, 185, 129, 0.4)' }}
            >
              Update Sellable Stock ({mockProdStock} units)
            </button>
          </div>

          {mockProdResult && (
            <div
              id="mock-prod-result-box"
              style={{
                marginTop: 18,
                padding: 16,
                borderRadius: 8,
                background: 'rgba(16, 185, 129, 0.08)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#34d399', fontSize: '0.85rem', marginBottom: 8 }}>
                <CheckCircle2 size={16} /> Action '{mockProdResult.action}' completed successfully
              </div>
              <pre
                className="font-mono"
                style={{
                  margin: 0,
                  fontSize: '0.78rem',
                  color: '#e2e8f0',
                  background: 'rgba(0,0,0,0.3)',
                  padding: 10,
                  borderRadius: 6,
                  overflowX: 'auto',
                }}
              >
                {JSON.stringify(mockProdResult, null, 2)}
              </pre>
            </div>
          )}

          {mockProdError && (
            <div
              id="mock-prod-error-box"
              style={{
                marginTop: 18,
                padding: 16,
                borderRadius: 8,
                background: 'rgba(244, 63, 94, 0.1)',
                border: '1px solid rgba(244, 63, 94, 0.3)',
                color: 'var(--accent-rose)',
                fontSize: '0.85rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 4 }}>
                <AlertCircle size={16} /> Error
              </div>
              <div>{mockProdError}</div>
            </div>
          )}

          {/* Sub-section: Order Line Return Simulator (F24) */}
          <div
            style={{
              marginTop: 24,
              paddingTop: 20,
              borderTop: '1px solid var(--border-color)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Sparkles size={16} color="var(--accent-purple, #a855f7)" />
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                Order Line Return Simulator (F24 Outfit Anchor Return Testing)
              </h3>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 14 }}>
              Simulate customer returning an anchor order line. If all units of the anchor item are returned, active outfit enrollments stop with reason code <code className="font-mono">ANCHOR_LINES_RETURNED</code>.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                  Order ID
                </label>
                <input
                  id="input-return-order-id"
                  type="text"
                  value={returnOrderId}
                  onChange={(e) => setReturnOrderId(e.target.value)}
                  className="input-field"
                  style={{ width: '100%', fontSize: '0.85rem' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                  Line ID
                </label>
                <input
                  id="input-return-line-id"
                  type="text"
                  value={returnLineId}
                  onChange={(e) => setReturnLineId(e.target.value)}
                  className="input-field"
                  style={{ width: '100%', fontSize: '0.85rem' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                  Return Qty
                </label>
                <input
                  id="input-return-qty"
                  type="number"
                  min={1}
                  value={returnQty}
                  onChange={(e) => setReturnQty(e.target.value)}
                  className="input-field"
                  style={{ width: '100%', fontSize: '0.85rem' }}
                />
              </div>
            </div>

            <button
              id="btn-mock-line-return"
              type="button"
              onClick={handleOrderLineReturn}
              disabled={returnLoading}
              className="btn btn-secondary"
              style={{ fontSize: '0.85rem', padding: '8px 16px', color: '#c084fc', borderColor: 'rgba(168, 85, 247, 0.4)' }}
            >
              {returnLoading ? 'Processing return...' : 'Simulate Order Line Return'}
            </button>

            {returnResult && (
              <div
                id="mock-line-return-result"
                style={{
                  marginTop: 14,
                  padding: 12,
                  borderRadius: 6,
                  background: 'rgba(168, 85, 247, 0.08)',
                  border: '1px solid rgba(168, 85, 247, 0.3)',
                  fontSize: '0.8rem',
                }}
              >
                <div style={{ color: '#c084fc', fontWeight: 700, marginBottom: 4 }}>
                  Return processed &amp; order.refunded ingested:
                </div>
                <pre className="font-mono" style={{ margin: 0, fontSize: '0.75rem', color: '#e2e8f0' }}>
                  {JSON.stringify(returnResult, null, 2)}
                </pre>
              </div>
            )}

            {returnError && (
              <div
                id="mock-line-return-error"
                style={{
                  marginTop: 14,
                  padding: 12,
                  borderRadius: 6,
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  color: 'var(--accent-rose)',
                  fontSize: '0.8rem',
                }}
              >
                {returnError}
              </div>
            )}
          </div>
        </div>

        {/* Section 5: Quarantined Events Audit & Dead Letter Queue (Spec p24, p29) */}
        <div className="glass-panel" style={{ padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: 'rgba(245, 158, 11, 0.15)',
                  border: '1px solid rgba(245, 158, 11, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ShieldAlert size={20} color="var(--accent-amber)" />
              </div>
              <div>
                <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                  Quarantined Events Audit &amp; Dead Letter Queue (Spec p24, p29)
                </h2>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Events with unknown schema, stale entity version, or producer mismatch are safely quarantined with visible reason and never roll state backwards or broaden audiences.
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  padding: '4px 10px',
                  borderRadius: 20,
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  background: quarantinedTotal > 0 ? 'rgba(245, 158, 11, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                  color: quarantinedTotal > 0 ? 'var(--accent-amber)' : 'var(--text-muted)',
                  border: `1px solid ${quarantinedTotal > 0 ? 'rgba(245, 158, 11, 0.3)' : 'var(--border-color)'}`,
                }}
              >
                {quarantinedTotal} Quarantined
              </span>

              <button
                id="btn-refresh-quarantine"
                onClick={fetchQuarantinedEvents}
                disabled={quarantinedLoading}
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '6px 12px' }}
              >
                <RefreshCw size={13} className={quarantinedLoading ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
          </div>

          {/* Quarantined Events Table */}
          <div style={{ overflowX: 'auto' }}>
            <table id="quarantine-events-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '10px 12px' }}>Event ID</th>
                  <th style={{ padding: '10px 12px' }}>Producer</th>
                  <th style={{ padding: '10px 12px' }}>Event Type</th>
                  <th style={{ padding: '10px 12px' }}>Entity ID &amp; Ver</th>
                  <th style={{ padding: '10px 12px' }}>Quarantine Reason</th>
                  <th style={{ padding: '10px 12px' }}>Occurred At</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {quarantinedEvents.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
                      No quarantined events recorded. The event ingestion pipeline is clean.
                    </td>
                  </tr>
                ) : (
                  quarantinedEvents.map((evt) => (
                    <tr key={evt._id || evt.eventId} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#fff' }}>
                        {evt.eventId}
                      </td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>
                        <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.05)', fontSize: '0.75rem' }}>
                          {evt.producer}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px', color: '#c7d2fe' }}>
                        {evt.eventType}
                      </td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>
                        {evt.entityId} (v{evt.entityVersion})
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <span
                          style={{
                            padding: '3px 8px',
                            borderRadius: 4,
                            fontSize: '0.72rem',
                            fontWeight: 700,
                            background: 'rgba(245, 158, 11, 0.15)',
                            color: 'var(--accent-amber)',
                            border: '1px solid rgba(245, 158, 11, 0.3)',
                          }}
                        >
                          {evt.quarantineReason || 'UNKNOWN'}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                        {evt.occurredAt ? new Date(evt.occurredAt).toLocaleString() : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                        <button
                          type="button"
                          onClick={() => setSelectedQuarantineItem(evt)}
                          className="btn btn-secondary"
                          style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                        >
                          <Eye size={13} /> View Payload
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Quarantine Payload Detail Modal */}
        {selectedQuarantineItem && (
          <div
            id="quarantine-payload-modal"
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.8)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000,
              padding: 24,
            }}
          >
            <div
              className="glass-panel"
              style={{
                width: '100%',
                maxWidth: 640,
                maxHeight: '90vh',
                overflowY: 'auto',
                padding: 24,
                position: 'relative',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                    Quarantined Event Details
                  </h3>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                    Event ID: <span className="font-mono">{selectedQuarantineItem.eventId}</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedQuarantineItem(null)}
                  className="btn btn-secondary"
                  style={{ padding: '6px 10px', borderRadius: '50%' }}
                >
                  <X size={16} />
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 16 }}>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255, 255, 255, 0.02)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Quarantine Reason</div>
                  <div style={{ fontWeight: 700, color: 'var(--accent-amber)', fontSize: '0.85rem' }}>
                    {selectedQuarantineItem.quarantineReason}
                  </div>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255, 255, 255, 0.02)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Producer / Type</div>
                  <div style={{ fontWeight: 700, color: '#c7d2fe', fontSize: '0.85rem' }}>
                    {selectedQuarantineItem.producer} / {selectedQuarantineItem.eventType}
                  </div>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255, 255, 255, 0.02)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Entity ID &amp; Version</div>
                  <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem' }}>
                    {selectedQuarantineItem.entityId} (v{selectedQuarantineItem.entityVersion})
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6 }}>
                  Quarantined Raw Payload JSON:
                </div>
                <pre
                  className="font-mono"
                  style={{
                    background: 'rgba(0, 0, 0, 0.5)',
                    padding: 14,
                    borderRadius: 8,
                    fontSize: '0.8rem',
                    color: '#e2e8f0',
                    overflowX: 'auto',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  {JSON.stringify(selectedQuarantineItem.payload, null, 2)}
                </pre>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setSelectedQuarantineItem(null)}
                  className="btn btn-secondary"
                  style={{ fontSize: '0.85rem', padding: '8px 18px' }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
