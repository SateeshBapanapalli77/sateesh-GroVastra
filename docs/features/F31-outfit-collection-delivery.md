# F31: Outfit Collection / Delivery Campaign

## Overview & Architecture

Feature F31 implements the **Outfit Collection / Delivery** (`outfit_collection_delivery`) campaign preset family per the GroVastra Auto Campaigns Developer Handoff v2.0 (Spec p5, p15, p18, p20, p24, p28, p30–33).

- **Catalog Preset Key:** `outfit_collection_delivery`
- **Aliases:** `OUTFIT_COLLECTION_DELIVERY`, `outfit_fulfilment`, `fulfilment_milestone`, `outfit_collection`
- **Category & Purpose:** `SERVICE` (order service sequence, Meta `UTILITY` templates only, no promotional wording/offers, caps not consumed, service spacing default 24h)
- **Priority:** 60 (Precedence ranking: `DELIVERED` > `DISPATCHED` > `OUTFIT_READY`)
- **Trigger Family:** `PRODUCTION_MILESTONE`
- **Trigger Type:** `FULFILMENT_MILESTONE`

---

## Supported Milestones & Occurrence IDs

The engine orchestrates three distinct operational milestones:

1. **`OUTFIT_READY`**:
   - Occurrence format: `ready:${orderId}:${readinessVersion}`
   - Triggers when an order reaches `READY` status.
   - Dispatches Step 1 Ready Notice (`tpl_fulfil_ready` or `tpl_fulfil_ready_partial`).
   - Reminders (`tpl_fulfil_reminder`) follow up at configured days (default 3 days) if the order remains uncollected.
   - Spacing: 24h default service spacing between uncollected reminders.
   - Staleness / Expiry: Useful window (1–60 days, default 14).

2. **`DISPATCHED`**:
   - Occurrence format: `dispatch:${orderId}:${shipmentId}`
   - Triggers when a courier shipment is verified as `DISPATCHED` / in-transit.
   - Dispatches Dispatch Notice (`tpl_fulfil_dispatched` or `tpl_fulfil_dispatched_simple`).
   - Single-step constraint strictly enforced.

3. **`DELIVERED`**:
   - Occurrence format: `delivered:${orderId}:${shipmentId}`
   - Triggers when a shipment is marked `DELIVERED`.
   - Dispatches Delivery Notice (`tpl_fulfil_delivered`).
   - Single-step constraint strictly enforced.

---

## Critical Hard Rules & Guardrails

1. **Read-Only Ingestion Boundary:**
   - Production code **never** writes to `src_fulfilments` or `src_orders`.
   - All access is mediated through the read-only `FulfilmentSource` interface.
2. **Readiness Version Integrity:**
   - The engine **never** computes or increments `readinessVersion`. It only stores and compares authoritative source versions.
3. **Delivery Arranged Rule:**
   - *"If delivery is arranged, do not send pickup instructions."*
   - If an order is marked `DELIVERY` or has active shipping arranged, pickup instructions are blocked with `DELIVERY_ARRANGED`.
4. **Verified Shipment Dispatch Rule:**
   - *"Label creation alone is not dispatch."*
   - Unverified shipment labels (e.g. `LABEL_CREATED` without courier movement) do not trigger dispatch notifications (`UNVERIFIED_SHIPMENT_EVENT`).
5. **Frozen Dispatch Intent Staleness Check:**
   - Prior to message submission, the engine verifies that the customer's phone destination and the order's `readinessVersion` match the frozen enrollment intent. If changed, the execution is blocked with `BLOCKED_STALE_INTENT`.
6. **Pre-Submission Lifecycle Status Recheck:**
   - If an order is collected (`COLLECTED`), cancelled (`CANCELLED`), returned (`RETURNED`), or reworked (`REWORK`) prior to step dispatch, remaining uncollected reminders are immediately skipped (`ORDER_COLLECTED`, `ORDER_DELIVERED`, `STATUS_SUPERSEDED`, `ORDER_CANCELLED`, `ORDER_REWORK`).
7. **Service Purpose & Meta UTILITY Compliance:**
   - Service campaigns never consume marketing contact caps (`campaignContactGates`).
   - Templates are strictly restricted to Meta `UTILITY` category; promotional wording and offers are prohibited.
   - Quiet hours apply: messages scheduled outside 10:00–19:00 defer to next morning at 10:00.

---

## Variable Bindings & Late Resolution

The following variables are bound and resolved late from authoritative fulfilment data at dispatch:

| Variable Source | Description | Fallback Literal Allowed? |
|-----------------|-------------|---------------------------|
| `customer.firstName` | Recipient customer first name | Yes (e.g. "Valued Customer") |
| `order.number` | Authoritative order/bill number | No (Resolved directly from source) |
| `shipment.carrierName` | Courier name (e.g. Blue Dart, Delhivery) | No (Resolved directly from source) |
| `shipment.trackingRef` | Airway bill / tracking number | No (Resolved directly from source) |
| `shop.displayName` | Tenant business display name | No |

---

## API Endpoints

- `GET /campaigns/outfit-collection-delivery/fulfilments`: Bounded list of order fulfilments with masked phone numbers.
- `POST /campaigns/outfit-collection-delivery/preview`: Candidate dry-run evaluator with zero writes or provider calls.
- `POST /campaigns/outfit-collection-delivery/reconcile`: Trigger manual reconciliation scanning.
- `POST /campaigns/outfit-collection-delivery/events/fulfilment`: Ingest OMS webhook event (`fulfilment.updated`).
- `POST /campaigns/outfit-collection-delivery/events/shipment`: Ingest courier webhook event (`shipment.updated`).

---

## Seeding & CLI Commands

```powershell
# Seed the full outfit-fulfilment scenario (14 customers, 16 fulfilments, 4 campaigns)
pnpm seed:scenario outfit-fulfilment

# Run offline checkpointed reconciler
pnpm --filter @grovastra/api reconcile:fulfilment

# Run automated test matrix (37 tests)
pnpm --filter @grovastra/api test tests/outfit-collection-delivery.test.ts
```

---

## Test Matrix (OD00 – OD36)

All 37 test cases are fully verified and passing in `apps/api/tests/outfit-collection-delivery.test.ts`:
- **OD00:** Meta-test verifying all 36 test titles match `docs/test-matrix/OD.txt` verbatim.
- **OD01 – OD06:** In-store pickup happy path, reminder sequencing, 24h spacing, cancellation on collection.
- **OD07 – OD11:** Courier dispatch verification, label creation vs actual dispatch, in-transit tracking, delivery confirmation.
- **OD12 – OD16:** Delivery arranged pickup blocking, partial readiness filtering, split shipment deduping, carrier suppression.
- **OD17 – OD22:** Late binding resolution, pre-submission status checks, duplicate courier events.
- **OD23 – OD28:** Frozen intent staleness verification, customer destination changes, quiet hours deferrals, expiry.
- **OD29 – OD32:** Checkpointed reconciler, bounded batch scanning, error recovery, idempotent retries.
- **OD33 – OD36:** Web preview endpoint, campaign validation rules, Meta UTILITY enforcement, multi-tenancy isolation.
