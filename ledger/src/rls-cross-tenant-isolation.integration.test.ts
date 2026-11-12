import {
  startMigratedPostgres,
  type MigratedPostgres,
  cash,
  seedCashAccounts,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import type { FxRateProvider, QuoteProvider } from "@kerdial/market-ports";
import {
  appUser,
  cashAccount,
  cashBalance,
  createDb,
  fxRateUser,
  holdingState,
  instrument,
  instrumentIcon,
  manualPricePoint,
  personalAccessToken,
  portfolio,
  portfolioDailyValuation,
  portfolioIcon,
  ratePresetList,
  realizedGain,
  session,
  tenant,
  transaction,
  transactionPosting,
  transactionRevision,
  watchlistItem,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { TransactionWriteService } from "./transaction-write-service.js";

/**
 * T-23 acceptance — the RLS & cross-tenant isolation suite (built **now**, even with a single tenant, because
 * writing it later means writing it against a schema that has already grown)
 * plus the explicit AC47 privilege negative test (FR-57).
 *
 * Two real tenants' rows are seeded into **every** tenant-scoped table via the
 * Testcontainers superuser (`ownerDb`, which bypasses RLS — the out-of-band
 * setup a real request never does). Every isolation assertion then runs as the
 * password-authenticated `app_web` role through T-9's `withTenant`, the role
 * RLS actually applies to (`FORCE ROW LEVEL SECURITY`, migrations `0007`/
 * `0008`) — so each assertion is a proof about the database's policies, not
 * about any application-layer `where` clause.
 *
 * ## Why each assertion can actually go red (the whole point of this suite)
 *
 * Every table's isolation check is structured so that removing RLS from that
 * table (or pointing the scope at the wrong tenant) flips it red:
 *   - a positive control first proves tenant A *can* see its own row, so
 *     "tenant B's row is invisible" is never a vacuous pass on a scope that
 *     sees nothing at all;
 *   - the negative `SELECT`/`UPDATE`/`DELETE` against tenant B's row must each
 *     return zero rows — with RLS disabled they return one, failing the
 *     assertion;
 *   - the superuser then confirms tenant B's row *survived*, proving the
 *     `DELETE` affected zero rows because RLS hid the row, not because the row
 *     was actually removed.
 * The coverage test below drives the whole list from a single array and
 * asserts it against the schema's live set of tenant-scoped tables, so a table
 * added to RLS later without a matching isolation test is a hard failure here,
 * not a silent omission.
 */
describe("ledger — RLS & cross-tenant isolation (T-23, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql; // seeding + raw catalog reads, as the superuser (bypasses RLS)
  let ownerDb: Db;
  let appWebSql: postgres.Sql; // password-authenticated app_web, pinned to one physical connection
  let appWebDb: Db;
  let appIngestSql: postgres.Sql; // password-authenticated app_ingest, for the AC47 negative test

  const tenantA = "00000000-0000-7000-8000-00000023000a";
  const tenantB = "00000000-0000-7000-8000-00000023000b";
  const userA = "00000000-0000-7000-8000-000000230a01";
  const userB = "00000000-0000-7000-8000-000000230b01";
  const portfolioA = "00000000-0000-7000-8000-000000230a02";
  const portfolioB = "00000000-0000-7000-8000-000000230b02";
  /**
   * T-30: the AC47 subject's own portfolio, separate from `portfolioA`. A
   * real `recordBuy()` through the write service now triggers a full
   * `holding_state`/`cash_balance`/`realized_gain` recompute for whatever
   * portfolio it targets — targeting `portfolioA`
   * would silently overwrite this file's hand-seeded, fixed-value RLS
   * fixtures for those three tables with recomputed figures, and (for
   * `realized_gain`, which has no real disposal backing the seed) delete the
   * seeded row outright. The AC47 test only ever addresses `pinnedTxnId` by
   * id, never by portfolio, so an isolated portfolio changes nothing it
   * checks.
   */
  const pinnedTxnPortfolio = "00000000-0000-7000-8000-000000230a09";
  const txnA = "00000000-0000-7000-8000-000000230a03";
  const txnB = "00000000-0000-7000-8000-000000230b03";
  const postingA = "00000000-0000-7000-8000-000000230a04";
  const postingB = "00000000-0000-7000-8000-000000230b04";
  const revisionA = "00000000-0000-7000-8000-000000230a05";
  const revisionB = "00000000-0000-7000-8000-000000230b05";
  const realizedA = "00000000-0000-7000-8000-000000230a06";
  const realizedB = "00000000-0000-7000-8000-000000230b06";
  const sessionA = "00000000-0000-7000-8000-000000230a07";
  const sessionB = "00000000-0000-7000-8000-000000230b07";
  // CA-1: migration 0038 adds one
  // more tenant-scoped, RLS-protected table, and the coverage assertion below
  // is built to fail the moment one appears.
  const cashAccountA = "00000000-0000-7000-8000-000000230a08";
  const cashAccountB = "00000000-0000-7000-8000-000000230b08";
  const shareInstrumentId = "00000000-0000-7000-8000-000000230f00";

  /** The real, T-19-written transaction the AC47 negative test targets. */
  let pinnedTxnId: string;

  /**
   * The one authoritative list this suite is driven by. `name` is the pg table
   * name; `mut` is a harmless self-assignment (`col = col`) on a real column of
   * that table, used by the negative `UPDATE`. Every table here has a single
   * `tenant_id = tenantB` row seeded below, so `tenant_id = '<tenantB>'`
   * uniquely names tenant B's row on each without needing per-table primary
   * keys — and, being unfiltered by any tenant predicate the policy could be
   * accused of duplicating, it is RLS (not a `where` clause) that must return
   * zero rows under tenant A's scope.
   *
   * This is the list T-23 enumerates verbatim. `app_user` is
   * also tenant-scoped (RLS + `tenant_id`) but is deliberately **not** here:
   * it is outside this suite's stated list, and its narrow pre-tenant
   * auth-lookup policy path is exercised by T-9/T-10. The coverage test below
   * makes that exclusion explicit rather than silent.
   */
  const TENANT_SCOPED_TABLES: readonly {
    readonly name: string;
    readonly mut: string;
    /**
     * `transaction_revision` is append-only from the API's perspective
     * (migration 0007 grants `app_web` only SELECT/INSERT, no UPDATE/DELETE),
     * so an UPDATE/DELETE is denied at the *privilege* layer (SQLSTATE 42501)
     * rather than silently filtered to zero rows by RLS — a strictly stronger
     * isolation guarantee. The negative assertion for such a table therefore
     * expects a permission error, not an empty result.
     */
    readonly appendOnly?: boolean;
    /**
     * `rate_preset_list` (migration 0076) grants `app_web` SELECT/INSERT/UPDATE
     * and **no DELETE** ("delete every preset" stores `[]`, and the
     * row is what stops a re-seed). Its UPDATE still reaches the policy and is
     * filtered to zero rows; its DELETE is refused at the privilege layer
     * (42501), the stronger guarantee, as for an append-only table.
     */
    readonly noDelete?: boolean;
  }[] = [
    { name: "transaction", mut: "note = note" },
    { name: "transaction_posting", mut: "flow_class = flow_class" },
    { name: "transaction_revision", mut: "revision_kind = revision_kind", appendOnly: true },
    { name: "portfolio", mut: "name = name" },
    // CA-15's cross-tenant requirement for `cash_account` (FR-170: "tenant A
    // inserts, tenant B can neither SELECT nor UPDATE nor DELETE it") is
    // satisfied by this one line, because the loops below run all three
    // operations per table individually and the coverage assertion above is
    // driven from `pg_class` — the table could not have been put under RLS
    // without appearing here. `mut` is a self-assignment on `name`, one of the
    // three columns `0038` actually grants `app_web` `UPDATE` on, so the
    // negative UPDATE is filtered to zero rows by the policy rather than
    // refused earlier at the privilege layer, which is the stronger of the two
    // things to prove here. CA-15's *session*-level half (tenant B's logged-in
    // session against tenant A's URL) is in `api/src/cash-accounts.e2e.test.ts`.
    { name: "cash_account", mut: "name = name" },
    { name: "cash_balance", mut: "amount = amount" },
    { name: "holding_state", mut: "calc_epoch = calc_epoch" },
    { name: "realized_gain", mut: "calc_epoch = calc_epoch" },
    { name: "portfolio_daily_valuation", mut: "total_value_base = total_value_base" },
    // `width_px` self-assignment rather than `source`: `0058` grants `app_web`
    // UPDATE at table level, so either would reach the policy, but a
    // self-assign on an integer cannot trip the three CHECKs the way a
    // rewritten enum or length column could — the negative UPDATE must be
    // filtered to zero rows by RLS, never refused by a constraint, or the
    // assertion would pass for the wrong reason.
    { name: "instrument_icon", mut: "width_px = width_px" },
    // `portfolio_icon` (migration 0068, feature cycle `portfolio-details`
    // PD-T1). Added the same way `instrument_icon` and `watchlist_item` were,
    // and for the reason this file's coverage assertion exists: the table
    // landed in Batch 1 and this suite went red naming it. `width_px` again,
    // and again for `instrument_icon`'s reason — a self-assign on an integer
    // cannot trip the three CHECKs the way a rewritten enum or length column
    // could, so the negative UPDATE is filtered to zero rows by RLS rather than
    // refused by a constraint, which would pass the assertion for the wrong
    // reason.
    { name: "portfolio_icon", mut: "width_px = width_px" },
    // `watchlist_item` (migration 0062, feature cycle `watchlist` T-63). Added
    // here the same way `instrument_icon` was, and for the reason this file's
    // coverage assertion exists: the table landed in Batch B and this suite
    // went red naming it. `note = note` is a self-assignment on a nullable
    // free-text column, so the negative UPDATE reaches the policy and is
    // filtered to zero rows rather than being refused earlier by
    // `watchlist_item_note_length` — which would pass the assertion for the
    // wrong reason.
    { name: "watchlist_item", mut: "note = note" },
    // `rate_preset_list` (migration 0076, `transaction-dialog-refresh` TDR-T2).
    // This suite was expected to cover it with no edit; it went
    // red naming the table, which is what the coverage assertion is for.
    // `presets = presets` is a self-assignment that keeps every CHECK true, so
    // the negative UPDATE is filtered to zero rows by RLS, not refused by a
    // constraint.
    { name: "rate_preset_list", mut: "presets = presets", noDelete: true },
    { name: "manual_price_point", mut: "source_key = source_key" },
    { name: "fx_rate_user", mut: "rate = rate" },
    { name: "session", mut: "user_agent = user_agent" },
    // `personal_access_token` (migration 0081, ADR-0019). `revoked_at` is one
    // of the two columns `app_web` holds column-level UPDATE on, so the
    // negative UPDATE reaches the policy and is filtered to zero rows rather
    // than refused at the privilege layer; DELETE is not granted at all
    // (42501), as for `rate_preset_list`.
    { name: "personal_access_token", mut: "revoked_at = revoked_at", noDelete: true },
  ];

  /**
   * A stub FX provider that satisfies the port but must never be reached: the
   * AC47 transaction below is written with a pinned rate (USER_PINNED), and
   * the FX precedence rule makes the provider branch structurally
   * unreachable when a user rate is present. `fetchDailyRates` throwing rather
   * than returning proves the pinned write does not consult it.
   */
  function pinnedOnlyProvider(): FxRateProvider {
    return {
      capabilities: vi.fn(() => ({
        key: "unused-fx-provider",
        publishedPairs: [],
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded" as const,
      })),
      fetchDailyRates: vi.fn(async () => {
        throw new Error("the FX provider must not be consulted for a USER_PINNED rate");
      }),
      fetchLatestRates: vi.fn(async () => []),
    } satisfies FxRateProvider;
  }

  /** No CRYPTO settlement asset appears in this file's one write — a stub that must never be reached. */
  function unreachableQuoteProvider(): QuoteProvider {
    return {
      capabilities: vi.fn(() => ({
        key: "unused-quote-provider",
        assetKinds: ["CRYPTO"] as const,
        supportsLatestQuote: true,
        supportsDailyHistory: true,
        supportsCorporateActions: false,
        maxHistoryYears: 1,
        quoteQuality: "REALTIME" as const,
        delayMinutes: 0,
        batchSize: 20,
      })),
      resolve: vi.fn(async () => []),
      fetchLatest: vi.fn(async () => []),
      fetchDailyHistory: vi.fn(async () => {
        throw new Error("the crypto quote provider must not be consulted by this scenario");
      }),
    } satisfies QuoteProvider;
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;

    // Both role connections authenticate over the wire exactly as the real
    // API/worker do, rather than emulating the role with `SET LOCAL ROLE`.
    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    appIngestSql = postgres(pg.appIngestUri, { max: 1 });

    // --- Out-of-band seeding of two real tenants' rows in every table ------
    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    await ownerDb.insert(appUser).values([
      {
        id: userA,
        tenantId: tenantA,
        email: "a@t23.example",
        passwordHash: "argon2id$placeholder",
      },
      {
        id: userB,
        tenantId: tenantB,
        email: "b@t23.example",
        passwordHash: "argon2id$placeholder",
      },
    ]);
    await ownerDb.insert(instrument).values({
      id: shareInstrumentId,
      kind: "SHARE",
      displayName: "T-23 Share Co",
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      isin: "FR0000999923",
      primaryIdentifier: "ISIN",
      quotePolicy: "AUTO",
    });
    await ownerDb.insert(portfolio).values([
      { id: portfolioA, tenantId: tenantA, name: "Tenant A" },
      { id: portfolioB, tenantId: tenantB, name: "Tenant B" },
      { id: pinnedTxnPortfolio, tenantId: tenantA, name: "Tenant A — AC47 subject" },
    ]);
    // CA-9: the AC47 subject's BUY below names the cash account its money
    // moved through (FR-156).
    await seedCashAccounts(ownerDb, tenantA, pinnedTxnPortfolio);
    await ownerDb.insert(cashAccount).values([
      {
        id: cashAccountA,
        tenantId: tenantA,
        portfolioId: portfolioA,
        name: "A EUR",
        currency: "EUR",
      },
      {
        id: cashAccountB,
        tenantId: tenantB,
        portfolioId: portfolioB,
        name: "B EUR",
        currency: "EUR",
      },
    ]);
    await ownerDb.insert(transaction).values([
      {
        id: txnA,
        tenantId: tenantA,
        baseCurrency: "EUR",
        portfolioId: portfolioA,
        kind: "BUY",
        tradeDate: "2025-05-01",
        seq: 1n,
        instrumentId: shareInstrumentId,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("1000"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("1000"),
        cashAccountId: cashAccountA,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      },
      {
        id: txnB,
        tenantId: tenantB,
        baseCurrency: "EUR",
        portfolioId: portfolioB,
        kind: "BUY",
        tradeDate: "2025-05-01",
        seq: 1n,
        instrumentId: shareInstrumentId,
        quantity: new Decimal("5"),
        unitPrice: new Decimal("200"),
        grossAmount: new Decimal("1000"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("1000"),
        cashAccountId: cashAccountB,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      },
    ]);
    await ownerDb.insert(transactionPosting).values([
      {
        id: postingA,
        tenantId: tenantA,
        baseCurrency: "EUR",
        transactionId: txnA,
        portfolioId: portfolioA,
        seq: 1,
        leg: "CASH",
        currency: "EUR",
        cashAccountId: cashAccountA,
        amountNative: new Decimal("-1000"),
        amountBase: new Decimal("-1000"),
        fxRateApplied: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
        flowClass: "INTERNAL",
      },
      {
        id: postingB,
        tenantId: tenantB,
        baseCurrency: "EUR",
        transactionId: txnB,
        portfolioId: portfolioB,
        seq: 1,
        leg: "CASH",
        currency: "EUR",
        cashAccountId: cashAccountB,
        amountNative: new Decimal("-1000"),
        amountBase: new Decimal("-1000"),
        fxRateApplied: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
        flowClass: "INTERNAL",
      },
    ]);
    await ownerDb.insert(transactionRevision).values([
      {
        id: revisionA,
        tenantId: tenantA,
        transactionId: txnA,
        revisionKind: "CREATE",
        changedBy: userA,
      },
      {
        id: revisionB,
        tenantId: tenantB,
        transactionId: txnB,
        revisionKind: "CREATE",
        changedBy: userB,
      },
    ]);
    await ownerDb.insert(cashBalance).values([
      {
        tenantId: tenantA,
        portfolioId: portfolioA,
        cashAccountId: cashAccountA,
        currency: "EUR",
        amount: new Decimal("-1000"),
        calcEpoch: 1n,
      },
      {
        tenantId: tenantB,
        portfolioId: portfolioB,
        cashAccountId: cashAccountB,
        currency: "EUR",
        amount: new Decimal("-1000"),
        calcEpoch: 1n,
      },
    ]);
    await ownerDb.insert(holdingState).values([
      {
        tenantId: tenantA,
        portfolioId: portfolioA,
        instrumentId: shareInstrumentId,
        quantity: new Decimal("10"),
        costBasisBase: new Decimal("1000"),
        pmpUnitBase: new Decimal("100"),
        costBasisNative: new Decimal("1000"),
        pmpUnitNative: new Decimal("100"),
        lastTxnSeq: 1n,
        calcEpoch: 1n,
      },
      {
        tenantId: tenantB,
        portfolioId: portfolioB,
        instrumentId: shareInstrumentId,
        quantity: new Decimal("5"),
        costBasisBase: new Decimal("1000"),
        pmpUnitBase: new Decimal("200"),
        costBasisNative: new Decimal("1000"),
        pmpUnitNative: new Decimal("200"),
        lastTxnSeq: 1n,
        calcEpoch: 1n,
      },
    ]);
    await ownerDb.insert(realizedGain).values([
      {
        id: realizedA,
        tenantId: tenantA,
        portfolioId: portfolioA,
        instrumentId: shareInstrumentId,
        transactionId: txnA,
        disposalDate: "2025-06-01",
        quantitySold: new Decimal("2"),
        pmpUnitBaseAtSale: new Decimal("100"),
        proceedsBase: new Decimal("240"),
        gainBase: new Decimal("40"),
        gainNative: new Decimal("40"),
        fxComponentBase: new Decimal("0"),
        calcEpoch: 1n,
      },
      {
        id: realizedB,
        tenantId: tenantB,
        portfolioId: portfolioB,
        instrumentId: shareInstrumentId,
        transactionId: txnB,
        disposalDate: "2025-06-01",
        quantitySold: new Decimal("1"),
        pmpUnitBaseAtSale: new Decimal("200"),
        proceedsBase: new Decimal("260"),
        gainBase: new Decimal("60"),
        gainNative: new Decimal("60"),
        fxComponentBase: new Decimal("0"),
        calcEpoch: 1n,
      },
    ]);
    await ownerDb.insert(portfolioDailyValuation).values([
      {
        tenantId: tenantA,
        portfolioId: portfolioA,
        valuationDate: "2025-06-01",
        totalValueBase: new Decimal("1040"),
      },
      {
        tenantId: tenantB,
        portfolioId: portfolioB,
        valuationDate: "2025-06-01",
        totalValueBase: new Decimal("1060"),
      },
    ]);
    await ownerDb.insert(manualPricePoint).values([
      {
        tenantId: tenantA,
        instrumentId: shareInstrumentId,
        priceDate: "2025-06-01",
        close: new Decimal("101"),
        currency: "EUR",
      },
      {
        tenantId: tenantB,
        instrumentId: shareInstrumentId,
        priceDate: "2025-06-01",
        close: new Decimal("202"),
        currency: "EUR",
      },
    ]);
    // `instrument_icon` (migration 0058, feature cycle `instrument-icons`
    // LD-3). Seeded here for the same reason every other table is: the
    // coverage assertion below is driven from `pg_class`, so a tenant-scoped
    // table cannot be added to the schema without appearing in this file —
    // which is exactly how this seed came to be written (the table landed in
    // Batch A and this suite went red naming it).
    //
    // Both rows key the *same* shared catalogue instrument, deliberately: that
    // is the configuration LD-3 exists for. `instrument.owner_tenant_id IS
    // NULL` means the row is visible to every tenant, so if the icon lived on
    // it, tenant A would see tenant B's upload. Two icons on one shared
    // instrument, mutually invisible, is the structural claim FR-299 makes and
    // the loops below prove per operation.
    //
    // `byte_length` must equal `octet_length(bytes)` (CHECK
    // `instrument_icon_byte_length_is_real`), so the values are not free —
    // they are the real length of the buffer beside them.
    await ownerDb.insert(instrumentIcon).values([
      {
        tenantId: tenantA,
        instrumentId: shareInstrumentId,
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        contentType: "image/png",
        byteLength: 4,
        widthPx: 16,
        heightPx: 16,
      },
      {
        tenantId: tenantB,
        instrumentId: shareInstrumentId,
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
        contentType: "image/jpeg",
        byteLength: 5,
        widthPx: 32,
        heightPx: 32,
      },
    ]);
    // `portfolio_icon` (migration 0068, `portfolio-details` PD-T1). Unlike the
    // two above, the parent row is *not* shared: each tenant's icon hangs off
    // its own portfolio, so the leak this guards against is the plain missing
    // `tenant_id` predicate rather than LD-3's shared-catalogue one. Same
    // `byte_length = octet_length(bytes)` CHECK, so the lengths beside the
    // buffers are the real ones.
    await ownerDb.insert(portfolioIcon).values([
      {
        tenantId: tenantA,
        portfolioId: portfolioA,
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        contentType: "image/png",
        byteLength: 4,
        widthPx: 16,
        heightPx: 16,
      },
      {
        tenantId: tenantB,
        portfolioId: portfolioB,
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
        contentType: "image/jpeg",
        byteLength: 5,
        widthPx: 32,
        heightPx: 32,
      },
    ]);
    // `watchlist_item` (migration 0062, `watchlist` T-63). Both rows key the
    // *same* shared catalogue instrument, deliberately — FR-338's "an
    // instrument may be watched by any number of tenants" is exactly the
    // configuration where a missing `tenant_id` predicate would leak one
    // tenant's target price and note to another. `target_price` stays NULL on
    // one row and set on the other so the negative UPDATE below cannot pass by
    // touching two identical rows.
    await ownerDb.insert(watchlistItem).values([
      { tenantId: tenantA, instrumentId: shareInstrumentId, note: "A's own note" },
      {
        tenantId: tenantB,
        instrumentId: shareInstrumentId,
        targetPrice: new Decimal("123.5"),
        note: "B's own note",
      },
    ]);
    // `rate_preset_list` (migration 0076): one list per tenant, distinct
    // contents so a leak would be visible as well as countable.
    await ownerDb.insert(ratePresetList).values([
      { tenantId: tenantA, presets: sql`'[{"rubrique":"TAX","label":"A","rate":"0.4"}]'::jsonb` },
      { tenantId: tenantB, presets: sql`'[{"rubrique":"TAX","label":"B","rate":"0.5"}]'::jsonb` },
    ]);
    await ownerDb.insert(fxRateUser).values([
      {
        tenantId: tenantA,
        baseCurrency: "EUR",
        quoteCurrency: "USD",
        rateDate: "2025-06-01",
        rate: new Decimal("0.91"),
      },
      {
        tenantId: tenantB,
        baseCurrency: "EUR",
        quoteCurrency: "USD",
        rateDate: "2025-06-01",
        rate: new Decimal("0.92"),
      },
    ]);
    await ownerDb.insert(session).values([
      {
        id: sessionA,
        tenantId: tenantA,
        userId: userA,
        tokenHash: Buffer.from("t23-session-token-hash-a"),
        expiresAt: new Date("2030-01-01T00:00:00Z"),
      },
      {
        id: sessionB,
        tenantId: tenantB,
        userId: userB,
        tokenHash: Buffer.from("t23-session-token-hash-b"),
        expiresAt: new Date("2030-01-01T00:00:00Z"),
      },
    ]);

    // `personal_access_token` (migration 0081): one token per tenant, each
    // owned by that tenant's user, with distinct 32-byte hashes (the table's
    // unique index and `octet_length = 32` CHECK).
    await ownerDb.insert(personalAccessToken).values([
      {
        id: "00000000-0000-7000-8000-000000230a10",
        tenantId: tenantA,
        userId: userA,
        label: "A's token",
        tokenHash: Buffer.alloc(32, 0xa1),
        hint: "kdl_pat_…aaaa",
      },
      {
        id: "00000000-0000-7000-8000-000000230b10",
        tenantId: tenantB,
        userId: userB,
        label: "B's token",
        tokenHash: Buffer.alloc(32, 0xb1),
        hint: "kdl_pat_…bbbb",
      },
    ]);

    // The AC47 subject: a real USER_PINNED transaction written through T-19's
    // service as app_web (not a hand-crafted INSERT), so the negative test
    // below runs against a transaction that exists exactly as production would
    // have written it.
    const pinnedTxnFxRateResolver = new FxRateResolver({
      db: appWebDb,
      provider: pinnedOnlyProvider(),
      tenantId: tenantA,
      baseCurrency: "EUR",
    });
    pinnedTxnId = (
      await new TransactionWriteService({
        db: appWebDb,
        fxRateResolver: pinnedTxnFxRateResolver,
        cryptoRateResolver: new CryptoRateResolver({
          db: appWebDb,
          provider: unreachableQuoteProvider(),
          fxRateResolver: pinnedTxnFxRateResolver,
        }),
      }).recordBuy({
        portfolioId: pinnedTxnPortfolio,
        instrumentId: shareInstrumentId,
        tradeDate: "2025-05-02",
        quantity: new Decimal("3"),
        unitPrice: new Decimal("170"),
        txnCurrency: "USD",
        cashAccountId: cash(pinnedTxnPortfolio, "USD"),
        fxRateUserInput: new Decimal("0.9"),
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  describe("coverage — the isolation list matches the schema's tenant-scoped tables (AC35)", () => {
    it("every table carrying tenant_id with RLS enabled is covered here (app_user aside), so a new one is a failure not an omission", async () => {
      // The live set of tenant-scoped tables straight from the catalogue:
      // RLS on and a tenant_id column present. If a future migration adds such
      // a table and this array is not updated, `shouldCover` grows and this
      // assertion fails — the "visibly missing" guarantee.
      // This and `platform/db`'s roles-and-rls suite are the whole
      // of the tenant-column rule; the shared set's per-table prose is
      // `platform/db/src/schema/README.md`.
      const dbTenantScoped = await ownerClient<{ relname: string }[]>`
        SELECT c.relname
        FROM pg_class c
        WHERE c.relkind = 'r'
          AND c.relnamespace = 'public'::regnamespace
          AND c.relrowsecurity = true
          AND EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
          )
      `;
      // `app_user` is tenant-scoped but explicitly outside T-23's list
      // (its pre-tenant auth-lookup policy is a T-9/T-10 concern).
      const excluded = new Set(["app_user"]);
      const shouldCover = dbTenantScoped
        .map((r) => r.relname)
        .filter((name) => !excluded.has(name))
        .sort();
      const covered = TENANT_SCOPED_TABLES.map((t) => t.name).sort();

      expect(covered).toEqual(shouldCover);
      // And the exact count, so silently dropping a table from the
      // array (which would also drop it from `covered`) is caught too.
      expect(TENANT_SCOPED_TABLES).toHaveLength(17);
    });
  });

  describe("cross-tenant isolation — tenant A can neither SELECT, UPDATE, nor DELETE tenant B's row (AC35, FR-45)", () => {
    for (const { name, mut, appendOnly, noDelete } of TENANT_SCOPED_TABLES) {
      it(`${name}: tenant A sees/touches only its own row, never tenant B's`, async () => {
        await withTenant(appWebDb, tenantA, async (tx) => {
          // Positive control: tenant A genuinely sees its *own* row, so the
          // zero-rows results below cannot be a vacuous pass on a scope that
          // sees nothing at all.
          const ownRows = await tx.execute(
            sql.raw(`SELECT tenant_id FROM "${name}" WHERE tenant_id = '${tenantA}'`),
          );
          expect(ownRows.length).toBeGreaterThanOrEqual(1);

          // SELECT: tenant B's row is invisible. No tenant predicate stands in
          // for the policy — RLS's USING clause is what returns nothing.
          const selectedB = await tx.execute(
            sql.raw(`SELECT tenant_id FROM "${name}" WHERE tenant_id = '${tenantB}'`),
          );
          expect(selectedB).toHaveLength(0);
        });

        if (appendOnly) {
          // No UPDATE/DELETE grant at all (append-only): the write is refused
          // at the privilege layer with 42501, regardless of tenant. Each in
          // its own transaction, since a permission error aborts it.
          for (const stmt of [
            `UPDATE "${name}" SET ${mut} WHERE tenant_id = '${tenantB}'`,
            `DELETE FROM "${name}" WHERE tenant_id = '${tenantB}'`,
          ]) {
            const attempt = withTenant(appWebDb, tenantA, async (tx) => {
              await tx.execute(sql.raw(stmt));
            });
            await expect(attempt).rejects.toThrow();
            const raised = await attempt.catch((err: unknown) => err);
            const pgError =
              raised instanceof postgres.PostgresError
                ? raised
                : ((raised as Error).cause as postgres.PostgresError);
            expect(pgError.code).toBe("42501");
          }
        } else {
          await withTenant(appWebDb, tenantA, async (tx) => {
            // UPDATE: RLS excludes tenant B's row, so zero rows are affected
            // (RETURNING yields nothing) — not an error, and not a write.
            const updatedB = await tx.execute(
              sql.raw(
                `UPDATE "${name}" SET ${mut} WHERE tenant_id = '${tenantB}' RETURNING tenant_id`,
              ),
            );
            expect(updatedB).toHaveLength(0);

            if (noDelete) return;
            // DELETE: likewise excluded — zero rows deleted.
            const deletedB = await tx.execute(
              sql.raw(`DELETE FROM "${name}" WHERE tenant_id = '${tenantB}' RETURNING tenant_id`),
            );
            expect(deletedB).toHaveLength(0);
          });
          if (noDelete) {
            const attempt = withTenant(appWebDb, tenantA, async (tx) => {
              await tx.execute(sql.raw(`DELETE FROM "${name}" WHERE tenant_id = '${tenantB}'`));
            });
            const raised = await attempt.catch((err: unknown) => err);
            const pgError =
              raised instanceof postgres.PostgresError
                ? raised
                : ((raised as Error).cause as postgres.PostgresError);
            expect(pgError?.code).toBe("42501");
          }
        }

        // The superuser confirms tenant B's row survived every attempt above —
        // proving the DELETE returned zero (or was refused) because the row was
        // protected, not because it was actually removed.
        const survivors = await ownerClient.unsafe(
          `SELECT tenant_id FROM "${name}" WHERE tenant_id = '${tenantB}'`,
        );
        expect(survivors).toHaveLength(1);
      });
    }
  });

  describe("fail-closed — app.tenant_id unset returns zero rows, not an error (AC33, AC35)", () => {
    for (const { name } of TENANT_SCOPED_TABLES) {
      it(`${name}: a query with no tenant context returns nothing, though two tenants' rows exist`, async () => {
        // Run directly on the app_web connection with no `withTenant` wrapper,
        // so `app.tenant_id` is unset (or reverted to '' after a prior
        // request). Migration 0008's NULLIF makes both collapse to NULL, so
        // the policy denies every row — reconfirmed here against real
        // multi-tenant fixtures rather than a single synthetic row.
        const rows = await appWebSql.unsafe(`SELECT tenant_id FROM "${name}"`);
        expect(rows).toHaveLength(0);
      });
    }
  });

  describe("AC47 negative test — app_ingest cannot mutate a transaction's FX rate (FR-57)", () => {
    it("the seeded transaction is a real USER_PINNED write, so the mutation attempt has real data to fail against", async () => {
      const [row] = await withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .select()
          .from(transaction)
          .where(sql`${transaction.id} = ${pinnedTxnId}`),
      );
      expect(row).toBeDefined();
      expect(row!.fxRateSource).toBe("USER_PINNED");
      expect(row!.fxRate.toString()).toBe("0.9");
    });

    it("UPDATE transaction SET fx_rate = ... as the app_ingest role raises SQLSTATE 42501 (permission denied)", async () => {
      const attempt = appIngestSql`
        UPDATE "transaction" SET fx_rate = '1.5' WHERE id = ${pinnedTxnId}
      `;

      await expect(attempt).rejects.toThrow();
      const raised = await attempt.catch((err: unknown) => err);
      // Discriminate the specific privilege failure, never a bare toThrow():
      // app_ingest holds SELECT-only on `transaction` (migration 0007), so a
      // table-privilege check denies the UPDATE before RLS is ever consulted.
      const pgError =
        raised instanceof postgres.PostgresError
          ? raised
          : ((raised as Error).cause as postgres.PostgresError);
      expect(pgError.code).toBe("42501");
      expect(pgError.message).toMatch(/permission denied/i);

      // The pinned rate is untouched — the write never landed.
      const [after] = await ownerClient<{ fx_rate: string }[]>`
        SELECT fx_rate FROM "transaction" WHERE id = ${pinnedTxnId}
      `;
      expect(after?.fx_rate).toBe("0.900000000000");
    });
  });

  /**
   * `portfolio-details` PD-T2 — GATE-1 (AC-402). `portfolio-icon-schema.integration.test.ts`
   * says explicitly what it does *not* cover: the grants and RLS policy as the
   * real `app_web`/`app_ingest` roles. This is that proof.
   *
   * The generic `TENANT_SCOPED_TABLES` loop above already covers
   * `portfolio_icon`'s cross-tenant SELECT/UPDATE(self-assign)/DELETE-returns-
   * zero-rows case with a positive control (AC-412's "gains `portfolio_icon`
   * in its coverage" — already landed by PD-T1, unedited here). What that loop
   * does not reach is: `app_web`'s full four-verb CRUD on its own tenant
   * (its own UPDATE is a harmless self-assign, never an INSERT/DELETE
   * round-trip); `app_ingest` refused *outright* on this table specifically
   * (the loop's only `app_ingest` case is AC47's `transaction` probe); the
   * `WITH CHECK` half of the policy against a real re-parenting `UPDATE`
   * (the loop's self-assign mutation cannot trip it); and `portfolio`'s own
   * table-level grant reaching the three new columns.
   */
  describe("portfolio-details GATE-1 — AC-402: app_web/app_ingest on portfolio_icon, as the real roles", () => {
    const gatePortfolioA = "00000000-0000-7000-8000-000000040201";
    const gatePortfolioB = "00000000-0000-7000-8000-000000040202";
    // A third, dedicated portfolio for the re-parenting case: the app_ingest
    // case above leaves `gatePortfolioA`'s icon row in place (its own DELETE
    // attempt is refused), so a case that runs after it needs a row of its
    // own rather than re-inserting onto an already-occupied primary key.
    const gatePortfolioC = "00000000-0000-7000-8000-000000040203";

    const pngBytes = (): Buffer => Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    beforeAll(async () => {
      // A portfolio per tenant carrying no icon row yet — distinct from
      // `portfolioA`/`portfolioB`, which already carry this file's own
      // top-level `portfolioIcon` seed, so this block's own INSERT/UPDATE/
      // DELETE sequence can neither collide with, nor be silently satisfied
      // by, those rows.
      await ownerDb.insert(portfolio).values([
        { id: gatePortfolioA, tenantId: tenantA, name: "AC-402 subject A" },
        { id: gatePortfolioB, tenantId: tenantB, name: "AC-402 subject B" },
        { id: gatePortfolioC, tenantId: tenantA, name: "AC-402 subject C" },
      ]);
    });

    /** Resolves to the failed statement's SQLSTATE, or `undefined` if it did not fail. */
    async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
      const raised = await promise.then(
        () => undefined,
        (err: unknown) => err,
      );
      if (raised === undefined) return undefined;
      const pgError =
        raised instanceof postgres.PostgresError
          ? raised
          : ((raised as Error).cause as postgres.PostgresError | undefined);
      return pgError?.code;
    }

    it("app_web: INSERT, SELECT, UPDATE, and DELETE all succeed on the caller's own tenant's row — all four DML verbs asserted present, not merely 'some'", async () => {
      await withTenant(appWebDb, tenantA, async (tx) => {
        await tx.insert(portfolioIcon).values({
          tenantId: tenantA,
          portfolioId: gatePortfolioA,
          bytes: pngBytes(),
          contentType: "image/png",
          byteLength: 4,
          widthPx: 16,
          heightPx: 16,
        });
      });

      const afterInsert = await withTenant(appWebDb, tenantA, (tx) =>
        tx
          .select({ widthPx: portfolioIcon.widthPx })
          .from(portfolioIcon)
          .where(sql`${portfolioIcon.portfolioId} = ${gatePortfolioA}`),
      );
      expect(afterInsert).toEqual([{ widthPx: 16 }]);

      await withTenant(appWebDb, tenantA, async (tx) => {
        await tx
          .update(portfolioIcon)
          .set({ widthPx: 32 })
          .where(sql`${portfolioIcon.portfolioId} = ${gatePortfolioA}`);
      });
      const afterUpdate = await withTenant(appWebDb, tenantA, (tx) =>
        tx
          .select({ widthPx: portfolioIcon.widthPx })
          .from(portfolioIcon)
          .where(sql`${portfolioIcon.portfolioId} = ${gatePortfolioA}`),
      );
      expect(afterUpdate).toEqual([{ widthPx: 32 }]);

      await withTenant(appWebDb, tenantA, async (tx) => {
        await tx.delete(portfolioIcon).where(sql`${portfolioIcon.portfolioId} = ${gatePortfolioA}`);
      });
      const afterDelete = await withTenant(appWebDb, tenantA, (tx) =>
        tx
          .select({ widthPx: portfolioIcon.widthPx })
          .from(portfolioIcon)
          .where(sql`${portfolioIcon.portfolioId} = ${gatePortfolioA}`),
      );
      expect(afterDelete).toEqual([]);
    });

    it("app_ingest is refused outright on portfolio_icon (no grant, no policy) — every DML verb, with app_web's own-tenant success as the positive control in the same test", async () => {
      // Positive control first: the same table, a real row, succeeds as
      // app_web — so the app_ingest refusals below cannot be passing
      // vacuously because the table (or this fixture) is empty.
      await withTenant(appWebDb, tenantA, async (tx) => {
        await tx.insert(portfolioIcon).values({
          tenantId: tenantA,
          portfolioId: gatePortfolioA,
          bytes: pngBytes(),
          contentType: "image/png",
          byteLength: 4,
          widthPx: 16,
          heightPx: 16,
        });
      });
      const control = await withTenant(appWebDb, tenantA, (tx) =>
        tx
          .select({ widthPx: portfolioIcon.widthPx })
          .from(portfolioIcon)
          .where(sql`${portfolioIcon.portfolioId} = ${gatePortfolioA}`),
      );
      expect(control).toEqual([{ widthPx: 16 }]);

      expect(
        await pgErrorCode(
          appIngestSql`SELECT * FROM "portfolio_icon" WHERE portfolio_id = ${gatePortfolioA}`,
        ),
      ).toBe("42501");
      expect(
        await pgErrorCode(appIngestSql`
          INSERT INTO "portfolio_icon"
            (tenant_id, portfolio_id, bytes, content_type, byte_length, width_px, height_px)
          VALUES (${tenantB}, ${gatePortfolioB}, ${pngBytes()}, 'image/png', 4, 16, 16)
        `),
      ).toBe("42501");
      expect(
        await pgErrorCode(
          appIngestSql`UPDATE "portfolio_icon" SET width_px = 99 WHERE portfolio_id = ${gatePortfolioA}`,
        ),
      ).toBe("42501");
      expect(
        await pgErrorCode(
          appIngestSql`DELETE FROM "portfolio_icon" WHERE portfolio_id = ${gatePortfolioA}`,
        ),
      ).toBe("42501");

      // Confirmed unchanged after every refused attempt.
      const survivor = await withTenant(appWebDb, tenantA, (tx) =>
        tx
          .select({ widthPx: portfolioIcon.widthPx })
          .from(portfolioIcon)
          .where(sql`${portfolioIcon.portfolioId} = ${gatePortfolioA}`),
      );
      expect(survivor).toEqual([{ widthPx: 16 }]);
      const leaked = await ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "portfolio_icon" WHERE portfolio_id = ${gatePortfolioB}
      `;
      expect(leaked[0]?.n).toBe("0");
    });

    it("app_web cannot re-parent a portfolio_icon row to a different tenant_id — the WITH CHECK half of the policy rejects the UPDATE (42501)", async () => {
      await withTenant(appWebDb, tenantA, async (tx) => {
        await tx.insert(portfolioIcon).values({
          tenantId: tenantA,
          portfolioId: gatePortfolioC,
          bytes: pngBytes(),
          contentType: "image/png",
          byteLength: 4,
          widthPx: 16,
          heightPx: 16,
        });
      });

      const code = await pgErrorCode(
        withTenant(appWebDb, tenantA, async (tx) => {
          await tx.execute(
            sql`UPDATE "portfolio_icon" SET tenant_id = ${tenantB} WHERE portfolio_id = ${gatePortfolioC}`,
          );
        }),
      );
      expect(code).toBe("42501");

      // Never re-parented — still tenant A's row.
      const [row] = await ownerClient<{ tenant_id: string }[]>`
        SELECT tenant_id FROM "portfolio_icon" WHERE portfolio_id = ${gatePortfolioC}
      `;
      expect(row?.tenant_id).toBe(tenantA);
    });

    it("app_web's UPDATE on portfolio reaches broker/description/accent_color — 0007's table-level grant, no migration change needed", async () => {
      await withTenant(appWebDb, tenantA, async (tx) => {
        await tx
          .update(portfolio)
          .set({ broker: "Boursorama", description: "AC-402 probe", accentColor: "CHART_2" })
          .where(sql`${portfolio.id} = ${portfolioA}`);
      });

      const [row] = await ownerClient<
        { broker: string | null; description: string | null; accent_color: string | null }[]
      >`
        SELECT broker, description, accent_color FROM "portfolio" WHERE id = ${portfolioA}
      `;
      expect(row).toEqual({
        broker: "Boursorama",
        description: "AC-402 probe",
        accent_color: "CHART_2",
      });
    });
  });
});
