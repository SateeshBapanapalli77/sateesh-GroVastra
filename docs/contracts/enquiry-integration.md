# Enquiry & Product Integration Contract & Data Exchange Specification

> **Document Status**: Proposed, to be agreed between GroVastra Auto Campaigns and Boutique Enquiry/POS System Owner.  
> **Channel**: Meta WhatsApp Cloud API (Graph API v25.0 pinned).  
> **Feature**: F23 Unresolved Enquiry Automated Campaign (`unresolved_enquiry`).  

---

## 1. Overview & Architectural Boundaries *(Proposed, to be agreed)*

GroVastra Auto Campaigns provides automated WhatsApp follow-up sequences for boutique, handloom, and apparel retailers.
For preset **Unresolved Enquiry**, the engine follows up with customers who visited the store, made an enquiry about clothing or sarees, and left without purchasing.

Auto Campaigns is **strictly read-only** regarding customer enquiries, product catalogues, and inventory:
1. **Production Code is Read-Only on Enquiries & Products**: Auto Campaigns **never** creates, updates, deletes, or reserves enquiries or inventory. All enquiries originate in an external enquiry or POS system, read through `EnquirySource` and `ProductSource` adapters. Production code writes to `src_enquiries` and `src_products` are strictly prohibited and verified by AST boundary tests.
2. **Authoritative Activity Clock**: `lastCustomerInteractionAt` is the **only** clock that represents customer engagement. Staff record edits (notes, tags, formatting) change `updatedAt` and `entityVersion` but **must never** modify `lastCustomerInteractionAt`.
3. **No Phantom Reservations (Spec p13)**: Handloom and bridal sarees often comprise unique one-of-a-kind pieces. Sending a follow-up WhatsApp message **never** reserves an item or decrements inventory. Template copy and variable values must never claim, imply, or promise a reservation (prohibited phrases: "reserved", "reserve", "held for you", "kept aside", "on hold for you", "guarantee").
4. **Purpose = MARKETING**: Follow-up messages are commercial nudges. Mandatory marketing gates apply at all times: active customer record, valid phone destination, opt-in consent (`marketingOptIn = true`), no channel suppression, and rolling contact frequency caps.
5. **Observational, Not Sales Attribution (Spec p28)**: While completed orders matching an enquired item stop the follow-up sequence, reporting is strictly observational. Auto Campaigns never claims a WhatsApp message caused an in-store sale.

---

## 2. Source Enquiry Model (`src_enquiries`) *(Proposed, to be agreed)*

```typescript
export type EnquiryChannel = 'IN_STORE' | 'PHONE' | 'WHATSAPP' | 'OTHER';

export type EnquiryStatus = 'OPEN' | 'RESOLVED' | 'CLOSED' | 'CANCELLED' | 'DELETED';

export interface SourceEnquiryItemRef {
  productId: string;                // Authoritative product identifier [Required]
  variantId?: string | null;        // Specific color/size variant or null for general product [Optional]
}

export interface SourceEnquiry {
  enquiryId: string;                 // Stable unique identifier (e.g. "enq_20261026_01") [Required]
  tenantId: string;                  // Tenant identifier [Required]
  customerId: string | null;         // Owning customer ID in store CRM (null if anonymous) [Nullable]
  branchId: string | null;           // Store location/branch identifier [Nullable]
  channel: EnquiryChannel;           // "IN_STORE" | "PHONE" | "WHATSAPP" | "OTHER" [Required]
  status: EnquiryStatus;             // "OPEN" | "RESOLVED" | "CLOSED" | "CANCELLED" | "DELETED" [Required]
  staffTakeover: boolean;            // True when a sales associate is actively handling the customer [Required]
  itemRef: SourceEnquiryItemRef | null; // Enquired item reference or null if general inquiry [Nullable]
  createdAt: Date;                   // Creation instant (UTC Date) [Required]
  lastCustomerInteractionAt: Date;   // The ONLY customer activity clock [Required]
  updatedAt: Date;                   // Staff/system edit timestamp [Required]
  entityVersion: number;             // Monotonically increasing version counter (1, 2, 3...) [Required]
  source: 'MOCK' | 'EXTERNAL_API';   // Integration adapter source tag [Required]
}
```

### Key Field Semantics
- `enquiryId`: Globally stable key for the lifetime of the inquiry. Even if resolved and re-opened, `enquiryId` does not change.
- `lastCustomerInteractionAt`: Updated **only** when the customer visits, speaks, calls, or texts. A newer interaction before scheduled nudges triggers an automatic atomic replan from the new anchor. An interaction after an accepted nudge sets a `CUSTOMER_INTERACTION` hold.
- `staffTakeover`: When `true`, indicates a boutique associate took over personal communication. Placing an enquiry into takeover puts the campaign enrollment on hold with reason `STAFF_TAKEOVER`. Setting it back to `false` does **not** automatically lift the hold; an explicit staff resolution via `POST /enrollments/:id/resolve-hold` is required.
- `status`:
  - `OPEN`: Eligible for campaign follow-up sequence.
  - `RESOLVED`: In-store staff marked the inquiry complete; cancels unsent executions with reason `ENQUIRY_RESOLVED`.
  - `CLOSED`: Inquiry expired or abandoned; cancels unsent executions with `ENQUIRY_CLOSED`.
  - `CANCELLED`: Customer explicitly declined interest; cancels unsent executions with `ENQUIRY_CANCELLED`.
  - `DELETED`: Inquiry deleted in source system; cancels unsent executions with `ENQUIRY_DELETED`.

---

## 3. ProductSource & Inventory Contract *(Proposed, to be agreed)*

