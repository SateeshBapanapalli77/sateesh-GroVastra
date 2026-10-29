=== BLOCK G: PROJECT CONTEXT ===
PROJECT: GroVastra Auto Campaigns. An automatic WhatsApp campaign engine for handloom
stores, boutiques and apparel shops. An owner activates a preset (e.g. Birthday). The
system picks eligible customers, plans steps, sends ONE approved WhatsApp template per
step, stops on reply/purchase/opt-out, and reports results. A manual "Send" button is
NOT the goal.

SOURCE OF TRUTH: /docs/spec/ (GroVastra Auto Campaigns Developer Handoff v2.0 PDF).
Page numbers in prompts refer to that PDF. Before starting, ALSO read
/docs/PROJECT_CONTEXT.md, /docs/PROGRESS.md and /docs/ASSUMPTIONS.md (if they exist),
/docs/meta-templates.json and /docs/samples/*.json.

STACK (fixed, do not change): Next.js (App Router) + React + TypeScript (apps/web) |
Node.js + TypeScript (apps/api; planner, event-consumer and worker run as separate
processes from the same codebase) | MongoDB replica set with transactions | Mongo-backed
scheduler | NO Redis | WhatsApp Cloud API (Meta) is the ONLY channel.
Libraries I chose: pnpm monorepo, Express, Mongoose, zod, luxon, pino, Vitest.

ENVIRONMENT FACTS:
- Windows machine, PowerShell. Write cross-platform scripts (no bash-only commands).
- NO Docker. MongoDB Community runs locally as a single-node replica set
  (replSetName rs0), used through Compass. Dev DB: grovastra_dev. Test DB:
  grovastra_test. Connection: mongodb://localhost:27017/?replicaSet=rs0.
  Transactions are required.
- No real CRM/orders/inventory/appointment systems exist. All source data is SEEDED MOCK
  DATA in "src_*" collections, read ONLY through adapter interfaces so real systems can
  replace them later.
- WhatsApp = Meta TEST number only (Graph API v25.0 pinned via the connection record,
  phoneNumberId 1290524220819472). Real sends go only to numbers in env
  META_TEST_ALLOWLIST (max 5 verified phones). Other customers are blocked by a
  dev-only sandbox guard with reason SANDBOX_NOT_ALLOWLISTED.
- The 3 real Meta test templates (hello_world, jaspers_market_plain_text_v1,
  jaspers_market_order_confirmation_v1) are all UTILITY/UNKNOWN. A dev-only flag
  ALLOW_TEST_CATEGORY_MISMATCH lets a MARKETING campaign use them, shown with a
  "TEST ONLY" badge.
- Templates are provided by another team. This project NEVER creates, submits or
  approves templates and has NO UI for token entry, template creation or approval.
  Dummy templates are marked sendable=false.
- There is NO WhatsApp simulator. Failure-path tests use stubbed HTTP in automated tests.
- Secrets live only in .env (gitignored). Never print, log, commit or return them.

HARD RULES (from the spec):
1. tenantId on every collection, index and query. Tenant comes from auth, never from
   the request body or route IDs.
2. Money = integer minor units (paise). Instants = BSON Date UTC. Date-only values
   (birthday) are stored as {month, day} or explicit date objects, NEVER via midnight UTC.
3. Never use one setTimeout per future message. All schedules live in MongoDB.
4. Never do provider HTTP inside a Mongo transaction.
5. Business-identity keys never include campaign version, template revision, retry
   count, worker ID or schedule time (spec p18).
6. Published campaign versions are immutable. Existing enrollments keep their version.
7. Mandatory gates always apply: active customer, valid destination, marketing
   permission, channel suppression, no duplicate enrollment (spec p10).
8. Never infer religion, relationships, birthdays or partner contacts. Never invent
   offers. No free-text or rewritten messages, no silent template/language swap.
9. Logs never contain full phone numbers or message bodies. Phones are encrypted;
   show masked values in the UI.
10. No preset appears as functional in the UI until its evaluator is implemented.

WORKING RULES:
- Build ONE feature end to end (DB schema + indexes, backend API, UI, tests). Do not
  start other features. Create only the collections this feature needs.
- Follow existing code conventions. Validate all input with zod. Return structured errors.
- Welcome is purchase-based only. Never reintroduce visit triggers, visit records or staff 'record visit' actions without written manager approval.
- Template values and message payloads are produced ONLY by apps/api/src/templates/ (resolveForStep, canonicalizeParameters, buildMetaTemplateBody). New binding sources are added in bindingSources.ts only. The LINT01 test enforces this.
- If the spec is ambiguous or contradicts itself, do NOT guess silently. Write the
  assumption in /docs/ASSUMPTIONS.md and list it in your final summary.
- At the end: update /docs/PROGRESS.md (what exists: collections, endpoints, pages,
  env vars, how to run/test), then give me: files changed, how to run, a manual
  test checklist, tests added, known gaps. Then STOP and wait for my confirmation.
=== END BLOCK G ===