import { serializeDecimal, serializeSubscriptionFeePct } from "@kerdial/api-contracts";
import { parseDecimalString, type Decimal } from "@kerdial/core-decimal";
import {
  KERDIAL_CATALOGUE_GENERATOR,
  KERDIAL_CATALOGUE_SCHEMA_VERSION,
  catalogueIconBase64,
  serializeKerdialCatalogue,
  serializeKerdialTransactions,
  systemClock,
  type ExportedTransactionRow,
  type KerdialCatalogueDocument,
} from "@kerdial/importer";
import { routedProviderKeys } from "@kerdial/market-composition";
import {
  cashAccount,
  fxRateUser,
  instrument,
  instrumentIcon,
  instrumentProviderMap,
  manualPricePoint,
  portfolio,
  portfolioIcon,
  tenant,
  transaction,
  watchlistItem,
  withTenant,
  type Db,
  type TenantId,
  type Tx,
} from "@kerdial/platform-db";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

/**
 * `api/src/exports` — the export **read path**
 * (EI-21).
 *
 * Two functions, one per package (FR-500/FR-508), each of which reads its
 * tenant's rows and hands them to the pure serializers `@kerdial/importer`
 * owns. **There is no controller here** — routes, headers and the
 * `413 EXPORT_TOO_LARGE` refusal are EI-25's; this module returns the bytes
 * *and their size* so that decision has something to be made on.
 *
 * ## The four rules this module exists to obey
 *
 *  1. **No transaction spans the serialization** (FR-510/AC-441). Every read
 *     goes through {@link tenantReader}'s `read()`, the module's *only* call
 *     site of `withTenant`, which times each transaction and reports it to an
 *     injectable observer, and each serialization step reports a span of its
 *     own on the same monotonic timeline. AC-441's test asserts the structure
 *     — every transaction ended before serialization began, and no two
 *     transactions overlap — never a timing ratio, which a slow runner can
 *     flip. Nothing here opens a transaction any other way, so no read can
 *     escape the measurement.
 *  2. **Nothing provider-fetched is read** (L6/FR-500(c)). No query below
 *     names `instrument_price_daily`, `instrument_quote_latest`,
 *     `fx_rate_daily`, `fx_tracked_pair`, `instrument_backfill_state`,
 *     `instrument_price_gap` or `provider_fetch_log`; a transaction's
 *     `fx_rate` is **selected through a `CASE` that yields NULL unless
 *     `fx_rate_source = 'USER_PINNED'`** (L9/FR-521), so the serializer is
 *     never handed a provider rate in the first place. The writer applies the
 *     same predicate a second time on `fx_rate_source`, which this projection
 *     carries verbatim — two independent gates, because AC-440's negative
 *     assertion is the one an accidental refactor is most likely to undo.
 *  3. **Nothing credential or audit is read** (FR-501/NG7). `session`,
 *     `app_user` and `transaction_revision` appear nowhere in this file, and
 *     `tenant` is read for **`id` and `base_currency` only** — which is also
 *     all `app_web` is granted on it (MEASURED, migration
 *     `0024_tenant-base-currency-grant.sql:61`).
 *  4. **No derived table is read** (SD-2/FR-506). `transaction_posting`,
 *     `cash_balance`, `holding_state`, `realized_gain` and
 *     `portfolio_daily_valuation` are absent; the export carries source rows,
 *     and the import re-derives the rest.
 *
 * ## Buffered, not streamed (KD6)
 *
 * Both functions return a `Buffer` and its `byteLength`. The whole file is in
 * memory before the caller sees any of it, so an error mid-serialization is
 * still an honest 500 rather than a truncated `200` body — and the controller
 * can set `content-length` before it returns, the way the icon route already
 * does.
 */

/**
 * Icons page at 100 rows because each row carries up to 256 KiB of
 * `bytea` — `INSTRUMENT_ICON_MAX_BYTES` (MEASURED,
 * `core/reference-data/src/instrument-icon.ts`) — so a page is bounded at
 * ~25 MiB of payload regardless of how many icons the tenant has.
 */
const ICON_PAGE_ROWS = 100;

/**
 * Manual price points page at 2 000 rows: the tenant cap is
 * `MANUAL_PRICE_POINT_TENANT_ROW_CAP = 500_000` (MEASURED,
 * `ledger/src/manual-price-service.ts`), which is three orders of magnitude
 * past what one transaction should hold open.
 */
const MANUAL_PRICE_PAGE_ROWS = 2_000;

/** Transactions page at 500 rows — NFR-10's 5 000-transaction ceiling is then 10 pages. */
const TRANSACTION_PAGE_ROWS = 500;

/**
 * The clock the manifest's `exportedAt` is read from. Structurally
 * `@kerdial/importer`'s own `Clock` minus `sleep`, so {@link systemClock}
 * satisfies it and a test's fake clock does too — nothing here needs to
 * sleep, and a port that can would be a wider seam than this path has any use
 * for.
 */
export interface ExportClock {
  now(): Date;
}

/**
 * One `withTenant` transaction's own elapsed time, as AC-441 instruments it.
 * `section` names the read (`"catalogue:icons"`, `"transactions:page"`, …) so
 * a failing assertion says *which* transaction was the long one.
 */
export interface ExportTransactionSpan {
  readonly section: string;
  /**
   * `"transaction"` for one `withTenant` transaction; `"serialization"` for a
   * step that turns the buffered document into bytes **outside** any
   * transaction. AC-441's proof is structural, not a ratio: every
   * `"transaction"` span ends before the `"serialization"` span starts, and
   * no two `"transaction"` spans overlap — properties a slow CI runner cannot
   * flip, where "longest transaction < half the wall time" could (it did,
   * 2026-09-25: 216 ms of 264 ms on a shared runner against 0.28 locally).
   */
  readonly kind: "transaction" | "serialization";
  /** `performance.now()` at the span's start and end — one monotonic clock for the whole export. */
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
}

/** What both read functions accept: a clock, and AC-441's instrumentation hook. */
interface ExportReadOptions {
  readonly clock?: ExportClock;
  /** Called once per `withTenant` transaction and once per serialization step, in completion order. */
  readonly onTransactionSpan?: (span: ExportTransactionSpan) => void;
}

/**
 * Times one serialization step and reports it through the same hook as the
 * transactions, so a test can place it on the same timeline. The step runs
 * with no transaction open — the reader's `read` has returned before this is
 * called — which is exactly what the reported span lets a test assert.
 */
function serialized(section: string, options: ExportReadOptions, produce: () => string): Buffer {
  const startedAt = performance.now();
  try {
    return Buffer.from(produce(), "utf8");
  } finally {
    const endedAt = performance.now();
    options.onTransactionSpan?.({
      section,
      kind: "serialization",
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
    });
  }
}

/**
 * KD4's size-avoidance half: `"omitted"` skips the icon reads entirely — not
 * "reads them and drops them" — and the document says so in `iconsIncluded`,
 * so a reader of the file can tell an icon-less tenant from an icon-less
 * export. (The 413-refusal half is EI-25's.)
 */
export interface CatalogueExportOptions extends ExportReadOptions {
  readonly icons: "included" | "omitted";
  /**
   * KD4.3's ceiling, injected — `KERDIAL_JSON_LIMITS.maxFileBytes` in
   * production, through the **same** token the catalogue import route reads its
   * own from (KD4.1: one constant, never two copies).
   *
   * **Required, with no default**. The gate this number drives
   * is the reason the security review's M2 existed: the refusal used to be
   * decided by the controller on `body.byteLength`, i.e. *after* ~175 MB of
   * base64 had been built for a tenant at the icon cap, on a route whose
   * default is `icons=included` and whose trigger is a link. A ceiling with a
   * default is a ceiling a call site can forget; this one cannot be.
   */
  readonly maxFileBytes: number;
}

export type TransactionsExportOptions = ExportReadOptions;

