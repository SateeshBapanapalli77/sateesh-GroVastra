# GroVastra Auto Campaigns - Progress & Status

## Project Status: Feature F31 Complete — Outfit Collection / Delivery Campaign (OD00–OD36)

Feature F31 (Outfit Collection / Delivery campaign, `outfit_collection_delivery`) is fully implemented and tested. It includes:
- Preset family registered with key `outfit_collection_delivery` and aliases (`OUTFIT_COLLECTION_DELIVERY`, `outfit_fulfilment`, `fulfilment_milestone`, `outfit_collection`) operating under category `SERVICE`, purpose `SERVICE`, priority 60, and trigger family `PRODUCTION_MILESTONE`.
- Supported milestones: `OUTFIT_READY` (`ready:${orderId}:${readinessVersion}`), `DISPATCHED` (`dispatch:${orderId}:${shipmentId}`), and `DELIVERED` (`delivered:${orderId}:${shipmentId}`).
- Strict adherence to the 10 Hard Rules:
  - Read-only ingestion boundary: Production code never writes `src_fulfilments` or `src_orders` (accessed exclusively via read-only `FulfilmentSource` interface).
  - Authoritative readiness version: Engine never computes `readinessVersion`, only compares source versions.
  - Delivery arranged pickup blocking: *"If delivery is arranged, do not send pickup instructions"* (`DELIVERY_ARRANGED`).
  - Verified shipment dispatch: *"Label creation alone is not dispatch"* (`UNVERIFIED_SHIPMENT_EVENT`).
  - Recheck at dispatch: Changed destination or readiness version blocks message with `BLOCKED_STALE_INTENT`.
  - Pre-submission lifecycle recheck: Orders collected or delivered skip pending uncollected reminders (`ORDER_COLLECTED`, `ORDER_DELIVERED`, etc.).
- Meta UTILITY template compliance: 6 templates mapped strictly to `UTILITY` (`tpl_fulfil_ready`, `tpl_fulfil_ready_partial`, `tpl_fulfil_reminder`, `tpl_fulfil_dispatched`, `tpl_fulfil_dispatched_simple`, `tpl_fulfil_delivered`). Marketing caps not consumed; 24h default service spacing between uncollected reminders.
- Late snapshot variable resolution for `order.number`, `shipment.carrierName`, `shipment.trackingRef`, and `shop.displayName`.
- Checkpointed offline reconciler (`reconcile:fulfilment`) using `CampaignCheckpointModel` and bounded scanning.
- Seed scenario `outfit-fulfilment`: 14 customers, 16 fulfilments, 4 campaigns across pickup and delivery modes.
- Complete automated test suite OD00–OD36: 37/37 passing (OD00 meta-test verifying `docs/test-matrix/OD.txt` verbatim + OD01 through OD36).
- Web UI updates: `Truck` preset icon, `SERVICE` badge in preset library, trigger milestone & mode filter controls, static compliance notice, bindings helper hint, and interactive Mock Fulfilment Dev Review panel in `apps/web`.

### F31 Status: COMPLETE

## Previous Milestone: Feature F30 Complete — Fitting / alteration campaign (FA01–FA35)

Feature F30 (Fitting / alteration campaign) is fully implemented and tested. It includes:
- Clarified single catalog preset vs two operational sequences: Defined as a single catalog preset family (`id: 'fitting_alteration'`, `category: 'SERVICE'`, `triggerFamily: 'PRODUCTION_MILESTONE'`) with aliases (`FITTING_ALTERATION`, `fitting`, `alteration`, `fitting_appointment`, `alteration_milestone`) covering both Fitting Appointment sequence (`fitting:appointmentId`) and Alteration Milestone sequence (`alteration:jobId:milestoneId`).
- Service category & anti-cap-bypass: Operates under purpose `SERVICE` (does not consume marketing contact caps). Enforces strict C14 anti-marketing-bypass (no discounts, promotions, or voucher variables in service templates).
- Authoritative database schemas and adapters: `src_appointments` (`appointment-source.ts`) and `src_alterations` (`alteration-source.ts`) with compound unique indexes and status querying.
- Pure matching engines: `matchFittingAppointment` and `matchAlterationMilestone` verifying customer status, suppression, appointment status/date validity, and alteration job stage integrity.
- Late snapshot variable bindings: `appointment.serviceType`, `appointment.date`, `appointment.time`, `appointment.branch`, `appointment.stylistName`, and `alteration.jobId`, `alteration.garment`, `alteration.stage`, `alteration.trialDate`, `alteration.notes`.
- Enroller & QA Matrix A17:
  - Immediate confirmation step + 24h reminder step for appointments; skips reminder if appointment is within 24h (`APPOINTMENT_PASSED`).
  - Stage execution planning for alteration milestones; strictly enforces anti-overpromise rule (never imply full outfit is ready when only a partial stage is complete).
  - Rescheduling moves unsubmitted reminders to 24h before new time, updates `dateHistory` with `APPOINTMENT_RESCHEDULED`, and increments `planRevision`. Cancellation or completion stops unsubmitted reminder executions.
- Event lifecycle consumers: `appointments` (`appointment.booked`, `appointment.rescheduled`, `appointment.cancelled`, `appointment.completed`) and `alterations` (`alteration.stage_changed`, `alteration.trial_ready`, `alteration.completed`, `alteration.cancelled`).
- Reconciler script and endpoints: `GET /campaigns/:id/fitting-alteration/summary`, `POST /campaigns/:id/fitting-alteration/preview`, and dev trigger routes.
- Seed scenario `fitting-alteration`: 4 appointments, 3 alterations, 25 customers across `shop_a` and `shop_b`, active campaign `cmp_fitting_alteration`.
- Complete test suite FA01–FA35: 36/36 tests passing (FA00 meta-test + FA01 through FA35).
- Web UI: Preset icon `Scissors` in `apps/web/app/campaigns/page.tsx`, and interactive flow toggle simulator card in `apps/web/app/campaigns/[id]/page.tsx`.

### F30 Status: COMPLETE

## Previous Milestone: Feature F29 Complete — Exhibition / trunk show campaign (EX01–EX35)

Feature F29 (Exhibition / trunk show campaign) is fully implemented and tested. It includes:
- Store events database schema and adapter (`src_events`, `event-source.ts`) with compound unique index `{ tenantId: 1, eventId: 1 }` and `{ tenantId: 1, status: 1, startDate: 1 }`.
- Customer schema update: added `city?: string | null` to `ISrcCustomer` and `SrcCustomerSchema` for localized geographic event filtering.
- Pure preference matching module (`matchExhibitionEvent`) strictly adhering to Hard Rule 8 (customer name, gender, or religion is never inferred). Only declared category affinities, geographic location (`customer.city` matching `event.venue.city`), capacity status, and existing RSVP status are evaluated.
- Capacity & RSVP gating:
  - If event is marked `FULL` or `registeredCount >= capacity`, matching rejects candidate with `EVENT_AT_CAPACITY`.
  - If customer has already registered/RSVP'd, generic invites are skipped with `CUSTOMER_REGISTERED`.
