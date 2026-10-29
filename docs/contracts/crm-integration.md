# CRM Integration Contract & Data Exchange Specification

> **Document Status**: Proposed, to be agreed between GroVastra Auto Campaigns and CRM Integration Team.  
> **Channel**: WhatsApp Cloud API (Meta Graph API pinned).

---

## 1. Overview & Architectural Boundaries

GroVastra Auto Campaigns is an automated WhatsApp campaign engine. It is **NOT** a CRM, order management, or inventory system. Customer identities, contact channels, and marketing consents originate from the store CRM and point-of-sale systems.

### Hard Rules
1. **Never merge identities**: Two customer records sharing the same phone number remain separate records. Contact caps and undeliverable status apply per destination, but customer identity records are never merged.
2. **Authoritative CRM data**: Auto Campaigns reads customer data and receives event hints (`customer.updated`, `preference.changed`). The engine always re-fetches authoritative state from the CRM/store source.
3. **Encrypted at rest**: Phone numbers are encrypted using AES-256-GCM. Plain phone numbers are never stored in log files, campaign enrollments, or analytics tables.

---

## 2. Customer & Destination Schema *(Proposed, to be agreed)*

When synchronizing customer records or emitting CRM events, the following fields are defined:

```typescript
interface CustomerPayload {
  customerId: string;               // Unique CRM customer ID (e.g. "cust_12345") [Required]
  firstName: string;                // Customer given name (for template greeting) [Required]
  branchId?: string;                // Home or primary branch ID [Optional]
  status: 'ACTIVE' | 'INACTIVE' | 'DELETED'; // Account status [Required]

  destination: {
    rawInput: string;               // Original input string (e.g. "+91 98765 43210") [Proposed]
    e164: string;                   // E.164 international format (e.g. "+919876543210") [Required]
    nationalDigits: string;         // 10 digits without country code [Required]
    verified: boolean;              // Verification flag [Required]
    verificationLevel:              // Minimum verification level [Required]
      | 'UNVERIFIED'                // 0: Unchecked/raw entry
      | 'FORMAT_VALID'              // 1: Syntactically valid via libphonenumber
      | 'CONFIRMED_BY_STAFF'        // 2: Read back to customer or double-entered
      | 'OTP_VERIFIED';             // 3: Verified via one-time SMS/WhatsApp code
    verifiedAt: string;             // ISO-8601 UTC timestamp of last verification [Required]
    verificationMethod:             // Verification audit trail [Required]
      | 'COUNTER_READBACK'          // Staff read back the digits to customer
      | 'DOUBLE_ENTRY'              // Staff entered the number twice at checkout
      | 'OTP'                       // Customer verified via one-time password
      | 'IMPORTED'                  // Historical data import
      | 'MOCK';                     // Test/sandbox seed
    version: number;                // Incrementing destination revision [Required]
  };

  consent: {
    marketingOptIn: boolean;        // Express marketing consent [Required]
    consentCapturedAt: string;      // ISO-8601 UTC timestamp [Required]
    consentSource:                  // Source of consent record [Required when opt-in is true]
      | 'COUNTER_FORM'              // Physical counter consent form
      | 'VERBAL_RECORDED'           // Verbal permission during checkout
      | 'QR'                        // Scanned store QR code
      | 'IMPORTED'                  // Historical CRM migration
      | 'MOCK';                     // Test seed
    channelSuppressed?: boolean;    // Global emergency suppression [Optional]
  };

  version: number;                  // Customer entity version for optimistic concurrency [Required]
}
```

---

## 3. Verification Levels & Gates *(Proposed, to be agreed)*

GroVastra enforces destination verification gates prior to enrolling a customer or dispatching WhatsApp messages:

| Verification Level | Rank | Pre-dispatch Qualification | Description |
|---|:---:|:---:|---|
| `UNVERIFIED` | 0 | ❌ Excluded (`DESTINATION_NOT_VERIFIED`) | Raw phone entered with no checks. Blocked from all automated campaigns. |
| `FORMAT_VALID` | 1 | ❌ Excluded (under default settings) | Syntactically conforms to country mobile rules, but unconfirmed by customer. |
| `CONFIRMED_BY_STAFF` | 2 | ✅ Allowed (Default Minimum) | Counter staff confirmed number via readback or double entry. Default minimum threshold. |
| `OTP_VERIFIED` | 3 | ✅ Allowed | Strongest verification; customer confirmed ownership via OTP code. |