/** Row counts, for the caller's one log line (FR-513: counts, bytes and a duration — never content). */
export interface CatalogueExportCounts {
  /**
   * Entries in the `instruments` section — every instrument the tenant can
   * list, not only the ones it has traded or attached something to
   * (see {@link collectInstrumentIds}). It therefore tracks the
   * size of the shared catalogue and is **not** a measure of how much of it
   * this tenant uses; `watchlistItems`, `manualPrices` and `icons` are the
   * tenant-scoped counts beside it.
   */
  readonly instruments: number;
  readonly portfolios: number;
  readonly cashAccounts: number;
  readonly icons: number;
  readonly manualPrices: number;
  readonly watchlistItems: number;
  readonly fxRatesUser: number;
}

export interface CatalogueExportResult {
  /** Discriminates this from {@link CatalogueExportTooLarge}; see {@link CatalogueExport}. */
  readonly refused: false;
  /** `kerdial-instruments.json`, UTF-8. */
  readonly body: Buffer;
  /** `body.byteLength` — what EI-25 compares against `KERDIAL_JSON_LIMITS.maxFileBytes` to answer 413. */
  readonly byteLength: number;
  /** The manifest's own instant: the time the **first** page was read (RK9). */
  readonly exportedAt: Date;
  readonly counts: CatalogueExportCounts;
  /** Wall time of the whole read + serialize, measured here so AC-441's ratio has an honest denominator. */
  readonly durationMs: number;
}

/**
 * KD4.3's refusal, decided **during** the icon read
 * (security review M2).
 *
 * The controller turns this into `413 EXPORT_TOO_LARGE` with `?icons=omitted`
 * as the remedy, exactly as it already did for the post-serialisation check.
 * What changed is *when*: at the icon cap a tenant's document is ~500 icons ×
 * 349 528 base64 characters, and deciding on `body.byteLength` meant building
 * every one of those strings, the JSON around them and the `Buffer` under them
 * before answering. This refusal is reached with at most one page of icon rows
 * in memory.
 */
export interface CatalogueExportTooLarge {
  readonly refused: true;
  /**
   * The size the document had already reached when the read stopped: the
   * icon-less body, **measured**, plus the exact base64 length of every icon
   * read — including the one whose charge crossed the ceiling, so this figure
   * is always strictly over {@link maxFileBytes} and the 413 that quotes it
   * does not contradict itself.
   *
   * A **lower bound**, deliberately: it leaves out the ~60 bytes of JSON each
   * `icon` object wraps its base64 in, so this gate never refuses a document
   * that would in fact have fitted. The exact answer stays where it was — the
   * controller's own `byteLength` check on the serialised body, now a backstop
   * rather than the whole mechanism.
   */
  readonly projectedBytes: number;
  /** Icon rows **encoded** before the stop — the observable that the paging stopped early rather than merely refusing late. */
  readonly iconsRead: number;
  readonly maxFileBytes: number;
  readonly durationMs: number;
}

/** What {@link readCatalogueForExport} answers: a document, or KD4.3's refusal. */
export type CatalogueExport = CatalogueExportResult | CatalogueExportTooLarge;

export interface TransactionsExportResult {
  /** `kerdial-transactions.csv`, UTF-8. */
  readonly body: Buffer;
  readonly byteLength: number;
  /** Data rows written — the version line and the header row are not counted. */
  readonly rowCount: number;
  readonly durationMs: number;
}

/**
 * The module's single seam onto `withTenant` — see {@link tenantReader}.
 * Declared as an interface rather than left to inference so that the paged
 * helpers below can name it without depending on the shape of a query
 * builder's return type.
 */
interface TenantReader {
  read<T>(section: string, run: (tx: Tx) => Promise<T>): Promise<T>;
  /** The first read's instant — the manifest's `exportedAt`. */
  exportedAt(): Date;
}

/**
 * The module's single seam onto `withTenant` (rule 1 above).
 *
 * `read` opens one short, tenant-scoped, `app_web` transaction, times it, and
 * reports the span. It also records the instant of the **first** read, which
 * is what the catalogue manifest stamps: paging across transactions means the
 * export is not a point-in-time snapshot (stated outright), so the file
 * claims the earliest instant it read anything at, never an instant after
 * data it does not contain.
 */
function tenantReader(db: Db, tenantId: TenantId, options: ExportReadOptions): TenantReader {
  const clock = options.clock ?? systemClock;
  let firstReadAt: Date | null = null;

  return {
    async read<T>(section: string, run: (tx: Tx) => Promise<T>): Promise<T> {
      const at = clock.now();
      firstReadAt ??= at;
      const startedAt = performance.now();
      try {
        return await withTenant(db, tenantId, run);
      } finally {
        const endedAt = performance.now();
        options.onTransactionSpan?.({
          section,
          kind: "transaction",
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
        });
      }
    },
    /** The first read's instant. Called after at least one read — every export path has one. */
    exportedAt(): Date {
      if (firstReadAt === null) {
        throw new Error("exportedAt() read before any export transaction ran");
      }
      return firstReadAt;
    },
  };
}

/**
 * An RFC 3339 **UTC** instant at second precision — `2026-09-24T18:03:11Z`,
 * the manifest's own form. `toISOString()`'s milliseconds are dropped
 * rather than kept: two exports a millisecond apart are not a distinction the
 * document has any use for, and the fractional form would make a hand-authored
 * manifest and an exported one two spellings of one field.
 */
function rfc3339Utc(instant: Date): string {
  return `${instant.toISOString().slice(0, 19)}Z`;
}

/* -------------------------------------------------------------------------- */
/*  The catalogue package — `kerdial-instruments.json`                         */
/* -------------------------------------------------------------------------- */

type CatalogueInstrumentEntry = KerdialCatalogueDocument["instruments"][number];
type CataloguePortfolioEntry = KerdialCatalogueDocument["portfolios"][number];
type CatalogueCashAccountEntry = CataloguePortfolioEntry["cashAccounts"][number];
type CatalogueManualPriceEntry = CatalogueInstrumentEntry["manualPrices"][number];
type CatalogueFxRateEntry = KerdialCatalogueDocument["fxRatesUser"][number];
type CatalogueInstrumentIcon = NonNullable<CatalogueInstrumentEntry["icon"]>;
type CataloguePortfolioIcon = NonNullable<CataloguePortfolioEntry["icon"]>;

/**
 * The three paged reads below name their page's row type explicitly, and pass
 * it to `read<T>` as a type argument rather than letting it be inferred.
 *
 * That is not decoration: a keyset page's query mentions the cursor, the
 * cursor comes from the previous page, and TypeScript refuses to infer a type
 * that is (however indirectly) defined in terms of itself — `page implicitly
 * has type any because it is referenced ... in its own initializer`, MEASURED
 * on this exact file. Naming the row type cuts the loop, and has the side
 * effect of pinning each page's projection against the document shape it
 * feeds: a column that stops matching is a compile error here rather than a
 * silently widened `unknown`.
 */
interface InstrumentIconPageRow {
  readonly instrumentId: string;
  readonly bytes: Buffer;
  /** `octet_length(bytes)` by CHECK — the number {@link chargeIcon} decides on. */
  readonly byteLength: number;
  readonly contentType: CatalogueInstrumentIcon["contentType"];
  readonly source: CatalogueInstrumentIcon["source"];
}

interface PortfolioIconPageRow {
  readonly portfolioId: string;
  readonly bytes: Buffer;
  /** See {@link InstrumentIconPageRow.byteLength}. */
  readonly byteLength: number;
  readonly contentType: CataloguePortfolioIcon["contentType"];
}

interface ManualPricePageRow {
  readonly instrumentId: string;
  readonly priceDate: string;
  readonly close: Decimal;
  readonly currency: string;
}

