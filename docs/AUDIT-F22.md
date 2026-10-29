# F22 Gap Check & Architectural Audit: Preset "Gift / Wedding Reminder"

> **Audit Type**: Read-Only Specification & Test Coverage Gap Analysis  
> **Target Feature**: F22 — Preset "Gift / wedding reminder" (`CUSTOMER_EVENT_DATE` Trigger, Occasion Kinds `GIFT` & `WEDDING`)  
> **Source Documents**: GroVastra Auto Campaigns Developer Handoff v2.0 (PDF), `docs/PROJECT_CONTEXT.md`, `docs/contracts/occasion-integration.md`, `docs/samples/event-occasion-*.json`, `docs/QA_MATRIX_COVERAGE.md`  
> **Target Output**: `/docs/AUDIT-F22.md` only (Zero modifications to code, seeds, tests, or existing documentation)

---

## 1. G01–G36 Requirements Traceability & Coverage Matrix

The table below maps each of the **G01–G36 prompt requirements** against the automated test suite.

> [!CRITICAL]
> **Key Finding on Test Suite Renumbering**:  
> The previous implementation in `apps/api/tests/gift-wedding-reminder.test.ts` did **not** follow the original prompt's G01–G36 requirement definitions. Instead, it generated a custom, locally renumbered list of 36 tests. Consequently, several critical core engine scenarios (such as **G02 event replay x5**, **G07 due time shifted by blackout past latestUsefulAt**, **G13 racing replan vs final worker submission**, **G26 concurrent planner evaluation**, **G27 reconciler recovery**, **G28 DST zone evaluation**, and **G31 stubbed-HTTP request bodies**) were either omitted or only covered generically in other test suites, while **G32** correctly implements the static AST read-only guard.