- Full preset registration (`exhibition_trunk_show` and aliases `EXHIBITION_TRUNK_SHOW`, `exhibition`, `trunk_show`, `store_event`) with trigger type `OWNER_DATED_EVENT` / `STORE_EVENT`, default priority 45, Step 1 Invite (D-14), and Step 2 Reminder (D-3).
- Store event event-family ingestion (`event.published`, `event.updated`, `event.cancelled`, `rsvp.completed`) with schema validation, non-existent event quarantine (`EVENT_INVALID`), bounded cursor fan-out with checkpoint persistence (`exhibition-fanout:{eventId}:{campaignId}`), and cancellation on event cancellation.
- Step execution timing capped at `event.startDate`, skipping elapsed or past steps with `EVENT_ENDED` / `SKIPPED_ELAPSED`.
- Late variable snapshot resolution for `event.name`, `event.date`, `event.venue`, `event.city`, and `event.rsvpLink`.
- Goal handler stopping active enrollments and recording goal events upon matching `order.completed` events referencing `eventRef: eventId` or `occasionRef: storeevent:{eventId}`, as well as on customer RSVP completion.
- Reconciler script and endpoints (`GET /campaigns/:id/exhibition/summary`, `POST /campaigns/:id/exhibition/preview`, `POST /dev/exhibition/trigger-event`).
- Complete seed scenario `exhibition-trunk-show` with test fixtures (`evt_ex_mumbai_2026`, `evt_ex_delhi_2026`, `cus_ex_01-25`, shop_b customers, and `cmp_exhibition_trunk_show`).
- Complete test suite EX01–EX35 (36 passed tests, including meta-test EX00 verifying `docs/test-matrix/F29.txt`).
- Web UI test preview and summary card in `apps/web/app/campaigns/[id]/page.tsx` and preset icon in `apps/web/app/campaigns/page.tsx`.

### F29 Status: COMPLETE

DONE:
- Prerequisites gate: MongoDB `rs0` replica set, all previous suites passing.
- Templates verified in `docs/meta-templates.json` (`tpl_exhibition_invite`, `tpl_exhibition_reminder`).
- Store event schema (`src_events`), ingestion validation & quarantine.
- Hard Rule 8 preference matching, geography, capacity, RSVP, and variable bindings (`event.name`, `event.date`, `event.venue`, `event.city`, `event.rsvpLink`).
- Enroller, idempotent fan-out, and event-delay engine integration.
- Goal match handler on `order.completed` and RSVP completion.
- Full test suite `exhibition-trunk-show.test.ts` (EX00-EX35, 36/36 tests passed).
- Seed scenario `exhibition-trunk-show` implemented and verified.
- Web UI test preview and summary endpoints verified.

## Previous Milestone: Feature F28 Complete — Festival collection campaign (FC01–FC35)

DONE:
- Prerequisites gate: MongoDB `rs0` replica set, all previous suites passing.
- Templates verified in `docs/meta-templates.json` (`tpl_collection_new_items`, `tpl_collection_new_simple`, `tpl_collection_followup`).
- Season schema extension (`src_seasons`), ingestion validation & quarantine.
- Hard Rule 8 preference matching, item capping, and variable bindings (`festival.name`, `festival.date`, `collection.name`, `match.itemList`).
- Enroller, idempotent fan-out, and event-delay engine integration.
- Goal match handler on `order.completed`.
- Full test suite `festival-collection.test.ts` (FC00-FC35, 36/36 tests passed).
- Seed scenario `festival-collection` implemented and verified.
- Web UI test preview and summary endpoints verified.

## Previous Milestone: Feature F27 Complete — Selected-stock promotion (SP01–SP35)


### What Exists

