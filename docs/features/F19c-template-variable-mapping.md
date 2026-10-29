# F19c: Template Variable Mapping Hardening

## 1. Feature Overview & Design Contract
Feature **F19c** hardens template variable mapping, parameter resolution, and Meta WhatsApp Cloud API payload construction across the entire GroVastra platform. It establishes a single canonical source of truth for parameter handling, preventing provider rejections, template parameter misalignment, and silent data corruption across Preview, Dry Run, and Live Dispatch.

### Core Architectural Invariants
1. **Single Canonical Resolver (`resolveTemplateParameters`)**:
   - Uniform parameter resolution across live dispatch, simulation dry runs, and web previews.
   - Enforces strict sanitization rules on every parameter value before dispatch.
2. **Single Canonical Meta Payload Builder (`buildMetaTemplateBody`)**:
   - Sole authorized constructor for Meta WhatsApp Cloud API template request bodies across the codebase.
   - O错误/omit `components` array entirely for 0-variable templates.
   - Strict 1..N ascending index ordering for template body parameters.
3. **Strict Sanitization & Zero Silent Truncation**:
   - Unicode NFC canonical decomposition/composition (`val.normalize('NFC')`).
   - Strips non-printable and ASCII control characters (`[\x00-\x1F\x7F]`).
   - Collapses consecutive whitespace runs (`[ \t]+` $\rightarrow$ single space).
   - Strips newlines and tabs (`[\r\n\t]`).
   - Rejects empty values with `MISSING_VARIABLE` unless a non-empty `fallbackLiteral` is configured.
   - Rejects values exceeding Meta's 200-character limit with `VARIABLE_TOO_LONG` (never truncates silently).
4. **Schema v2 Normalization (`bindingsSchemaVersion = 2`)**:
   - Canonical format: `Record<string, { source: BindingSource, value?: string, fallbackLiteral?: string }>`.
   - Backward compatible: legacy string format (`"customer.firstName"`, `"literal:Hello"`) and legacy object format are normalized in-memory upon draft load without mutating published campaign versions in MongoDB (Hard Rule 6).
5. **Provider HTTP Isolation & Error Classification**:
   - Meta Cloud API HTTP calls are strictly isolated from MongoDB transactions (Hard Rule 4).
   - Parameter format/length/count rejection codes (132000, 132012, 132018) map to `PARAMETER_REJECTED_BY_PROVIDER` (`FAILED`, terminal, no retry).
   - Template pause/block code 132015 maps to `BLOCKED_TEMPLATE`.

---

## 2. Core Modules & Pipeline Architecture

```
[Campaign Step Bindings] + [Customer / Tenant / Occasion Facts]
                     │
                     ▼
        ┌─────────────────────────┐
        │ resolveTemplateParameters│  <-- apps/api/src/templates/resolveTemplateParameters.ts
        └────────────┬────────────┘
                     │
        ┌────────────▼────────────┐
        │ sanitizeTemplateParameter│  <-- apps/api/src/templates/sanitize.ts
        └────────────┬────────────┘
                     │
         [Validated Parameter Array]
                     │
        ┌────────────▼────────────┐
        │  buildMetaTemplateBody   │  <-- apps/api/src/templates/buildMetaTemplateBody.ts
        └────────────┬────────────┘
                     │
                     ▼
       Meta WhatsApp Cloud API Payload
```

### Module Specifications

- **`apps/api/src/templates/sanitize.ts`**:
  - `sanitizeTemplateParameter(val: string, options: SanitizeOptions)`:
    - Normalizes string to Unicode NFC form.
    - Strips control characters (`\x00-\x1F\x7F`).
    - Strips embedded newlines and carriage returns (`\r\n`, `\n`, `\r`).
    - Collapses consecutive spaces into a single space and trims edges.
    - Validates length $\le 200$ characters; throws `VARIABLE_TOO_LONG` if exceeded.
    - Throws `MISSING_VARIABLE` if sanitized string is empty.

