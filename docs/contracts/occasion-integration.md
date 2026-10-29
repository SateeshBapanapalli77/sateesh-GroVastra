# Occasion Integration Contract & Data Exchange Specification

> **Document Status**: Proposed, to be agreed between GroVastra Auto Campaigns and CRM Integration Team.  
> **Channel**: WhatsApp Cloud API (Meta Graph API pinned).  
> **Feature**: F22 Gift & Wedding Reminder Automated Campaigns.

---

## 1. Overview & Architectural Boundaries

GroVastra Auto Campaigns is an automated WhatsApp campaign engine designed for boutiques, handloom stores, and apparel retailers. It is **NOT** a CRM, appointment scheduler, or inventory management system.

Occasions (such as weddings and gifting milestones) originate in the store CRM or POS system when volunteered directly by customers at the counter. Auto Campaigns consumes these occasions via a read-only adapter (`OccasionSource`) and receives real-time domain event notifications (`occasion.saved`, `occasion.cancelled`, `occasion.deleted`, `occasion.completed`).

### Hard Architectural Rules
1. **Production Code is Read-Only on Customer Events**: Auto Campaigns production code **NEVER** writes directly to `src_customerEvents`. All occasion state modifications belong to the store CRM. Auto Campaigns accesses occasions strictly through the `OccasionSource` abstraction.
2. **Strict Multi-Tenant Scoping**: All queries, domain events, and database collections are partitioned by `tenantId`. `tenantId` is derived exclusively from authenticated session context and never trusted from user-supplied request bodies.
3. **No Inferred Contact Information**: For weddings and couples, Auto Campaigns communicates strictly with the customer who volunteered their contact details. The engine **never** infers, captures, or contacts partner identities without explicit declaration and verified consent.
4. **Pure Date-Only Representation**: Occasion dates are stored and communicated as calendar dates `{ year, month, day }` and ISO-8601 strings (`YYYY-MM-DD`). Date calculations must never convert through UTC midnight to avoid timezone shifts.
5. **Minor Units (Paise)**: All budgets and currency amounts are represented as integers in minor units (paise: ₹1.00 = 100 paise).
6. **No Phantom Bookings**: WhatsApp templates and campaign messages may offer booking links, but must never claim or imply an appointment is confirmed merely because an invitation or message was delivered.

---

## 2. Occasion Record Schema *(Proposed, to be agreed)*

When querying `OccasionSource` or persisting source occasion snapshots, the following schema is enforced:

```typescript
export type OccasionKind = 'GIFT' | 'WEDDING';

export type OccasionStatus = 'ACTIVE' | 'CANCELLED' | 'COMPLETED';

export type OccasionSourceType = 'COUNTER' | 'CRM_API' | 'IMPORT' | 'DEV_TOOL';

export type OccasionCategory =
  | 'saree'
  | 'blouse'
  | 'lehenga'
  | 'kurta'
  | 'dupatta'
  | 'menswear'
  | 'kidswear'
  | 'accessories';

export interface OccasionRecord {
  id: string;                       // Document identifier
  tenantId: string;                 // Tenant identifier [Required]
  customerId: string;               // Owning customer ID [Required]
  eventId: string;                  // Unique occasion ID (e.g. "wed_001") [Required]
  type: string;                     // Lowercase kind ("wedding" | "gift") [Required]
  kind: OccasionKind;               // "GIFT" | "WEDDING" [Required]
  eventDate: string;                // ISO calendar string "YYYY-MM-DD" [Required]
  eventDateKey: string;             // ISO calendar string "YYYY-MM-DD" [Required]
  recipientLabel?: string | null;   // Volunteer label (e.g. "Mom", "Niece", "Bride") [GIFT only]
  budgetPaise?: number | null;      // Stated budget in minor units (e.g. 5000000 = ₹50,000)
  categories: OccasionCategory[];   // Selected attire/shopping categories
  status: OccasionStatus;           // "ACTIVE" | "CANCELLED" | "COMPLETED" [Required]
  declaredByCustomer: boolean;      // Customer-volunteered consent flag [Required: must be true]
  declaredAt?: string | null;       // ISO timestamp when customer declared the event
  source: OccasionSourceType;       // Origin of occasion record [Required]
  entityVersion: number;            // Monotonically increasing version counter [Required]
  deletedAt: string | null;         // Soft-deletion timestamp [Nullable]
}
```

---

## 3. CRM Domain Event Specifications

Domain events emitted by the CRM to the GroVastra event broker must conform to `CampaignEventInputSchema`:

### 3.1 `occasion.saved`
Emitted when a customer registers an occasion, or when an existing occasion's date, budget, or categories change. In GroVastra Auto Campaigns, postponement is occasion.saved with a new date.

```json
{
  "schemaVersion": 1,
  "producer": "crm",
  "eventId": "evt_crm_20261026_01",
  "tenantId": "shop_a",
  "type": "occasion.saved",
  "entityId": "wed_001",
  "entityVersion": 2,
  "customerId": "cust_456",
  "occurredAt": "2026-10-26T10:00:00.000Z",
  "data": {
    "eventId": "wed_001",
    "customerId": "cust_456",
    "kind": "WEDDING",
    "eventDate": "2027-02-14",
    "eventDateKey": "2027-02-14",
    "recipientLabel": null,
    "budgetPaise": 10000000,
    "categories": ["saree", "blouse"],
    "declaredByCustomer": true,
    "source": "CUSTOMER_DECLARED",
    "status": "ACTIVE"
  }
}
```

