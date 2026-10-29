# Fulfilment & Courier Integration Contract (F31)

> **Document Status**: Proposed, to be agreed between GroVastra Auto Campaigns and Order/Fulfilment & Courier system owners.  
> **Source Systems**: External Order/Fulfilment Management System (OMS/WMS) and Logistics/Courier Carrier Integration. GroVastra only **READS** fulfilment and shipment data through `FulfilmentSource` (`src_fulfilments`) and **NEVER** creates or mutates fulfilment or order records in production.

---

## 1. Overview & Architectural Boundaries

GroVastra Auto Campaigns uses fulfilment milestone data for the **Outfit Collection / Delivery (F31)** automated campaign preset.

### Key Operational Guarantees
1. **Service Purpose**: These are order-service sequences, strictly separate from promotional campaigns. They use approved WhatsApp `UTILITY` templates only. They do **NOT** consume marketing caps, and marketing opt-out does **NOT** block service messages.
2. **Read-Only Invariant**: Production campaign engines only read fulfilment records. All order, status, and shipment updates originate in external OMS and courier systems.
3. **Delivery vs Pickup Isolation**: "If delivery is arranged, do not send pickup instructions." Orders in `DELIVERY` mode never receive store pickup notices (`DELIVERY_ARRANGED`).
4. **Verified Dispatches**: "Label creation alone is not dispatch." Only verified courier `DISPATCHED` events trigger in-transit notices.
5. **Readiness Versioning**: The engine **NEVER** computes `readinessVersion`; it compares the authoritative version supplied by the source. `readinessVersion` increments only on genuine new readiness events.

---

## 2. Fulfilment Entity Schema (`src_fulfilments`)

| Field Name | Type | Description | Agreement Status |
| :--- | :--- | :--- | :--- |
| `orderId` | `String` | Unique order identifier matching `src_orders` when an order exists. | Proposed, to be agreed |
| `tenantId` | `String` | Tenant identifier (e.g. `shop_a`). | Proposed, to be agreed |
| `customerId` | `String?` | Customer identifier for messaging destination lookup. | Proposed, to be agreed |
| `branchId` | `String` | Branch or boutique store location ID. | Proposed, to be agreed |
| `orderNumber` | `String` | Customer-facing display order number (e.g., `ORD-F-001`). | Proposed, to be agreed |
| `mode` | `'PICKUP' \| 'DELIVERY'` | Fulfilment delivery channel. | Proposed, to be agreed |
| `status` | `FulfilmentStatus` | Current fulfilment lifecycle status. | Proposed, to be agreed |
| `readinessKind` | `'FULL' \| 'PARTIAL' \| null` | Granularity of readiness. | Proposed, to be agreed |
| `readinessVersion` | `Integer (>= 0)` | Monotonic readiness version counter supplied by the source. | Proposed, to be agreed |
| `readyAt` | `UTC Date?` | Authoritative timestamp when the order became ready. | Proposed, to be agreed |
| `collectedAt` | `UTC Date?` | Authoritative timestamp when customer picked up the order. | Proposed, to be agreed |
| `entityVersion` | `Integer` | Monotonically increasing version counter for the entire fulfilment document. | Proposed, to be agreed |
| `shipments` | `Array<Shipment>` | List of carrier shipments associated with this order. | Proposed, to be agreed |

### Status Enumeration (`FulfilmentStatus`)
- `NOT_READY`: Order is in fabrication, tailoring, or queue. *(Proposed, to be agreed)*
- `PARTIALLY_READY`: Only part of the order is ready; skipped unless campaign has an explicitly configured partial-ready template. *(Proposed, to be agreed)*
- `READY_FOR_COLLECTION`: Full order is ready for boutique pickup. *(Proposed, to be agreed)*
- `COLLECTED`: Customer has picked up the outfit in store. Cancels pending uncollected reminders. *(Proposed, to be agreed)*
- `DELIVERED`: Handed over to customer via store or courier. Cancels pending ready/dispatch notices. *(Proposed, to be agreed)*
- `CANCELLED`: Order was cancelled. Stops all pending notices. *(Proposed, to be agreed)*
- `REWORK`: Outfit returned to tailoring for adjustments. Cancels pending notices. *(Proposed, to be agreed)*
- `RETURNED`: Order returned by customer. *(Proposed, to be agreed)*

---

## 3. Shipment Entity Schema (`shipments[]`)

| Field Name | Type | Description | Agreement Status |
| :--- | :--- | :--- | :--- |
| `shipmentId` | `String` | Unique package shipment identifier (e.g., `shp_f_001`). | Proposed, to be agreed |
| `carrier` | `String` | Carrier code (e.g., `BLUEDART`, `DELHIVERY`). | Proposed, to be agreed |
| `carrierName` | `String` | Customer-facing carrier display name (e.g., `BlueDart Express`). | Proposed, to be agreed |
| `trackingRef` | `String?` | Valid tracking number or URL. | Proposed, to be agreed |
| `status` | `ShipmentStatus` | Carrier milestone status. | Proposed, to be agreed |
| `verified` | `Boolean` | True only when verified by courier webhook/API, not self-declared label print. | Proposed, to be agreed |
| `lastCourierEventId` | `String?` | Courier webhook event ID for deduplication. | Proposed, to be agreed |
| `dispatchedAt` | `UTC Date?` | Actual courier handover/dispatch timestamp. | Proposed, to be agreed |
| `deliveredAt` | `UTC Date?` | Actual delivery timestamp. | Proposed, to be agreed |
| `entityVersion` | `Integer` | Monotonic version counter for this shipment. | Proposed, to be agreed |