#### Collections
- `src_products` - Read-only external product & inventory catalogue (`tenantId`, `productId`, `name`, `category` [saree|blouse|lehenga|kurta|dupatta|accessories|petticoat|jewellery], `colourFamily`, `weave`, `pricePaise`, `status` [ACTIVE|DISCONTINUED], `entityVersion`, `variants` [{ variantId, label, sellableQty, version }]). Compound index `{ tenantId: 1, category: 1, status: 1 }`. Production code strictly prohibited from writing to this collection (verified via AST boundary tests Q26, OF29, & RA29).
- `src_requests` - Read-only external boutique customer product requests (`tenantId`, `requestId`, `customerId`, `branchId`, `status` [OPEN|FULFILLED|CANCELLED|EXPIRED], `source` [CUSTOMER_DECLARED|STAFF_ON_BEHALF|MOCK], `declaredByCustomer`, `itemRef` [productId, variantId], `conditions` [size, colourFamily, weave], `createdAt`, `updatedAt`, `expiresAt`, `entityVersion`, `seedGroup`). Compound unique index `{ tenantId: 1, requestId: 1 }`. Production code strictly prohibited from writing to this collection (verified via AST boundary test RA29).
- `src_orders` - Source order history (`tenantId`, `orderId`, `customerId`, `status`, `paid`, `netPaise` in minor units, `outfitRef`, `occasionRef`, `lines` [lineId, productId, variantId, qty, returnedQty, lineNetPaise, pricePaise], `entityVersion`, `completedAt`, `branchId`). Compound unique index `{ tenantId: 1, orderId: 1 }`. Production code strictly prohibited from writing to this collection (verified via AST boundary tests OF29 & RA29).
- `src_enquiries` - Read-only external boutique customer product enquiries (`tenantId`, `enquiryId`, `customerId`, `branchId`, `channel`, `status` [OPEN|RESOLVED|CLOSED|CANCELLED|DELETED], `staffTakeover`, `itemRef` [productId, variantId], `createdAt`, `lastCustomerInteractionAt`, `updatedAt`, `entityVersion`, `source`). Production code strictly prohibited from writing to this collection (verified via AST boundary test Q26).
- `src_offers` - In-store coupon offers (`offerId`, `tenantId`, `kind`, `amountPaise`, `validFrom`, `validUntil`, `status`, `version`, timestamps).
- `campaignTombstones` - Spec p18, p25, QA Matrix B18 logical-key tombstones collection (`tenantId`, `type` [ENROLLMENT|EXECUTION], `key`, `campaignId`, `customerId`, `occurrenceId`, `stepId`, `tombstonedAt`, `originalId`, `retentionReason`, `metadata`, timestamps). Compound unique index `{ tenantId: 1, type: 1, key: 1 }` per Spec p25, and indexes on `{ tenantId: 1, campaignId: 1 }`, `{ tenantId: 1, customerId: 1 }`, `{ tenantId: 1, tombstonedAt: -1 }`. Created atomically inside the retention transaction BEFORE pruning detailed enrollments/executions. All evaluators (calendar planner, inactivity evaluator, step worker) check both live collections and tombstones to permanently prevent duplicate steps upon historical replay (B18).
- `campaignEventInbox` - Spec p20, p24, p25 durable domain event inbox and dead-letter quarantine store (`tenantId`, `producer`, `eventId`, `type`, `schemaVersion`, `entityId`, `entityVersion`, `occurredAt`, `receivedAt`, `customerId`, `data`, `status` [PENDING|PROCESSED|QUARANTINED|FAILED], `quarantineReason` [UNKNOWN_SCHEMA|STALE_ENTITY_VERSION|PRODUCER_FAMILY_MISMATCH|SOURCE_UNAVAILABLE|INVALID_PAYLOAD|CROSS_TENANT_REJECTED], `quarantineDetails`, `processedAt`, `error`, timestamps). Compound unique index `{ tenantId: 1, producer: 1, eventId: 1 }` per Spec p25 and indexes on `{ tenantId: 1, status: 1, occurredAt: 1 }` and `{ tenantId: 1, type: 1 }`. Durably deduplicates all incoming producer events before acknowledging HTTP 200.
- `campaignCustomerFacts` - Spec p14, p21 durable customer facts projection, fully rebuildable from source orders (`tenantId`, `customerId`, `orderCount`, `totalSpendPaise`, `firstOrderAt`, `lastOrderAt`, `lastOrderId`, `lastQualifyingPurchaseAt`, `lastQualifyingOrderId`, `aggregateVersion`, `authoritativeSourceVersions`, `nextEvaluationAt`, `categoryPurchases`, timestamps). Compound unique index `{ tenantId: 1, customerId: 1 }`, and performance indexes `{ tenantId: 1, nextEvaluationAt: 1 }` and `{ tenantId: 1, lastQualifyingPurchaseAt: 1 }`. Enforces strict Spec p14 qualifying purchase rules: `paid: true`, `status: 'COMPLETED'`, `netPaise > 0` (pending, cancelled, or zero-value orders never count; partial returns affect net amounts). Tracks per-category qualifying purchases.
- `campaignGoalEvents` - Spec p11, p20, p26, p33 durable campaign goal and occasion conversion store (`goalEventId`, `tenantId`, `enrollmentId`, `occurrence`, `customerId`, `campaignId`, `source` [ORDER_OCCASION|STAFF_MANUAL|STAFF_ATTRIBUTED|ORDER_OCCASION_MATCH|MANUAL_CONVERSION|OTHER], `orderRef`, `cause`, `supportingRecord`, `recordedBy`, `at`, timestamps). Compound unique index `{ tenantId: 1, goalEventId: 1 }` and indexes on `{ tenantId: 1, enrollmentId: 1, at: -1 }` and `{ tenantId: 1, occurrence: 1, customerId: 1 }`. Stores explicit staff-attributed or matched domain goal evidence. Delivery alone never creates a goal.
- `tenantControlGates` - Spec p20, p25 tenant-level emergency control gate document (`tenantId`, `isPaused`, `pauseGeneration`, `version`, timestamps). Compound unique index `{ tenantId: 1 }`. Provides atomic CAS gate locking inside multi-document submission transactions to halt all message dispatches across campaigns and invalidate racing submissions.
- `campaignContactGates` - Spec p18, p25 rolling contact capacity and destination collision gate (`tenantId`, `destinationHash`, `version`, `ledger` array of `{ executionId, campaignId, purpose, reservedAt, status, releasedAt, releaseReason, updatedAt }`, timestamps). Compound unique index `{ tenantId: 1, destinationHash: 1 }`. Bounded rolling ledger keeps in-flight `RESERVED` locks, records terminal outcomes (`ACCEPTED`, `UNKNOWN`, `RELEASED`), and prunes old aged-out entries beyond 30 days or released entries beyond 24 hours. Monotonically increasing `version` guarantees optimistic lock arbitration in concurrent execution claims.
- `campaignProviderEvents` - Spec p27, QA Matrix C10 durable provider event store (`eventId`, `tenantId`, `phoneNumberId`, `eventType` [STATUS|INBOUND_MESSAGE], `messageId`, `status`, `timestamp`, `recipientHash`, `recipientMasked`, `dedupeKey`, `rawPayload`, `correlatedExecutionId`, `correlatedEnrollmentId`, `replyAttribution`, `processed`, timestamps). Compound unique index `{ tenantId: 1, dedupeKey: 1 }` and `{ tenantId: 1, messageId: 1 }`. Stores raw payloads with phones masked and customer text bodies redacted per Hard Rule 9. Deduplicates per status event (`messageId:status:timestampSec`) and per inbound message.
- `campaigns` - Campaign metadata, state, and version pointers (`campaignId`, `tenantId`, `name`, `presetId`, `status` [DRAFT|VALIDATED|ACTIVE|PAUSED|ARCHIVED], `activeVersionId`, `draftVersion`, `pauseGeneration`, `enabledBranches`, `activatedAt`, `endAt`, timestamps). Unique compound index `{ tenantId: 1, campaignId: 1 }` and `{ tenantId: 1, status: 1, createdAt: -1 }`.
- `campaignVersions` - Immutable campaign version snapshots and working drafts (`tenantId`, `campaignId`, `version`, `trigger` [type, field, leapDayPolicy], `audience` [mode, rules], `steps` [stepId, stepName, offsetDays, localTime, prerequisite, templateRef, bindings, stopOnReply, stopOnGoal, maxLatenessMinutes], `goal` [type, lookbackDays, purchaseWithinDays, minOrderValuePaise], `timezone`, `isPublished`, `activatedBy`, `activatedAt`, `reviewFingerprint`, `nextEvaluationAt`, timestamps). Compound unique index `{ tenantId: 1, campaignId: 1, version: 1 }` per Spec p25. **Enforced Immutability**: Mongoose pre-save and pre-update hooks block any update or mutation once `isPublished: true`.
- `campaignControlGates` - Control-gate document tracking concurrency state, pause generation, and active version pointers (`tenantId`, `campaignId`, `pauseGeneration`, `version`, timestamps). Compound unique index `{ tenantId: 1, campaignId: 1 }`.
- `campaignDryRuns` - Candidate dry run simulations and diagnostic evaluations (`tenantId`, `campaignId`, `dryRunId`, `draftVersion`, `draftFingerprint` [SHA-256], `counts` [scanned, eligible, excluded], `reasonBreakdown`, `samplePlans` [with local dates, UTC instants, and rendered WhatsApp messages], `excludedSamples`, `evaluatedAt`, `evaluatedBy`, `isStale`, timestamps). Compound indexes `{ tenantId: 1, campaignId: 1, createdAt: -1 }` and `{ tenantId: 1, dryRunId: 1 }`. Guarantees ZERO live writes to enrollments or executions (Spec p8, p26, C01).
- `campaignEnrollments` - Spec p25 compound unique index `{ tenantId: 1, campaignId: 1, customerId: 1, occurrenceId: 1 }`. Stores `enrollmentId`, `enrollmentKey` (`tenant:campaign:customer:occurrence`), `campaignVersionId`, `campaignVersion`, `customerId`, `occurrenceId` (`birthday:YYYY`, `anniversary:eventId:year`, `wedding:eventId`, or `gift:eventId`), `occasionLocalDate`, `occasionKind` (`WEDDING`|`GIFT`), `eventDate`, `fulfillmentLeadDays`, `dateHistory` array (`{ oldDate, newDate, changedAt, reason }`), `sourceRef`, `matchExplanation` ("why selected"), `status` (ACTIVE|COMPLETED|CANCELLED|FAILED), `replyHoldAt`, `lastReplyHoldAt`, `replyAttribution` (CAMPAIGN|NOT_CAMPAIGN_CONSERVATIVE), `replyContextMessageId`, `holdResolvedAt`, `holdResolvedBy`, `holdResolutionCause`, `goalReachedAt`, `goalEventId`, `goalOrderRef`, `goalSource`, `orderRef`, timestamps.
- `campaignExecutions` - Spec p25 compound unique index `{ tenantId: 1, enrollmentId: 1, stepId: 1 }` and state index `{ state: 1, dueAt: 1, _id: 1 }`. Stores `executionId`, `executionKey` (`enrollmentId:stepId`), `stepId`, `stepName`, `dueAt` (UTC), `originalDueAt` (UTC), `expiresAt` (UTC), `localDate`, `localTime`, `timezone`, `planRevision`, `state` (SCHEDULED|DEFERRED|EVALUATING|DISPATCHING|SKIPPED|CANCELLED|EXPIRED|BLOCKED|PROVIDER_ACCEPTED|SENT|DELIVERED|READ|OUTCOME_UNKNOWN|FAILED), `skipReason`, `usefulUntilReason`, `prerequisite`, `templateRef`, `deliveryIntentId`, `lease` (`token`, `until`), `providerMessageId` (wamid), `providerStatus`, `sentAt`, `deliveredAt`, `readAt`, `failedAt`, `statusHistory`, `lastErrorCategory`, `retryAt`, `attemptCount`, and `attempts` history array (`attemptId`, `attemptNumber`, `startedAt`, `completedAt`, `status`, `providerMessageId`, `httpStatus`, `errorCode`, `errorCategory`, `errorMessage`), timestamps.
- `campaignDeliveryIntents` - Spec p23, p25 immutable frozen delivery intent collection (`deliveryIntentId`, `tenantId`, `campaignId`, `enrollmentId`, `executionId`, `deliveryKey` = `executionId`, `attemptId`, `recipientVersion`, `maskedRecipient`, `templateRef` [id, revision, language], `parameters` [sorted by variable index], `payloadHash` [SHA-256], `state` [PREPARED_DRY|PENDING_SUBMISSION|SENT_TO_PROVIDER|SENT|DELIVERED|READ|REJECTED_LOCALLY|OUTCOME_UNKNOWN|FAILED], `providerMessageId`, `failureReason`, `attempts` history array, `lastErrorCategory`, `retryAt`, `dispatchedAt`, `createdAt`, `updatedAt`). Compound unique indexes `{ tenantId: 1, executionId: 1 }` and `{ tenantId: 1, deliveryIntentId: 1 }`. Protected against payload modifications at the schema layer.
- `campaignCheckpoints` - Spec p25 compound unique index `{ tenantId: 1, campaignId: 1, type: 1 }`. Stores `type` (`CALENDAR_PLANNER`), `status` (IN_PROGRESS|COMPLETED|FAILED), `lastCustomerId`, `horizonStart`, `horizonEnd`, `processedCount`, `enrolledCount`, `leaseToken`, `leaseExpiresAt`, `startedAt`, `completedAt`, `error`, timestamps.
- `idempotencyRecords` - Idempotency store for mutating API requests (`tenantId`, `key`, `statusCode`, `response`, `createdAt`). Compound unique index `{ tenantId: 1, key: 1 }` with 24-hour TTL.
- `tenants` - Tenant organization profiles (`tenantId`, `name`, `status`, timestamps).
- `branches` - Physical branches belonging to a tenant (`tenantId`, `branchId`, `name`, `isMain`, `status`). Unique compound index `{ tenantId: 1, branchId: 1 }`.
- `users` - Multi-tenant user accounts (`tenantId`, `email`, `passwordHash`, `role` [owner|admin|staff], `branchIds`, `name`, `status`). Unique compound index `{ tenantId: 1, email: 1 }`.
- `auditLog` - Append-only immutable audit trail (`tenantId`, `userId`, `action`, `metadata`, `ip`, `userAgent`, `createdAt`). Protected against updates and deletions at the database schema layer.
- `campaignSettings` - Tenant-level campaign policies and configuration (`tenantId`, `version`, `timezone`, `allowedSendingHours` [start, end], `blackoutDates`, `holidays` [date, name], `marketingCaps` [daily, weekly], `serviceContactSpacingHours`, `outageGraceHours`, `resumePolicy` [FUTURE_ONLY], `importPolicy` [FUTURE_ONLY], `priorityAllowlistRanges` [birthday, anniversary, wedding, requestedStock, festival, winBack], `isPaused`, `bookingLinkUrl`, `lastIdempotencyKey`, `lastResponse`). Unique index on `{ tenantId: 1 }`.
- `src_customers` - Read-only mock source customer directory (`tenantId`, `customerId`, `firstName`, `destination` [encryptedPhone, destinationHash, masked, verified, version], `birthday` [month, day], `consent` [marketingOptIn, channelSuppressed], `preferences` [weave, budgetMaxPaise, size, colour], `tags`, `status`, `branchId`, `deletedAt`, `version`, `language`, `isLive`). Compound unique index `{ tenantId: 1, customerId: 1 }`.
- `src_customerEvents` - Saved customer occasion events/anniversaries (`tenantId`, `customerId`, `eventId`, `type` [`BIRTHDAY`|`ANNIVERSARY`|`WEDDING`|`GIFT`], `eventDate` [{year, month, day}], `eventDateKey` [YYYY-MM-DD], `month`, `day`, `label`, `declaredByCustomer`, `recipientLabel`, `fulfillmentLeadDays`, `source` [`CUSTOMER_PORTAL`|`IN_STORE_CONVERSATION`|`STAFF_ON_BEHALF`|`IMPORT`], `version`, `deletedAt`). Compound unique index `{ tenantId: 1, eventId: 1 }`. Application code strictly prohibited from writing to this collection (Hard Rule 10, AST G32).
- `src_orders` - Source order history (`tenantId`, `orderId`, `customerId`, `status`, `paid`, `netPaise` in minor units, `occasionRef`, `lines` [lineId, itemRef, name, quantity, pricePaise], `entityVersion`, `completedAt`, `branchId`). Compound unique index `{ tenantId: 1, orderId: 1 }`.
- `src_templates` - Read-only source WhatsApp templates seeded from `meta-templates.json` (`id`, `name`, `language`, `category` [MARKETING|UTILITY|UNKNOWN], `status`, `bodyText`, `variables` [{index, name, type, sample}], `revision`, `sendable` boolean, `source` [META_PROVIDED|DUMMY]). Protected against application code writes.
- `src_connections` - Read-only WhatsApp connections per tenant (`id`, `tenantId`, `phoneNumberId`, `wabaId`, `secretRef` = ENV KEY NAME, `graphApiVersion` pinned to `v25.0`, `status`). Protected against application code writes; secrets are NEVER stored in database.
- `dev_seedState` - Development-only seed tracking document (not indexed by production; dropped on `seed:reset`). Tracks `tenantId`, `liveOwner` (which scenario currently holds the live customer handover), `appliedScenarios` (array of all applied scenario names), `appliedAt` timestamps. Unique index `{ tenantId: 1 }`. Allows `seed:status` to report current state without querying all collections. Enforced: only exists in development databases; verified via `verifySeedEnvironment` guard before any seed operation.