| Req ID | Original Prompt Requirement | Test File | Test Name / Verification Status | Status |
| :--- | :--- | :--- | :--- | :--- |
| **G01** | Preset registry entry & aliasing (`gift_wedding_reminder` / `gift_wedding`, priority 70) | `apps/api/tests/gift-wedding-reminder.test.ts` | `G01: Preset Registry registers gift_wedding_reminder and alias gift_wedding` | **COVERED** |
| **G02** | **Event replay x5** (Spec B02: Idempotent inbox deduplicates 5x replayed occasion domain events) | *None* | **MISSING** in `gift-wedding-reminder.test.ts`. *(Generic replay tested in `tests/events-and-consumer.test.ts`, but 5x replay for `occasion.saved` (create and date change), `occasion.cancelled`, and `occasion.completed` is absent)* | **MISSING** |
| **G03** | Trigger validation: `occasionKind` must be `GIFT` or `WEDDING` | `apps/api/tests/gift-wedding-reminder.test.ts` | `G02: Trigger validation enforces occasionKind is either GIFT or WEDDING` *(renumbered as local G02)* | **COVERED** |
| **G04** | Lead days validation (`fulfillmentLeadDays` between 0 and 180 integer) | `apps/api/tests/gift-wedding-reminder.test.ts` | `G03: Validation of fulfillmentLeadDays allows 0-180 and rejects invalid values` *(renumbered as local G03)* | **COVERED** |
| **G05** | Store `bookingLinkUrl` required on activation when step uses `shop.bookingLink` | `apps/api/tests/gift-wedding-reminder.test.ts` | `G04: Activation requires valid store bookingLinkUrl when step uses shop.bookingLink` *(renumbered as local G04)* | **COVERED** |
| **G06** | Anti-pattern warning: Template copy/literal claiming appointment is already booked | `apps/api/tests/gift-wedding-reminder.test.ts` | `G05: Anti-pattern warning when template copy or literals claim appointment is already booked` *(renumbered as local G05)* | **COVERED** |
| **G07** | **Due time shifted by hours/blackout that would pass `latestUsefulAt` is SKIPPED** (Spec B08) | *None* | **MISSING** in `gift-wedding-reminder.test.ts`. *(Local G07 tested gift discovery; local G14/G15 test static lead-time skip, but shifting due time via blackout/outside-hours past `latestUsefulAt` is absent)* | **MISSING** |
| **G08** | Candidate discovery for WEDDING queries `src_customerEvents` | `apps/api/tests/gift-wedding-reminder.test.ts` | `G06: Candidate discovery for WEDDING queries src_customerEvents for WEDDING kind` *(renumbered as local G06)* | **COVERED** |
| **G09** | Candidate discovery for GIFT queries `src_customerEvents` | `apps/api/tests/gift-wedding-reminder.test.ts` | `G07: Candidate discovery for GIFT queries src_customerEvents for GIFT kind` *(renumbered as local G07)* | **COVERED** |
| **G10** | Customer declared gate (`declaredByCustomer: false` excluded from discovery) | `apps/api/tests/gift-wedding-reminder.test.ts` | `G08: Unverified customer occasions (declaredByCustomer: false) are excluded from discovery` *(renumbered as local G08)* | **COVERED** |
| **G11** | Active status gate (`CANCELLED`, `COMPLETED`, `PAST` excluded from discovery) | `apps/api/tests/gift-wedding-reminder.test.ts` | `G09: Inactive occasions (status CANCELLED, COMPLETED, PAST) are excluded from discovery` *(renumbered as local G09)* | **COVERED** |
| **G12** | Audience rule evaluation on occasion `budgetPaise` and `categories` | `apps/api/tests/gift-wedding-reminder.test.ts` | `G10: Audience rule evaluation filters candidates on occasion budget and categories` *(renumbered as local G10)* | **COVERED** |
| **G13** | **Racing replan vs final worker submission** (Spec B20: atomic CAS rejects stale worker claim when postponement bumps `planRevision`) | *None* | **MISSING** in `gift-wedding-reminder.test.ts`. *(Local G13 tested GIFT steps; local G20 tested frozen intent marking, but the concurrent CAS race where worker holds lease with v1 while replan bumps v2 is absent)* | **MISSING** |
| **G14** | Idempotent enrollment creation (`wedding:{eventId}` and `gift:{eventId}`) | `apps/api/tests/gift-wedding-reminder.test.ts` | `G11: Idempotent enrollment creation creates occurrence key wedding:{eventId} or gift:{eventId}` *(renumbered as local G11)* | **COVERED** |
| **G15** | Default steps scheduling (WEDDING: D-45, D-21 with `PREVIOUS_ACCEPTED`; GIFT: D-10, D-3) | `apps/api/tests/gift-wedding-reminder.test.ts` | `G12: WEDDING default steps schedule D-45 and D-21 correctly` & `G13: GIFT default steps schedule D-10 and D-3 relative to event date` | **COVERED** |
| **G16** | `latestUsefulAt` computation (`eventDate - fulfillmentLeadDays` at end of allowed hours) | `apps/api/tests/gift-wedding-reminder.test.ts` | `G14: Lead time deadline latestUsefulAt computed as eventDate - fulfillmentLeadDays` *(renumbered as local G14)* | **COVERED** |
| **G17** | Short lead time steps SKIPPED with `INSUFFICIENT_LEAD_TIME` and owner-facing reason | `apps/api/tests/gift-wedding-reminder.test.ts` | `G15: Short lead time steps are SKIPPED with INSUFFICIENT_LEAD_TIME and owner-facing reason` *(renumbered as local G15)* | **COVERED** |
| **G18** | Date change via `occasion.saved` revises existing occurrence in place without duplication | `apps/api/tests/gift-wedding-reminder.test.ts` | `G16: Date change via occasion.saved revises existing occurrence without duplicate enrollments` *(renumbered as local G16)* | **COVERED** |
| **G19** | Atomic plan revision bump (`planRevision` incremented v1 -> v2 on date change) | `apps/api/tests/gift-wedding-reminder.test.ts` | `G17: planRevision is bumped atomically on date change` *(renumbered as local G17)* | **COVERED** |
| **G20** | Unsubmitted executions (`deliveryIntentId: null`) recomputed to new dates | `apps/api/tests/gift-wedding-reminder.test.ts` | `G18: Unsubmitted executions (deliveryIntentId: null) recomputed to new dates` *(renumbered as local G18)* | **COVERED** |
| **G21** | Reschedule appends entry to `dateHistory` audit trail | `apps/api/tests/gift-wedding-reminder.test.ts` | `G19: Reschedule appends entry to dateHistory audit trail` *(renumbered as local G19)* | **COVERED** |
| **G22** | In-flight worker claim with `deliveryIntentId !== null` marked `BLOCKED_STALE_INTENT` | `apps/api/tests/gift-wedding-reminder.test.ts` | `G20: In-flight worker claim with deliveryIntentId !== null is marked BLOCKED_STALE_INTENT` *(renumbered as local G20)* | **COVERED** |
| **G23** | `occasion.cancelled` cancels pending executions with `OCCASION_CANCELLED` | `apps/api/tests/gift-wedding-reminder.test.ts` | `G21: occasion.cancelled cancels pending executions with OCCASION_CANCELLED` *(renumbered as local G21)* | **COVERED** |
| **G24** | `occasion.deleted` cancels pending executions with `OCCASION_DELETED` | `apps/api/tests/gift-wedding-reminder.test.ts` | `G22: occasion.deleted cancels pending executions with OCCASION_DELETED` *(renumbered as local G22)* | **COVERED** |
| **G25** | `occasion.completed` cancels pending executions with `OCCASION_COMPLETED` and emits goal | `apps/api/tests/gift-wedding-reminder.test.ts` | `G23: occasion.completed cancels pending executions with OCCASION_COMPLETED` & `G24: Goal event recorded...` | **COVERED** |
| **G26** | **Planner horizon, idempotent & restart-safe, two planners one enrollment** (Spec B01) | *None* | **MISSING** in `gift-wedding-reminder.test.ts`. *(Local G26 tested WEDDING goal order; concurrent dual-planner evaluation for occasions is absent)* | **MISSING** |
| **G27** | **Reconciler catches a missed event** (Nightly sweep discovers un-enrolled occasion in source) | *None* | **MISSING** in `gift-wedding-reminder.test.ts`. *(Local G27 tested GIFT goal order; reconciliation sweep catching dropped occasion event is absent)* | **MISSING** |
| **G28** | **DST zone evaluation** (Spec B07: Missing/repeated local hour deterministic handling) | *None* | **MISSING** in `gift-wedding-reminder.test.ts`. *(Local G28 tested untagged order; DST boundary transitions for occasion lead-times are absent)* | **MISSING** |
| **G29** | Goal attribution (WEDDING): Tagged `order.completed` with `occasionRef` stops sequence | `apps/api/tests/gift-wedding-reminder.test.ts` | `G26: order.completed with occasionRef wedding:{eventId} satisfies goal and stops steps` *(renumbered as local G26)* | **COVERED** |
| **G30** | Goal attribution (GIFT): Tagged `order.completed` with `occasionRef` stops sequence | `apps/api/tests/gift-wedding-reminder.test.ts` | `G27: order.completed with occasionRef gift:{eventId} satisfies goal and stops steps` *(renumbered as local G27)* | **COVERED** |
| **G31** | **Stubbed-HTTP request bodies** (Validates Meta Graph API JSON payload matches sample contracts) | *None* | **MISSING** in `gift-wedding-reminder.test.ts`. *(Local G31 tested in-memory parameter resolution string helper; asserting the outbound HTTP payload against `meta-send-request-bodies.json` is absent)* | **MISSING** |
| **G32** | **Production never writes `src_customerEvents`** (AST static scan read-only guard) | `apps/api/tests/gift-wedding-reminder.test.ts` | `G32: Static code scan: production code NEVER writes to src_customerEvents collection` *(line 1239)* | **COVERED** |
| **G33** | Untagged orders (`occasionRef: null`) or mismatched tags do not affect occasion campaign | `apps/api/tests/gift-wedding-reminder.test.ts` | `G28: Untagged orders...` & `G29: Mismatched occasion reference...` *(renumbered as local G28 & G29)* | **COVERED** |
| **G34** | Privacy & Security: phone encrypted in DB, masked in APIs/logs, no partner contacts inferred | `apps/api/tests/gift-wedding-reminder.test.ts` | `G33: Privacy & Security: phone numbers encrypted in DB, masked in logs and APIs` *(renumbered as local G33)* | **COVERED** |
| **G35** | Observational metrics endpoint `GET /campaigns/:id/occasion-reminders/summary` | `apps/api/tests/gift-wedding-reminder.test.ts` | `G34: Summary endpoint GET /campaigns/:id/occasion-reminders/summary returns accurate counts` *(renumbered as local G34)* | **COVERED** |
| **G36** | Tenant-scoped Occasions API (`GET /occasions`) and seed scenario idempotency | `apps/api/tests/gift-wedding-reminder.test.ts` | `G35: Occasions API GET /occasions...` & `G36: Seed scenario gift-wedding executes idempotently...` | **COVERED** |