- **`apps/api/src/templates/resolveTemplateParameters.ts`**:
  - Resolves bindings against:
    - `customer.firstName`: Returns customer's first name, or uses `fallbackLiteral` (e.g. "Valued Customer") if name is blank/whitespace.
    - `shop.displayName`: Tenant boutique name from store profile.
    - `offer.amountRupees`: Offer rupee discount value formatted as integer string (Hard Rule 2).
    - `literal`: Fixed literal value entered by the merchant.
    - `occasion.localDate`: Formatted date string.
    - `order.firstOrderNumber` / `order.firstOrderDate`: First purchase reference.
    - `credit.balanceDisplay` / `credit.expiryDate` / `credit.daysToExpiry`: Store credit attributes.

- **`apps/api/src/templates/buildMetaTemplateBody.ts`**:
  - Assembles the outgoing Meta Graph API JSON body:
    ```json
    {
      "messaging_product": "whatsapp",
      "recipient_type": "individual",
      "to": "+919876543210",
      "type": "template",
      "template": {
        "name": "tpl_welcome_new_customer",
        "language": { "code": "en" },
        "components": [
          {
            "type": "body",
            "parameters": [
              { "type": "text", "text": "Lakshmi" },
              { "type": "text", "text": "Sita Handlooms" }
            ]
          }
        ]
      }
    }
    ```
  - If the template defines 0 parameters, `components` is entirely omitted from the payload per Meta specification.

- **`apps/api/src/templates/normalizeBindings.ts`**:
  - Converts string-based or legacy v1 bindings to schema v2 `{ source, value, fallbackLiteral }`.
  - Sets `bindingsSchemaVersion: 2` on drafts in memory.

- **`apps/api/src/templates/suggestions.ts`**:
  - Loads `/docs/template-mappings.json`.
  - Validates all suggestion entries; discards malformed entries with structured warnings.
  - Exposes `getSuggestions(presetId)` and `reloadSuggestions()` for live development reloading without restart.

---

## 3. API Endpoints & Developer Tooling