#### Endpoints
- `GET /campaign-presets` - Returns preset library with `implemented: boolean` (Hard Rule 10: Birthday, Anniversary, Win-Back, Welcome [New Customer], First-to-Second Purchase, Gift / Wedding Reminder, Unresolved Enquiry, Complete the Outfit, and Requested Item Available are active; other presets locked).
- `GET /requests` - Paginated read-only request listing (`status`, `customerId`, `productId`, `page`, `limit`) with tenant isolation, masked customer data, and resolved product display names.
- `GET /campaigns/:id/requested-item/summary` - Provides Requested Item Available campaign summary metrics (`totalEnrollments`, `scheduledCount`, `sentCount`, `deliveredCount`, `readCount`, `purchasesCount`, `revenuePaise`, `excludedByReason`, `skippedByReason`).
- `POST /campaigns/:id/requested-item/preview` - Live preview simulation for a request ID without writing delivery records.
- `POST /dev/mock-requests` - Dev CRM endpoint to simulate external customer request creation.
- `POST /dev/mock-requests/fulfill`, `/cancel` - Dev CRM endpoints to simulate external customer request fulfillment or cancellation.
- `GET /products` - Paginated read-only product catalogue listing (`category`, `colourFamily`, `status`, `page`, `limit`) with tenant isolation, price, and sellable quantities.
- `POST /campaigns/:id/complete-outfit/preview` - Live outfit matching preview simulation for an order ID without writing delivery records.
- `GET /campaigns/:id/complete-outfit/summary` - Provides Complete the Outfit observational summary metrics (eligibleOrders, enrolled, scheduled, sent, delivered, read, observationalPurchases, observationalRevenuePaise, excludedByReason, skippedByReason).
- `POST /dev/mock-orders/:orderId/lines/:lineId/return` - Dev endpoint to simulate external customer return of an order line, recalculating net amounts and emitting `order.refunded`.
- `GET /enquiries` - Paginated read-only enquiry listing (`status`, `customerId`, `page`, `limit`) with tenant isolation, masked customer data, and resolved product display names.
- `GET /campaigns/:id/enquiry-followups/summary` - Provides Unresolved Enquiry campaign summary metrics (scheduled, held, skippedItemUnavailable, completed, total).
- `POST /dev/mock-enquiries` - Dev CRM endpoint to simulate external customer enquiry creation (`customerId`, `itemRef`, `channel`, `staffTakeover`).
- `POST /dev/mock-enquiries/interaction`, `/takeover`, `/resolve`, `/close`, `/delete` - Dev CRM endpoints to simulate external customer interactions, staff takeovers, resolutions, closures, and deletions.
- `POST /dev/mock-products` & `/dev/mock-products/:productId/variants/:variantId/stock` - Dev endpoints to create mock products and update variant sellable quantity for stock recheck verification.
- `GET /campaigns/:id/occasion-reminders/summary` - Provides occasion reminders summary metrics (totalOccasions, activeReminders, postponed, skippedLeadTime, completed).
- `GET /occasions` - Lists tenant customer occasions from `src_customerEvents` with filters (`customerId`, `type`).
- `POST /dev/mock-occasions` - Dev CRM endpoint to simulate external customer occasion creation (`type`, `eventDateKey`, `fulfillmentLeadDays`, `recipientLabel`).
- `POST /dev/mock-occasions/postpone`, `/cancel`, `/delete`, `/complete` - Dev CRM endpoints to simulate external occasion changes and dispatch domain events.
- `GET /campaigns/:id/welcome/summary` - Provides Welcome campaign summary counters (firstPurchases, eligibleFirstPurchases, enrolled, deferred, skipped).
- `GET /campaigns` - Retrieves tenant campaigns with branch scoping and status filters.
- `POST /campaigns` - Initializes campaign draft and control-gate with preset defaults (idempotent via `Idempotency-Key`).
- `GET /campaigns/:id` - Retrieves campaign details, draft version, active version snapshot, and version history.
- `GET /campaigns/:id/versions` (and `/api/v1/campaigns/:id/versions`) - Lists all immutable campaign version snapshots and drafts sorted descending by version.
- `PATCH /campaigns/:id/draft` - Updates draft configuration with optimistic locking (`expectedVersion`) and deduplication (`Idempotency-Key`). When editing an active campaign whose working draft was published, automatically forks draft N+1 while preserving version N untouched (Spec p9, B14). Returns 409 Conflict on version mismatch.
- `POST /campaigns/:id/validate` - Executes comprehensive validation matrix and returns `{ valid, errors, warnings }` with `fieldPath`, `message`, and `resolutionOwner` (`BOUTIQUE_OWNER` vs `INTEGRATION_DEVELOPER`).
- `POST /campaigns/:id/dry-runs` (and `/api/v1/campaigns/:id/dry-runs`) - Runs complete autonomous dry run simulation against tenant mock directory: evaluates audience rules, mandatory platform gates, calculates exact local dates and UTC instants (10:00 IST = 04:30 UTC), fills approved template variables or fallback, computes exclusion breakdown, and stores diagnostic snapshot. Zero live WhatsApp messages or database enrollments.
- `GET /campaigns/:id/dry-runs/latest` (and `/api/v1/campaigns/:id/dry-runs/latest`) - Retrieves the most recent dry run simulation for a campaign, dynamically flagging `isStale: true` if the current draft configuration fingerprint does not match the evaluation fingerprint.
- `POST /campaigns/:id/activate` (and `/api/v1/campaigns/:id/activate`) - Validates campaign draft; requires fresh dry run matching current draft fingerprint; blocks on integration readiness, unusable template or broken binding source (A05) with `fieldPath` and `resolutionOwner`. Enforces dummy template rule (`DISPATCH_MODE=meta` blocks activation; `DISPATCH_MODE=dry` allows with warning). In ONE MongoDB transaction: freezes immutable `campaignVersion` (`activatedBy`, `activatedAt`, `reviewFingerprint`, `nextEvaluationAt`), sets `campaign.activeVersionId`, transitions status to `ACTIVE`, and synchronizes control gate. Triggers initial calendar planner evaluation immediately. Returns "next evaluation scheduled", never "sent". Idempotent for rapid double-clicks (Spec p9, p17, p20, p25, C15).
- `POST /campaigns/:id/publish-revision` (and `/api/v1/campaigns/:id/publish-revision`) - Publishes working draft N+1 as a new immutable version. Points `campaign.activeVersionId` to N+1 while preserving version N untouched. Existing enrollments remain pinned to version N (Spec p9, B14). Triggers calendar planner evaluation.
- `GET /campaigns/overview/upcoming-activity` (and `/api/v1/campaigns/overview/upcoming-activity`) - Returns scheduled executions across active campaigns for the tenant overview dashboard.
- `GET /campaigns/:id/enrollments` (and `/api/v1/campaigns/:id/enrollments`) - Paginated, filtered list of customer enrollments with customer details (masked phone), occurrence details, match explanation, and step execution summaries.
- `GET /campaigns/:id/enrollments/:enrollmentId` (and `/api/v1/campaigns/:id/enrollments/:enrollmentId`, `/enrollments/:enrollmentId`, `/api/v1/enrollments/:enrollmentId`) - Full breakdown of an individual enrollment, customer profile, all step executions, enriched frozen delivery intent details, and associated `goalEvents`. Automatically completes enrollment (`status: 'COMPLETED'`) when all steps reach terminal outcomes (Spec p19, p33).
- `POST /enrollments/:id/resolve-hold` (and `/api/v1/enrollments/:id/resolve-hold`, `/campaigns/:campaignId/enrollments/:id/resolve-hold`) - Resolves customer reply hold. Accessible to `owner`, `admin`, `staff`. Re-evaluates future steps only; overdue steps remain skipped (`'Elapsed step prior to evaluation instant'`). Audited to `auditLog` with cause and supporting record (Spec p11, p20, p26, QA Matrix A11).
- `POST /enrollments/:id/mark-goal` (and `/api/v1/enrollments/:id/mark-goal`, `/campaigns/:campaignId/enrollments/:id/mark-goal`) - Records explicit staff-attributed or matched domain goal evidence in durable `campaignGoalEvents` collection. Accessible ONLY to `owner` and `admin` (`staff` receives 403 Forbidden). Audited with cause and supporting record. Stops sales follow-ups (`stopOnGoal: true`) while independent greetings (`stopOnGoal: false`) execute on schedule. Delivery alone never creates a goal (Spec p11, p20, p26, p33, QA Matrix A12).
- `POST /campaigns/:id/plan` (and `/api/v1/campaigns/:id/plan`) - Triggers calendar planner execution for an active campaign with optional `force` and `batchSize`. For win-back campaigns, automatically delegates to inactivity evaluator engine.
- `POST /campaigns/:id/evaluate-inactivity` (and `/api/v1/campaigns/:id/evaluate-inactivity`) - Evaluates due win-back inactivity occurrences past configured threshold (e.g. 90, 180 days) using distributed lease checkpoints. Occurrence ID format `winback:lastQualifyingOrderId:ruleId` enrolled ONCE (Spec p14, p17).
- `POST /campaigns/:id/execute-due` (and `/api/v1/campaigns/:id/execute-due`) - Runs the worker engine cycle for a specific campaign: claims due steps, evaluates reason precedence, freezes delivery intents, and dispatches in dry mode.
- `POST /worker/cycle` (and `/api/v1/worker/cycle`) - Runs a worker evaluation cycle across all active campaigns for the authenticated tenant.
- `GET /campaign-settings` (and `/api/v1/campaign-settings`) - Retrieves tenant campaign settings and current version. Accessible by owner, admin, and staff (staff read-only).
- `PATCH /campaign-settings` (and `/api/v1/campaign-settings`) - Updates tenant campaign configuration with optimistic concurrency locking (`expectedVersion`) and deduplication (`Idempotency-Key`). Syncs `isPaused` with `tenantControlGates` to trigger immediate emergency pause across all campaigns. Accessible ONLY by owner and admin.
- `POST /campaigns/:id/pause` (and `/api/v1/campaigns/:id/pause`) - Halts new enrollments and worker message submission; increments `pauseGeneration` on both campaign and control gate; preserves existing future schedules. Idempotent via `Idempotency-Key` (Spec p9, p16, p20, p29, B11, B12).
- `GET /campaigns/:id/pause/preview` (and `/api/v1/campaigns/:id/pause/preview`) - Returns live affected counts (`scheduledCount`, `inProgressCount`, `activeEnrollmentsCount`) and honest engine boundary notice ("Messages already being sent may still go out").
- `POST /campaigns/:id/resume` (and `/api/v1/campaigns/:id/resume`) - Resumes paused campaign under `FUTURE_ONLY` policy: immediately expires/skips overdue steps (`dueAt <= now` or `expiresAt <= now`) with skip reason `'Elapsed step prior to evaluation instant'` to guarantee zero message bursts. Future steps execute at normal schedules (Spec p9, p20, B13).
- `GET /campaigns/:id/resume/preview` (and `/api/v1/campaigns/:id/resume/preview`) - Returns counts of future steps that will execute versus overdue steps that will be skipped upon resumption.
- `POST /campaigns/:id/archive` (and `/api/v1/campaigns/:id/archive`) - Transitions campaign to `ARCHIVED`: cancels unsubmitted work (`SCHEDULED`, `DEFERRED`, `EVALUATING`) and active enrollments, while strictly preserving accepted, delivered, and unknown history intact (Spec p9, p20).
- `GET /campaigns/:id/archive/preview` (and `/api/v1/campaigns/:id/archive/preview`) - Previews unsubmitted work that will be cancelled versus historical deliveries preserved intact.
- `POST /auth/login` - Authenticate via email & password, issues signed httpOnly cookie and bearer token, rate-limited.
- `POST /auth/logout` - Clears httpOnly session cookie and logs audit logout event.
- `GET /auth/me` - Returns current authenticated user profile and tenant context.
- `GET /tenant/branches` - Lists branches strictly scoped to the authenticated tenant.
- `GET /tenant/branches/:branchId` - Retrieves a single branch for the authenticated tenant.
- `GET /tenant/activity` - Retrieves audit logs for the authenticated tenant in reverse chronological order.
- `GET /tenant/users` - Retrieves team member list for the authenticated tenant.
- `POST /tenant/users/:id/role` - Modifies team member role (owner/admin only).
- `GET /tenant/customers` - Returns paginated, filtered customer directory strictly scoped to tenant with masked phone numbers.
- `GET /tenant/customers/:customerId` - Returns full customer profile.
- `GET /tenant/customers/:customerId/events` - Returns customer's saved anniversary events.
- `GET /tenant/customers/:customerId/orders` - Returns customer's order history with lines and minor unit net amounts.
- `GET /approved-template-catalogue` - Retrieves approved WhatsApp template catalogue (owner/admin only).
- `GET /template-mapping-suggestions` - Returns recommended parameter mappings from `/docs/template-mappings.json` filtered by preset or wildcard.
- `POST /template-mapping/preview` - Resolves template variables for a sample customer with fallback support; returns rendered preview text and parameter status (phone numbers strictly masked).
- `POST /dev/template-mapping/reload-suggestions` - Dev-only hot-reload of `/docs/template-mappings.json` without process restart (returns 403 in production).
- `GET /integration/readiness` - Evaluates WhatsApp channel readiness (owner/admin only).
- `POST /admin/seed` - Dev/test endpoint to trigger database re-seed with selectable scenario.
- `GET /health` - API server liveness, uptime, request ID, and system clock.
- `GET /health/db` - MongoDB replica set connection, primary status, and transaction support validation.
- `GET /webhooks/whatsapp` (and `/api/v1/webhooks/whatsapp`) - Meta WhatsApp Cloud API Webhook Verification Challenge [M2]. Returns `hub.challenge` when `hub.mode=subscribe` and `hub.verify_token` matches `META_WEBHOOK_VERIFY_TOKEN`. Rejects mismatched tokens with HTTP 403 Forbidden.
- `POST /webhooks/whatsapp` (and `/api/v1/webhooks/whatsapp`) - Meta WhatsApp Cloud API Webhook Event Receiver [M2, M3]. Verifies `X-Hub-Signature-256` HMAC-SHA256 over raw request byte buffer with `META_APP_SECRET` BEFORE parsing JSON (C11). Durably stores incoming events in `campaignProviderEvents` prior to processing projections or acknowledging (C10). Deduplicates per status event (`messageId:status:timestampSec`) and inbound message to ensure replay safety. Monotonically projects statuses onto executions and frozen intents (`sent` -> `delivered` -> `read` -> `failed`) without state regression (C10), preserves timestamps without inventing delivery times on read, and correlates pre-response in-flight executions (C12). Handles customer inbound replies: applies `replyHoldAt` with `CAMPAIGN` attribution when context points to a campaign message; conservatively holds active sales sequences (`NOT_CAMPAIGN_CONSERVATIVE`) when context is missing (Spec p14, p20, A11).
- `POST /internal/campaign-events` (and `/api/v1/internal/campaign-events`, `/campaign-events`, `/api/v1/campaign-events`) - Ingests internal domain events (`order.completed`, `order.cancelled`, `order.refunded`, `customer.updated`, `preference.changed`, `customer.deleted`). Authenticates per producer, scopes by tenant and event family, persists in `campaignEventInbox` (`{ tenantId, producer, eventId }` unique) BEFORE acknowledging HTTP 200. Replays return `DUPLICATE` without state changes (Spec p25, B02). Events act as hints: current authoritative state is verified through source adapters before mutations; stale entity versions (`entityVersion < authoritative`) and unknown schemas are quarantined with visible reason and never roll state backwards or broaden audiences (Spec p20, p24). Applies atomic date replans (same year), cross-year corrections with `correctionGroupId` and duplicate step suppression, promotional step cancellation on opt-out, and permanent deletion handling.
- `GET /internal/campaign-events/quarantine` (and `/api/v1/internal/campaign-events/quarantine`, `/campaign-events/quarantine`) - Returns quarantined events for the tenant with visible quarantine reasons (`UNKNOWN_SCHEMA`, `STALE_ENTITY_VERSION`, `PRODUCER_FAMILY_MISMATCH`, etc.) and payload inspection. Accessible to owner, admin, and staff.
- `GET /internal/campaign-events/inbox` (and `/api/v1/internal/campaign-events/inbox`) - Filterable domain event inbox history with status query parameters (`PENDING`, `PROCESSED`, `QUARANTINED`, `FAILED`).
- `POST /internal/campaign-events/process-pending` (and `/api/v1/internal/campaign-events/process-pending`) - Admin/dev utility endpoint to manually trigger a batch processing cycle for pending inbox events through the outbox consumer engine.
- `GET /campaigns/:id/report` (and `/api/v1/campaigns/:id/report`) - Spec p28 exact campaign reporting engine. Computes eligible (at stated instant), total and unique enrollments, pending scheduled vs deferred executions, skipped/cancelled/expired counts with primary reason breakdown visible to boutique owners, separate delivery evidence (accepted, sent, delivered, read - "Accepted is not delivered; delivered is not a sale"), replies & holds (distinguishing exact campaign replies from conservative customer-wide holds, active holds vs resolved holds), explicit goal completions, step-by-step conversion funnel, and single-attribution net sales with refunds subtracted.
- `GET /campaigns/:id/export/csv` (and `/api/v1/campaigns/:id/export/csv`) - Exports sanitized CSV report of campaign enrollments and delivery performance. Enforces Hard Rule 9: phone numbers are strictly masked (`+91 98*** **321`) and message text bodies are excluded.
- `GET /campaigns/:id/customer-timeline/:customerId` (and `/api/v1/campaigns/:id/customer-timeline/:customerId`) & `GET /campaigns/:id/enrollments/:enrollmentId/timeline` (and `/api/v1/campaigns/:id/enrollments/:enrollmentId/timeline`, `/enrollments/:id/timeline`, `/api/v1/enrollments/:id/timeline`) - Returns an explainable customer timeline explaining why selected (`matchExplanation`), occurrence ID, occasion local date, planned vs actual delivery instants, template revision and language, chronological status history trail (`SCHEDULED` -> `PROVIDER_ACCEPTED` -> `DELIVERED` -> `READ` / `SKIPPED` / `CANCELLED` / `EXPIRED`), stop reasons, masked recipient phone, and linked orders.
- `GET /monitoring/operational-metrics` (and `/api/v1/monitoring/operational-metrics`) - Spec p34 operational safeguards endpoint: computes planner lag (active campaigns and versions), due-step age, skipped reason breakdown, event backlog, OUTCOME_UNKNOWN count, template blocks, stalled checkpoint lease alerts, and tenant fair-share index.
- `GET /monitoring/system-health` (and `/api/v1/monitoring/system-health`) - Real-time system health status badge (`HEALTHY` | `DEGRADED` | `CRITICAL`) with actionable operational alert banners.
- `POST /monitoring/reconciliation/run` (and `/api/v1/monitoring/reconciliation/run`) - Bounded, checkpointed nightly reconciliation sweep (`type: 'RECONCILIATION'`). Sweeps and recovers stalled leases, marks orphaned intents older than 15m as FAILED, and marks expired steps as EXPIRED. Accessible by owner and admin.
- `POST /monitoring/retention/run` (and `/api/v1/monitoring/retention/run`) - Atomic data retention pruning with tombstones (Spec p18, p25, QA Matrix B18). Creates logical-key tombstones in `campaignTombstones` and deletes detailed enrollments/executions in ONE MongoDB transaction. Accessible ONLY by owner.
- `GET /admin/clock` - Current Clock service time, epoch, and offset (dev/test only).
- `POST /admin/clock/offset` - Modify dev time offset in milliseconds (dev/test only).
- `POST /admin/clock/reset` - Reset dev time offset to 0 (dev/test only).