---

## 2. Event Ingestion, Postponement Handling & Contract Mismatch Audit

### 2.1 Postponement Event Ingestion by `EventConsumerService`

1. **Accepted Event Types**:
   - In `apps/api/src/services/event-consumer/event-consumer.service.ts` (lines 75–85, 177–181), the authorized event types for `crm` and `occasions` producers are strictly whitelisted to:
     - `occasion.saved`
     - `occasion.cancelled`
     - `occasion.deleted`
     - `occasion.completed`
   - **Postponement Handling**: The consumer accepts postponements **strictly via `occasion.saved`**.
   - If an external CRM emits an unwhitelisted event type, the event consumer will **REJECT** the event with `UNSUPPORTED_EVENT_TYPE` and quarantine it in `campaignEventInbox`. Postponement is strictly handled via `occasion.saved` with a new event date.

2. **Date Change Evaluation in `occasion.saved`**:
   - `occasion.saved` with a changed date is fully handled:
     - The consumer inspects existing enrollments (`wedding:{eventId}` or `gift:{eventId}`).
     - Compares `oldDate = enr.eventDateSnapshot || enr.occasionLocalDate` with `newDate = occasion.eventDateKey`.
     - When `oldDate !== newDate`:
       - Updates the existing occurrence **in place** (zero duplicate enrollments).
       - Atomically bumps `enr.planRevision` ($v_1 \to v_2$).
       - Appends an audit record to `enr.dateHistory: [{ at, oldDate, newDate, oldVersion, newVersion }]`.
       - Recalculates unsubmitted steps (`deliveryIntentId: null`) with new local and UTC instants.
       - Evaluates in-flight claims (`deliveryIntentId !== null`): if an execution was claimed by a worker, marks the delivery intent `BLOCKED` with `BLOCKED_STALE_INTENT` and the execution state as `BLOCKED`.

