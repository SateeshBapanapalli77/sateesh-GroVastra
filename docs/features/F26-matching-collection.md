# F26: Matching collection

## Status

F26 is implemented and covered by
`apps/api/tests/matching-collection.test.ts` with MC01-MC34.

## Behaviour

The canonical preset key is `matching_collection`, with the existing
`MATCHING_COLLECTION` alias. A published collection event is persisted and
fanned out in bounded customer batches. Customers are filtered using normalized
customer-declared/staff-recorded preferences, active destination and marketing
gates, branch scope, and the configured affinity threshold.

The pure matcher in
`apps/api/src/presets/matchingCollection/matching.ts` computes deterministic
weave, colour, size, category, and budget affinity and returns an explanation.
Inferred preferences are not used. Collection and product records are read
through adapters; production code does not write external source collections.

Durable checkpoints make event replay and planner restart safe. Enrollment,
execution, timing, stop rules, reply holds, purchase goals, withdrawal, and
dispatch-time inventory checks use the shared campaign engine. Template values
are resolved through the single snapshot/resolution path.

## Surfaces

- Definition: `apps/api/src/presets/matchingCollection/definition.ts`
- Pure matcher: `apps/api/src/presets/matchingCollection/matching.ts`
- Fan-out: `apps/api/src/presets/matchingCollection/fanout.ts`
- Event handlers: `collectionHandlers.ts`
- Reconciliation: `reconciler.ts`
- Routes: `routes.ts`
- Tests and matrix meta-test: `apps/api/tests/matching-collection.test.ts`

All records, indexes, events, and queries are tenant scoped; future schedules
are persisted in MongoDB rather than process timers.