/**
 * Reads the tenant's catalogue and settings and serializes it
 * (FR-500(a)).
 *
 * One short transaction per section — manifest, instruments, provider
 * mappings, icons, manual prices, watchlist, portfolios, cash accounts, user
 * FX rates — with the icon and manual-price sections paged (they are the two
 * that are row-count- or byte-unbounded in a way the others are not).
 *
 * **Which instruments are "the tenant's"**: every instrument the tenant can
 * *list* — the whole shared catalogue (`owner_tenant_id IS NULL`) plus the
 * rows it owns privately (`owner_tenant_id = tenantId`, FR-504) — which is
 * exactly what `GET /instruments` shows on the instruments screen
 * (`listInstruments`, `ledger/src/instrument-service.ts`, filters
 * `owner_tenant_id IS NULL`; the private half is this export's own superset,
 * see {@link collectInstrumentIds}). The export is the instruments screen in a
 * file, so an instrument that is *named* but not yet traded travels too.
 *
 * A shared-catalogue row travels by identity with `private: false` (FR-503); it
 * is the same entry shape either way, and `private` is the whole of the
 * difference, which is what lets the import decide "match" vs "create" from the
 * document alone. **The tenant-owned attachments stay tenant-scoped**: an
 * instrument's icon, its manual prices and its watchlist entry are read from
 * RLS-scoped tables, so an instrument another household named appears in this
 * document as bare catalogue metadata and nothing else. Its provider mapping
 * travels with it, and that is not an exception: `instrument_provider_map`
 * carries no RLS and its `owner_tenant_id` is NULL on every live row
 * (MEASURED) — it is shared catalogue data, the same as the instrument row it
 * pins. **The mapping query nevertheless states `owner_tenant_id IS NULL OR =
 * tenant`, symmetrically with the instrument query**: a table
 * with no RLS and a column nobody writes yet is one writer away from a
 * cross-tenant read, and "no writer exists" is not a predicate.
 *
 * **How the byte ceiling is enforced differs by `icons`, on purpose**:
 *
 *  - `icons=included` refuses **early**: the icon-less body is serialised once
 *    to measure the floor, and each icon is charged against what is left
 *    *before* it is encoded, so an oversize catalogue is
 *    refused without ever holding its icons. The price is that the non-icon
 *    part is serialised twice — once to measure, once inside the served
 *    document. CPU, not memory: the measuring string is dropped before any
 *    icon is read.
 *  - `icons=omitted` — the remedy the 413 names — has **no early refusal**,
 *    because there is nothing to project: the icon-less body *is* the
 *    document, and measuring it is serialising it. It is served once and
 *    refused, if at all, by the controller's exact post-serialisation check.
 *    Its size is bounded by the manual-price tenant cap (≈25–40 MB of JSON),
 *    not by icons, so its peak is ~3× that — up to ~120 MB, the same order as
 *    the ~100 MiB per export the api's memory budget assumes, and bounded in
 *    number by the export concurrency cap of 2.
 */
