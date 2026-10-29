# F20: First-to-Second Purchase Bring-Back Campaign (FIRST_TO_SECOND_PURCHASE)

## 1. Feature Overview & Design Contract
The **First-to-Second Purchase Bring-Back Campaign** (`first_to_second_purchase` / `FIRST_TO_SECOND_PURCHASE`) automatically encourages customers who completed their first qualifying store purchase to return for a second visit. In apparel boutiques and handloom retail, converting a first-time buyer into a repeat customer is one of the highest-ROI interventions.

GroVastra monitors order events (`order.completed`, `order.updated`), identifies when a customer achieves their first qualifying order, and schedules a multi-step sequence of approved WhatsApp messages (e.g., Step 1: 30-day invitation, Step 2: 45-day follow-up). The engine evaluates eligibility, enforces quiet hours, binds order and reward variables, and halts automatically if the customer makes a second purchase, replies to WhatsApp, or opts out.

### Core Principles & Hard Boundaries
- **Autonomous Lifecycle**: The shop owner activates the preset once. Eligible customers are identified, planned, dispatched, stopped on reply/purchase/opt-out, and reported without manual "Send" buttons.
- **Monotonic Qualifying Order Accounting**: An order qualifies only if status is `COMPLETED`, `paid === true`, and `netPaise > 0`. A monotonic counter `maxQualifyingOrderCountSeen` tracks qualifying purchases. If a customer already has $\ge 2$ completed purchases upon evaluation, they are excluded (`ALREADY_REPEAT_CUSTOMER`).
- **Strictly Once-Per-Customer**: Each customer is enrolled at most once across the lifetime of the tenant (terminal state `ALREADY_NUDGED`, `occurrenceId: repeat:{orderId}`).
- **Automatic Stops (Spec p33 Precedence)**:
  1. Goal reached: a second qualifying order halts all pending executions with `SKIPPED_GOAL_REACHED`.
  2. Customer reply: halts with `SKIPPED_REPLY_HOLD`.
  3. Marketing opt-out or channel suppression: halts with `MARKETING_OPT_OUT` or `CHANNEL_SUPPRESSED`.
  4. Full refund before dispatch: halts with `FIRST_ORDER_NO_LONGER_QUALIFIES`.
- **Honest Metrics Boundary (Spec p28)**: Observational metrics only. "Observational, NOT sales attribution. No revenue claims."

---

## 2. Reusable Framework: `_shared/orderTrigger/` & `_shared/eventDelay/`
The campaign engine leverages the generic `EVENT_DELAY` architecture augmented by order trigger fact evaluators:

1. **`orderFacts.ts`**:
   - Computes `computeOrderFacts(orders, now)`:
     - `completedCount`: Active completed, paid orders with `netPaise > 0`.
     - `maxQualifyingOrderCountSeen`: Monotonic count including refunded qualifying orders.
     - `firstOrder`: Earliest completed qualifying order.
     - `lastOrder`: Most recent completed qualifying order.
     - `totalSpendPaise`: Sum of net revenue across qualifying orders.
     - `isRepeatCustomer`: True if `maxQualifyingOrderCountSeen >= 2`.

2. **`orderEventHandlers.ts`**:
   - `handleOrderCompletedEvent(tenantId, orderId)`: Triggers candidate evaluation when an order is completed.
   - `handleOrderUpdatedEvent(tenantId, orderId)`: Re-evaluates customer facts on refunds or status changes. Halts pending executions if the qualifying order is voided or refunded.
   - `handleSecondOrderGoalEvaluation(tenantId, customerId)`: Sweeps active enrollments and marks pending executions `SKIPPED_GOAL_REACHED`.

3. **`delayTiming.ts`**:
   - Computes `rawDueAt = orderCompletedAt + delay` (e.g. +30 days, +45 days).
   - Translates into tenant timezone (`Asia/Kolkata`).
   - Evaluates allowed sending hours (default 10:00–19:00), holidays, and blackout dates.
   - Implements `outsideHoursPolicy`:
     - `DEFER_NEXT_DAY`: Defers to allowed window start on next valid day.
     - `SKIP`: Skips execution with `skipReason: 'OUTSIDE_SENDING_HOURS'`.
   - Lateness cutoff: $\text{expiresAt} = \min(\text{adjustedDueAt} + \text{maxLateness}, \text{campaignEndAt})$. If elapsed, marked `SKIPPED_ELAPSED`.

4. **`dispatchRecheck.ts`**:
   - Pre-flight recheck milliseconds before Meta WhatsApp API dispatch:
     - Customer must still be active and marketing-opted-in.
     - First order must still be completed, paid, and have `netPaise > 0`.
     - Customer must not have completed a second qualifying order in the interim.
     - Customer must not have replied (`replyHoldAt == null`).
     - Campaign control gate and tenant send-window must remain open.

---

## 3. Rules Implementation Matrix (R01–R29)

