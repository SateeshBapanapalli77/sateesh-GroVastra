# F25: Requested item available

## Status

F25 is implemented and covered by `apps/api/tests/requested-item-available.test.ts`
with RA01-RA32 and its matrix meta-test.

## Behaviour

The preset uses the canonical key `requested_item_available` and alias
`request_stock_available`. It consumes request and inventory domain events,
matches open customer requests to currently sellable products/variants, and
creates one durable enrollment per request/product/variant occurrence. All
customer, request, product, order, consent, destination, suppression, branch,
and tenant gates are rechecked through source adapters.

Enrollment and execution planning use the shared event-delay timing engine.
Mongo-backed checkpoints support bounded fan-out and restart-safe replay.
Dispatch reads current stock and status and skips unavailable items without
calling the provider. Purchases, fulfilled requests, cancellation, replies,
holds, suppression, and opt-out stop future unsent steps.

## Surfaces

- Read-only request and product routes are under `apps/api/src/presets/requestedItemAvailable/routes.ts`.
- Stock/request/order handlers are in `stockHandlers.ts`.
- Reconciliation is in `reconciler.ts`.
- The preset definition and defaults are in `definition.ts`.
- Tests and the required ID meta-test are in `apps/api/tests/requested-item-available.test.ts`.

External source collections remain read-only to production code. Prices are
integer paise, instants are UTC BSON dates, and all queries are tenant scoped.