---

### 2.2 Detailed Mismatch List: Implementation vs Contract vs Samples

Comparing `apps/api/src/services/event-consumer/event-consumer.service.ts`, `docs/contracts/occasion-integration.md`, and sample payloads in `docs/samples/event-occasion-*.json`:

```
====================================================================================================
CONTRACT MISMATCH MATRIX (F22 OCCASIONS)
====================================================================================================
#   Dimension             Contract Specification           Sample JSON Files                Actual Consumer Implementation
--  --------------------  -------------------------------  -------------------------------  ----------------------------------
1   Postponement Event    occasion.saved (with updateType: occasion.saved (in event-        Whitelists ONLY occasion.saved.
    Type Name             "POSTPONED")                     occasion-saved-wedding-          Postponement is strictly
                                                           postponed.json)                  occasion.saved with new date.

2   Date Representation   Dual fields:                     Single string field:             Reads occasion.eventDateKey from
    in `data`             data.eventDateKey: "YYYY-MM-DD"  data.eventDate: "2027-03-21"     DB model. Does not parse string
                          data.eventDate: {y, m, d}        (NO eventDateKey in sample!)     data.eventDate into {y,m,d}.

3   Entity Identification data.eventId: "evt_wed_101"      NO eventId in data.              Reads eventDoc.entityId as eventId
    Key                   (inside data payload)            Uses entityId: "wed_001" on      and queries DB mockOccasionSource.
                                                           top-level envelope.              Ignores data.eventId.

4   Category Naming &     Uppercase enums:                 Lowercase free-text array:       Direct array passthrough; no enum
    Casing                ['BRIDAL_WEAR', 'SAREES', ...]   ["saree", "blouse"]              validation against contract types.

5   Cancellation &        data contains: eventId,          data contains ONLY:              Consumer relies on top-level
    Completion Payloads   customerId, kind, reason         {"reason": "CUSTOMER_CANCELLED"} entityId and ignores missing inner
                                                                                            fields in data.

6   Data Consumption      Self-contained event payload     Self-contained sample payload    Database Re-fetch Architecture:
    Pattern               drives campaign updates.         with all fields.                 Consumer ignores payload data and
                                                                                            re-queries mockOccasionSource!
====================================================================================================
```