#### Pages
- `/` - Root route: automatically checks session and redirects to `/overview` or `/login`.
- `/login` - Boutique authentication page with dev role quick-fill buttons.
- `/overview` - Boutique workspace dashboard: active tenant details, branch list, role capability summary, and "Next Scheduled Campaign Activity (Spec p17)" card with upcoming executions table.
- `/customers` - Full-featured Boutique Customer Directory with search, filters, masked phones, order history, and Registered Occasions list showing saved occasions with lead times, recipient labels, and dates.
- `/dev-tools` - Time Travel, Re-Seed Engine, and Domain Event Ingestion & Replay Tester (hidden in production). Features:
  - **Injectable Engine Clock (Spec p3, p18)**: Time travel adjustments (+1h, +1d, +7d, -1d, exact hours, reset).
  - **Campaign Worker Engine (Spec p19, p25)**: Evaluates due steps, claims locks, and dispatches intents.
  - **Database Re-Seed Pipeline**: 6 distinct test scenarios (`base`, `birthday-today`, `feb29`, `household-collision`, `opt-out`, `gift-wedding`).
  - **Domain Event Ingestion Poster & Replay Tester (Spec p20, p24, p25)**: Interactive event poster form with 14 scenario presets (including `occasion.saved_wedding`, `occasion.saved_gift`, `occasion.postpone`, `occasion.cancelled`, `occasion.completed`), unique UUID generator, "Post Domain Event" button (`#btn-post-event`), "Replay 5x (Idempotency Test)" button (`#btn-replay-event-5x`), single-post response visualizer, and 5-run replay breakdown table proving Spec B02 idempotency.
  - **Mock Occasions CRM Control Panel (Spec Block G)**: Interactive CRM simulator to register new customer occasions, postpone dates, cancel, delete, and mark complete with automatic domain event dispatch.
  - **Quarantined Events Audit & Dead Letter Queue (Spec p24, p29)**: Filterable audit table (`#quarantine-events-table`) displaying quarantined events, visible reason chips, occurrence timestamps, and modal for raw payload inspection (`#quarantine-payload-modal`).
