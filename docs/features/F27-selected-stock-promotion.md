# F27: Selected-stock promotion

## Status

The selected-stock offer contract, pricing and matching, offer event ingestion,
durable fan-out, enrollment, timing, goal handling, dispatch rechecks,
reconciliation, API preview/summary, additive scenario seed, and campaign
review surface are implemented. Offer creation/editing remains outside this
project: source systems publish authoritative offers and GroVastra consumes
their events.

## Implemented pieces

- `SELECTED_STOCK` is additive to the existing read-only `src_offers` contract.
- `computeOfferPrice` applies percentage, flat, and special-price rules without
  floating-point money or negative prices.
- `formatPaiseInr` formats integer paise with Indian grouping.
- `matchSelectedStock` filters active, sellable products, applies offer prices to
  budget checks, ignores inferred preferences, and ranks by match score,
  position, then product ID.
- The `selected_stock_promotion` preset is listed in the campaign preset
  registry with the proposed one-hour and three-day defaults.
- Binding source definitions cover offer name, discount, validity, terms, and
  matched item list/price values. Offer and price bindings do not allow
  fallback literals.
- Offer events are authoritative only after a source re-read; invalid offers
  are quarantined with `OFFER_INVALID`, and stale entity versions are ignored.
- Fan-out uses bounded scans and durable checkpoints, with the
  `stockoffer:{offerId}` occurrence key and recipient limits.
- Withdrawn, paused, and ended offers are rechecked before work is sent.
  Product, stock, price, validity, and entity-version changes stale-block a
  frozen intent.
- Completed qualifying orders can stop future work through the selected-stock
  offer-item/tag goal modes; no discount redemption or stock reservation is
  performed.

## Data and seed

Run:

```powershell
pnpm seed:base
pnpm seed:scenario selected-stock-promotion
pnpm seed:scenario selected-stock-promotion --reset
```

The scenario adds twelve mock products, forty `cus_sp_*` customers, the
required draft/withdrawn/expired offer fixtures, and an ACTIVE campaign using
`seedGroup=selected-stock-promotion`. Offers intentionally remain `DRAFT`;
publishing is not performed by the seed engine. `--live` hands over only the
first selected-stock customer; without it the existing live customer is
untouched. Reset, purge, status, demo, and idempotent upserts use the shared
seed wiring.

## Manual checklist

1. Run the commands above and confirm the scenario reports 12 products, 40
   customers, 8 offers, and one ACTIVE campaign.
2. Open the selected-stock campaign and use **Test an offer** with
   `off_sp_percent`; confirm matched/scanned counts, truncation at the preview
   limit, and masked data.
3. Confirm the UI explains that prices and validity are read at send time and
   that no message reserves stock or claims scarcity.
4. Publish, update, pause, withdraw, and expire an offer through the dev
   event routes, then verify only eligible customers are enrolled and the offer
   preview remains read-only.
5. Run `seed:scenario selected-stock-promotion --reset`, then
   `seed:purge-mock --yes`; verify other scenario rows remain unchanged.

## Questions for the manager

- Should branch-two offers be visible to all owners or only branch-two users?
- Which approved Marketing templates should replace the dummy stock templates?
- Who owns redemption/stacking rules when an offer is used in-store?
- Should an expired offer remain visible in reporting indefinitely or be
  archived after a retention period?

## Deliberate boundaries

The UI does not create or edit offers, enter provider credentials, approve
templates, reserve stock, or claim scarcity. Those operations belong to the
source systems and Meta/template administrators.