**Semantics on Postponement / Date Change**:
- Auto Campaigns revises the **same occurrence** (`wedding:wed_001`); it **never** creates a second duplicate enrollment.
- Atomically increments `planRevision`.
- Recomputes all unsubmitted executions (`deliveryIntentId: null`) to match the new date.
- Preserves all already sent, delivered, or read execution history intact.
- Appends an audit entry to `dateHistory: [{ at, oldDate, newDate, oldVersion, newVersion }]`.
- If an execution was currently claimed in-flight by a worker (`deliveryIntentId !== null`), the frozen intent is marked `BLOCKED_STALE_INTENT` and the execution is blocked from dispatching.

---

### 3.2 `occasion.cancelled`
Emitted when the customer cancels the occasion or states they will not be shopping.

```json
{
  "schemaVersion": 1,
  "producer": "crm",
  "eventId": "evt_crm_20261026_02",
  "tenantId": "shop_a",
  "type": "occasion.cancelled",
  "entityId": "wed_001",
  "entityVersion": 3,
  "customerId": "cust_456",
  "occurredAt": "2026-10-26T10:05:00.000Z",
  "data": {
    "eventId": "wed_001",
    "customerId": "cust_456",
    "kind": "WEDDING",
    "reason": "CUSTOMER_CANCELLED"
  }
}
```

**Semantics**:
- Cancels all pending unsubmitted steps with `skipReason = 'OCCASION_CANCELLED'`.
- Sets enrollment status to `CANCELLED`.

---

### 3.3 `occasion.deleted`
Emitted when an occasion record is purged or soft-deleted in the CRM.

```json
{
  "schemaVersion": 1,
  "producer": "crm",
  "eventId": "evt_crm_20261026_03",
  "tenantId": "shop_a",
  "type": "occasion.deleted",
  "entityId": "wed_001",
  "entityVersion": 4,
  "customerId": "cust_456",
  "occurredAt": "2026-10-26T10:10:00.000Z",
  "data": {
    "eventId": "wed_001",
    "customerId": "cust_456",
    "kind": "WEDDING"
  }
}
```

**Semantics**:
- Cancels all pending unsubmitted steps with `skipReason = 'OCCASION_DELETED'`.
- Sets enrollment status to `CANCELLED`.

---

### 3.4 `occasion.completed`
Emitted when staff at the counter confirm that wedding or gifting shopping is completed.

```json
{
  "schemaVersion": 1,
  "producer": "crm",
  "eventId": "evt_crm_20261026_04",
  "tenantId": "shop_a",
  "type": "occasion.completed",
  "entityId": "wed_001",
  "entityVersion": 5,
  "customerId": "cust_456",
  "occurredAt": "2026-10-26T10:15:00.000Z",
  "data": {
    "eventId": "wed_001",
    "customerId": "cust_456",
    "kind": "WEDDING",
    "completedBy": "STAFF",
    "reason": "SHOPPING_COMPLETE"
  }
}
```

**Semantics**:
- Cancels pending unsubmitted steps with `skipReason = 'OCCASION_COMPLETED'`.
- Marks enrollment status `COMPLETED` and sets `goalReachedAt`.
- Emits a durable `CampaignGoalEvent` with `source: 'OCCASION_COMPLETED'`.

---

## 4. Point-of-Sale Order Tagging Contract (`occasionRef`)

When an order is completed at checkout, the POS/CRM system should tag the order with the associated `occasionRef` if the purchase was for a registered occasion.

### Tagging Format
- Wedding purchase: `occasionRef = "wedding:<eventId>"` (e.g. `"wedding:wed_001"`)
- Gift purchase: `occasionRef = "gift:<eventId>"` (e.g. `"gift:gft_001"`)

### Order Completed Payload (`order.completed`)
```json
{
  "schemaVersion": 1,
  "producer": "orders",
  "eventId": "evt_ord_9001",
  "tenantId": "shop_a",
  "type": "order.completed",
  "entityId": "ord_555",
  "entityVersion": 1,
  "customerId": "cust_456",
  "occurredAt": "2026-10-26T11:00:00.000Z",
  "data": {
    "orderId": "ord_555",
    "orderNumber": "ORD-123456",
    "customerId": "cust_456",
    "status": "COMPLETED",
    "paid": true,
    "netPaise": 4500000,
    "occasionRef": "wedding:wed_001",
    "completedAt": "2026-10-26T11:00:00.000Z"
  }
}
```

### Goal Stop Semantics
1. **Tagged Orders**: If `order.occasionRef` matches an active enrollment's occurrence ID (`wedding:<eventId>` or `gift:<eventId>`), Auto Campaigns marks the enrollment goal reached and cancels remaining `stopOnGoal` steps with `SKIPPED_GOAL_REACHED`.
2. **Untagged Orders**: An order without an `occasionRef` (or tagged for an unrelated occasion) is treated as a general store purchase. It does **NOT** stop wedding or gift reminder campaigns.

---

## 5. Fulfillment Lead Times & Expiry Deadlines

Auto Campaigns calculates a hard cutoff deadline for every occasion:
$$\text{latestUsefulLocalDate} = \text{eventDate} - \text{fulfillmentLeadDays}$$
$$\text{latestUsefulAt} = \text{End of Allowed Sending Hours on latestUsefulLocalDate in campaign timezone (converted to UTC)}$$

- Default Lead Times:
  - Wedding (`WEDDING`): **21 days** (configurable from 0 to 180 days).
  - Gift (`GIFT`): **2 days** (configurable from 0 to 180 days).
- **Enforcement**: Any message step whose evaluated delivery instant falls past `latestUsefulAt` is immediately marked `SKIPPED` with reason `INSUFFICIENT_LEAD_TIME` and the human-readable explanation:
  `"Skipped: needs <leadDays> days before the event; the event is in <daysUntilEvent> days"`.