#### Detailed Breakdown of Mismatches:
1. **Mismatch 1: Postponement Event Type Naming**:
   - `docs/contracts/occasion-integration.md` Section 3.1 documents `type: "occasion.saved"`.
   - Postponement is strictly represented as `occasion.saved` with a new event date.
   - `event-consumer.service.ts` line 177 whitelists `occasion.saved`. Any third-party system posting unwhitelisted event types will be quarantined.
2. **Mismatch 2: Date Representation (`eventDate` vs `eventDateKey`)**:
   - `docs/contracts/occasion-integration.md` specifies `eventDateKey: "2027-02-14"` and `eventDate: { year: 2027, month: 2, day: 14 }`.
   - `docs/samples/event-occasion-saved-wedding.json` and `event-occasion-saved-wedding-postponed.json` use `data.eventDate: "2027-03-21"` as a string and **omit `eventDateKey` entirely**.
   - `event-consumer.service.ts` line 1295 expects `occasion.eventDateKey`.
3. **Mismatch 3: Identification Key (`entityId` vs `eventId`)**:
   - In `docs/contracts/occasion-integration.md`, `eventId` is included inside `data` (`data.eventId = "evt_wed_101"`).
   - In `docs/samples/event-occasion-saved-wedding.json`, `eventId` does not exist inside `data`; the occasion identifier is `entityId: "wed_001"` on the outer envelope.
4. **Mismatch 4: Category Enum Taxonomy**:
   - Contract defines strict categories: `BRIDAL_WEAR`, `GROOM_WEAR`, `SAREES`, `SUITING`, `ACCESSORIES`, `KIDS_ETHNIC`, `CASUAL`.
   - Samples contain un-enumerated strings such as `"saree"`, `"blouse"`.
5. **Mismatch 5: Cancellation & Completion Data Payloads**:
   - Contract Sections 3.2 and 3.4 state `data` contains `eventId`, `customerId`, and `kind`.
   - Samples `event-occasion-cancelled.json` and `event-occasion-completed.json` contain only `{ "reason": "CUSTOMER_CANCELLED" }` and `{ "completedBy": "STAFF", "reason": "SHOPPING_COMPLETE" }`.
