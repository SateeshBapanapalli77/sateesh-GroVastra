# F28: Festival collection campaign

## Status

The Festival Collection campaign feature (F28) is fully implemented end-to-end:
- Festival seasons database schema and adapter (`src_seasons`, `season-source.ts`).
- Pure preference matching module (`matchFestivalCollection`) strictly adhering to Hard Rule 8 (customer name or religion is never inferred).
- Preset definition (`festival_collection`, alias `FESTIVAL_COLLECTION`, `festival`) registered in `CAMPAIGN_PRESETS` with default priority 50, Step 1 Launch (D-21), and Step 2 Follow-up (D-7).
- Variable bindings for `festival.name`, `festival.date`, `collection.name`, and `match.itemList` with late snapshot resolution.
- Bounded cursor fan-out with durable checkpoints (`festival-fanout:{seasonId}:{campaignId}`), enroller, and event handlers (`season.published`, `season.updated`, `season.cancelled`, `season.withdrawn`).
- Goal tracking on `order.completed` with collection item or tagged `festival:{seasonId}`, stopping remaining steps.
- Reconciler script and endpoints (`GET /campaigns/:id/festival/summary`, `POST /campaigns/:id/festival/preview`, `POST /dev/festival/trigger-season`).
- Scenario seed `festival-collection` with mock products (`prd_fc_*`), collection (`rel_fc_diwali`), season (`season_fc_diwali`), customers (`cus_fc_*`), and campaign (`cmp_festival_collection`).
- UI Festival Season Collection Review & Matching card in `apps/web/app/campaigns/[id]/page.tsx` and preset icon in `apps/web/app/campaigns/page.tsx`.
- Complete test suite `apps/api/tests/festival-collection.test.ts` with 36/36 tests passing (FC00 meta-test + FC01 through FC35).

## Implemented pieces

- **Data Model & Schema**: `ISrcSeason` in `src_seasons` collection with `seasonId`, `festivalDate`, `releaseId`, `collectionId`, `status` (`DRAFT` | `ACTIVE` | `PAUSED` | `CANCELLED` | `COMPLETED`), `validFrom`, `validUntil`, compound unique index `{ tenantId: 1, seasonId: 1 }`.
- **Authoritative Adapter**: `MockSeasonSource` provides authoritative re-read for seasons (`getSeason`, `listActiveSeasons`).
- **Hard Rule 8 Compliance**: `matchFestivalCollection` strictly rejects any name, gender, or religious demographic inference. Only explicitly declared weaves, budget, size, and colour affinities are evaluated.
- **Timing & Expiry**: Step 1 defaults to Launch at D-21 (`offsetDays: -21`), Step 2 to Follow-up at D-7 (`offsetDays: -7`). Any execution scheduled past `festivalDate` or `validUntil` is automatically capped and marked `SKIPPED` with `FESTIVAL_ENDED`.
- **Event Lifecycle**:
  - `season.published`: Initiates bounded cursor fan-out across active festival campaigns.
  - `season.cancelled` / `season.withdrawn`: Cancels active enrollments and marks scheduled executions `CANCELLED`.
  - `season.updated` (status `PAUSED`): Skips scheduled executions with `SEASON_PAUSED`.
  - Invalid season: Quarantined with `SEASON_INVALID`.
- **Goal Tracking**: `handleOrderCompletedForFestivalGoal` detects orders containing items from the festival collection or tagged with `festival:{seasonId}`, marks enrollment `COMPLETED`, records `CampaignGoalEvent`, and cancels subsequent steps.
- **Collision Arbitration**: Priority 50 ensures Birthday campaigns (priority 80) take precedence when competing for the same customer/date slot under daily contact caps (QA Matrix B09).

## Data and Seed

Run:

```powershell
pnpm --filter @grovastra/api seed:festival
# or
pnpm seed:scenario festival-collection
pnpm seed:scenario festival-collection --reset
```

The seed adds:
- 8 festive products (`prd_fc_red_kanjivaram`, `prd_fc_gold_zari_saree`, etc.)
- 1 published collection (`rel_fc_diwali`)
- 1 festival season (`season_fc_diwali` for Diwali Festive Season 2026)
- 30 customers (`cus_fc_01` to `cus_fc_30`) with varied preferences and opt-in states
- 1 ACTIVE campaign (`cmp_festival_collection`) with revision v1

## Test Verification

Run the comprehensive test suite:

```powershell
pnpm --filter @grovastra/api test --run -- festival-collection.test.ts
```

All 36 tests pass:
- `FC00`: Meta-test verifying all matrix IDs FC01-FC35 are covered.
- `FC01-FC03`: Season & collection validation.
- `FC04-FC07`: Timing, offsets, and expiry capping.
- `FC08-FC12`: Preference matching and Hard Rule 8 compliance.
- `FC13-FC16`: Variable bindings & late snapshot resolution.
- `FC17-FC20`: Enroller & eligibility gates.
- `FC21-FC22`: Fan-out & checkpoint idempotency.
- `FC23-FC26`: Event lifecycle & handler quarantining.
- `FC27-FC29`: Goal tracking & stop conditions.
- `FC30-FC31`: Collision arbitration & tenant isolation.
- `FC32-FC35`: API routes & preset definition.

## Boundaries and Notes

- Festival date and collection definitions are managed by external catalogue/calendar systems; GroVastra consumes domain events and enforces timing and preference matching.
- Messages never claim false scarcity; expired seasons automatically skip remaining executions.
