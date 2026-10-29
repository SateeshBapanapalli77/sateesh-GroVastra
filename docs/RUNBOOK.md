# GroVastra Auto Campaigns — Operational Recovery Runbook

**Audience**: DevOps, Store Support Engineers, Technical Operations  
**Scope**: Operational recovery procedures for worker restarts, `OUTCOME_UNKNOWN` triage, template blocks, event replay, and emergency stops.  
**Reference Document**: GroVastra Auto Campaigns Developer Handoff v2.0 (Spec p18, p25, p27, p34)

---

## Runbook Index
1. [Procedure 1: Worker Process Restart & Mid-Run Crash Recovery](#procedure-1-worker-process-restart--mid-run-crash-recovery)
2. [Procedure 2: Handling and Resolving `OUTCOME_UNKNOWN`](#procedure-2-handling-and-resolving-outcome_unknown)
3. [Procedure 3: Diagnosing & Unblocking Template Blocks](#procedure-3-diagnosing--unblocking-template-blocks)
4. [Procedure 4: Historical Event Replay & Re-evaluation Safety](#procedure-4-historical-event-replay--re-evaluation-safety)
5. [Procedure 5: Emergency Tenant & Campaign Control](#procedure-5-emergency-tenant--campaign-control)

---

## Procedure 1: Worker Process Restart & Mid-Run Crash Recovery

### Context & Design Guarantees (Spec p25, p34)
GroVastra Auto Campaigns never stores schedule timers in volatile server memory (`setTimeout` is strictly barred by Hard Rule 3). All scheduled executions reside durably in MongoDB inside `campaignExecutions`.

When a worker claims an execution, it uses an atomic `findOneAndUpdate` with a 30-second expiring lease (`lease.until = serverNow + 30s`). If a worker crashes mid-evaluation or is killed during a rolling deployment:
1. **Zero Schedule Loss**: The execution remains safely stored in MongoDB.
2. **Automatic Reclamation**: As soon as `lease.until` expires, any restarted worker automatically reclaims the execution via the query:
   ```typescript
   {
     state: EXECUTION_STATE.EVALUATING,
     'lease.until': { $lte: serverNow }
   }
   ```
3. **At-Most-Once Provider Submission**: Before any provider HTTP call is initiated, the worker freezes an immutable `campaignDeliveryIntent` with a unique index `{ tenantId: 1, deliveryKey: 1 }`. Duplicate provider calls are structurally blocked.

### Safe Restart Steps
1. **Stop Worker Service**:
   ```powershell
   # Graceful stop of worker background process
   Stop-Process -Name "node" -Force
   ```
2. **Restart Worker**:
   ```powershell
   # Start worker from the monorepo root
   pnpm --filter @grovastra/api worker
   ```
3. **Verify Lease Auto-Recovery**:
   - Check the Operational Monitoring Dashboard at `/monitoring` on the web interface.
   - Or query the health endpoint:
     ```http
     GET /api/v1/monitoring/system-health
     Authorization: Bearer <ADMIN_OR_OWNER_JWT>
     ```
   - Ensure `stalledCheckpointsCount` is 0. If leases were stalled, trigger immediate reconciliation:
     ```http
     POST /api/v1/monitoring/reconciliation/run
     Authorization: Bearer <ADMIN_OR_OWNER_JWT>
     ```

---

## Procedure 2: Handling and Resolving `OUTCOME_UNKNOWN`

### Context (Spec p19, p27, p34, QA Matrix C07)
An execution enters `OUTCOME_UNKNOWN` when the worker successfully submitted a payload to the Meta WhatsApp Cloud API, but:
- The network connection timed out before receiving the HTTP 200 response, OR
- The Meta Graph API returned an ambiguous 5xx server error, OR
- A transient socket hang-up occurred after bytes were transmitted.

> **CRITICAL RULE (Spec p19, Hard Rule 4)**:  
> GroVastra NEVER blindly resends a message in `OUTCOME_UNKNOWN`. Dependent reminder steps in multi-step sequences will defer and will NOT advance without positive acceptance evidence (Spec p32, QA Matrix C13).

### Step-by-Step Triage
1. **Identify Affected Executions**:
   - Review `/monitoring` page under the "Outcome Unknown" safeguard card.
   - Query the database or monitoring endpoint:
     ```bash
     GET /api/v1/monitoring/operational-metrics
     ```
2. **Inspect Delivery Intent**:
   - Find the associated `campaignDeliveryIntents` record using `executionId`:
     ```javascript
     db.campaignDeliveryIntents.findOne({ tenantId: "shop_a", executionId: "exe_xyz" })
     ```
   - Note the `deliveryIntentId`, `payloadHash`, and `maskedRecipient`.
3. **Reconcile with Meta Graph API**:
   - Query Meta Graph API using the connection's WABA ID / phone number ID for outbound message logs to the recipient within that timestamp window.
   - **Case A: Provider Accepted the Message**:
     - Update execution state to `PROVIDER_ACCEPTED` or `DELIVERED`:
       ```javascript
       db.campaignExecutions.updateOne(
         { tenantId: "shop_a", executionId: "exe_xyz" },
         { $set: { state: "PROVIDER_ACCEPTED", providerMessageId: "<wamid>" } }
       );
       ```
     - Contact gate ledger marks capacity as accepted.
   - **Case B: Provider Never Received the Message**:
     - Mark delivery intent as `FAILED` with category `RECONCILED_PROVIDER_DROPPED`.
     - Update execution state to `FAILED` or reschedule if retry window is open.

---

## Procedure 3: Diagnosing & Unblocking Template Blocks

### Symptoms
- Step executions show state `BLOCKED` with reasons such as:
  - `TEMPLATE_NOT_APPROVED`
  - `TEMPLATE_CATEGORY_MISMATCH`
  - `SANDBOX_NOT_ALLOWLISTED`

### Resolution Workflows

#### Scenario A: Sandbox Not Allowlisted (Dev Environment)
- **Cause**: In dev mode, `DISPATCH_MODE=meta` blocks all recipient phone numbers not explicitly listed in `META_TEST_ALLOWLIST` (max 5 verified test numbers).
- **Remedy**:
  - Add the recipient phone number to Meta Business Suite Developer Portal > WhatsApp > API Setup > To Phone Numbers.
  - Add the phone number to `.env` variable `META_TEST_ALLOWLIST`.
  - Or switch `DISPATCH_MODE=dry` to simulate dispatching without live Meta calls.

#### Scenario B: Template Category Mismatch (Test Mode)
- **Cause**: Real Meta test templates (`hello_world`, `jaspers_market_plain_text_v1`) are registered under `UTILITY` or `UNKNOWN` category. Marketing campaigns require `MARKETING` templates per WhatsApp Business policy.
- **Remedy**:
  - In development and staging, set environment flag:
    ```env
    ALLOW_TEST_CATEGORY_MISMATCH=true
    ```
  - The UI will display a distinct amber "TEST ONLY" badge beside the template, allowing testing without production rejection.

#### Scenario C: Template Paused or Disabled by Meta
- **Cause**: Meta automated quality rating lowered template quality, causing Meta to pause the template.
- **Remedy**:
  - Check Meta WhatsApp Business Manager template status.
  - Update `src_templates` cache once Meta approves a revised template.

---

## Procedure 4: Historical Event Replay & Re-evaluation Safety

### Context & Tombstone Architecture (Spec p18, p25, QA Matrix B18)
When data retention pruning runs, detailed campaign executions and enrollments older than the retention threshold (e.g. 90 days) are pruned from the database.

To guarantee that replaying historical CRM events or re-running the calendar planner NEVER sends duplicate messages to customers whose records were pruned:
1. **Atomic Tombstone Creation**: Before detailed records are removed, `CampaignTombstoneModel` atomically writes logical-key tombstones (`tenantId`, `type`, `key`).
2. **Dual-Key Lookup**: All evaluators (`calendarPlannerService`, `inactivityEvaluatorService`, `workerService`) query both live collections AND tombstone keys.
3. **Permanent Idempotency**: If a tombstone exists for an enrollment key (`tenant:campaign:customer:occurrence`), evaluation skips instantly.

### Safe Replay Procedure
1. When re-ingesting legacy orders or replaying customer webhooks:
   - Ensure the event records include unique `eventId`.
   - Ingest events via `POST /api/v1/events/ingest`.
   - The inbox deduplicates identical `eventId`s.
2. If re-evaluating historical campaign horizons:
   - The planner verifies tombstones in `campaignTombstones`.
   - No duplicate enrollments or executions will be generated.

---

## Procedure 5: Emergency Tenant & Campaign Control

### Immediate Global Emergency Stop (Hard Rule 7, Spec p25, p34)
If an errant template, provider bug, or store emergency requires instantly halting ALL outbound WhatsApp messages across an entire tenant:

1. **Trigger Tenant Global Pause**:
   ```http
   POST /api/v1/campaigns/tenant-pause
   Authorization: Bearer <OWNER_JWT>
   ```
2. **Immediate Effect**:
   - `TenantControlGateModel` sets `isPaused: true`.
   - Workers executing final CAS submission atomically abort with `TENANT_GLOBAL_PAUSED`.
   - Active executions transition to `DEFERRED` with reason `GLOBAL_PAUSED`.
   - Zero outbound HTTP provider calls occur.

3. **Resume Operations Once Resolved**:
   ```http
   POST /api/v1/campaigns/tenant-resume
   Authorization: Bearer <OWNER_JWT>
   ```
   - Normal worker evaluation resumes and deferred steps catch up adhering to max lateness windows.

---

## Procedure 6: Seed Engine (F24b — Layered Additive Seed Architecture)

### Design Principles

The seed engine uses a **two-layer additive architecture**:

| Layer | Command | Creates | Labels |
|---|---|---|---|
| Platform | `seed:base` | Tenants, branches, users, settings, templates, connections, base customers | `seedGroup: "core"` |
| Scenario | `seed:scenario <name>` | Scenario-specific customers, orders, events, campaigns | `seedGroup: <scenario>` |

**Key invariants enforced by the engine:**
- `seed:base` creates **zero campaigns**.
- Each `seed:scenario` is **additive and upsert-only** — running scenario A then B never deletes A's data.
- All monetary values are stored in **integral paise** (minor units) — no floats.
- Phone numbers are logged only via `maskPhone()` — full numbers never appear in logs.
- `verifySeedEnvironment()` blocks all seed commands when `NODE_ENV=production`, DB name doesn't end in `_dev`/`_test`, or no replica set is configured.

### Common Seed Workflows

```powershell
# Fresh start: reset everything, seed base + all scenarios
pnpm seed:reset --yes
pnpm seed:demo

# Add a single scenario on top of existing base (non-destructive)
pnpm seed:scenario welcome

# Reload one scenario without affecting others
pnpm seed:scenario gift-wedding --reset

# Transfer live customer phone to a specific scenario's campaign
pnpm seed:scenario welcome --live

# Check current seed state
pnpm seed:status

# Remove all mock source data and scenario campaigns (preserve platform data)
pnpm seed:purge-mock --yes

# Nuclear wipe (drop all dev collections)
pnpm seed:reset --yes
```

### DevSeedState Document

The `dev_seedState` collection stores one document per tenant tracking:
- `liveOwner`: which scenario currently owns the live customer phone
- `appliedScenarios`: ordered list of all scenario names applied

Query directly for debugging:
```javascript
db.dev_seedState.find({ tenantId: 'shop_a' })
```

### Environment Guard — `verifySeedEnvironment()`

Called before **every** seed command. Throws with a clear message if any of the following are violated:
- `NODE_ENV === 'production'`
- `MONGODB_DB` does not end with `_dev` or `_test`
- `MONGODB_URI` does not include `replicaSet=` (transactions are required for atomicity)

