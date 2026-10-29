# GroVastra Seed Engine � Developer Reference (F24b)

**Feature**: F24b � Seed Policy Cleanup & Additive Architecture  
**Test Suite**: `seed-policy-f24b.test.ts` (SD01-SD12, 12/12 passing)  
**Audience**: GroVastra API developers, QA engineers

---

## Overview

The seed engine uses a **two-layer, additive, labeled design**. Every seed command is strictly idempotent and environment-guarded.

```
+-----------------------------------------------------+
|  Layer 1: seed:base (Platform Data)                  |
|  tenants, branches, users, settings                  |
|  templates, connections, base customers              |
|  seedGroup: "core" | source: "MOCK"                  |
|  ZERO campaigns created                              |
+-----------------------------------------------------+
        | additive, non-destructive overlays
        v
+-----------------------------------------------------+
|  Layer 2: seed:scenario <name>                       |
|  Scenario-specific customers, orders, events         |
|  Campaigns for that scenario                         |
|  seedGroup: <scenario_name>                          |
+-----------------------------------------------------+
```

---

## Available Commands

| Script | Description |
|---|---|
| `pnpm seed:base` | Seeds platform layer only (zero campaigns) |
| `pnpm seed:base --live` | As above + ingests `LIVE_CUSTOMER_PHONES` as a base live customer |
| `pnpm seed:scenario <name>` | Additively seeds a named scenario over the base |
| `pnpm seed:scenario <name> --live` | Scenario + live customer handover |
| `pnpm seed:scenario <name> --reset` | Purges that scenario only, then re-seeds it |
| `pnpm seed:demo` | Runs base + all 5 scenarios (no live handover) |
| `pnpm seed:status` | Prints current seed state from `dev_seedState` |
| `pnpm seed:purge-mock --yes` | Removes mock source data + scenario campaigns; preserves platform data |
| `pnpm seed:reset --yes` | Wipes all dev collections and `dev_seedState` |

> NOTE: The deprecated alias `pnpm seed` still works (delegates to `seed:base`) but prints a deprecation notice.

---

## Available Scenarios

| Scenario Name | Campaigns Seeded | Description |
|---|---|---|
| `welcome` | Welcome New Customer | Customers with completed orders; live customer fixtures |
| `gift-wedding` | Gift / Wedding Reminder | Customers with wedding/gift occasions |
| `first-repeat` | First-to-Second Purchase | Customers with one qualifying order |
| `unresolved-enquiry` | Unresolved Enquiry Follow-up | Customers with open enquiries |
| `complete-outfit` | Complete the Outfit | Customers with outfit-eligible orders |
| `selected-stock-promotion` | Selected-stock Promotion | 12 products, 40 customers, edge-case draft/withdrawn/expired offers, and an ACTIVE F27 campaign |

---

## Key Design Rules

### 1. Strictly Additive - No Cross-Scenario Deletions

Running scenario A then B **never** deletes or modifies A's data. Every write is an upsert keyed on the document's natural unique key. Running the same scenario twice is a no-op.

### 2. Zero Campaigns in Base Layer

`seed:base` creates the platform infrastructure needed for any campaign to function, but creates no campaign documents. Campaign data is exclusively owned by scenarios.

### 3. Labeled Upserts via seedGroup + source

Every document upserted by the seed engine carries:
- **`seedGroup`**: `"core"` for base data, or `<scenario_name>` for scenario data
- **`source`**: `"MOCK"` for all seed-engine documents; `"LIVE"` for live customer records

These labels allow `seed:purge-mock --yes` to remove precisely mock data without touching platform records.

### 4. Live Customer Handover

When `--live` is passed to `seed:scenario`, the engine:
1. Clears existing live customer records from the database (orders, events, enrollments, deliveries)
2. Re-seeds live fixtures keyed to the specified scenario
3. Updates `dev_seedState.liveOwner` to the new scenario name

This guarantees the live phone number is always associated with exactly one scenario's campaign at a time.

