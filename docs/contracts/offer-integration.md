# Offer Integration Contract (F27)

`src_offers` is owned by the offer/promotion system. GroVastra reads it
through `OfferSource` and never creates, edits, approves, redeems, or
reserves an offer.

## Selected-stock offer

Required fields:

- `offerId`, `tenantId`, sanitized `name` (maximum 60 characters)
- `kind: SELECTED_STOCK`
- `status: DRAFT | ACTIVE | PAUSED | WITHDRAWN | EXPIRED`
- `publishedAt`, `validFrom`, `validUntil`
- `discount: PERCENT_OFF | FLAT_OFF | SPECIAL_PRICE`
- `items[]` with stable `productId`, optional `variantIds`, optional
  item-specific `offerPricePaise`, and deterministic `position`
- `tags[]`, `branchIds[]`, `terms`, and monotonic `entityVersion`

Prices are integer paise. GroVastra computes percentage discounts with floor
rounding and rejects zero, negative, or above-regular prices. A selected-stock
offer is not eligible until it is active, published, valid, and has at least
one valid item.

## Events

The offer owner emits `offer.published`, `offer.updated`, and
`offer.withdrawn` using the campaign event envelope. Events are hints:
GroVastra re-reads the authoritative offer, products, prices, stock, and
customer preferences before enrollment and again at dispatch.

Replays are deduplicated by tenant, producer, and event ID. Invalid offers are
quarantined with `OFFER_INVALID`. Older entity versions never overwrite newer
source state.

## Operational guarantees

- `stockoffer:{offerId}` is the occurrence identity.
- Messages do not reserve or hold stock.
- Product and offer values are frozen only in a delivery intent after the
  dispatch snapshot; a price, entity-version, stock, or validity change blocks
  submission.
- `offer.withdrawn` and `EXPIRED` cancel unsent work. `PAUSED` skips work due
  while paused. Accepted provider deliveries are not rewritten.
- The engine does not claim attribution or redeem discounts.
