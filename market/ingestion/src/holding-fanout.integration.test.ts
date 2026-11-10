import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import {
  cashAccount,
  createDb,
  fxTrackedPair,
  holdingState,
  instrument,
  instrumentPriceDaily,
  portfolio,
  tenant,
  transaction,
  transactionPosting,
  type Db,
} from "@kerdial/platform-db";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchHeldCurrencies, fetchHeldInstruments } from "./holding-fanout.js";

/**
 * One cash movement written as the ledger writes it — the `transaction` row and
 * its single CASH posting, signed (`amount` > 0 credits the account). Seeded
 * through the owner role: this suite tests the fan-out read, not the write path.
 */
async function cashMovement(
  ownerDb: Db,
  params: {
    readonly tenantId: string;
    readonly portfolioId: string;
    readonly cashAccountId: string;
    readonly currency: string;
    readonly kind: "DEPOSIT" | "WITHDRAWAL" | "FEE";
    readonly amount: string;
    readonly tradeDate: string;
    readonly seq: bigint;
  },
): Promise<void> {
  const signed = new Decimal(params.amount);
  const gross = signed.abs();
  const fxRate = new Decimal("0.9");
  const transactionId = randomUUID();
  await ownerDb.insert(transaction).values({
    id: transactionId,
    tenantId: params.tenantId,
    baseCurrency: "EUR",
    portfolioId: params.portfolioId,
    kind: params.kind,
    tradeDate: params.tradeDate,
    seq: params.seq,
    grossAmount: gross,
    txnCurrency: params.currency,
    cashCurrency: params.currency,
    cashAmount: gross,
    cashAccountId: params.cashAccountId,
    fxRate,
    fxRateSource: "USER_PINNED",
  });
  await ownerDb.insert(transactionPosting).values({
    id: randomUUID(),
    tenantId: params.tenantId,
    baseCurrency: "EUR",
    transactionId,
    portfolioId: params.portfolioId,
    seq: 1,
    leg: "CASH",
    currency: params.currency,
    cashAccountId: params.cashAccountId,
    amountNative: signed,
    amountBase: signed.times(fxRate),
    fxRateApplied: fxRate,
    fxRateSource: "USER_PINNED",
    flowClass: params.kind === "FEE" ? "FEE" : "EXTERNAL",
  });
}

interface HoldingRowParams {
  readonly tenantId: string;
  readonly portfolioId: string;
  readonly instrumentId: string;
  readonly quantity: string;
}

/** A minimal, deliberately-simplified `holding_state` row — this suite only exercises the fan-out query, not real PMP arithmetic (`ledger`'s own T-30 tests cover that), so `costBasis*`/`pmpUnit*` are set equal to `quantity * 100` throughout for internal consistency, nothing more. */
function holdingRow(params: HoldingRowParams) {
  const costBasisBase = new Decimal(params.quantity).times(100);
  return {
    tenantId: params.tenantId,
    portfolioId: params.portfolioId,
    instrumentId: params.instrumentId,
    quantity: new Decimal(params.quantity),
    costBasisBase,
    pmpUnitBase: new Decimal("100"),
    costBasisNative: costBasisBase,
    pmpUnitNative: new Decimal("100"),
    lastTxnSeq: 1n,
    calcEpoch: 1n,
  };
}

/**
 * T-34's third acceptance criterion: "Only instruments
 * present in `holding_state` with `quantity > 0` for some tenant are
 * included in a poll cycle's fan-out — verified by seeding one held and one
 * unheld instrument and asserting only the held one is fetched." Run against
 * a real Postgres 17 container, reading through the `app_ingest`-scoped
 * connection (migration `0018_ingestion-reference-read-grant.sql`'s new
 * grant, plus `0007_roles-grants-rls.sql`'s pre-existing
 * `holding_state_ingest_read` cross-tenant `SELECT` policy) — mirroring
 * `fetch-log.integration.test.ts`'s precedent of proving this package's own
 * DB reads/writes against the real role, not the Testcontainers bootstrap
 * superuser.
 */