6. **Mismatch 6: Database Re-Fetch vs Payload Consumption**:
   - Rather than hydrating occasion changes from `eventDoc.data`, `event-consumer.service.ts` line 1190 queries `mockOccasionSource.getOccasion(tenantId, eventId)` directly from MongoDB. If an event is posted before the source CRM record is persisted in MongoDB, the consumer treats the occasion as deleted (`!occasion`).

---

## 3. Template Parameter & Binding Resolution Audit

### 3.1 Canonical Implementation (Inside `apps/api/src/templates/`)

1. **`apps/api/src/templates/resolveTemplateParameters.ts`**:
   - **`resolveTemplateParameters(params)`**: The authoritative pure resolver.
   - Enforces variable sorting by numeric index ($1, 2, 3\dots$), Unicode NFC sanitization, whitespace collapse, max length validation (1024 chars), missing variable detection (`MISSING_VARIABLE_BINDING`), and fallback literal resolution.
2. **`apps/api/src/templates/buildMetaTemplateBody.ts`**:
   - **`buildMetaTemplateBody(template, parameters, toDigits)`**: The authoritative serializer for Meta Graph API payloads.
   - Formats the request body matching `docs/samples/meta-send-request-bodies.json`, strictly sorting positional text parameters into body components.
3. **`apps/api/src/templates/validateMapping.ts`** & **`bindingSources.ts`**:
   - Defines allowed binding sources (`customer.*`, `shop.*`, `event.*`, `order.*`, `offer.*`, `credit.*`) and validates template mappings against preset constraints.

---

### 3.2 Flagged Locations Outside `apps/api/src/templates/`

The following locations in `apps/api/src` perform parameter resolution, variable extraction, or payload building outside the canonical `templates/` module:

```
+------------------------------------------------------------------------------------------------------+
| FLAGGED CODE LOCATIONS (RESOLVING BINDINGS OR BUILDING PARAMETERS OUTSIDE TEMPLATES)                 |
+------------------------------------------------------------------------------------------------------+
| 1. apps/api/src/services/worker/worker.service.ts:71-113                                             |
|    - export function resolveBindingValue(binding, customer, shopName, occasionLocalDate, context)    |
|    - VIOLATION: Creates an ad-hoc dummy template ("mock_tpl") with variable index 1 to resolve a     |
|      single binding into a string outside the templates module.                                      |
+------------------------------------------------------------------------------------------------------+
| 2. apps/api/src/services/worker/worker.service.ts:654-685                                            |
|    - Direct context assembly inside evaluateAndProcessExecution().                                   |
|    - Fetches mockOccasionSource.getOccasion, manually extracts recipientLabel, bookingLinkUrl, and   |
|      occasionKind, injecting them into the resolver params.                                          |
+------------------------------------------------------------------------------------------------------+
| 3. apps/api/src/services/worker/worker.service.ts:716-720                                            |
|    - Hand-rolled conversion of resolution.parameters array into a dictionary with duplicate keys:    |
|      resolvedParameters[String(p.index)] = p.text; resolvedParameters[p.name] = p.text;             |
+------------------------------------------------------------------------------------------------------+
| 4. apps/api/src/services/worker/worker.service.ts:1012-1025                                          |
|    - Manual construction of canonicalPayload.parameters dictionary before SHA-256 hashing.           |
+------------------------------------------------------------------------------------------------------+
| 5. apps/api/src/presets/welcome/bindings.ts:24-58                                                    |
|    - export function resolveWelcomeBindingValue(binding, customer, shopName, context)                |
|    - VIOLATION: Creates synthetic template "tpl_welcome_mock" to resolve single bindings.            |
+------------------------------------------------------------------------------------------------------+
| 6. apps/api/src/presets/firstToSecondPurchase/bindings.ts:24-56                                      |
|    - export function resolveFirstToSecondPurchaseBinding(binding, context)                           |
|    - VIOLATION: Creates synthetic template "tpl_f20_mock" to resolve single bindings.               |
+------------------------------------------------------------------------------------------------------+
| 7. apps/api/src/services/dry-run.service.ts:134-146                                                  |
|    - Direct invocation of resolveTemplateParameters during simulation projections.                  |
+------------------------------------------------------------------------------------------------------+
| 8. apps/api/src/routes/template-mapping.ts:75-85                                                     |
|    - Direct invocation of resolveTemplateParameters inside Express route controller to render        |
|      sample message preview strings.                                                                 |
+------------------------------------------------------------------------------------------------------+
| 9. apps/api/src/adapters/whatsapp-delivery.ts:439-440                                                |
|    - Direct call to buildMetaTemplateBody inside delivery adapter to serialize HTTP payload.         |
+------------------------------------------------------------------------------------------------------+
```

