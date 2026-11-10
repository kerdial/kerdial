import { SECTOR_CODES } from "@kerdial/core-reference-data";
import { sql } from "drizzle-orm";
import {
  char,
  check,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { currency } from "./currency.js";
import { tenant } from "./tenant.js";

export const instrumentKindEnum = pgEnum("instrument_kind", [
  "SHARE",
  "ETF",
  "FUND",
  "CRYPTO",
  "INDEX",
  // `scpi` cycle (migration `0074`): an unlisted real-estate fund, priced by
  // hand and never routed to a provider. Appended last so every existing
  // label keeps its sort position. **No migration may present the literal
  // `'SCPI'` to this enum** — a fresh install runs every migration in one
  // transaction (`55P04`); constraints below compare `kind::text`.
  "SCPI",
]);

export const primaryIdentifierEnum = pgEnum("primary_identifier", ["ISIN", "SYMBOL"]);

export const quotePolicyEnum = pgEnum("quote_policy", ["AUTO", "MANUAL_ONLY"]);

export const instrumentStatusEnum = pgEnum("instrument_status", ["ACTIVE", "DELISTED", "MERGED"]);

/**
 * IR-6 (DD22) — the
 * fifth PG enum on this table, and the idiomatic closed set here for the same
 * reason the four above are enums: NFR-5's "a client may not write an
 * arbitrary string" becomes a **database** guarantee rather than one resting
 * on the Zod layer alone.
 *
 * Generated **from `SECTOR_CODES`**, the single definition of the vocabulary
 * (`@kerdial/api-contracts`'s `sector.ts`) — spreading it here is what makes
 * the TS list and the database type the same list by construction, on top of
 * the `pg_enum`-reading drift test in
 * `instrument-classification-columns.integration.test.ts`. The member **order**
 * is `SECTOR_CODES`'s display order and is load-bearing: that drift test
 * compares the two lists in order, so a reordering here without a migration is
 * a failure rather than a silent divergence.
 *
 * Cost, stated: a tenth sector later is an `ALTER TYPE ... ADD VALUE`
 * migration (legal inside a transaction on Postgres 17, the deployed and
 * tested version) — a deliberate act, which is exactly the property FR-3 wants.
 */
export const instrumentSectorEnum = pgEnum("instrument_sector", SECTOR_CODES);

/**
 * `instrument` — The canonical internal identity for
 * anything the ledger can hold (FR-1..FR-5, AC1-AC3). `id` never changes for
 * any reason (AC3) — no update path anywhere may write
 * to it.
 *
 * Deliberately carries **no** `tenant_id` — this is shared reference
 * catalogue data (an explicit FR-45 exclusion), not a user-owned table.
 * `owner_tenant_id` is the nullable P2 forward-compat column: always
 * NULL in phase 1 (shared catalogue), reserved for a future tenant-private
 * instrument.
 */
export const instrument = pgTable(
  "instrument",
  {
    id: uuid("id").primaryKey(),
    kind: instrumentKindEnum("kind").notNull(),
    displayName: text("display_name").notNull(),
    listingCurrency: char("listing_currency", { length: 3 })
      .notNull()
      .references(() => currency.code),
    exchangeMic: char("exchange_mic", { length: 4 }), // ISO 10383; NULL for CRYPTO (FR-3)
    isin: char("isin", { length: 12 }), // FR-2; NULL allowed for CRYPTO (AC2)
    symbol: text("symbol"), // FR-4 crypto symbol / equity local ticker
    figi: char("figi", { length: 12 }), // optional cross-source anchor
    primaryIdentifier: primaryIdentifierEnum("primary_identifier").notNull(),
    quotePolicy: quotePolicyEnum("quote_policy").notNull(),
    // P2 forward-compat: NULL = shared catalogue (always NULL in
    // phase 1). Deliberately nullable, deliberately no `.notNull()`.
    ownerTenantId: uuid("owner_tenant_id").references(() => tenant.id),
    status: instrumentStatusEnum("status").notNull().default("ACTIVE"),
    // IR-6 (DD22/DD23) — the
    // three classification columns, all three **deliberately nullable**:
    // « Non classé » is the normal starting state of a user-added row (AC-5,
    // AC-10), so absence is NULL here and a UI bucket in `web`, never a
    // sentinel code and never a default invented at write time.
    sectorCode: instrumentSectorEnum("sector_code"),
    // Opaque, display-only, rendered as received. Free text rather
    // than an enum because it is the provider's finer-grained string, which is
    // neither closed nor stable — the closed set is `sector_code` above.
    industryLabel: text("industry_label"),
    // Issuer domicile ("Pays du siège social"), ISO 3166-1 alpha-2. A
    // *different fact* from the listing country, which is derived from
    // `exchange_mic` at the response boundary and never stored. Written
    // only by the verified seed or an explicit user entry — **never** defaulted
    // from `exchange_mic` and never from `isin.slice(0,2)`. That rule is
    // enforced by migration `0036`'s grants (`app_ingest` holds no UPDATE on
    // this column at all), not by this comment (DD24).
    domicileCountry: char("domicile_country", { length: 2 }),
    // `scpi` cycle (FR-611, SCD-6): the two descriptive facts an SCPI carries
    // — société de gestion and frais de souscription (a percentage, 0..100,
    // two decimals). Both nullable, no default; `instrument_scpi_attributes_only_on_scpi`
    // keeps them NULL on every other kind. Like `domicile_country`, written only
    // by an explicit user entry: `app_ingest` holds no UPDATE on either (0074).
    managementCompany: text("management_company"),
    subscriptionFeePct: decimalCol("subscription_fee_pct", 5, 2),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // AR-2 (ADR-0005 part 1): every content-dedupe key below is
    // split into two lanes so a future tenant-private row cannot collide with
    // another tenant's. The **shared lane** (`owner_tenant_id IS NULL`) keeps
    // the pre-AR-2 index name and exactly the pre-AR-2 guarantee — every
    // phase-1 row lives here, which is what keeps the AC1/AC2 dedupe tests
    // and the constraint-name error mapping in `instrument-service.ts`
    // unchanged. The **tenant lane** scopes the same key by
    // `owner_tenant_id`; its `IS NOT NULL` predicate is semantically the
    // ADR's unpredicated form (Postgres treats NULLs as distinct, so a
    // NULL-owner row can never conflict in it) while keeping the index empty
    // in phase 1. Cross-lane duplication (a private row shadowing a shared
    // one) is deliberately legal — visibility and dedup across lanes are
    // ADR-0005 part 2 (C27) semantics, not a constraint's.
    //
    // AC1 + FR-3 dual listings: the same ISIN on a different exchange_mic is
    // a distinct, valid row (e.g. Euronext Paris vs. NYSE listings of the
    // same company).
    uniqueIndex("instrument_isin_exchange_mic_key")
      .on(table.isin, table.exchangeMic)
      .where(sql`${table.isin} IS NOT NULL AND ${table.ownerTenantId} IS NULL`),
    uniqueIndex("instrument_tenant_isin_exchange_mic_key")
      .on(table.ownerTenantId, table.isin, table.exchangeMic)
      .where(sql`${table.isin} IS NOT NULL AND ${table.ownerTenantId} IS NOT NULL`),
    // AC2: a CRYPTO instrument is identified by symbol alone (no ISIN).
    uniqueIndex("instrument_symbol_crypto_key")
      .on(table.symbol)
      .where(sql`${table.kind} = 'CRYPTO' AND ${table.ownerTenantId} IS NULL`),
    uniqueIndex("instrument_tenant_symbol_crypto_key")
      .on(table.ownerTenantId, table.symbol)
      .where(sql`${table.kind} = 'CRYPTO' AND ${table.ownerTenantId} IS NOT NULL`),
    // F1(c) (T-37): the CRYPTO key above
    // dedupes CRYPTO rows only. Any other symbol-identified kind (INDEX
    // today, `primary_identifier = 'SYMBOL'`, `isin IS NULL`) had no dedupe
    // key at all — the same symbol could be inserted any number of times.
    // This partial index covers every non-CRYPTO, no-ISIN row keyed by
    // `(kind, symbol)` (N4 — originally `symbol`
    // alone, corrected to match this comment's own always-intended
    // composite key: `symbol` alone risks a false cross-kind collision, e.g.
    // a future second symbol-based kind sharing a ticker with an existing
    // INDEX row, and misreports which kind the conflicting row actually is);
    // `kind <> 'CRYPTO'` keeps it disjoint from the key above so a
    // duplicate CRYPTO symbol is unambiguously reported against
    // `instrument_symbol_crypto_key`, not this one.
    // This third key postdates ADR-0005 (it arrived with T-37's F1(c)), so
    // the ADR's "instrument × 2" undercounts it — it gets the same two-lane
    // split for the same reason.
    uniqueIndex("instrument_symbol_no_isin_key")
      .on(table.kind, table.symbol)
      .where(
        sql`${table.kind} <> 'CRYPTO' AND ${table.isin} IS NULL AND ${table.symbol} IS NOT NULL AND ${table.ownerTenantId} IS NULL`,
      ),
    uniqueIndex("instrument_tenant_symbol_no_isin_key")
      .on(table.ownerTenantId, table.kind, table.symbol)
      .where(
        sql`${table.kind} <> 'CRYPTO' AND ${table.isin} IS NULL AND ${table.symbol} IS NOT NULL AND ${table.ownerTenantId} IS NOT NULL`,
      ),
    // `scpi` cycle (FR-609, SCD-2): `instrument_isin_exchange_mic_key` treats
    // NULL MICs as distinct, so two MIC-less rows with one ISIN (two SCPI)
    // would both pass it. This key states the real rule — an ISIN with no
    // listing is unique — and names no kind (no enum literal in a predicate,
    // R1), so it would hold for any later unlisted kind. Same two-lane split as
    // the keys above (AR-2).
    uniqueIndex("instrument_isin_no_mic_key")
      .on(table.isin)
      .where(
        sql`${table.isin} IS NOT NULL AND ${table.exchangeMic} IS NULL AND ${table.ownerTenantId} IS NULL`,
      ),
    uniqueIndex("instrument_tenant_isin_no_mic_key")
      .on(table.ownerTenantId, table.isin)
      .where(
        sql`${table.isin} IS NOT NULL AND ${table.exchangeMic} IS NULL AND ${table.ownerTenantId} IS NOT NULL`,
      ),
    // IR-6 (NFR-5) — `char(2)` alone would accept `'fr'`, `'f '` or `'12'`.
    // `domicile_country` is compared against `CURATED_EXCHANGE_MICS`'s own
    // uppercase `countryCode` values and rendered through a label table keyed
    // the same way, so a lower-case row would silently lose its label rather
    // than fail loudly. NULL passes (a NULL `~` comparison is NULL, which a
    // CHECK treats as satisfied) — which is intended: absent is the normal
    // state, malformed is not.
    check("instrument_domicile_country_charset", sql`${table.domicileCountry} ~ '^[A-Z]{2}$'`),
    // IR-6 (NFR-5) — `industry_label` is provider text stored verbatim; a
    // bound keeps an unbounded provider string out of the shared catalogue and
    // out of every row it is rendered in. 120 is generous for the observed
    // vocabulary and short enough to stay a single line of UI.
    check("instrument_industry_label_length", sql`char_length(${table.industryLabel}) <= 120`),
    // `scpi` cycle (SCD-6, SCD-5) — every comparison is on `kind::text`, never
    // the enum: `0074` adds the `SCPI` label in the same transaction these are
    // created in, and Postgres refuses to *use* a fresh label there (`55P04`).
    check(
      "instrument_management_company_length",
      sql`char_length(${table.managementCompany}) BETWEEN 1 AND 120`,
    ),
    check(
      "instrument_subscription_fee_pct_range",
      sql`${table.subscriptionFeePct} >= 0 AND ${table.subscriptionFeePct} <= 100`,
    ),
    check(
      "instrument_scpi_attributes_only_on_scpi",
      sql`${table.kind}::text = 'SCPI' OR (${table.managementCompany} IS NULL AND ${table.subscriptionFeePct} IS NULL)`,
    ),
    // NULL MIC, `MANUAL_ONLY` and "ISIN or symbol" are a database rule for an
    // SCPI, not only an API one. `quote_policy = 'MANUAL_ONLY'` compares a
    // label of a *different*, pre-existing enum — legal in `0074`.
    check(
      "instrument_scpi_shape",
      sql`${table.kind}::text <> 'SCPI' OR (${table.exchangeMic} IS NULL AND ${table.quotePolicy} = 'MANUAL_ONLY' AND (${table.isin} IS NOT NULL OR ${table.symbol} IS NOT NULL))`,
    ),
  ],
);