| Rule | Requirement | Implementation & Verification |
| :--- | :--- | :--- |
| **R01** | Event delay trigger | Preset configures `EVENT_DELAY` anchored to `FIRST_QUALIFYING_ORDER`. |
| **R02** | Monotonic qualifying count | `computeOrderFacts` tracks `maxQualifyingOrderCountSeen` across refunds and updates. |
| **R03** | Qualifying criteria | Order must have status `COMPLETED`, `paid === true`, and `netPaise > 0`. |
| **R04** | Non-qualifying handling | Pending, cancelled, unpaid, or zero-rupee orders are excluded (`NO_QUALIFYING_ORDER`). |
| **R05** | Timezone & business hours | Luxon evaluates tenant timezone (`Asia/Kolkata`) sending window (10:00–19:00). |
| **R06** | Outside-hours policy | `DEFER_NEXT_DAY` moves candidate to next morning; `SKIP` cancels outside window. |
| **R07** | Relative delay calculation | Step 1 and Step 2 due dates calculated relative to order anchor (`rawDueAt = anchorAt + delay`). |
| **R08** | Lateness & arrival cutoff | `FUTURE_ONLY` arrival policy marks executions beyond lateness window as `SKIPPED_ELAPSED`. |
| **R09** | Lifetime once-per-customer | Terminal enrollment check prevents re-enrollment (`ALREADY_NUDGED`, `occurrenceId: repeat:{orderId}`). |
| **R10** | Existing repeat exclusion | Customers with $\ge 2$ completed orders upon arrival are excluded (`ALREADY_REPEAT_CUSTOMER`). |
| **R11** | Multi-step support | Supports multi-step sequences (e.g. Step 1: 30 days, Step 2: 45 days). |
| **R12** | Step prerequisites | Step 2 enforces prerequisite `step_1` completion before dispatching. |
| **R13** | Second order goal stop | Any subsequent qualifying order transitions pending executions to `SKIPPED_GOAL_REACHED`. |
| **R14** | WhatsApp reply stop | Customer WhatsApp inbound message transitions pending executions to `SKIPPED_REPLY_HOLD`. |
| **R15** | Reply attribution | Distinguishes exact campaign button replies from conservative inbound hold window. |
| **R16** | Suppression & opt-out | Customer opt-out immediately cancels unexecuted messages with `MARKETING_OPT_OUT`. |
| **R17** | Full refund handling | Full refund reduces qualifying count and cancels executions with `FIRST_ORDER_NO_LONGER_QUALIFIES`. |
| **R18** | Pre-flight safety recheck | Milliseconds before Meta dispatch, verifies order status, goal, reply, and consent. |
| **R19** | Variable bindings | Resolves `customer.firstName`, `shop.displayName`, `order.firstOrderDate`, `order.firstOrderAmount`. |
| **R20** | Missing variable safety | Fallback values ensure no raw curly braces `{{...}}` reach customer WhatsApp. |
| **R21** | Meta delivery lifecycle | Transitions execution through `PROVIDER_ACCEPTED` $\rightarrow$ `SENT` $\rightarrow$ `DELIVERED` $\rightarrow$ `READ`. |
| **R22** | Hard Rule 1 (Tenant isolation) | Scoped strictly to authenticated `tenantId` in every database query and mutation. |
| **R23** | Hard Rule 2 (Integer paise) | Currency stored and computed strictly as integer paise (`netPaise`, `grossPaise`, `refundedPaise`). |
| **R24** | Observational metrics | `GET /campaigns/:id/repeat-purchase/summary` provides honest non-revenue counts. |
| **R25** | Single attribution policy | Adheres to Spec p28 single-attribution window for campaign performance. |
| **R26** | Nightly reconciliation | `reconcileEventDelayCampaign` sweeps backfill candidates without duplicate enrollments. |
| **R27** | Mock ledger integration | Supports optional loyalty reward balance and credit expiry bindings. |
| **R28** | Dev simulation endpoints | Full suite of dev endpoints (`/dev/mock-orders`, `/dev/mock-refunds`, etc.). |
| **R29** | Full test coverage | 100% pass rate across all 29 rules in `first-to-second-purchase.test.ts`. |

---

## 4. Endpoints & Security Scopes

| Method | Path | Roles | Purpose |
| :--- | :--- | :--- | :--- |
| `GET` | `/campaigns/:id/repeat-purchase/summary` | `owner`, `admin`, `staff` | Observational summary: enrolled first orders, active/excluded breakdown, delivered/read counts, replies & holds. |
| `POST` | `/dev/mock-orders` | Dev / Owner | Simulates order completion event and triggers real-time campaign evaluation. |
| `POST` | `/dev/mock-refunds` | Dev / Owner | Simulates order refund event and triggers order fact recalculation. |
| `POST` | `/dev/reconcile-first-to-second-purchase` | Dev / Owner | Triggers batch reconciliation sweep for repeat purchase enrollments. |

---

## 5. UI Integration (`apps/web`)

1. **Campaigns Catalogue**:
   - Preset card for **First to Second Purchase Bring-Back** (`first_to_second_purchase`).
   - Marked `Ready to Configure` (`implemented: true`).
   - One-click launchpad creating a configured multi-step draft.

2. **Campaign Editor Wizard**:
   - **Step 1 (Trigger)**: Displays `EVENT_DELAY (First Qualifying Order Delay)` with anchor `FIRST_QUALIFYING_ORDER (First Qualifying Order Completed)`.
   - **Step 3 (Messages)**: Configures delay values in days (e.g. 30 days, 45 days) with extended range up to 180 days. Informational banner explains automatic halting on second order.
   - **Step 5 (Review & Validate)**: Real-time validation matrix validating approved Meta templates (`tpl_repeat_visit_invite`, `tpl_repeat_visit_reward`, etc.).

3. **Performance & Attribution Dashboard**:
   - Dedicated **Repeat Purchase Bring-Back Summary (F20)** card.
   - Observational banner: `"Observational metrics only • NOT sales attribution"`.
   - 5 KPI tiles:
     - **First Orders Enrolled** (active vs excluded count)
     - **Scheduled / Deferred** (scheduled due vs outside-hours deferred)
     - **Delivered & Read** (WhatsApp delivery & confirmed read receipts)
     - **Skipped Executions** (evaluated and safely skipped)
     - **Replies & Holds** (exact campaign replies vs active reply holds)
   - Excluded & Skipped reason chip breakdowns (e.g., `ALREADY_REPEAT_CUSTOMER`, `SKIPPED_GOAL_REACHED`).