---

## 4. Omissions, Assumptions, and Manager Review Questions

### 4.1 Manual Testing Checklist

Below is the verification checklist for manual QA, staging smoke testing, and field audits:

- [ ] **1. Baseline Seed Verification (`pnpm seed:base`)**:
  - Run `pnpm seed:base`.
  - Verify `cmp_gift_wedding_shop_a` (WEDDING, D-45 & D-21) and `cmp_gift_reminder_shop_a` (GIFT, D-10 & D-3) are created and in `ACTIVE` status.
  - Verify customer `cus_live_01` has both a Wedding occasion (due in 45 days) and a Gift occasion (due in 10 days).
- [ ] **2. Calendar Planning Cycle**:
  - Run `pnpm dev:api` and navigate to `/campaigns` in `apps/web`.
  - Click into the Wedding campaign and trigger "Run Calendar Planner".
  - Verify enrollments appear in the Campaign Activity tab with `occasionKind: 'WEDDING'` and occurrence ID `wedding:<eventId>`.
- [ ] **3. In-Place Date Postponement & Audit Trail**:
  - Navigate to `/dev-tools` -> Mock Occasions CRM Control Panel.
  - Select customer `cus_live_01`'s wedding occasion and postpone the date by +14 days.
  - Check the Campaign Activity tab: verify `planRevision` increments ($v_1 \to v_2$), pending executions are updated to new dates, and enrollment details show a populated `dateHistory` banner.
  - Verify no duplicate enrollment was created.
- [ ] **4. In-Flight Worker Claim vs Postponement Race**:
  - In a test environment, trigger worker execution up to the `deliveryIntentId !== null` stage.
  - Dispatch an `occasion.saved` postponement event before HTTP submission.
  - Verify the execution and intent transition to `BLOCKED` with reason `BLOCKED_STALE_INTENT`.
- [ ] **5. Lead Time Cutoff Skipping (`latestUsefulAt`)**:
  - Register an occasion with event date 5 days away for a campaign with `fulfillmentLeadDays = 21`.
  - Run the Calendar Planner or Worker Cycle.
  - Verify the execution state is `SKIPPED` with reason `INSUFFICIENT_LEAD_TIME` and owner-facing message:
    `"Skipped: needs 21 days before the event; the event is in 5 days"`.
- [ ] **6. Tagged Order Completion Goal Stop (`occasionRef`)**:
  - Post an `order.completed` event with `data.occasionRef = "wedding:<eventId>"`.
  - Verify all unsubmitted steps for that enrollment transition to `SKIPPED_GOAL_REACHED`.
  - Verify enrollment status transitions to `COMPLETED`.
  - Verify a durable `CampaignGoalEvent` is written with `source: 'ORDER_OCCASION'` and `orderRef`.
- [ ] **7. Live WhatsApp Cloud API Dispatch (Meta Sandbox)**:
  - Configure `.env` with `DISPATCH_MODE=meta` and `ALLOW_TEST_CATEGORY_MISMATCH=true`.
  - Run worker cycle for verified test recipient `+91 9640708699`.
  - Verify WhatsApp message delivery on the physical test handset.
  - Verify response logs real Meta `wamid` and intent transitions to `DELIVERED`.