- `/campaigns` - Campaigns Overview & Preset Launchpad: displays preset cards (including Gift / Wedding Reminder with Gift icon), readiness blockers alert, campaigns table with status chips (DRAFT, VALIDATED, ACTIVE, PAUSED, ARCHIVED), branch badges, inline lifecycle actions (Pause, Resume, Archive) with preview confirmation dialogs, and new draft creation modal.
- `/campaigns/[id]` - Campaign Detail & 5-Step Editor:
  - **Campaign Detail View (Active/Paused/Archived Campaigns)**: Header action buttons dynamically reflect campaign lifecycle status: Pause Campaign (amber), Resume Campaign (emerald), and Archive (rose). Integrated with `PauseModal`, `ResumeModal`, and `ArchiveModal` showing live affected counts and honest engine boundary notice ("Messages already being sent may still go out"). Includes two primary tabs:
    - **Dashboard & Performance Tab (Spec p28, Block G)**: Primary default overview showing 8 metric cards, Occasion Reminders Summary banner (Total Occasions, Active Reminders, Postponed, Skipped: Lead Time, Completed), Step Funnel visualization, Skipped/Cancelled primary reasons breakdown visible to boutique owners, Attributed Orders table with attribution source (`GOAL_EVENT` vs `OCCASION_REF`), unassigned store orders notice, and "Export CSV Report" button.
    - **Campaign Activity Tab**: Displays total enrolled customer count, search by customer/phone, filter by enrollment status, "Run Calendar Planner" button, "Run Worker Cycle" button, paginated enrollments table with `occasionKind` badges, `Replanned (vN)` badges, match explanation ("why selected"), inline "Timeline" action button launching the explainable `CustomerTimelineModal`, and modal step execution inspector (scheduled local and UTC instants, template revision, skip reasons, provider message id [wamid], last error category, and execution attempts history timeline).
  - **Customer Timeline Modal (Spec p28, Block G)**: Interactive customer journey explaining why selected, occurrence ID, occasion date, `occasionKind` badge, `dateHistory` reschedule trail banner (oldDate -> newDate with timestamp), `Replanned (Rev vN)` badge, `Skipped: not enough time` badge with `usefulUntilReason`, planned vs actual delivery instants, template revision, chronological status events trail (`SCHEDULED` -> `PROVIDER_ACCEPTED` -> `DELIVERED` -> `READ` / `SKIPPED` / `CANCELLED` / `EXPIRED`), stop reasons, masked phone numbers, and linked orders.
  - **Sanitized CSV Export (Hard Rule 9, Spec p28)**: Downloads enrollment and delivery data with strictly masked phones (`+91 98*** **321`) and zero message text bodies.
  - **5-Step Editor Wizard**: Trigger (`CUSTOMER_EVENT_DATE` with Occasion Kind and Fulfillment Lead Time inputs), Audience, Messages (anti-pattern copy check for booking claims), Sending Rules, Review & Simulation.
  - **Step 5 Activation Section**: Readiness checklist (validation, matching dry run fingerprint, A04 zero matches notice, dummy template notice, booking link validation). "Activate Campaign" / "Publish Revision" button.
  - **Activation Confirmation Modal**: Explains immutability, autonomous next evaluation, zero manual sends, and version pinning before freezing.