| Method | Route | Security | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/template-mapping-suggestions` | Tenant Auth | Returns recommended bindings catalogue from `template-mappings.json` filtered by preset. |
| `POST` | `/template-mapping/preview` | Tenant Auth | Resolves template variables for a sample customer with fallback support; returns rendered preview text and parameter status. Privacy invariant: recipient phone number is NEVER returned raw. |
| `POST` | `/dev/template-mapping/reload-suggestions` | Dev Only | Hot-reloads `template-mappings.json` without process restart. Returns `403 Forbidden` in production environments. |

---

## 4. Provider Error Handling & Retry Matrix

| Meta Error Code | Meta Subcode / Message | GroVastra Classification | Worker Action | Retry Policy |
| :--- | :--- | :--- | :--- | :--- |
| **132000** | Parameter count mismatch | `PARAMETER_REJECTED_BY_PROVIDER` | Execution marked `FAILED` | Terminal, NO retry |
| **132012** | Parameter format invalid | `PARAMETER_REJECTED_BY_PROVIDER` | Execution marked `FAILED` | Terminal, NO retry |
| **132018** | Parameter length / invalid characters | `PARAMETER_REJECTED_BY_PROVIDER` | Execution marked `FAILED` | Terminal, NO retry |
| **132015** | Template paused or blocked | `BLOCKED_TEMPLATE` | Execution marked `FAILED` | Alert store owner |
| **131056** | Rate limit hit | `RATE_LIMIT` | Execution deferred | Exponential backoff |

---

## 5. Web Studio Experience (`apps/web`)

1. **Step 3 Variable Mapping Table**:
   - Dynamic table rendering all template parameters declared in `meta-templates.json`.
   - Variable index tag `{{index}}` and parameter purpose.
   - Source selector (`customer.firstName`, `shop.displayName`, `literal`, etc.).
   - Character counter for literals (`count/200`) with visual warning when approaching or exceeding Meta limits.
   - Dedicated `fallbackLiteral` input for `customer.firstName` ensuring walk-ins without recorded names receive a graceful greeting.
2. **Auto-Fill Suggestions (Diff) Modal**:
   - Click "Auto-Fill Suggestions (Diff)" in Step 3 toolbar.
   - Compares existing step bindings against `/docs/template-mappings.json`.
   - Modal displays side-by-side diff (Current vs. Recommended) with affected steps and variables.
   - Applying updates all step mappings in memory with one click.
3. **Live 5-Customer Preview Panel**:
   - Instant WhatsApp bubble preview updating live as bindings or fallbacks change.
   - Interactive profile selector testing 5 edge cases:
     1. *Standard Patron*: Clean name ("Lakshmi Devi").
     2. *No Name Recorded*: Tests `fallbackLiteral` ("Valued Customer").
     3. *Whitespace & Newlines*: Tests space collapsing and newline stripping.
     4. *Unicode & Emoji*: Tests Unicode NFC normalization and emoji handling.
     5. *Alternative Patron*: Second boutique customer profile.

---

## 6. Dry Run Breakdown Counters

Dry runs now calculate and report fine-grained template variable health:
```typescript
variableBreakdown: {
  ok: number;              // Parameters resolved cleanly from customer/store facts
  usedFallback: number;    // Parameters that fell back to fallbackLiteral (e.g. empty name)
  skippedMissing: number;  // Executions skipped due to MISSING_VARIABLE
  skippedTooLong: number;  // Executions skipped due to VARIABLE_TOO_LONG (>200 chars)
}
```

---

## 7. Verification Matrix (Tests M01–M24)

| Test ID | Area | Scenario Tested | Status |
| :--- | :--- | :--- | :--- |
| **M01** | Sanitization | Replaces consecutive whitespace runs with a single space | Passed |
| **M02** | Sanitization | Strips newline, carriage return, and tab characters | Passed |
| **M03** | Sanitization | Normalizes non-NFC Unicode compositions to canonical NFC | Passed |
| **M04** | Sanitization | Strips ASCII control characters | Passed |
| **M05** | Sanitization | Rejects values exceeding 200 characters (`VARIABLE_TOO_LONG`) | Passed |
| **M06** | Sanitization | Rejects empty strings without fallback (`MISSING_VARIABLE`) | Passed |
| **M07** | Sanitization | Never truncates long strings silently | Passed |
| **M08** | Resolver | Resolves `fallbackLiteral` when `customer.firstName` is empty | Passed |
| **M09** | Resolver | Resolves all standard binding sources cleanly | Passed |
| **M10** | Builder | Omits `components` parameter for 0-variable templates | Passed |
| **M11** | Builder | Strictly orders parameters in ascending 1..N variable sequence | Passed |
| **M12** | Builder | Produces valid Meta Graph API request payload structure | Passed |
| **M13** | Normalizer | Normalizes legacy string bindings (`literal:xyz`) to Schema v2 | Passed |
| **M14** | Normalizer | Preserves immutable published campaign versions in DB | Passed |
| **M15** | Validator | Flags missing bindings for declared template variables | Passed |
| **M16** | Provider | Classifies Meta error 132000 as `PARAMETER_REJECTED_BY_PROVIDER` | Passed |
| **M17** | Provider | Classifies Meta error 132012 as `PARAMETER_REJECTED_BY_PROVIDER` | Passed |
| **M18** | Provider | Classifies Meta error 132018 as `PARAMETER_REJECTED_BY_PROVIDER` | Passed |
| **M19** | Suggestions | Validates suggestion file and discards invalid entries | Passed |
| **M20** | Dev Route | Dev reload reloads suggestions; returns 403 in production | Passed |
| **M21** | Preview API | `POST /template-mapping/preview` respects fallbacks and privacy | Passed |
| **M22** | AST Linter | Ensures NO duplicate Meta template payload builder exists in code | Passed |
| **M23** | Dry Run | Computes accurate `variableBreakdown` counters | Passed |
| **M24** | Seed Scenario | Welcome scenario edge cases seeded with `mapping-test` tag | Passed |