export async function readCatalogueForExport(
  db: Db,
  tenantId: TenantId,
  options: CatalogueExportOptions,
): Promise<CatalogueExport> {
  const startedAt = performance.now();
  const reader = tenantReader(db, tenantId, options);
  const withIcons = options.icons === "included";

  const baseCurrency = await reader.read("catalogue:manifest", async (tx) => {
    // `app_web` holds a column-level grant on `(id, base_currency)` only
    // (migration 0024) — and `tenant` carries no RLS (it *is* the tenant
    // root), so the `where` here is the scoping, deliberately explicit.
    const [row] = await tx
      .select({ baseCurrency: tenant.baseCurrency })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    if (row === undefined) throw new Error(`tenant ${tenantId} does not exist`);
    return row.baseCurrency;
  });

  const instrumentRows = await reader.read("catalogue:instruments", async (tx) => {
    const ids = await collectInstrumentIds(tx, tenantId);
    if (ids.length === 0) return [];
    return tx
      .select({
        id: instrument.id,
        kind: instrument.kind,
        isin: instrument.isin,
        exchangeMic: instrument.exchangeMic,
        symbol: instrument.symbol,
        ownerTenantId: instrument.ownerTenantId,
        listingCurrency: instrument.listingCurrency,
        displayName: instrument.displayName,
        primaryIdentifier: instrument.primaryIdentifier,
        quotePolicy: instrument.quotePolicy,
        status: instrument.status,
        figi: instrument.figi,
        sectorCode: instrument.sectorCode,
        industryLabel: instrument.industryLabel,
        domicileCountry: instrument.domicileCountry,
        managementCompany: instrument.managementCompany,
        subscriptionFeePct: instrument.subscriptionFeePct,
      })
      .from(instrument)
      .where(inArray(instrument.id, ids))
      .orderBy(asc(instrument.id));
  });

  const instrumentIds = instrumentRows.map((row) => row.id);

  const mappings = await reader.read("catalogue:provider-mappings", async (tx) => {
    if (instrumentIds.length === 0) return new Map<string, { key: string; symbol: string }>();
    // Only a **CONFIRMED** mapping travels: `confidence` and
    // `lastVerifiedAt` are deliberately not in the document, and an imported
    // mapping is written through the confirm path — so exporting a HEURISTIC
    // guess would turn a guess into an assertion on the next import. The
    // document carries at most one mapping per instrument; `provider_key`
    // order makes the choice deterministic rather than driver-dependent.
    //
    // **The `owner_tenant_id` predicate is this query's own tenancy scope**
    // (security review L1). `instrument_provider_map` carries no
    // RLS — it is shared catalogue data — so unlike every other read in this
    // file the transaction's `SET LOCAL` does not bound it, and the only thing
    // standing between another household's private mapping and this document is
    // the sentence below. It matches nothing today (no writer sets the column
    // yet) and is written out for the same reason
    // {@link collectInstrumentIds}'s own half is: the export must be correct the
    // day a writer for it lands, not the day someone remembers this query.
    const rows = await tx
      .select({
        instrumentId: instrumentProviderMap.instrumentId,
        providerKey: instrumentProviderMap.providerKey,
        providerSymbol: instrumentProviderMap.providerSymbol,
      })
      .from(instrumentProviderMap)
      .where(
        and(
          inArray(instrumentProviderMap.instrumentId, instrumentIds),
          eq(instrumentProviderMap.confidence, "CONFIRMED"),
          // A mapping under a retired provider key (`coingecko`) is read
          // by nothing, and would sort ahead of `yahoo` below.
          inArray(instrumentProviderMap.providerKey, [...routedProviderKeys()]),
          or(
            isNull(instrumentProviderMap.ownerTenantId),
            eq(instrumentProviderMap.ownerTenantId, tenantId),
          ),
        ),
      )
      .orderBy(asc(instrumentProviderMap.instrumentId), asc(instrumentProviderMap.providerKey));
    const byInstrument = new Map<string, { key: string; symbol: string }>();
    for (const row of rows) {
      if (!byInstrument.has(row.instrumentId)) {
        byInstrument.set(row.instrumentId, { key: row.providerKey, symbol: row.providerSymbol });
      }
    }
    return byInstrument;
  });

  const manualPrices = await readManualPrices(reader);

  const watchlist = await reader.read("catalogue:watchlist", async (tx) => {
    const rows = await tx
      .select({
        instrumentId: watchlistItem.instrumentId,
        targetPrice: watchlistItem.targetPrice,
        note: watchlistItem.note,
      })
      .from(watchlistItem)
      .orderBy(asc(watchlistItem.instrumentId));
    return new Map(rows.map((row) => [row.instrumentId, row]));
  });

  const portfolioRows = await reader.read("catalogue:portfolios", async (tx) =>
    tx
      .select({
        id: portfolio.id,
        name: portfolio.name,
        broker: portfolio.broker,
        description: portfolio.description,
        accentColor: portfolio.accentColor,
        archivedAt: portfolio.archivedAt,
      })
      .from(portfolio)
      .orderBy(asc(portfolio.name)),
  );

  const cashAccounts = await reader.read("catalogue:cash-accounts", async (tx) => {
    const rows = await tx
      .select({
        portfolioId: cashAccount.portfolioId,
        name: cashAccount.name,
        currency: cashAccount.currency,
        archivedAt: cashAccount.archivedAt,
      })
      .from(cashAccount)
      .orderBy(asc(cashAccount.portfolioId), asc(cashAccount.name));
    const byPortfolio = new Map<string, CatalogueCashAccountEntry[]>();
    for (const row of rows) {
      const list = byPortfolio.get(row.portfolioId) ?? [];
      // `archived` is `archived_at IS NOT NULL`: the instant itself is
      // operational, so only the flag travels.
      list.push({ name: row.name, currency: row.currency, archived: row.archivedAt !== null });
      byPortfolio.set(row.portfolioId, list);
    }
    return byPortfolio;
  });

  const fxRatesUser = await reader.read("catalogue:fx-rates-user", async (tx) => {
    const rows = await tx
      .select({
        baseCurrency: fxRateUser.baseCurrency,
        quoteCurrency: fxRateUser.quoteCurrency,
        rateDate: fxRateUser.rateDate,
        rate: fxRateUser.rate,
      })
      .from(fxRateUser)
      .orderBy(
        asc(fxRateUser.baseCurrency),
        asc(fxRateUser.quoteCurrency),
        asc(fxRateUser.rateDate),
      );
    return rows.map((row): CatalogueFxRateEntry => ({
      baseCurrency: row.baseCurrency,
      quoteCurrency: row.quoteCurrency,
      rateDate: row.rateDate,
      // FR-505/NFR-61: a figure is a decimal **string**, converted here —
      // once, on the way out of the ledger — so the serializer has no JSON
      // number available to emit even by accident.
      rate: serializeDecimal(row.rate),
    }));
  });

  const exportedAt = reader.exportedAt();

  /**
   * The document, given a set of icons — called **twice**: once
   * with none, to measure the floor the icon budget is taken from, and once
   * with the icons that fitted.
   *
   * Building it is pure map/`reduce` over rows already in memory; the cost the
   * gate exists to avoid is the base64 encoding, which happens in
   * {@link readInstrumentIcons} and not here.
   */
  const documentOf = (
    instrumentIcons: ReadonlyMap<string, CatalogueInstrumentEntry["icon"]>,
    portfolioIconsOf: ReadonlyMap<string, CataloguePortfolioEntry["icon"]>,
  ): KerdialCatalogueDocument => {
    const instruments = instrumentRows.map((row): CatalogueInstrumentEntry => {
      const mapping = mappings.get(row.id);
      const icon = instrumentIcons.get(row.id);
      const watched = watchlist.get(row.id);
      return {
        identity: {
          kind: row.kind,
          ...optional("isin", row.isin),
          ...optional("exchangeMic", row.exchangeMic),
          ...optional("symbol", row.symbol),
        },
        private: row.ownerTenantId === tenantId,
        listingCurrency: row.listingCurrency,
        displayName: row.displayName,
        primaryIdentifier: row.primaryIdentifier,
        quotePolicy: row.quotePolicy,
        status: row.status,
        ...optional("figi", row.figi),
        // Never for an SCPI (N11), even on a row that already carries
        // one — the importer refuses the pair on an SCPI entry (G7).
        ...optional("sectorCode", row.kind === "SCPI" ? null : row.sectorCode),
        ...optional("industryLabel", row.kind === "SCPI" ? null : row.industryLabel),
        ...optional("domicileCountry", row.domicileCountry),
        // SCPI only: NULL on every other kind (a CHECK of
        // migration 0074), so neither key appears for a tenant without an SCPI.
        ...optional("managementCompany", row.managementCompany),
        ...(row.subscriptionFeePct !== null && {
          subscriptionFeePct: serializeSubscriptionFeePct(row.subscriptionFeePct),
        }),
        ...(mapping !== undefined && {
          providerMapping: { providerKey: mapping.key, providerSymbol: mapping.symbol },
        }),
        ...(icon !== undefined && { icon }),
        manualPrices: manualPrices.get(row.id) ?? [],
        ...(watched !== undefined &&
          (watched.targetPrice !== null || watched.note !== null) && {
            watchlist: {
              ...(watched.targetPrice !== null && {
                targetPrice: serializeDecimal(watched.targetPrice),
              }),
              ...optional("note", watched.note),
            },
          }),
      };
    });

    const portfolios = portfolioRows.map((row): CataloguePortfolioEntry => {
      const icon = portfolioIconsOf.get(row.id);
      return {
        name: row.name,
        ...optional("broker", row.broker),
        ...optional("description", row.description),
        ...optional("accentColor", row.accentColor),
        ...(icon !== undefined && { icon }),
        // FR-604: `archived_at IS NOT NULL`, written only as `true`; a
        // non-archived portfolio carries no key at all.
        ...(row.archivedAt !== null && { archived: true as const }),
        cashAccounts: cashAccounts.get(row.id) ?? [],
      };
    });

    return {
      schemaVersion: KERDIAL_CATALOGUE_SCHEMA_VERSION,
      generator: KERDIAL_CATALOGUE_GENERATOR,
      exportedAt: rfc3339Utc(exportedAt),
      baseCurrency,
      iconsIncluded: withIcons,
      instruments,
      portfolios,
      fxRatesUser,
    };
  };

  const served = (document: KerdialCatalogueDocument, iconCount: number): CatalogueExportResult => {
    const body = serialized("catalogue:serialize", options, () =>
      serializeKerdialCatalogue(document),
    );
    return {
      refused: false,
      body,
      byteLength: body.byteLength,
      exportedAt,
      counts: {
        instruments: document.instruments.length,
        portfolios: document.portfolios.length,
        cashAccounts: document.portfolios.reduce(
          (total, entry) => total + entry.cashAccounts.length,
          0,
        ),
        icons: iconCount,
        manualPrices: document.instruments.reduce(
          (total, entry) => total + entry.manualPrices.length,
          0,
        ),
        watchlistItems: document.instruments.filter((entry) => entry.watchlist !== undefined)
          .length,
        fxRatesUser: document.fxRatesUser.length,
      },
      durationMs: performance.now() - startedAt,
    };
  };

  const noIcons = new Map<string, CatalogueInstrumentEntry["icon"]>();
  const noPortfolioIcons = new Map<string, CataloguePortfolioEntry["icon"]>();
  if (!withIcons) return served(documentOf(noIcons, noPortfolioIcons), 0);

  // KD4.3, first half: the icon-**less** body is the floor, and
  // it is measured rather than guessed. A tenant whose manual prices alone
  // overflow the ceiling is refused here with **no icon row read at all**,
  // which the earlier code could not do — it decided on a body that already
  // held every icon.
  //
  // The extra serialisation this costs is of the part that is not the problem:
  // GATE-1's whole non-icon document measured 3 350 bytes for six entities
  // (MEASURED, `exports.round-trip.integration.test.ts`), against the ~175 MB
  // of base64 the icon cap admits.
  const iconlessBytes = serialized("catalogue:measure-iconless", options, () =>
    serializeKerdialCatalogue(documentOf(noIcons, noPortfolioIcons)),
  ).byteLength;
  const budget: IconBudget = {
    remainingBytes: options.maxFileBytes - iconlessBytes,
    base64Bytes: 0,
    rowsRead: 0,
    exceeded: false,
  };
  const refusal = (): CatalogueExportTooLarge => ({
    refused: true,
    projectedBytes: iconlessBytes + budget.base64Bytes,
    iconsRead: budget.rowsRead,
    maxFileBytes: options.maxFileBytes,
    durationMs: performance.now() - startedAt,
  });
  if (budget.remainingBytes < 0) return refusal();

  const icons = await readInstrumentIcons(reader, instrumentIds, budget);
  if (budget.exceeded) return refusal();
  const portfolioIcons = await readPortfolioIcons(
    reader,
    portfolioRows.map((row) => row.id),
    budget,
  );
  if (budget.exceeded) return refusal();

  return served(documentOf(icons, portfolioIcons), icons.size + portfolioIcons.size);
}