### Shipment Status Enumeration (`ShipmentStatus`)
- `NONE` / `LABEL_CREATED`: Label generated. **Never triggers dispatch notice**. *(Proposed, to be agreed)*
- `DISPATCHED`: Verified carrier physical pickup. Triggers dispatch notice. *(Proposed, to be agreed)*
- `IN_TRANSIT` / `OUT_FOR_DELIVERY`: Package moving through courier hubs. Does not re-trigger dispatch. *(Proposed, to be agreed)*
- `DELIVERED`: Verified delivery to customer. Supersedes unsent dispatch notices and triggers delivery confirmation. *(Proposed, to be agreed)*
- `FAILED` / `RETURNED`: Delivery failed or returned to boutique. Cancels unsent delivery notices with `SHIPMENT_FAILED`. *(Proposed, to be agreed)*

---

## 4. Domain Events

All domain events are POSTed to `/api/v1/internal/campaign-events`.

### 4.1 Event: `fulfilment.updated`
Emitted whenever an order's readiness, mode, or terminal status changes.

```json
{
  "schemaVersion": 1,
  "producer": "fulfilment",
  "eventId": "evt_ful_001",
  "tenantId": "shop_a",
  "type": "fulfilment.updated",
  "entityId": "ord_f_001",
  "entityVersion": 3,
  "occurredAt": "2026-10-30T09:00:00Z",
  "receivedAt": "2026-10-30T09:00:02Z",
  "customerId": "cus_001",
  "data": {
    "orderNumber": "ORD-F-001",
    "branchId": "branch_main",
    "mode": "PICKUP",
    "status": "READY_FOR_COLLECTION",
    "readinessKind": "FULL",
    "readinessVersion": 1,
    "readyAt": "2026-10-30T09:00:00Z"
  }
}
```
*(Proposed, to be agreed)*

### 4.2 Event: `shipment.updated`
Emitted on carrier courier tracking events.

```json
{
  "schemaVersion": 1,
  "producer": "fulfilment",
  "eventId": "evt_shp_001",
  "tenantId": "shop_a",
  "type": "shipment.updated",
  "entityId": "shp_f_001",
  "entityVersion": 2,
  "occurredAt": "2026-10-30T14:00:00Z",
  "receivedAt": "2026-10-30T14:00:02Z",
  "customerId": "cus_002",
  "data": {
    "orderId": "ord_f_002",
    "orderNumber": "ORD-F-002",
    "branchId": "branch_main",
    "carrier": "SAMPLE_COURIER",
    "carrierName": "Sample Courier",
    "trackingRef": "SC123456789",
    "status": "DISPATCHED",
    "verified": true,
    "courierEventId": "cr_evt_100",
    "dispatchedAt": "2026-10-30T14:00:00Z",
    "deliveredAt": null
  }
}
```
*(Proposed, to be agreed)*

---

## 5. State Transition & Cancellation Rules

| Upstream Change | Event Emitted | Engine Action on Pending Executions |
| :--- | :--- | :--- |
| Mark Ready (`FULL`, `version: 1`) | `fulfilment.updated` (`READY_FOR_COLLECTION`) | Enrolls `ready:orderId:1`, schedules Step 1 notice and Step 2 uncollected reminder. |
| Customer Collects Order | `fulfilment.updated` (`COLLECTED`) | Cancels pending reminder executions with `ORDER_COLLECTED`. Accepted executions untouched. |
| Order In Rework | `fulfilment.updated` (`REWORK`) | Cancels pending ready executions with `ORDER_IN_REWORK`. |
| Ready Again After Rework | `fulfilment.updated` (`READY_FOR_COLLECTION`, `version: 2`) | New occurrence `ready:orderId:2`. Step 1 re-scheduled. Same version replay ignored. |
| Mode Switched to DELIVERY | `fulfilment.updated` (`mode: 'DELIVERY'`) | Cancels unsent pickup steps with `DELIVERY_ARRANGED`. |
| Verified Dispatched | `shipment.updated` (`DISPATCHED`, `verified: true`) | Enrolls `dispatch:orderId:shipmentId`. |
| Verified Delivered | `shipment.updated` (`DELIVERED`, `verified: true`) | Enrolls `delivered:orderId:shipmentId`. Supersedes any pending dispatch notices with `STATUS_SUPERSEDED`. |
| Shipment Failed / Returned | `shipment.updated` (`FAILED` / `RETURNED`) | Cancels unsent delivery steps with `SHIPMENT_FAILED`. |
| Delayed Stale Ready Event | `fulfilment.updated` (older `entityVersion`) | Ignored with `STALE_ENTITY_VERSION`. Never overrides `COLLECTED` status. |
| Duplicate Courier Webhook | `shipment.updated` (same `courierEventId`) | Ignored with `DUPLICATE_COURIER_EVENT`. |

*(Proposed, to be agreed)*

---

## 6. Open Questions & Future Considerations

1. **Consent for Service Messages**: Service messages do not require marketing consent under WhatsApp policy, but does local privacy law require an explicit transactional opt-in? *(Proposed, to be agreed)*
2. **Multiple Shipments per Order**: Can an order be fulfilled in multiple parcels with different carriers? Current schema supports `shipments[]` array with distinct `shipmentId` occurrences (`dispatch:orderId:shipmentId`). *(Proposed, to be agreed)*
3. **Partial Deliveries**: If one parcel is delivered while another is in transit, should delivery confirmation wait for all shipments? Currently each verified delivery triggers independently. *(Proposed, to be agreed)*
4. **Branch-Level Readiness**: Are orders marked ready at the central warehouse or at the boutique pickup branch? The `branchId` field routes scope. *(Proposed, to be agreed)*