The `ProductSource` adapter is minimal, read-only, and shared with future stock campaigns:

```typescript
export type ProductStatus = 'ACTIVE' | 'DISCONTINUED';

export interface ProductVariant {
  variantId: string;                // Variant identifier (e.g. "var_red_m") [Required]
  label: string;                    // Human-readable variant label (e.g. "Crimson Red / Free Size") [Required]
  sellableQty: number;              // Available physical quantity on shop floor (integer >= 0) [Required]
  version: number;                  // Monotonic version counter [Required]
}

export interface SourceProduct {
  productId: string;                // Authoritative product identifier [Required]
  tenantId: string;                 // Tenant identifier [Required]
  name: string;                     // Product display name (e.g. "Kanchipuram Silk Saree") [Required]
  status: ProductStatus;            // "ACTIVE" | "DISCONTINUED" [Required]
  entityVersion: number;            // Monotonic version counter [Required]
  variants: ProductVariant[];       // List of variants [Required]
}
```

### Sellable Definition *(Spec p13)*
- An item is **sellable** if and only if `product.status === 'ACTIVE'` and:
  - If `itemRef.variantId` is specified: `variant.sellableQty > 0`.
  - If `itemRef.variantId` is null: at least one variant in `product.variants` has `sellableQty > 0`.
- **Dispatch Check**: At execution time, the worker verifies sellability. If not sellable, the step is skipped with reason `ITEM_UNAVAILABLE`. The occurrence is kept; later steps recheck availability at their scheduled times.
- **Pre-submission Guard**: Immediately before final Meta submission CAS, availability is rechecked. If inventory reached 0 between planning and dispatch, submission aborts with 0 WhatsApp provider calls.

---

## 4. Domain Events Specification *(Proposed, to be agreed)*

Enquiry events are sent to `POST /api/v1/internal/campaign-events`:

### 4.1 `enquiry.saved`
Emitted on enquiry creation, subsequent customer interactions, staff record edits, or takeover toggle.

```json
{
  "schemaVersion": 1,
  "producer": "enquiries",
  "eventId": "evt_enq_20261026_01",
  "tenantId": "shop_a",
  "type": "enquiry.saved",
  "entityId": "enq_1001",
  "entityVersion": 1,
  "customerId": "cust_456",
  "occurredAt": "2026-10-26T10:00:00.000Z",
  "data": {
    "enquiryId": "enq_1001",
    "status": "OPEN",
    "staffTakeover": false,
    "channel": "IN_STORE",
    "itemRef": {
      "productId": "prod_saree_01",
      "variantId": "var_red"
    },
    "createdAt": "2026-10-26T10:00:00.000Z",
    "lastCustomerInteractionAt": "2026-10-26T10:00:00.000Z"
  }
}
```

### 4.2 `enquiry.resolved`
Emitted when staff marks an inquiry as resolved, closed, or cancelled.

```json
{
  "schemaVersion": 1,
  "producer": "enquiries",
  "eventId": "evt_enq_20261026_02",
  "tenantId": "shop_a",
  "type": "enquiry.resolved",
  "entityId": "enq_1001",
  "entityVersion": 2,
  "customerId": "cust_456",
  "occurredAt": "2026-10-26T14:30:00.000Z",
  "data": {
    "enquiryId": "enq_1001",
    "status": "RESOLVED",
    "resolvedAt": "2026-10-26T14:30:00.000Z"
  }
}
```

### 4.3 `enquiry.deleted`
Emitted when an inquiry record is deleted in the external POS.

```json
{
  "schemaVersion": 1,
  "producer": "enquiries",
  "eventId": "evt_enq_20261026_03",
  "tenantId": "shop_a",
  "type": "enquiry.deleted",
  "entityId": "enq_1001",
  "entityVersion": 3,
  "customerId": "cust_456",
  "occurredAt": "2026-10-26T15:00:00.000Z",
  "data": {
    "enquiryId": "enq_1001",
    "deletedAt": "2026-10-26T15:00:00.000Z"
  }
}
```

---

## 5. Orders Referencing Enquiries & Items *(Proposed, to be agreed)*

When a customer completes a purchase in-store:
1. `order.enquiryRef`: May explicitly tag the inquiry (`"enquiry:enq_1001"`). An order with this tag immediately satisfies the goal for that occurrence.
2. `order.lines`: Each line contains `productId` and optional `variantId`. In default goal mode (`ITEM_OR_TAGGED`), any qualifying order completed after `enquiry.createdAt` containing the enquired item is verified by re-fetching through `OrderSource` and marks the goal reached (`ENQUIRY_PURCHASE`).

---

## 6. Open Questions for POS/Enquiry System Owner *(Proposed, to be agreed)*

1. **Multiple Items per Enquiry**: Current contract models one primary `itemRef: { productId, variantId }`. Does the POS support customers enquiring about multiple independent items in a single session?
   - *Proposal*: Support primary `itemRef` for messaging; additional items stored in metadata for goal matching.
2. **Inbound WhatsApp Inquiries**: When an enquiry arrives via WhatsApp rather than in-store, how should the interaction clock be initialized?
   - *Proposal*: Inbound WhatsApp message initializes `lastCustomerInteractionAt` and sets channel to `WHATSAPP`.
3. **Marketing Consent at Counter**: If an in-store customer volunteers their phone number during an enquiry without a formal CRM registration, does the store capture explicit marketing permission at that moment?
   - *Proposal*: Customer must have verified destination and `marketingOptIn = true` in CRM before automated marketing nudges can dispatch. Anonymous enquiries count as `NO_CUSTOMER_RECORD` and are skipped.