/**
 * The running icon budget, shared by the two icon reads — KD4.3's ceiling is on
 * the *document*, so one tenant's 400 instrument icons and its 300 portfolio
 * icons are one total and not two.
 *
 * `base64Bytes` is **exact, not an estimate**: `4 * ceil(n / 3)` is base64's own
 * padded length, the same expression
 * `core/reference-data/src/instrument-icon.ts` derives
 * `INSTRUMENT_ICON_MAX_BASE64_CHARS` with, and every character of it is one
 * UTF-8 byte in the document. What it leaves out is the JSON each icon object
 * wraps it in (~60 bytes), which is why the projection is a lower bound and the
 * controller's own byte check remains the exact answer.
 */
interface IconBudget {
  /** `maxFileBytes` minus the measured icon-less body. */
  remainingBytes: number;
  /** Base64 length of every icon row charged, the one that tripped the budget included. */
  base64Bytes: number;
  rowsRead: number;
  /** Set once the budget is spent; both readers stop paging on it. */
  exceeded: boolean;
}

/**
 * Charges one icon row against {@link IconBudget} **before** it is encoded, and
 * says whether it may be.
 *
 * `byte_length` is a column (`instrument_icon`/`portfolio_icon`, with a CHECK
 * that it equals `octet_length(bytes)` — MEASURED, the schema files), so this
 * costs nothing beyond the row already read and the decision is made on a
 * number rather than on the string it would have produced.
 */
function chargeIcon(budget: IconBudget, byteLength: number): boolean {
  // Charged **before** the verdict, so the row that crosses the ceiling is
  // counted into the projection: a refusal whose stated size did not exceed the
  // stated ceiling would be a 413 that contradicts itself.
  budget.base64Bytes += 4 * Math.ceil(byteLength / 3);
  if (budget.base64Bytes > budget.remainingBytes) {
    budget.exceeded = true;
    return false;
  }
  budget.rowsRead += 1;
  return true;
}

/**
 * Every instrument id the export carries: **everything the tenant can list**,
 * plus everything it has attached something to.
 *
 * The first source is the one that matters and the one this function used to
 * lack (TESTER-1 finding F1). It mirrors `listInstruments`
 * (`ledger/src/instrument-service.ts`), the query behind `GET /instruments`:
 * the shared catalogue is visible to every tenant, so the export of "my
 * instruments" is the screen that lists them, not the subset that happens to
 * have a trade or an icon behind it. Without it, an instrument named through
 * the catalogue import and not yet traded was created, listed on the screen,
 * and then absent from the very next export — which is the L4 audience's own
 * first move ("name it now, trade it later").
 *
 * `owner_tenant_id = tenantId` is the private half FR-504 reserves. It matches
 * nothing today — no writer sets that column anywhere in the repository
 * — and is written out rather than assumed away, because the
 * export must be the superset of what the screen shows the day a create path
 * for it lands, not the day someone remembers this function.
 *
 * The five attachment sources are kept **beneath** the visibility query rather
 * than replaced by it: they are all RLS-scoped tables, and an instrument this
 * tenant has traded but cannot list (a row privately owned by someone else)
 * would otherwise silently drop out of an export that used to carry it. No such
 * row can exist today, for the reason above; the union costs one round of
 * `Set.add` and removes the need to prove it.
 */
async function collectInstrumentIds(tx: Tx, tenantId: TenantId): Promise<string[]> {
  const ids = new Set<string>();
  const visible = await tx
    .select({ id: instrument.id })
    .from(instrument)
    .where(or(isNull(instrument.ownerTenantId), eq(instrument.ownerTenantId, tenantId)));
  for (const row of visible) ids.add(row.id);

  const traded = await tx
    .selectDistinct({ id: transaction.instrumentId })
    .from(transaction)
    .where(isNotNull(transaction.instrumentId));
  for (const row of traded) if (row.id !== null) ids.add(row.id);

  const settled = await tx
    .selectDistinct({ id: transaction.txnSettlementInstrumentId })
    .from(transaction)
    .where(isNotNull(transaction.txnSettlementInstrumentId));
  for (const row of settled) if (row.id !== null) ids.add(row.id);

  const watched = await tx.selectDistinct({ id: watchlistItem.instrumentId }).from(watchlistItem);
  for (const row of watched) ids.add(row.id);

  const priced = await tx
    .selectDistinct({ id: manualPricePoint.instrumentId })
    .from(manualPricePoint);
  for (const row of priced) ids.add(row.id);

  const iconed = await tx.selectDistinct({ id: instrumentIcon.instrumentId }).from(instrumentIcon);
  for (const row of iconed) ids.add(row.id);

  return [...ids];
}

/**
 * Instrument icons, paged at {@link ICON_PAGE_ROWS} and keyset-paginated on
 * `instrument_id` (the table's own primary key alongside `tenant_id`, so the
 * keyset is total). Bytes travel verbatim — base64 of exactly what is stored,
 * no re-encode, no metadata strip (FR-514/L10).
 */
async function readInstrumentIcons(
  reader: TenantReader,
  instrumentIds: readonly string[],
  budget: IconBudget,
): Promise<Map<string, CatalogueInstrumentEntry["icon"]>> {
  const icons = new Map<string, CatalogueInstrumentEntry["icon"]>();
  if (instrumentIds.length === 0) return icons;
  let after: string | null = null;
  for (;;) {
    const page = await instrumentIconPage(reader, after);
    for (const row of page) {
      // Charged on `byte_length` first, and the encode is what
      // is skipped when the budget is spent — not merely the keeping of the
      // result. Returning here also stops the **paging**, which is the half
      // that bounds a 500-icon tenant to one page in memory.
      if (!chargeIcon(budget, row.byteLength)) return icons;
      icons.set(row.instrumentId, {
        contentType: row.contentType,
        source: row.source,
        base64: catalogueIconBase64(row.bytes),
      });
    }
    if (page.length < ICON_PAGE_ROWS) return icons;
    after = page[page.length - 1]!.instrumentId;
  }
}

/**
 * One page of instrument icons.
 *
 * **Every paged read below is written as its own function with an explicit
 * return type, and the loop that drives it holds only the cursor.** Inlining
 * the query in the loop does not compile: the query mentions the cursor, the
 * cursor is assigned from the previous page, and TypeScript then refuses the
 * page's type as "referenced in its own initializer" (MEASURED on this file,
 * `TS7022`/`TS7024`). The split is the fix, and it also makes each page's
 * projection reviewable beside its keyset predicate.
 */
function instrumentIconPage(
  reader: TenantReader,
  after: string | null,
): Promise<InstrumentIconPageRow[]> {
  return reader.read<InstrumentIconPageRow[]>("catalogue:icons", async (tx) =>
    tx
      .select({
        instrumentId: instrumentIcon.instrumentId,
        bytes: instrumentIcon.bytes,
        byteLength: instrumentIcon.byteLength,
        contentType: instrumentIcon.contentType,
        source: instrumentIcon.source,
      })
      .from(instrumentIcon)
      .where(after === null ? undefined : gt(instrumentIcon.instrumentId, after))
      .orderBy(asc(instrumentIcon.instrumentId))
      .limit(ICON_PAGE_ROWS),
  );
}

/** Portfolio icons — the same shape and the same paging, **without** `source`: `portfolio_icon` has no such column. */
async function readPortfolioIcons(
  reader: TenantReader,
  portfolioIds: readonly string[],
  budget: IconBudget,
): Promise<Map<string, CataloguePortfolioEntry["icon"]>> {
  const icons = new Map<string, CataloguePortfolioEntry["icon"]>();
  if (portfolioIds.length === 0) return icons;
  let after: string | null = null;
  for (;;) {
    const page = await portfolioIconPage(reader, after);
    for (const row of page) {
      if (!chargeIcon(budget, row.byteLength)) return icons;
      icons.set(row.portfolioId, {
        contentType: row.contentType,
        base64: catalogueIconBase64(row.bytes),
      });
    }
    if (page.length < ICON_PAGE_ROWS) return icons;
    after = page[page.length - 1]!.portfolioId;
  }
}