### 5. Money in Integral Paise

All monetary amounts are stored in integral paise (100 paise = 1 INR). No floating-point values appear anywhere in seed data.

### 6. Masked Phone Logging

`maskPhone()` is called before any phone number appears in logs. Full E.164 numbers are never written to stdout/stderr by the seed engine.

---

## Environment Safeguards

`verifySeedEnvironment()` is called before every seed operation. It throws an error and aborts if:

| Condition | Error |
|---|---|
| `NODE_ENV === 'production'` | Seed operations are blocked in production |
| `MONGODB_DB` does not end in `_dev` or `_test` | Seed operations require a development database |
| `MONGODB_URI` does not include `replicaSet=` | Transactions require a replica set |

CAUTION: Never override or bypass `verifySeedEnvironment()`. It is the last safeguard against accidental production data modification.

---

## DevSeedState Collection (dev_seedState)

A single document per tenant tracks the current seed state. Automatically created and updated by seed commands.

```typescript
interface DevSeedState {
  tenantId: string;           // e.g. "shop_a"
  liveOwner: string | null;   // which scenario owns the live customer, or null
  appliedScenarios: string[]; // ordered list of all applied scenarios
  appliedAt: Date;            // last update timestamp
}
```

Query for debugging:
```javascript
db.dev_seedState.find({ tenantId: "shop_a" })
```

`seed:status` prints this document in a human-readable format to stdout.

---

## Programmatic API

The seed engine exports functions for use in tests:

```typescript
import {
  seedBase,
  seedScenario,
  seedReset,
  seedPurgeMock,
  seedDemo,
  seedStatus,
  verifySeedEnvironment,
} from '../src/db/seed';

// Seed base layer (no campaigns)
await seedBase({ live: false });

// Seed a scenario additively
await seedScenario('welcome', { live: false });

// Reset entire DB (tests use this in beforeEach/beforeAll)
await seedReset(true); // true = confirmed, no --yes flag needed

// Purge mock data (preserve platform data)
await seedPurgeMock(true);

// Run demo (base + all scenarios)
await seedDemo();

// Check status
const status = await seedStatus();
```

---

## Test Suite (SD01-SD12)

The test file `apps/api/tests/seed-policy-f24b.test.ts` covers:

| Test ID | Description |
|---|---|
| SD01 | Scenario A then B leaves A's rows intact (additive isolation) |
| SD02 | Same scenario applied twice is idempotent (counts unchanged) |
| SD03 | `seed:scenario --reset` purges only that scenario; other scenarios unaffected |
| SD04 | `seed:base` creates zero campaigns; all docs have `seedGroup: "core"` |
| SD05 | Live handover wipes previous owner's live fixtures; no `--live` leaves them intact |
| SD06 | `seed:purge-mock --yes` removes mock data + campaigns; preserves platform data and auditLog |
| SD07 | `seed:reset` requires `--yes` and only wipes development collections |
| SD08 | `verifySeedEnvironment` refuses production env, non-dev DB name, missing replica set |
| SD09 | `seed:demo` twice is idempotent; live customer owner remains none |
| SD10 | Deprecated command aliases print deprecation notice and delegate correctly |
| SD11 | Applying an unrelated scenario leaves existing campaign version/fingerprint unchanged |
| SD12 | No secret or unmasked phone number appears in captured log output |

---

## File Map

| File | Role |
|---|---|
| `apps/api/src/db/seed.ts` | Core seed engine: all commands, handover, purge, reset, env guard |
| `apps/api/src/db/seed-data.ts` | Fixture data generators: `generateBaseData()`, `generateScenarioData()` |
| `apps/api/src/db/models/dev-seed-state.model.ts` | `DevSeedStateModel` Mongoose schema |
| `apps/api/tests/seed-policy-f24b.test.ts` | SD01-SD12 integration test suite |
| `package.json` (root) | `seed:*` npm scripts |
| `apps/api/package.json` | `seed:*` npm scripts for the API package |
