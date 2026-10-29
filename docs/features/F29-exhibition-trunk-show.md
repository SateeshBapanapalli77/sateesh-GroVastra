# F29: Exhibition / Trunk Show Campaign

## Status

The Exhibition / Trunk Show campaign feature (F29) is fully implemented end-to-end:
- Store events database schema and adapter (`src_events`, `event-source.ts`).
- Pure preference, geography, capacity, and RSVP matching module (`matchExhibitionEvent`) strictly adhering to Hard Rule 8 (customer name, religion, or background is never inferred).
- Preset definition (`exhibition_trunk_show`, aliases `EXHIBITION_TRUNK_SHOW`, `exhibition`, `trunk_show`, `store_event`) registered in `CAMPAIGN_PRESETS` with default priority 45, Step 1 Invite (D-14), and Step 2 Reminder (D-3).
- Variable bindings for `event.name`, `event.date`, `event.venue`, `event.city`, and `event.rsvpLink` with late snapshot resolution.
- Bounded cursor fan-out with durable checkpoints (`exhibition-fanout:{eventId}:{campaignId}`), enroller, and event handlers (`event.published`, `event.updated`, `event.cancelled`, `rsvp.completed`).
- Goal tracking on `order.completed` with event reference or customer RSVP completion, stopping remaining steps.
- Reconciler script and endpoints (`GET /campaigns/:id/exhibition/summary`, `POST /campaigns/:id/exhibition/preview`, `POST /dev/exhibition/trigger-event`).
- Scenario seed `exhibition-trunk-show` with mock store events (`evt_ex_mumbai_2026`, `evt_ex_delhi_2026`), customers (`cus_ex_*`), and campaign (`cmp_exhibition_trunk_show`).
- UI Exhibition / Trunk Show Review & Simulator card in `apps/web/app/campaigns/[id]/page.tsx` and preset icon in `apps/web/app/campaigns/page.tsx`.
- Complete test suite `apps/api/tests/exhibition-trunk-show.test.ts` with 36/36 tests passing (EX00 meta-test + EX01 through EX35).

## Implemented Pieces

- **Data Model & Schema**: `ISrcEvent` in `src_events` collection with `eventId`, `title`, `description`, `eventType` (`EXHIBITION` | `TRUNK_SHOW` | `STORE_EVENT`), `startDate`, `endDate`, `venue` (`name`, `address`, `city`, `pincode`, `mapUrl`), `rsvpLink`, `capacity`, `registeredCount`, `categories`, `status` (`DRAFT` | `PUBLISHED` | `CANCELLED` | `COMPLETED` | `FULL` | `PAUSED`), compound indexes `{ tenantId: 1, eventId: 1 }` and `{ tenantId: 1, status: 1, startDate: 1 }`.
- **Customer Schema Update**: Added `city?: string | null` to `ISrcCustomer` and `SrcCustomerSchema` for localized event filtering.
- **Authoritative Adapter**: `MockEventSource` (`event-source.ts`) providing authoritative read for store events (`getEvent`, `listActiveEvents`, `incrementRegisteredCount`, `setEventStatus`).
- **Hard Rule 8 Compliance**: `matchExhibitionEvent` strictly rejects any name, gender, or personal background inference. Eligibility evaluates only declared category affinities, geographic location (`customer.city` matching `event.venue.city`), capacity status, and existing RSVP status.
- **Capacity & RSVP Skipping**:
  - If event is marked `FULL` or `registeredCount >= capacity`, matching rejects candidate with `EVENT_AT_CAPACITY`.
  - If customer has already registered/RSVP'd, generic invites are skipped with `CUSTOMER_REGISTERED`.
- **Timing & Expiry**: Step 1 defaults to Invite at D-14 (`offsetDays: -14`), Step 2 to Reminder at D-3 (`offsetDays: -3`). Any execution scheduled past `startDate` is automatically capped and marked `SKIPPED` with `EVENT_ENDED`. Elapsed steps for future events are safely skipped.
- **Event Lifecycle**:
  - `event.published`: Initiates bounded cursor fan-out across active exhibition campaigns.
  - `event.cancelled`: Cancels active enrollments and marks scheduled executions `CANCELLED`.
  - `event.updated` (status `PAUSED` or `FULL`): Pauses enrollments and skips scheduled executions with `EVENT_PAUSED` / `EVENT_AT_CAPACITY`.
  - `rsvp.completed` / `event.rsvp`: Resolves RSVP goal for the customer and cancels subsequent reminder steps.
  - Invalid event: Quarantined with `EVENT_INVALID`.
- **Goal Tracking**: `handleOrderCompletedForExhibitionGoal` detects orders associated with `eventRef: eventId` or `occasionRef: storeevent:{eventId}`, marks enrollment `COMPLETED`, records `CampaignGoalEvent`, and cancels subsequent reminder steps.
- **Collision Arbitration**: Priority 45 ensures Birthday (80) and Festival (50) take precedence when competing for the same customer/date slot under daily contact caps (QA Matrix B09).

## Data and Seed

Run:

```powershell
pnpm --filter @grovastra/api seed:exhibition
# or
pnpm seed:scenario exhibition-trunk-show
pnpm seed:scenario exhibition-trunk-show --reset
```

The seed adds:
- 2 store events (`evt_ex_mumbai_2026` in Mumbai starting in 14 days, `evt_ex_delhi_2026` in Delhi starting in 30 days)
- 25 customers (`cus_ex_01` to `cus_ex_25`) with varied cities (Mumbai, Pune, Delhi), declared preferences, and opt-in states
- 5 customers for `shop_b` to ensure multi-tenant isolation
- 1 ACTIVE campaign (`cmp_exhibition_trunk_show`) with revision v1

## Test Verification

Run the comprehensive test suite:

```powershell
pnpm --filter @grovastra/api test --run -- tests/exhibition-trunk-show.test.ts
```

All 36 tests pass:
- `EX00`: Meta-test verifying all matrix IDs EX01-EX35 are covered.
- `EX01-EX03`: Event validation (invalid date, end date before start date, missing venue).
- `EX04-EX07`: Timing, offsets, `EVENT_ENDED` past start date, future-only elapsed skip.
- `EX08-EX12`: Preference matching, geography, capacity, RSVP, and Hard Rule 8 compliance.
- `EX13-EX16`: Variable bindings & late snapshot resolution (`event.name`, `event.date`, `event.venue`, `event.rsvpLink`).
- `EX17-EX20`: Enroller & eligibility gates (active enrollment, opt-out, unverified destination, duplicate check).
- `EX21-EX22`: Fan-out engine & checkpoint idempotency.
- `EX23-EX26`: Event lifecycle & handler quarantining.
- `EX27-EX29`: Goal tracking & stop conditions (order completed, customer RSVP stop, untagged order ignored).
- `EX30-EX31`: Collision arbitration & tenant isolation.
- `EX32-EX35`: API routes & preset definition.

## Boundaries and Notes

- Store event dates, capacity, and venues are managed by external boutique systems or POS; GroVastra consumes domain events and enforces timing, capacity checks, and preference matching.
- Messages never claim false scarcity; events at capacity skip candidate enrollments immediately.