/** One page of portfolio icons — see {@link instrumentIconPage} on why this is its own function. */
function portfolioIconPage(
  reader: TenantReader,
  after: string | null,
): Promise<PortfolioIconPageRow[]> {
  return reader.read<PortfolioIconPageRow[]>("catalogue:portfolio-icons", async (tx) =>
    tx
      .select({
        portfolioId: portfolioIcon.portfolioId,
        bytes: portfolioIcon.bytes,
        byteLength: portfolioIcon.byteLength,
        contentType: portfolioIcon.contentType,
      })
      .from(portfolioIcon)
      .where(after === null ? undefined : gt(portfolioIcon.portfolioId, after))
      .orderBy(asc(portfolioIcon.portfolioId))
      .limit(ICON_PAGE_ROWS),
  );
}

/**
 * Manual price points, paged at {@link MANUAL_PRICE_PAGE_ROWS} and keyset-
 * paginated on `(instrument_id, price_date)` — the remainder of the table's
 * own primary key once `tenant_id` is fixed by RLS, so the keyset is total.
 */
async function readManualPrices(
  reader: TenantReader,
): Promise<Map<string, CatalogueManualPriceEntry[]>> {
  const byInstrument = new Map<string, CatalogueManualPriceEntry[]>();
  let after: ManualPriceCursor | null = null;
  for (;;) {
    const page = await manualPricePage(reader, after);
    for (const row of page) {
      const list = byInstrument.get(row.instrumentId) ?? [];
      list.push({
        priceDate: row.priceDate,
        close: serializeDecimal(row.close),
        currency: row.currency,
      });
      byInstrument.set(row.instrumentId, list);
    }
    if (page.length < MANUAL_PRICE_PAGE_ROWS) return byInstrument;
    const last = page[page.length - 1]!;
    after = { instrumentId: last.instrumentId, priceDate: last.priceDate };
  }
}

interface ManualPriceCursor {
  readonly instrumentId: string;
  readonly priceDate: string;
}

/** One page of manual price points — see {@link instrumentIconPage} on why this is its own function. */
function manualPricePage(
  reader: TenantReader,
  after: ManualPriceCursor | null,
): Promise<ManualPricePageRow[]> {
  return reader.read<ManualPricePageRow[]>("catalogue:manual-prices", async (tx) =>
    tx
      .select({
        instrumentId: manualPricePoint.instrumentId,
        priceDate: manualPricePoint.priceDate,
        close: manualPricePoint.close,
        currency: manualPricePoint.currency,
      })
      .from(manualPricePoint)
      .where(
        after === null
          ? undefined
          : or(
              gt(manualPricePoint.instrumentId, after.instrumentId),
              and(
                eq(manualPricePoint.instrumentId, after.instrumentId),
                gt(manualPricePoint.priceDate, after.priceDate),
              ),
            ),
      )
      .orderBy(asc(manualPricePoint.instrumentId), asc(manualPricePoint.priceDate))
      .limit(MANUAL_PRICE_PAGE_ROWS),
  );
}

/**
 * `{ key: value }` when `value` is present, `{}` when it is `null` — the rule
 * "optional means omitted, never `null`", written once. With
 * `exactOptionalPropertyTypes` on, an explicit `undefined` would not even
 * type-check, which is the point.
 */
function optional<K extends string, V>(key: K, value: V | null): { [P in K]?: V } {
  return (value === null ? {} : { [key]: value }) as { [P in K]?: V };
}

/* -------------------------------------------------------------------------- */
/*  The transactions package — `kerdial-transactions.csv`                      */
/* -------------------------------------------------------------------------- */

interface CashAccountRef {
  readonly name: string;
  readonly currency: string;
}

interface InstrumentIdentityRef {
  readonly isin: string | null;
  readonly exchangeMic: string | null;
  readonly symbol: string | null;
}

/**
 * Reads the tenant's transactions and serializes them (FR-500(b)).
 *
 * Three lookup maps — portfolio names, cash-account names and currencies,
 * instrument identities — are read **once**, each in its own short
 * transaction, before paging begins; the pages then resolve ids to names in
 * memory instead of joining five tables per page. The maps are bounded by the
 * product's own caps (500 portfolios, 200 cash accounts each) and by the
 * tenant's distinct instrument ids.
 *
 * **Paging order vs. file order.** Pages are ordered — and keyset-paginated —
 * on `(trade_date, seq)`. `seq` is unique per tenant, so that pair is a total
 * order and no `OFFSET` scan is needed. The *file's* order is
 * `(trade_date, trade_ts NULLS FIRST, seq)`, and it is
 * `serializeKerdialTransactions` that applies it, over the buffered rows.
 * The file's order is named beside the keyset's, but a keyset only
 * works when the `ORDER BY` **is** the keyset, and the whole file is buffered
 * anyway, so the sort belongs where the writer already does it. Nothing is
 * lost: the bytes are in the design's stated order either way.
 */
export async function readTransactionsForExport(
  db: Db,
  tenantId: TenantId,
  options: TransactionsExportOptions = {},
): Promise<TransactionsExportResult> {
  const startedAt = performance.now();
  const reader = tenantReader(db, tenantId, options);

  const portfolios = await reader.read("transactions:portfolios", async (tx) => {
    const rows = await tx.select({ id: portfolio.id, name: portfolio.name }).from(portfolio);
    return new Map(rows.map((row) => [row.id, row.name]));
  });

  const cashAccounts = await reader.read("transactions:cash-accounts", async (tx) => {
    const rows = await tx
      .select({ id: cashAccount.id, name: cashAccount.name, currency: cashAccount.currency })
      .from(cashAccount);
    return new Map<string, CashAccountRef>(
      rows.map((row) => [row.id, { name: row.name, currency: row.currency }]),
    );
  });

  const identities = await reader.read("transactions:instruments", async (tx) => {
    const ids = new Set<string>();
    const traded = await tx
      .selectDistinct({ id: transaction.instrumentId })
      .from(transaction)
      .where(isNotNull(transaction.instrumentId));
    for (const row of traded) if (row.id !== null) ids.add(row.id);
    const settled = await tx
      .selectDistinct({ id: transaction.txnSettlementInstrumentId })
      .from(transaction)
      .where(isNotNull(transaction.txnSettlementInstrumentId));
    for (const row of settled) if (row.id !== null) ids.add(row.id);
    if (ids.size === 0) return new Map<string, InstrumentIdentityRef>();
    const rows = await tx
      .select({
        id: instrument.id,
        isin: instrument.isin,
        exchangeMic: instrument.exchangeMic,
        symbol: instrument.symbol,
      })
      .from(instrument)
      .where(inArray(instrument.id, [...ids]));
    return new Map<string, InstrumentIdentityRef>(
      rows.map((row) => [
        row.id,
        { isin: row.isin, exchangeMic: row.exchangeMic, symbol: row.symbol },
      ]),
    );
  });

  const source: SourceTransactionRow[] = [];
  let after: TransactionCursor | null = null;
  for (;;) {
    const page = await transactionPage(reader, after);
    source.push(...page);
    if (page.length < TRANSACTION_PAGE_ROWS) break;
    const last = page[page.length - 1]!;
    after = { tradeDate: last.tradeDate, seq: last.seq };
  }

  const rows = projectTransactions(source, { portfolios, cashAccounts, identities });
  const body = serialized("transactions:serialize", options, () =>
    serializeKerdialTransactions(rows),
  );
  return {
    body,
    byteLength: body.byteLength,
    rowCount: rows.length,
    durationMs: performance.now() - startedAt,
  };
}

interface TransactionCursor {
  readonly tradeDate: string;
  readonly seq: bigint;
}

/**
 * One page of transactions — see {@link instrumentIconPage} on why this is its
 * own function.
 *
 * The keyset is `(trade_date, seq)`: `seq` is unique per tenant, so the pair is
 * a total order and the page after a given row is a plain index range, never an
 * `OFFSET` scan that re-reads what it has already returned.
 */