*Tenant setting `minDestinationVerification` defaults to `CONFIRMED_BY_STAFF`.*

---

## 4. CRM Event Specifications *(Proposed, to be agreed)*

Events are submitted to GroVastra via `POST /api/v1/internal/campaign-events`:

### 4.1. Phone Correction (`customer.updated` with `DESTINATION_CHANGED`)
When a staff member or customer corrects a wrong or outdated phone number:
- **Event Type**: `customer.updated`
- **Data Payload**:
  ```json
  {
    "customerId": "cust_12345",
    "updateType": "DESTINATION_CHANGED",
    "destinationVersion": 2
  }
  ```
- **Privacy Rule**: The new phone number is **NEVER** transmitted in the event payload. The event consumer re-fetches the authoritative customer record via the customer adapter.
- **Engine Behavior**:
  1. Unsent scheduled/deferred executions are updated to use the new destination.
  2. Any execution with an already-frozen delivery intent is blocked as stale (`BLOCKED_STALE_INTENT`). The message is **never** silently rerouted to an intent frozen for another number.
  3. The previous phone's destination hash stays marked `UNDELIVERABLE` if it previously failed.

### 4.2. Preference Change (`preference.changed`)
When a customer revokes marketing consent:
- **Event Type**: `preference.changed`
- **Data Payload**:
  ```json
  {
    "customerId": "cust_12345",
    "changeType": "MARKETING_OPT_OUT",
    "marketingOptIn": false
  }
  ```
- **Engine Behavior**:
  1. All unsent promotional executions are immediately cancelled with reason `MARKETING_OPT_OUT`.
  2. Future opt-ins never resurrect previously cancelled campaign steps.

---

## 5. Counter & POS Best Practices *(Proposed, to be agreed)*

For retail staff at billing counters:
1. **Read Back the Number**: Staff must read back the 10 mobile digits to the customer before saving (`COUNTER_READBACK`).
2. **Double-Entry Safeguard**: Where UI allows, require double-entry confirmation (`DOUBLE_ENTRY`).
3. **Capture Consent Source**: Always record whether consent was verbal or written.
4. **Attach Customer to Bills**: Anonymous bills cannot receive Welcome messages (`NO_CUSTOMER_IDENTITY`). If the customer identity is attached later before dispatch lateness expires, the Welcome campaign evaluates automatically.
5. **Never Reuse Failed Numbers**: If a number is reported as not on WhatsApp or wrong number, do not reuse it for other members.

---

## 6. Destination Health & Clearing Rules *(Proposed, to be agreed)*

When Meta returns webhook status `failed` with code `131026` ("Message Undeliverable" / not on WhatsApp):
1. **Health Set to UNDELIVERABLE**: The destination hash is permanently flagged as `UNDELIVERABLE`.
2. **Cascade Cancellation**: All pending, unsent campaign steps across all campaigns for that destination are cancelled with `DESTINATION_UNDELIVERABLE`.
3. **No Automatic Resend**: Failed sends are never automatically retried.
4. **Health Clearing Mechanism**:
   - If the customer provides a **different** phone number, the new destination hash is used; the old hash remains `UNDELIVERABLE`.
   - If the **same** number is re-verified, health is cleared **only if** `destination.verifiedAt` is strictly later than `health.lastFailureAt`.

---

## 7. Open Questions for CRM & POS Team Alignment *(Proposed, to be agreed)*

1. **OTP Verification at Billing Counter**: Is an SMS/WhatsApp OTP flow acceptable during peak retail counter checkout, or does counter readback remain the primary standard?
2. **WhatsApp Pre-check**: Meta does not offer a free offline "is this on WhatsApp" lookup API. Numbers are discovered to lack WhatsApp only at first dispatch attempt. Should POS warn staff about landlines or VoIP numbers?
3. **One Number per Customer**: Should the POS allow multiple family members to share a single phone number? *(GroVastra supports shared numbers without merging identities; daily/weekly contact caps apply across all accounts sharing the number).*
4. **Customer Deletion & GDPR/DPDP Right-to-be-Forgotten**: When a customer record is deleted in the CRM, should the CRM emit `customer.deleted` to purge cached facts and suppress any remaining campaign steps?