---

### 4.2 Architectural Assumptions (with Spec Page Numbers)

| # | Assumption & Architectural Decision | Spec Page Reference | Rationale & Justification |
| :--- | :--- | :--- | :--- |
| **1** | **Date-Only Representation** | **Spec p12, p17, p21** | Stored as `{ year, month, day }` and `eventDateKey: "YYYY-MM-DD"`. Calculations never convert through UTC midnight to prevent day-shifting timezone anomalies. |
| **2** | **Fulfillment Lead Time Cutoff** | **Spec p12, p19, p31 (B08)** | `latestUsefulAt = (eventDate - fulfillmentLeadDays)` evaluated at the end of allowed sending hours in store timezone. Executions past this instant are `SKIPPED` with `INSUFFICIENT_LEAD_TIME`. |
| **3** | **Business Identity & Occurrence Scoping** | **Spec p12, p18, p21** | Occurrence keys are strictly formatted as `wedding:{eventId}` and `gift:{eventId}`. This isolates independent occasions for the same customer without collision. |
| **4** | **Postponement Plan Revision Bump** | **Spec p12, p20, p31 (B20)** | Date changes increment `planRevision` atomically in-place. Racing worker submissions holding older revision leases are aborted via optimistic CAS. |
| **5** | **No Inferred Partner Contacts** | **Spec p10, p12, Hard Rule 8** | Auto Campaigns communicates exclusively with the registered customer. Partner identities and numbers are never captured or inferred. `recipientLabel` is purely for template rendering. |
| **6** | **Point-of-Sale Order Tagging** | **Spec p12, p28, QA Matrix A12** | Orders stop occasion campaigns only when explicitly tagged with `occasionRef: "wedding:<eventId>"` or `"gift:<eventId>"`. Untagged orders do not stop occasion reminders. |
| **7** | **Read-Only Adapter Boundary** | **Spec p12, p21, Hard Rule 10** | Auto Campaigns production code never writes to `src_customerEvents`. All occasion state modifications occur in the CRM and are consumed via domain events. |

---

### 4.3 Unresolved Questions for Engineering Manager

1. **Strict Postponement Handling (`occasion.saved`)**:
   - Postponement is strictly handled via `occasion.saved` with a new event date. The event consumer quaranines any non-whitelisted event types. Should the CRM contract emphasize that postponement is exclusively `occasion.saved`?
2. **Decoupled Event Ingestion vs Database Re-Fetch**:
   - Currently, `handleOccasionEvent` queries `mockOccasionSource.getOccasion` in MongoDB instead of trusting `eventDoc.data`. In a distributed microservices deployment, should Auto Campaigns hydrate the occasion record directly from the event payload?
3. **Occasion Category Taxonomy**:
   - The contract defines strict uppercase categories (`'BRIDAL_WEAR'`, `'SAREES'`), whereas CRM seeds and samples use lowercase strings (`"saree"`, `"blouse"`). Should a schema validation and normalization layer be added?
4. **Missing Prompt Test Coverage (G02, G07, G13, G26, G27, G28, G31)**:
   - Should we backfill the 7 missing test scenarios (5x replay, blackout shifting past lead time, racing replan CAS, concurrent planner, reconciler sweep, DST zone, stubbed-HTTP request bodies) into `apps/api/tests/gift-wedding-reminder.test.ts`?
5. **Consolidation of Ad-Hoc Binding Resolvers**:
   - `resolveBindingValue`, `resolveWelcomeBindingValue`, and `resolveFirstToSecondPurchaseBinding` each create synthetic mock templates outside `templates/`. Should these be consolidated into a single `resolveSingleBinding` utility in `apps/api/src/templates/`?
