# F27 Change Log

## 2026-10-28

- Expanded `selected-stock-promotion` into an additive, idempotent Part 3
  scenario with twelve products, forty customers, edge-case offers, an ACTIVE
  campaign version, and live-customer handover support.
- Added selected-stock campaign review UI with read-only offer preview and
  safety notices, plus preset-card recognition.
- Updated the F27 feature document with the manual checklist, manager
  questions, seed contract, and current known gaps.
- Added the offer integration contract and the selected-stock product
  revalidation extension.
- Enforced the selected-stock recipient cap across resumable fan-out
  checkpoints, recomputed frozen offer prices at dispatch, added zod-validated
  event routes, and added the withdrawal trigger.

## 2025-02-14

- Restored the existing F25 and F26 feature documents from their implemented
  code and test suites so the prerequisite gate is auditable.
- Updated integration-readiness expectations to derive template totals and
  category counts from `docs/meta-templates.json`.
- Restored the existing `gift_wedding` preset alias expected by the F22 suite.
- Moved F26 preference-affinity matching into the shared
  `presets/_shared/preferenceMatching` module. F26 retains its compatibility
  barrel and F27 now reuses the shared item-affinity calculation.
- Extended the offer source schema for selected-stock draft/withdrawn states
  and added `offers` event-family ingestion with authoritative source
  revalidation.
- Invalid selected-stock offer events now stop processing and persist an
  `OFFER_INVALID` quarantine result instead of being marked processed.
- Added bounded selected-stock fan-out and enrollment with durable checkpoints,
  `stockoffer:{offerId}` occurrence keys, shared delay timing, validity caps,
  withdrawal/expiry/pause handling, and `reconcile:selected-stock`.
- Added selected-stock order goal handling for offered item/variant purchases
  and explicit stock-offer tags.
- Current validation: 627 passed, 2 failed, 0 skipped. The two failures are
  the pre-existing F24b `SD02` and `SD09` seed timeouts.