- `/campaigns/[id]/activity` - Direct linkable page for campaign activity.
- `/activity` - Governance Center with tabbed navigation:
  - **Security Audit Trail**: Real-time append-only audit trail displaying login, logout, role change, campaign lifecycle, and occasion event actions (`occasion.saved`, `occasion.cancelled`, `occasion.completed`).
  - **Quarantined Domain Events (Spec p24, p29)**: Dedicated boutique owner view for quarantined events in the dead-letter queue, showing event IDs, producers, event types, entity IDs, visible quarantine reasons, and raw JSON payload modal.
- `/settings` - Tenant Configuration, Global Policy & WhatsApp Integration. Features interactive Tenant-Wide Emergency Dispatch Gate with instant pause/resume toggle synchronized with `tenantControlGates`, and Store Booking Link URL configuration with real-time validation.
- `/monitoring` - Operational Safeguards & System Health Monitoring Dashboard (Spec p34). Displays real-time health badge (`HEALTHY` | `DEGRADED` | `CRITICAL`), actionable alert banners, 7 safeguard cards (Planner Lag, Due-Step Age, Event Backlog, OUTCOME_UNKNOWN Count, Template Blocks, Stalled Checkpoint Leases, Tenant Fair Processing), Skipped/Cancelled Reason Breakdown Table, and manual trigger controls for Nightly Reconciliation and Retention Pruning.
- `/403` - Dedicated HTTP 403 Forbidden page explaining role permission boundaries.
- `/health` - System diagnostics, replica set status, and dev clock time travel dashboard.