function transactionPage(
  reader: TenantReader,
  after: TransactionCursor | null,
): Promise<SourceTransactionRow[]> {
  return reader.read<SourceTransactionRow[]>("transactions:page", async (tx) =>
    tx
      .select(TRANSACTION_PROJECTION)
      .from(transaction)
      .where(
        after === null
          ? undefined
          : or(
              gt(transaction.tradeDate, after.tradeDate),
              and(eq(transaction.tradeDate, after.tradeDate), gt(transaction.seq, after.seq)),
            ),
      )
      .orderBy(asc(transaction.tradeDate), asc(transaction.seq))
      .limit(TRANSACTION_PAGE_ROWS),
  );
}

/**
 * The read projection, in one place so every page selects exactly the same
 * columns — and so the `CASE` expression below is written once.
 *
 * **`fx_rate` is selected only when its own source says
 * `USER_PINNED`** (L9/FR-521, AC-440's negative half made structural): the
 * value the serializer receives for any other provenance is `NULL`, so a
 * provider-derived rate cannot reach the file even if the writer's own
 * predicate were removed. `::text` keeps the driver's `numeric` in plain
 * notation, which {@link parsePinnedRate} then turns back into a `Decimal` —
 * never a `Number`, so no float touches a figure on this path.
 *
 * `'USER_PINNED'` is inline SQL (not a bound parameter) because it is compared
 * against an enum column: it is `fx_rate_source`'s own member, the same
 * literal `serialize.ts`'s `pinnedRateCell` tests.
 */
const TRANSACTION_PROJECTION = {
  kind: transaction.kind,
  tradeDate: transaction.tradeDate,
  tradeTs: transaction.tradeTs,
  seq: transaction.seq,
  baseCurrency: transaction.baseCurrency,
  portfolioId: transaction.portfolioId,
  cashAccountId: transaction.cashAccountId,
  instrumentId: transaction.instrumentId,
  settlementInstrumentId: transaction.txnSettlementInstrumentId,
  quantity: transaction.quantity,
  unitPrice: transaction.unitPrice,
  grossAmount: transaction.grossAmount,
  txnCurrency: transaction.txnCurrency,
  cashCurrency: transaction.cashCurrency,
  cashAmount: transaction.cashAmount,
  feeAmount: transaction.feeAmount,
  brokerFeeAmount: transaction.brokerFeeAmount,
  fxFeeAmount: transaction.fxFeeAmount,
  taxAmount: transaction.taxAmount,
  otherCostAmount: transaction.otherCostAmount,
  withholdingAmount: transaction.withholdingAmount,
  targetCurrency: transaction.targetCurrency,
  targetAmount: transaction.targetAmount,
  targetCashAccountId: transaction.targetCashAccountId,
  sourceDividendId: transaction.sourceDividendId,
  transferSourceId: transaction.transferSourceId,
  transferCostBase: transaction.transferCostBase,
  transferCostNative: transaction.transferCostNative,
  transferCostCurrency: transaction.transferCostCurrency,
  id: transaction.id,
  reference: transaction.reference,
  note: transaction.note,
  importFingerprint: transaction.importFingerprint,
  fxRateSource: transaction.fxRateSource,
  pinnedFxRate: sql<
    string | null
  >`case when ${transaction.fxRateSource} = 'USER_PINNED' then ${transaction.fxRate}::text end`,
} as const;

/** `transaction`'s own select model, so the enum-shaped columns below are named rather than retyped. */
type TransactionColumns = typeof transaction.$inferSelect;

/**
 * One row of {@link TRANSACTION_PROJECTION}, written out for the same reason
 * the icon and manual-price page rows are (see {@link InstrumentIconPageRow}):
 * the transaction pages are keyset-paginated, so the page's type cannot be
 * inferred from a query that mentions the previous page's cursor. TypeScript
 * still checks this shape against the projection at the `select` — a column
 * whose type moves is an error here, not a silent `unknown`.
 */
interface SourceTransactionRow {
  readonly kind: TransactionColumns["kind"];
  readonly tradeDate: string;
  readonly tradeTs: Date | null;
  readonly seq: bigint;
  readonly baseCurrency: string;
  readonly portfolioId: string;
  readonly cashAccountId: string | null;
  readonly instrumentId: string | null;
  readonly settlementInstrumentId: string | null;
  readonly quantity: Decimal | null;
  readonly unitPrice: Decimal | null;
  readonly grossAmount: Decimal;
  readonly txnCurrency: string | null;
  readonly cashCurrency: string | null;
  readonly cashAmount: Decimal | null;
  readonly feeAmount: Decimal | null;
  readonly brokerFeeAmount: Decimal | null;
  readonly fxFeeAmount: Decimal | null;
  readonly taxAmount: Decimal | null;
  readonly otherCostAmount: Decimal | null;
  readonly withholdingAmount: Decimal | null;
  readonly targetCurrency: string | null;
  readonly targetAmount: Decimal | null;
  readonly targetCashAccountId: string | null;
  readonly sourceDividendId: string | null;
  /** A `TRANSFER_IN`'s source leg; `NULL` on every other kind and on a severed target. */
  readonly transferSourceId: string | null;
  readonly transferCostBase: Decimal | null;
  readonly transferCostNative: Decimal | null;
  readonly transferCostCurrency: string | null;
  readonly id: string;
  readonly reference: string | null;
  readonly note: string | null;
  readonly importFingerprint: string | null;
  readonly fxRateSource: TransactionColumns["fxRateSource"];
  /** `NULL` unless `fx_rate_source = 'USER_PINNED'` — see {@link TRANSACTION_PROJECTION}. */
  readonly pinnedFxRate: string | null;
}

interface TransactionLookups {
  readonly portfolios: ReadonlyMap<string, string>;
  readonly cashAccounts: ReadonlyMap<string, CashAccountRef>;
  readonly identities: ReadonlyMap<string, InstrumentIdentityRef>;
}

/**
 * Turns the read rows into the writer's own projection, one row per
 * transaction, **with every column the row's `type` does not apply to left
 * blank** (the per-kind table, which `columns.ts` encodes as `appliesTo`).
 * That blanking is not cosmetic: a populated column on a kind that has no such
 * leg is `UNSUPPORTED_LEG` on re-import, and the ledger stores several columns
 * degenerately — a `CURRENCY_EXCHANGE` carries `cash_currency`/`cash_amount`
 * equal to its own principal (`degenerateCashLeg`, MEASURED
 * `ledger/src/transaction-write-service.ts`), and re-exporting those would
 * make a round trip refuse its own file.
 *
 * `row_ref`/`drip_of`/`transfer_of` are minted here, after paging, because
 * they are **file-local labels** and the row naming one may be read on
 * a later page than the row that declares it. Every exported `DIVIDEND` gets a
 * `d<n>`.
 *
 * **F-12: `row_ref` is no longer
 * dividend-only.** A `TRANSFER_OUT` whose linked `TRANSFER_IN` is in the file
 * gets a `t<n>`, and that target carries it as `transfer_of` — the link itself
 * travels (FR-587). A source leg with **no** linked target (Step A, or a
 * transfer out of Kerdial altogether) gets no label at all (FR-588): there is
 * nothing in the file to point at it, so a label would only invite a re-import
 * to look for a target that was never there. The page order `(trade_date,
 * seq)` already puts a source before its target (the target's `seq` is the
 * source's + 1), so the labels are minted before any row names one.
 */
function projectTransactions(
  source: readonly SourceTransactionRow[],
  lookups: TransactionLookups,
): ExportedTransactionRow[] {
  const linkedSources = new Set<string>();
  for (const row of source) {
    if (row.kind === "TRANSFER_IN" && row.transferSourceId !== null) {
      linkedSources.add(row.transferSourceId);
    }
  }
  const rowRefs = new Map<string, string>();
  let dividends = 0;
  let transfers = 0;
  for (const row of source) {
    if (row.kind === "DIVIDEND") {
      dividends += 1;
      rowRefs.set(row.id, `d${String(dividends)}`);
    } else if (row.kind === "TRANSFER_OUT" && linkedSources.has(row.id)) {
      transfers += 1;
      rowRefs.set(row.id, `t${String(transfers)}`);
    }
  }
  return source.map((row) => projectTransaction(row, lookups, rowRefs));
}

