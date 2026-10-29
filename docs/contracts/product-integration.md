# Product & Inventory Integration Contract (F23 & F24)

> **Document Status**: Proposed, to be agreed between GroVastra and Product/ERP/Inventory system owners.  
> **Source Systems**: External POS, Inventory, and Catalog Management Systems. GroVastra only **READS** product and stock data (`ProductSource`, `src_products`) and **NEVER** creates or mutates inventory or catalog records in production.

---

## 1. Overview & Architectural Boundaries

GroVastra Auto Campaigns uses product catalog and stock data for two automated campaign presets:
1. **Unresolved Enquiry Follow-up (F23)**: Rechecking product availability before sending enquiry reminder messages.
2. **Complete the Outfit (F24)**: Deterministically recommending compatible, in-stock complement items (e.g. matching blouse, dupatta, jewellery) after a customer completes a qualifying purchase (e.g. saree or lehenga).
3. **Selected-stock Promotion (F27)**: Resolving the current product price, variant stock, and `entityVersion` for owner-published selected-stock offers.

### Fundamental Invariants
- **Read-Only Invariant**: Production campaign engines only read products and stock. All writes in production happen in upstream POS/ERP systems.
- **No Reservation Concept**: WhatsApp messages never reserve physical stock. Suggestions do not hold inventory. Re-checks occur at dispatch evaluation AND immediately before carrier submission.
- **Neutral Matching**: Complement matching uses **ONLY** product attributes (category, colour, weave, price), purchase history, and recorded customer preferences. It **NEVER** inspects customer name, gender, religion, or inferred traits.
- **Selected-stock recheck**: F27 re-reads every selected product and included variant at dispatch and immediately before provider submission. A missing product, non-sellable variant, price change, or entity-version change blocks the frozen intent.

---

## 2. Product Entity Schema (`src_products`)

Every product record published to GroVastra conforms to the following schema:

| Field Name | Type | Description | Agreement Status |
| :--- | :--- | :--- | :--- |
| `productId` | `String` | Stable unique business identifier for the product (e.g., `prod_saree_kanchi_001`). | Proposed, to be agreed |
| `name` | `String` | Clean customer-facing display name (e.g., `Kanchipuram Silk Saree`). Sanitized, no prices. | Proposed, to be agreed |
| `category` | `String (Enum)` | Controlled product category from `PRODUCT_CATEGORIES`. Missing category causes `CATEGORY_UNKNOWN`. | Proposed, to be agreed |
| `colourFamily` | `String (Enum)?` | Controlled primary colour family from `COLOUR_FAMILIES`. Nullable for multi-colour/unspecified. | Proposed, to be agreed |
| `weave` | `String (Enum)?` | Controlled fabric/weave type from `WEAVES`. | Proposed, to be agreed |
| `pricePaise` | `Integer` | Price in integer minor units (paise). 100 paise = ₹1.00. | Proposed, to be agreed |
| `status` | `String (Enum)` | `'ACTIVE'` or `'DISCONTINUED'`. Only `'ACTIVE'` products are eligible for campaign matching. | Proposed, to be agreed |
| `variants` | `Array<Variant>` | List of stock-keeping variants for sizes/cuts. Lowest `variantId` chosen when ranking. | Proposed, to be agreed |
| `entityVersion` | `Integer` | Monotonically increasing version counter. Prevents stale updates from overriding newer state. | Proposed, to be agreed |

### Variant Object Schema
```json
{
  "variantId": "var_38",
  "label": "Size 38 / Ready-to-Wear",
  "sellableQty": 4,
  "version": 1
}
```

---

## 3. Controlled Controlled Attribute Value Lists

To guarantee deterministic matching, all systems must adhere to controlled enumerations. Unknown values are rejected with HTTP 422 (`PRODUCT_ATTRIBUTE_UNKNOWN`).

### 3.1 `PRODUCT_CATEGORIES`
```
saree, blouse, lehenga, kurta, dupatta, menswear, kidswear, accessories, petticoat, jewellery
```
*(Proposed, to be agreed)*

### 3.2 `COLOUR_FAMILIES`
```
red, maroon, pink, orange, yellow, green, blue, purple, black, white, cream, gold, silver, brown, multicolor
```
- **Neutral Colours** for pairing defaults: `white`, `cream`, `gold`, `silver`, `black`.  
*(Proposed, to be agreed)*

### 3.3 `WEAVES`
```
silk, cotton, linen, georgette, chiffon, handloom, other
```
*(Proposed, to be agreed)*

---

## 4. Definition of "Sellable"

A product/variant is considered **sellable** if and only if:
1. Product `status === 'ACTIVE'` (not `'DISCONTINUED'`).
2. Variant `sellableQty > 0`.
3. If no specific variant is requested, at least one variant on the product has `sellableQty > 0`.

When multiple variants of an active product have `sellableQty > 0`, GroVastra deterministically selects the variant with the lexicographically lowest `variantId`.

---

## 5. Order Line References & Partial Returns

Orders read through `OrderSource` (`src_orders`) link to products via lines:

```json
{
  "lineId": "line_01",
  "productId": "prod_saree_kanchi_001",
  "variantId": "var_std",
  "name": "Kanchipuram Silk Saree - Red",
  "qty": 2,
  "returnedQty": 1,
  "pricePaise": 1500000,
  "lineNetPaise": 1500000
}
```

### Return Invariants
- `qty`: Authoritative total quantity ordered.
- `returnedQty`: Authoritative cumulative quantity returned (default `0`).
- Line is active if `returnedQty < qty`.
- Line is fully returned if `returnedQty >= qty`.
- **Anchor Qualification**: If all anchor lines on an order are fully returned, the campaign sequence is cancelled with `ANCHOR_LINES_RETURNED`.
- **Returned Complements**: A previously returned complement purchase does **NOT** count as owned; it remains eligible for recommendation.

---

## 6. Open Questions & Future Extensions

The following items are flagged for mutual alignment:
1. **Curated Pairings**: Should merchandisers be allowed to define manual 1-to-1 pairings that override algorithmic scoring? (Current: purely rule/score-driven).
2. **Size Attribute Normalization**: Size matching between blouses and sarees. (Current: lowest sellable `variantId`).
3. **Branch-Level Stock**: Whether stock checks should enforce branch availability or pooled warehouse availability. (Current: tenant-wide catalog level).
4. **Multi-Colour Garments**: How dual-tone or ombre handloom weaves should be classified. (Current: primary `colourFamily` or `multicolor` which matches with score 0).