#### Environment Variables
- `NODE_ENV`: 'development' | 'test' | 'production'
- `PORT`: API server port (default `4000`)
- `MONGODB_URI`: MongoDB connection URI (e.g. `mongodb://localhost:27017/?replicaSet=rs0`)
- `MONGODB_DB`: Dev database name (`grovastra_dev`)
- `MONGODB_TEST_DB`: Test database name (`grovastra_test`)
- `SESSION_SECRET`: Session JWT signing key
- `ENCRYPTION_KEY`: 32-byte hex string (64 characters)
- `DISPATCH_MODE`: 'dry' | 'meta' (default `dry`)
- `ALLOW_TEST_CATEGORY_MISMATCH`: boolean (default `false`)
- `DEV_TIME_OFFSET_MS`: integer offset in ms (dev only)
- `PLANNER_INTERVAL_MINUTES`: integer minutes for periodic planner loop (default `15`)
- `META_ACCESS_TOKEN`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`: WhatsApp credentials
- `META_TEST_ALLOWLIST`: comma-separated verified phones
- `LIVE_CUSTOMER_PHONES`: comma-separated live phone numbers for verified test recipients

#### How to Seed (F24b Layered Seed Architecture)

**Seed commands operate in two layers: platform data (seed:base) and optional scenario overlays (seed:scenario).**

```powershell
# === LAYER 1: Platform / Base Data ===
# Seeds tenants, branches, users, settings, templates, connections, and base customers.
# Creates ZERO campaigns. All documents labeled seedGroup: "core", source: "MOCK".
pnpm seed:base

# With live handover: also ingests the LIVE_CUSTOMER_PHONES recipient into the base layer.
pnpm seed:base --live

# === LAYER 2: Scenario Overlays ===
# Additively seeds scenario-specific customers, orders, events, and campaigns.
# Never deletes data from other scenarios. Safe to apply multiple scenarios.
pnpm seed:scenario welcome
pnpm seed:scenario gift-wedding
pnpm seed:scenario first-repeat
pnpm seed:scenario unresolved-enquiry
pnpm seed:scenario complete-outfit

# With live customer handover (transfers live phone to that scenario's campaign):
pnpm seed:scenario welcome --live

# Reset a single scenario (purge & re-apply that scenario only, leave others intact):
pnpm seed:scenario welcome --reset

# === COMBINED DEMO SEED (runs base + all 5 scenarios) ===
pnpm seed:demo

# === STATUS ===
pnpm seed:status     # Prints which scenarios are applied and current live owner

# === CLEANUP ===
pnpm seed:purge-mock --yes   # Removes mock source data and scenario campaigns;
                              # preserves platform data (tenants, branches, users,
                              # settings, templates, connections) and auditLog.

pnpm seed:reset --yes        # Nuclear wipe: drops all development collections and
                              # DevSeedState. Requires --yes flag for safety.

# === DEPRECATED (still work via alias, print deprecation warning) ===
pnpm seed                    # -> seed:base
pnpm seed:scenario gift-wedding  # unchanged
```

**Environment Safeguards (enforced by verifySeedEnvironment before every seed operation):**
- `NODE_ENV=production` → blocked absolutely.
- Database name not ending in `_dev` or `_test` → blocked.
- No replica set (`?replicaSet=...`) → blocked (transactions required).
- Phone numbers logged only via `maskPhone()` — full numbers never appear in logs.

#### How to Run
```powershell
# 1. Install dependencies
pnpm install

# 2. Start both API and Web concurrently
pnpm dev

# Or run processes separately:
pnpm dev:api         # Starts Express API at http://localhost:4000
pnpm dev:web         # Starts Next.js Web at http://localhost:3000
pnpm planner         # Starts standalone Calendar Planner background engine
pnpm worker          # Starts standalone Campaign Worker background engine (Feature 9)
pnpm event-consumer  # Starts standalone Domain Event Consumer background engine (Feature 15)
```

#### How to Test
```powershell
# Run complete Vitest test suite (467 tests across 34 test suites, 100% passing)
pnpm test

# Run Gift / Wedding Reminder Preset (F22, CUSTOMER_EVENT_DATE, G01-G36) test suite specifically (36 tests)
pnpm --filter @grovastra/api test tests/gift-wedding-reminder.test.ts

# Run Template Variable Mapping Hardening (Feature F19c, M01-M24) test suites (45 tests)
pnpm --filter @grovastra/api test tests/template-mapping-part1.test.ts
pnpm --filter @grovastra/api test tests/template-mapping-part2.test.ts
pnpm --filter @grovastra/api test tests/template-mapping-part3.test.ts

# Run First-to-Second Purchase Bring-Back Campaign (F20, FIRST_TO_SECOND_PURCHASE, R01-R29) test suite specifically (29 tests)
pnpm --filter @grovastra/api test tests/first-to-second-purchase.test.ts

# Run Welcome Campaign Preset (WELCOME_NEW_CUSTOMER) test suite specifically
pnpm --filter @grovastra/api test tests/welcome-campaign.test.ts

# Run Operational Safeguards, Nightly Reconciliation & Data Retention (Spec p18, p25, p34, QA Matrix B18) test suite (5 tests)
pnpm --filter @grovastra/api test tests/operational-safeguards.test.ts

# Run Campaign Reporting, Single-Attribution & Customer Timeline (Spec p22, p28, QA Matrix C17, C18) test suite specifically (6 tests)
pnpm --filter @grovastra/api test tests/reporting-and-attribution.test.ts

# Run Win-Back Campaign Preset & Inactivity Evaluator (Spec p14, p17, QA Matrix A13, B17) test suite specifically (9 tests)
pnpm --filter @grovastra/api test tests/winback-inactivity.test.ts

# Run Domain Events, Inbox Dedupe, Outbox Consumer & Change Semantics test suite specifically (12 tests)
pnpm --filter @grovastra/api test tests/events-and-consumer.test.ts

# Run Goal events, Hold resolution, Reason precedence & p33 Lakshmi walkthrough (9 tests)
pnpm --filter @grovastra/api test tests/goals-and-holds.test.ts

# Run Campaign lifecycle management (pause, resume, archive, B11, B12, B13) test suite (8 tests)
pnpm --filter @grovastra/api test tests/lifecycle.test.ts

# Run WhatsApp contact policy, rolling gates & collision arbitration test suite (7 tests)
pnpm --filter @grovastra/api test tests/contact-policy.test.ts

# Run WhatsApp webhook & status ingestion test suite specifically (14 tests)
pnpm --filter @grovastra/api test tests/webhook.test.ts

# Run WhatsApp delivery adapter & sendCampaignStep test suite specifically (9 tests)
pnpm --filter @grovastra/api test tests/delivery-adapter.test.ts

# Run worker and evaluator test suite specifically (13 tests)
pnpm --filter @grovastra/api test tests/worker.test.ts

# Run Preset Unresolved Enquiry (Feature F23, Block G, Q01-Q29) test suite (30 tests)
pnpm --filter @grovastra/api test tests/unresolved-enquiry.test.ts

# Run Complete the Outfit (Feature F24, OF01-OF30) test suite (31 tests)
pnpm --filter @grovastra/api test tests/complete-outfit.test.ts

# Run Seed Policy Cleanup & Additive Architecture (F24b, SD01-SD12) test suite (12 tests)
pnpm --filter @grovastra/api test tests/seed-policy-f24b.test.ts

# Run all 39 test suites across the API test suite (556 tests)
pnpm --filter @grovastra/api test
```