function projectTransaction(
  row: SourceTransactionRow,
  lookups: TransactionLookups,
  rowRefs: ReadonlyMap<string, string>,
): ExportedTransactionRow {
  const portfolioName = lookups.portfolios.get(row.portfolioId);
  if (portfolioName === undefined) {
    throw new Error(`transaction ${row.id} names portfolio ${row.portfolioId}, which was not read`);
  }
  const cash =
    row.cashAccountId === null ? null : (lookups.cashAccounts.get(row.cashAccountId) ?? null);
  const instrumentRef =
    row.instrumentId === null ? null : (lookups.identities.get(row.instrumentId) ?? null);
  const settlementRef =
    row.settlementInstrumentId === null
      ? null
      : (lookups.identities.get(row.settlementInstrumentId) ?? null);
  const settled = row.settlementInstrumentId !== null;

  const kind = row.kind;
  const isTrade = kind === "BUY" || kind === "SELL";
  const isTransfer = kind === "TRANSFER_OUT" || kind === "TRANSFER_IN";
  const hasCostLeg = isTrade || kind === "DRIP" || kind === "CURRENCY_EXCHANGE";
  // `INTEREST` (cash-interest CI-D6) and `FEE` (portfolio-cash): a
  // cross-currency settlement round-trips.
  const cashSettled =
    isTrade || kind === "DIVIDEND" || kind === "DRIP" || kind === "INTEREST" || kind === "FEE";
  // The three cashless kinds move no money and name no account (`security-transfer`).
  const namesCashAccount = kind !== "SHARE_DISTRIBUTION" && !isTransfer;
  const carriesQuantity = isTrade || kind === "DRIP" || kind === "SHARE_DISTRIBUTION" || isTransfer;
  // `gross_amount` applies to every kind but `DRIP` — and on a trade it
  // is `quantity x unit_price`, which the importer re-derives, so only the
  // kinds that have no `unit_price` to derive from state it.
  const statesGrossAmount =
    kind === "DEPOSIT" ||
    kind === "WITHDRAWAL" ||
    kind === "DIVIDEND" ||
    kind === "INTEREST" ||
    kind === "FEE" ||
    kind === "CURRENCY_EXCHANGE" ||
    kind === "SHARE_DISTRIBUTION" ||
    isTransfer;
  const isTarget = kind === "TRANSFER_IN";
  const carriesWithholding = kind === "DIVIDEND" || kind === "INTEREST";

  return {
    kind,
    tradeDate: row.tradeDate,
    tradeTs: row.tradeTs,
    // `seq` is a per-tenant counter, far inside `Number.MAX_SAFE_INTEGER`; the
    // writer reads it only to order rows it already holds.
    seq: Number(row.seq),
    portfolioName,
    cashAccountName: namesCashAccount ? (cash?.name ?? null) : null,
    cashAccountCurrency: namesCashAccount ? (cash?.currency ?? null) : null,
    instrument: instrumentRef,
    quantity: carriesQuantity ? row.quantity : null,
    unitPrice: isTrade || kind === "DRIP" ? (settled ? null : row.unitPrice) : null,
    grossAmount: statesGrossAmount ? row.grossAmount : null,
    // A settled `BUY` is denominated in the settlement asset, so it has no ISO
    // currency at all (`txn_currency` is NULL on that row by CHECK).
    currency: row.txnCurrency,
    feeAmount: hasCostLeg ? row.feeAmount : null,
    brokerFee: hasCostLeg ? row.brokerFeeAmount : null,
    fxFee: hasCostLeg ? row.fxFeeAmount : null,
    tradeTax: hasCostLeg ? row.taxAmount : null,
    otherCost: hasCostLeg ? row.otherCostAmount : null,
    ...cashLeg(row, cashSettled),
    fxRate: parsePinnedRate(row.pinnedFxRate),
    fxRateSource: row.fxRateSource,
    // The withholding rides on DIVIDEND and INTEREST (cash-interest I-4): one
    // amount, denominated by the settling account since format v2.
    withholdingAmount: carriesWithholding ? row.withholdingAmount : null,
    targetCurrency: kind === "CURRENCY_EXCHANGE" ? row.targetCurrency : null,
    targetAmount: kind === "CURRENCY_EXCHANGE" ? row.targetAmount : null,
    // `exchange_rate` is what the write takes, and the ledger
    // stores `target_amount = amount x exchangeRate` rather than the rate
    // itself — so it is recovered here by division. Exact whenever the stored
    // pair is exact, which it is for every rate the ledger accepted.
    exchangeRate:
      kind === "CURRENCY_EXCHANGE" && row.targetAmount !== null && !row.grossAmount.isZero()
        ? row.targetAmount.dividedBy(row.grossAmount)
        : null,
    targetCashAccountName:
      kind === "CURRENCY_EXCHANGE" && row.targetCashAccountId !== null
        ? (lookups.cashAccounts.get(row.targetCashAccountId)?.name ?? null)
        : null,
    settlement: kind === "BUY" ? settlementRef : null,
    settlementAmount: kind === "BUY" && settled ? row.grossAmount : null,
    rowRef: kind === "DIVIDEND" || kind === "TRANSFER_OUT" ? (rowRefs.get(row.id) ?? null) : null,
    dripOf:
      kind === "DRIP" && row.sourceDividendId !== null
        ? (rowRefs.get(row.sourceDividendId) ?? null)
        : null,
    // FR-587: the link, by label. A severed target (FR-580) has no source to
    // name, and writes its carried cost alone — ND-2 (a)'s re-importable row.
    transferOf:
      isTarget && row.transferSourceId !== null
        ? (rowRefs.get(row.transferSourceId) ?? null)
        : null,
    // Written on every target, linked or not: on a lone one it is the whole
    // cost (nothing else can re-derive it); beside a label it is informational.
    transferCostBase: isTarget ? row.transferCostBase : null,
    transferCostNative: isTarget ? row.transferCostNative : null,
    transferCostCurrency: isTarget ? row.transferCostCurrency : null,
    reference: row.reference,
    note: row.note,
    importFingerprint: row.importFingerprint,
  };
}

/**
 * `cash_currency` / `cash_amount`, emitted only in the cases the ledger's own
 * resolution table calls *required* (MEASURED
 * `ledger/src/transaction-write-service.ts`'s `RecordTradeParams.cashCurrency`
 * table):
 *
 *  - settlement currency **equals** `txn_currency` — the degenerate case, and
 *    the ledger derives it; a re-import that stated it would be refused;
 *  - settlement currency **is the row's base** and differs from
 *    `txn_currency` (D4) — the currency is required, the amount is **derived**
 *    and a stated one is refused;
 *  - otherwise (D3/D5) — both are required, so both travel.
 *
 * `base_currency` is read off the transaction row itself (AR-5: the fact
 * states its own base), never off the tenant — a re-based tenant must not
 * retroactively change how an old row is exported.
 */
function cashLeg(
  row: SourceTransactionRow,
  cashSettled: boolean,
): { readonly cashCurrency: string | null; readonly cashAmount: Decimal | null } {
  if (!cashSettled || row.cashCurrency === null || row.cashCurrency === row.txnCurrency) {
    return { cashCurrency: null, cashAmount: null };
  }
  if (row.cashCurrency === row.baseCurrency) {
    return { cashCurrency: row.cashCurrency, cashAmount: null };
  }
  return { cashCurrency: row.cashCurrency, cashAmount: row.cashAmount };
}

/**
 * The `CASE`'s `::text` back into a `Decimal` — `null` stays `null`.
 *
 * `parseDecimalString` is `core-decimal`'s own codec, the only sanctioned
 * string -> `Decimal` conversion: never `Number`, and
 * it refuses exponential notation, which is why the `CASE` casts to `text`
 * rather than letting the driver decide.
 */
function parsePinnedRate(value: string | null): Decimal | null {
  return value === null ? null : parseDecimalString(value);
}