describe("fetchHeldInstruments — T-34 acceptance criterion 3 (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  const tenantA = "00000000-0000-7000-8000-000000340001";
  const tenantB = "00000000-0000-7000-8000-000000340002";
  const portfolioA = "00000000-0000-7000-8000-000000340011";
  const portfolioB = "00000000-0000-7000-8000-000000340012";

  const heldInstrumentId = "00000000-0000-7000-8000-000000340101"; // quantity > 0 for tenant A
  const soldToZeroInstrumentId = "00000000-0000-7000-8000-000000340102"; // holding_state row exists, quantity = 0
  const neverHeldInstrumentId = "00000000-0000-7000-8000-000000340103"; // no holding_state row at all
  const heldForOtherTenantInstrumentId = "00000000-0000-7000-8000-000000340104"; // held only by tenant B — proves the fan-out is cross-tenant, not scoped to one tenant

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appIngestSql = postgres(pg.appIngestUri, { max: 1 });
    appIngestDb = createDb(appIngestSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    await ownerDb.insert(portfolio).values([
      { id: portfolioA, tenantId: tenantA, name: "A" },
      { id: portfolioB, tenantId: tenantB, name: "B" },
    ]);

    await ownerDb.insert(instrument).values([
      {
        id: heldInstrumentId,
        kind: "SHARE",
        displayName: "Held Co",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR0000340101",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
      {
        id: soldToZeroInstrumentId,
        kind: "SHARE",
        displayName: "Sold-Out Co",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR0000340102",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
      {
        id: neverHeldInstrumentId,
        kind: "SHARE",
        displayName: "Never Held Co",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR0000340103",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
      {
        id: heldForOtherTenantInstrumentId,
        kind: "CRYPTO",
        displayName: "Other-Tenant Coin",
        listingCurrency: "EUR",
        symbol: "OTC340",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "AUTO",
      },
    ]);

    await ownerDb.insert(holdingState).values([
      holdingRow({
        tenantId: tenantA,
        portfolioId: portfolioA,
        instrumentId: heldInstrumentId,
        quantity: "10",
      }),
      holdingRow({
        tenantId: tenantA,
        portfolioId: portfolioA,
        instrumentId: soldToZeroInstrumentId,
        quantity: "0",
      }),
      holdingRow({
        tenantId: tenantB,
        portfolioId: portfolioB,
        instrumentId: heldForOtherTenantInstrumentId,
        quantity: "5",
      }),
    ]);
    // `neverHeldInstrumentId` deliberately gets no `holding_state` row at all.
  }, 120_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  it("returns only instruments with quantity > 0 in some tenant's holding_state, across tenants, excluding a zero-quantity row and an instrument never held", async () => {
    const held = await fetchHeldInstruments(appIngestDb);
    const ids = held.map((row) => row.instrumentId).sort();

    expect(ids).toEqual([heldForOtherTenantInstrumentId, heldInstrumentId].sort());
    expect(ids).not.toContain(soldToZeroInstrumentId);
    expect(ids).not.toContain(neverHeldInstrumentId);

    const heldRow = held.find((row) => row.instrumentId === heldInstrumentId);
    expect(heldRow?.kind).toBe("SHARE");
    expect(heldRow?.exchangeMic).toBe("XPAR");

    const cryptoRow = held.find((row) => row.instrumentId === heldForOtherTenantInstrumentId);
    expect(cryptoRow?.kind).toBe("CRYPTO");
    expect(cryptoRow?.exchangeMic).toBeNull();
  });

  it("narrows to the requested kinds — a crypto-only fan-out never returns the held SHARE", async () => {
    const cryptoOnly = await fetchHeldInstruments(appIngestDb, { kinds: ["CRYPTO"] });
    expect(cryptoOnly.map((row) => row.instrumentId)).toEqual([heldForOtherTenantInstrumentId]);

    const equityOnly = await fetchHeldInstruments(appIngestDb, {
      kinds: ["SHARE", "ETF", "INDEX"],
    });
    expect(equityOnly.map((row) => row.instrumentId)).toEqual([heldInstrumentId]);
  });

  it("narrows to the requested instrument IDs — a per-instrument caller gets a targeted lookup, not the whole held set", async () => {
    const targeted = await fetchHeldInstruments(appIngestDb, {
      instrumentIds: [heldForOtherTenantInstrumentId],
    });
    expect(targeted.map((row) => row.instrumentId)).toEqual([heldForOtherTenantInstrumentId]);

    // A held-but-not-requested instrument is excluded, same as an unheld one.
    const excluded = await fetchHeldInstruments(appIngestDb, {
      instrumentIds: [neverHeldInstrumentId],
    });
    expect(excluded).toEqual([]);

    // Composes with `kinds`, same as any other narrowing clause.
    const composed = await fetchHeldInstruments(appIngestDb, {
      kinds: ["CRYPTO"],
      instrumentIds: [heldInstrumentId, heldForOtherTenantInstrumentId],
    });
    expect(composed.map((row) => row.instrumentId)).toEqual([heldForOtherTenantInstrumentId]);
  });

  /*
   * `fetchHeldCurrencies` decides what `fx-daily` shops for, and valuation
   * converts from the **price row's** currency — not from
   * `instrument.listing_currency`. While this read looked only at the declared
   * one, a disagreement between them made the needed rate unfetchable: observed
   * live, `NOV.DE` declared EUR while its provider mapping pointed at the
   * Copenhagen line, so 4 993 days of DKK prices sat against a EUR instrument
   * and `fx-daily` logged "no held currency the provider publishes" — correctly,
   * against a currency set that was a lie. The holding was then permanently
   * unvaluable: valuation demanded DKK→EUR, and nothing would ever fetch it.
   */
  describe("fetchHeldCurrencies reads the currency prices are stored in, not only the declared one", () => {
    it("includes a held instrument's price currency when it differs from its listing currency", async () => {
      await ownerDb.insert(instrumentPriceDaily).values([
        {
          instrumentId: heldInstrumentId,
          priceDate: "2026-08-20",
          closeRaw: new Decimal("100"),
          currency: "DKK",
          sourceKey: "yahoo",
          quality: "EOD",
        },
      ]);

      const currencies = await fetchHeldCurrencies(appIngestDb);

      // The declared currency is still there — this widens the set, it does not
      // replace it.
      expect(currencies).toContain("EUR");
      // …and the one valuation will actually ask for is now in it, which is the
      // whole point.
      expect(currencies).toContain("DKK");
    });

    it("ignores a price currency belonging to an instrument nobody holds", async () => {
      await ownerDb.insert(instrumentPriceDaily).values([
        {
          instrumentId: neverHeldInstrumentId,
          priceDate: "2026-08-20",
          closeRaw: new Decimal("100"),
          currency: "JPY",
          sourceKey: "yahoo",
          quality: "EOD",
        },
      ]);

      const currencies = await fetchHeldCurrencies(appIngestDb);

      // The negative half — the `holding_state` discipline this function has
      // always had is unchanged, so the widening cannot turn into "fetch every
      // currency any row mentions".
      expect(currencies).not.toContain("JPY");
      // Positive companion: the read did run and did see the held rows.
      expect(currencies).toContain("EUR");
    });
  });

  /*
   * portfolio-cash AC-571 / NFR-92: a currency some cash account
   * holds a non-zero balance in is fetched daily — and so gets its history
   * through the existing coverage step — with no `fx_tracked_pair` row and no
   * held instrument in it. Run as `app_ingest`, RLS-realistic.
   */
  describe("fetchHeldCurrencies tracks every currency with a non-zero cash balance (AC-571)", () => {
    const tenantC = "00000000-0000-7000-8000-000000340003";
    const portfolioC = "00000000-0000-7000-8000-000000340013";
    const accounts = {
      USD: "00000000-0000-7000-8000-000000340201", // the portfolio's only USD exposure
      JPY: "00000000-0000-7000-8000-000000340202", // deposited, then withdrawn in full
      GBP: "00000000-0000-7000-8000-000000340203", // archived, balance still non-zero
      CHF: "00000000-0000-7000-8000-000000340204", // reduced by a FEE, still non-zero
    } as const;

    it("adds a cash-only currency, skips a zero balance, keeps an archived account and a balance a FEE reduced", async () => {
      // The pre-feature set: what the held instruments alone yield.
      const before = await fetchHeldCurrencies(appIngestDb);
      expect(before).not.toContain("USD");

      await ownerDb.insert(tenant).values({ id: tenantC });
      await ownerDb.insert(portfolio).values({ id: portfolioC, tenantId: tenantC, name: "C" });
      await ownerDb.insert(cashAccount).values(
        Object.entries(accounts).map(([currency, id]) => ({
          id,
          tenantId: tenantC,
          portfolioId: portfolioC,
          name: `Compte ${currency}`,
          currency,
          ...(currency === "GBP" ? { archivedAt: new Date("2026-08-01T00:00:00Z") } : {}),
        })),
      );
      const move = (
        currency: keyof typeof accounts,
        kind: "DEPOSIT" | "WITHDRAWAL" | "FEE",
        amount: string,
        seq: bigint,
      ) =>
        cashMovement(ownerDb, {
          tenantId: tenantC,
          portfolioId: portfolioC,
          cashAccountId: accounts[currency],
          currency,
          kind,
          amount,
          tradeDate: "2026-08-03",
          seq,
        });
      await move("USD", "DEPOSIT", "100.00", 1n);
      await move("JPY", "DEPOSIT", "1000", 2n);
      await move("JPY", "WITHDRAWAL", "-1000", 3n);
      await move("GBP", "DEPOSIT", "50.00", 4n);
      await move("CHF", "DEPOSIT", "100.00", 5n);
      await move("CHF", "FEE", "-10.00", 6n);

      const after = await fetchHeldCurrencies(appIngestDb);

      // No manual tracking stands behind the USD: it comes from the balance alone.
      const tracked = await ownerDb.select().from(fxTrackedPair);
      expect(tracked.filter((row) => row.quoteCurrency === "USD")).toEqual([]);

      expect(after).toContain("USD");
      expect(after).not.toContain("JPY");
      expect(after).toContain("GBP");
      expect(after).toContain("CHF");
      // The held-instrument currencies are unchanged: exactly the pre-feature
      // set plus the three cash currencies, sorted.
      expect(after).toEqual([...new Set([...before, "CHF", "GBP", "USD"])].sort());
    });
  });
});
