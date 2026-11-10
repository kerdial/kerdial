import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { isValidIsinCheckDigit } from "@kerdial/api-contracts";
import { Decimal } from "@kerdial/core-decimal";
import {
  cashAccount,
  createDb,
  createPostgresClient,
  instrument,
  portfolio,
  tenant,
  transaction,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { eq, ilike, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InstrumentAlreadyExistsError,
  InstrumentFigiAlreadySetError,
  InstrumentNotFoundError,
  createInstrumentByIsin,
  createInstrumentBySymbol,
  findInstrumentsByIdentity,
  getInstrumentById,
  listInstruments,
  setInstrumentFigi,
  updateInstrumentDetails,
  updateInstrumentIdentity,
  deleteInstrument,
  InstrumentDeleteBlockedError,
} from "./instrument-service.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Blocks until `Date.now()` is strictly past `instant`, so a subsequent
 * `new Date()` stamp cannot collide with an earlier one.
 *
 * Bounded by construction — the wall clock always advances, so this returns
 * within a millisecond or two. Deliberately not a fixed `setTimeout(10)`: a
 * sleep long enough to be safe is also long enough to notice, and one that
 * merely *usually* works is the flake this replaces.
 */
async function waitForClockToPass(instant: Date): Promise<void> {
  while (Date.now() <= instant.getTime()) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * A unique, **synthetic** ISIN per fixture — mirrors
 * `instruments-classification-patch.e2e.test.ts`'s own generator and for the
 * identical reason: this template database is pre-migrated *with* Batch F's
 * ~51 real seeded large-cap rows, so a real ISIN (LVMH, AXA, BNP Paribas, …)
 * collides with the catalogue rather than with another fixture in this file.
 * `ZZ` is not an allocated ISO 3166 prefix, so nothing real can ever occupy
 * these. `figi`-suite-scoped prefix (`ZZLF`) so it cannot collide with
 * `instrument-service.integration.test.ts`'s own other fixtures either.
 */
let figiFixtureIsinCounter = 0;
function nextFigiFixtureIsin(): string {
  figiFixtureIsinCounter += 1;
  const body = `ZZLF${String(figiFixtureIsinCounter).padStart(7, "0")}`;
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${body}${checkDigit}`;
    if (isValidIsinCheckDigit(candidate)) return candidate;
  }
  throw new Error(`nextFigiFixtureIsin: no valid check digit for ${body}`);
}

/**
 * T-11 acceptance: the instrument identity service
 * against a real Postgres 17 container, authenticated as `app_web` — the
 * same shape as `platform/auth/src/auth-service.integration.test.ts` (T-10)
 * and `platform/db/src/tenant-context.integration.test.ts` (T-9).
 *
 * `ownerDb`/`ownerClient` is the superuser handle, used only for
 * out-of-band setup/assertions a real request never does (seeding a tenant
 * to prove the "linked rows survive" property, inspecting raw grants). Every
 * call that exercises the service under test goes through `appWebDb`.
 *
 * `instrument` is shared reference data with no `tenant_id` and no RLS (see
 * the doc comment in `instrument-service.ts`), so — unlike the T-9/
 * T-10 suites — none of these calls go through `withTenant`; `appWebDb` is
 * used directly for every instrument read/write.
 */
describe("ledger — instrument identity service (T-11, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  describe("AC1 — ISIN-based creation for SHARE/ETF/FUND, dual listings (FR-3)", () => {
    it("creates a SHARE by ISIN + exchange_mic once", async () => {
      const row = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        // IR-22 — a **synthetic** ISIN, not a real listing. Migration `0037` seeds the
        // real large-cap identifiers into the shared catalogue, so a fixture reusing one
        // collides with the seeded row on `instrument_isin_exchange_mic_key`. The `TEST`
        // NSIN keeps the ISO 6166 check digit valid and can never be a real identifier.
        isin: "FRTEST000339",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "TotalEnergies SE",
      });
      expect(row.id).toBeTruthy();
      expect(row.isin).toBe("FRTEST000339");
      expect(row.exchangeMic).toBe("XPAR");
      expect(row.primaryIdentifier).toBe("ISIN");
    });

    it("repeating the identical (isin, exchange_mic) pair raises a clear domain error, not a raw constraint failure", async () => {
      await expect(
        createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FRTEST000339",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "TotalEnergies SE (duplicate attempt)",
        }),
      ).rejects.toThrow(InstrumentAlreadyExistsError);

      try {
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FRTEST000339",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "TotalEnergies SE (duplicate attempt)",
        });
        expect.fail("expected InstrumentAlreadyExistsError to have been thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(InstrumentAlreadyExistsError);
        expect((err as InstrumentAlreadyExistsError).conflict).toBe("ISIN_EXCHANGE_MIC");
        // Never a raw postgres.js PostgresError leaking to the caller.
        expect(err).not.toBeInstanceOf(postgres.PostgresError);
      }
    });

    it("the same ISIN on a different exchange_mic succeeds as a second, distinct instrument (a dual listing)", async () => {
      const paris = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "US88160R1014",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Tesla Inc (Euronext Paris listing)",
      });
      const nyse = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "US88160R1014",
        exchangeMic: "XNYS",
        listingCurrency: "USD",
        displayName: "Tesla Inc (NYSE listing)",
      });

      expect(paris.id).not.toBe(nyse.id);
      expect(paris.isin).toBe(nyse.isin);
      expect(paris.exchangeMic).not.toBe(nyse.exchangeMic);
      expect(paris.listingCurrency).not.toBe(nyse.listingCurrency);
    });

    it("adding the same ISIN + exchange_mic pair twice does not create a duplicate row (only one row exists for it)", async () => {
      const rows = await appWebDb
        .select()
        .from(instrument)
        .where(eq(instrument.isin, "FRTEST000339"));
      expect(rows).toHaveLength(1);
    });
  });

  describe("AC2 — symbol-based creation for CRYPTO, no ISIN required", () => {
    it("creates a CRYPTO instrument by symbol alone, with no isin/exchange_mic populated", async () => {
      const row = await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "ETH-T11",
        listingCurrency: "USD",
        displayName: "Ether",
      });
      expect(row.symbol).toBe("ETH-T11");
      expect(row.isin).toBeNull();
      expect(row.exchangeMic).toBeNull();
      expect(row.primaryIdentifier).toBe("SYMBOL");
    });

    it("a duplicate CRYPTO symbol raises a clear domain error, not a raw constraint failure", async () => {
      try {
        await createInstrumentBySymbol(appWebDb, {
          kind: "CRYPTO",
          symbol: "ETH-T11",
          listingCurrency: "USD",
          displayName: "Ether (duplicate attempt)",
        });
        expect.fail("expected InstrumentAlreadyExistsError to have been thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(InstrumentAlreadyExistsError);
        expect((err as InstrumentAlreadyExistsError).conflict).toBe("CRYPTO_SYMBOL");
      }
    });
  });

  describe("quote_policy defaults (FR-16, FR-23's routing precondition)", () => {
    it("(ADR-0018) a newly created FUND has quote_policy = AUTO — its NAV is backfilled like any other kind; MANUAL_ONLY is no longer a kind default", async () => {
      const row = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000441677",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Some OPCVM Fund",
      });
      expect(row.quotePolicy).toBe("AUTO");
    });

    it("a newly created SHARE, ETF, and CRYPTO each have quote_policy = AUTO", async () => {
      const share = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000347",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Accor SA",
      });
      const etf = await createInstrumentByIsin(appWebDb, {
        kind: "ETF",
        isin: "IE00B4L5Y983",
        exchangeMic: "XLON",
        listingCurrency: "USD",
        displayName: "iShares Core MSCI World UCITS ETF",
      });
      const crypto = await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "BTC-T11",
        listingCurrency: "USD",
        displayName: "Bitcoin",
      });

      expect(share.quotePolicy).toBe("AUTO");
      expect(etf.quotePolicy).toBe("AUTO");
      expect(crypto.quotePolicy).toBe("AUTO");
    });
  });

  describe("all five instrument kind values are creatable (C4/T-11's 'What to build')", () => {
    it("an INDEX instrument can be created via the symbol-based path", async () => {
      // Benchmarks (comparison endpoint, component C21) are [P1-LATER] and
      // out of this run's scope — only the identity primitive is exercised
      // here, per this function's own doc comment in instrument-service.ts.
      const row = await createInstrumentBySymbol(appWebDb, {
        kind: "INDEX",
        symbol: "^GSPC",
        listingCurrency: "USD",
        displayName: "S&P 500",
      });
      expect(row.kind).toBe("INDEX");
      expect(row.quotePolicy).toBe("AUTO");
    });

    // F1(c) (security review, T-37): `instrument_symbol_
    // crypto_key` is `WHERE kind = 'CRYPTO'` only, so a symbol-identified
    // non-CRYPTO row (INDEX is the only other symbol-based kind today) had
    // no dedupe key at all — the same symbol could be inserted any number of
    // times. A partial unique index on `symbol WHERE isin IS NULL AND kind
    // <> 'CRYPTO'` closes that hole; a duplicate now raises the same
    // {@link InstrumentAlreadyExistsError} domain error as AC1/AC2, not a
    // silently duplicated row.
    it("a duplicate INDEX symbol raises a clear domain error, not a silently duplicated row", async () => {
      await createInstrumentBySymbol(appWebDb, {
        kind: "INDEX",
        symbol: "^FTSE-T11",
        listingCurrency: "GBP",
        displayName: "FTSE 100",
      });

      try {
        await createInstrumentBySymbol(appWebDb, {
          kind: "INDEX",
          symbol: "^FTSE-T11",
          listingCurrency: "GBP",
          displayName: "FTSE 100 (duplicate attempt)",
        });
        expect.fail("expected InstrumentAlreadyExistsError to have been thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(InstrumentAlreadyExistsError);
        expect((err as InstrumentAlreadyExistsError).conflict).toBe("SYMBOL_NO_ISIN");
        expect(err).not.toBeInstanceOf(postgres.PostgresError);
      }

      const rows = await appWebDb
        .select()
        .from(instrument)
        .where(eq(instrument.symbol, "^FTSE-T11"));
      expect(rows).toHaveLength(1);
    });
  });

  describe("AC3 — the canonical id never changes for any update (display name, status)", () => {
    it("updateInstrumentDetails changes display_name/status but never id, and bumps updated_at", async () => {
      const created = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "DE0007164600",
        exchangeMic: "XETR",
        listingCurrency: "EUR",
        displayName: "SAP SE (original name)",
      });

      // `updateInstrumentDetails` stamps `updatedAt: new Date()` in JS, so a
      // create and an update that both land inside the same millisecond produce
      // an identical timestamp and the strict `toBeGreaterThan` below fails for
      // no defect at all — observed on a CI runner
      // ("expected 1787329461188 to be greater than 1787329461188").
      //
      // Waiting for the clock to actually move is the fix, rather than relaxing
      // the assertion to `toBeGreaterThanOrEqual`: that would also pass if the
      // `updated_at` bump were deleted outright, which is precisely what this
      // assertion exists to catch.
      await waitForClockToPass(created.updatedAt);

      const updated = await updateInstrumentDetails(appWebDb, created.id, {
        displayName: "SAP SE (renamed)",
        status: "DELISTED",
      });

      expect(updated.id).toBe(created.id);
      expect(updated.displayName).toBe("SAP SE (renamed)");
      expect(updated.status).toBe("DELISTED");
      expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());

      // Identity-defining attributes are untouched by this update path.
      expect(updated.isin).toBe(created.isin);
      expect(updated.exchangeMic).toBe(created.exchangeMic);
      expect(updated.kind).toBe(created.kind);
      expect(updated.primaryIdentifier).toBe(created.primaryIdentifier);
    });

    it("the app_web DB grant itself rejects any attempt to write instrument.id — a structural guarantee, not just a service-layer one", async () => {
      const created = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "NL0011794037",
        exchangeMic: "XAMS",
        listingCurrency: "EUR",
        displayName: "ASML Holding NV",
      });

      await expect(
        appWebSql`update "instrument" set id = ${crypto.randomUUID()} where id = ${created.id}`,
      ).rejects.toThrow(/permission denied/i);

      // Also rejects a write to another identity-defining column app_web has
      // no UPDATE grant on at all (only display_name/status/updated_at are
      // grantable — migration 0011_instrument-update-grant.sql).
      await expect(
        appWebSql`update "instrument" set isin = 'FR9999999999' where id = ${created.id}`,
      ).rejects.toThrow(/permission denied/i);

      const [row] = await ownerClient<{ id: string; isin: string | null }[]>`
        select id, isin from "instrument" where id = ${created.id}
      `;
      expect(row?.id).toBe(created.id);
      expect(row?.isin).toBe("NL0011794037");
    });

    it("updating an instrument's display name/status does not change its id or break a transaction's reference to it", async () => {
      // Deliberately scoped to what T-11 itself owns: an unrelated-field
      // update (display name / status) on the instrument this service
      // creates. This is NOT the provider-swap scenario ("swapping the
      // active instrument_provider_map row changes nothing about the
      // instrument's id/display_name/any referencing transaction") — that
      // scenario, and instrument_provider_map CRUD generally, is explicitly
      // T-12's job, out of scope for T-11
      // Building that test here would mean building T-12's service to make
      // it pass, which would be scope creep.
      const testTenantId = "00000000-0000-7000-8000-0000000c0000";
      const testPortfolioId = "00000000-0000-7000-8000-0000000c0001";
      const testTransactionId = "00000000-0000-7000-8000-0000000c0002";
      // CA-9/`0039`: a fiat-settled row names the cash account its money moved
      // through, so this hand-built fixture needs one.
      const testCashAccountId = "00000000-0000-7000-8000-0000000c0003";

      const created = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "GB0002875804",
        exchangeMic: "XLON",
        listingCurrency: "GBP",
        displayName: "BAE Systems plc",
      });

      await ownerDb.insert(tenant).values({ id: testTenantId });
      await withTenant(appWebDb, testTenantId, async (tx) => {
        await tx.insert(portfolio).values({
          id: testPortfolioId,
          tenantId: testTenantId,
          name: "T-11 linked-row stability test",
        });
        await tx.insert(cashAccount).values({
          id: testCashAccountId,
          tenantId: testTenantId,
          portfolioId: testPortfolioId,
          name: "Compte GBP",
          currency: "GBP",
        });
        await tx.insert(transaction).values({
          baseCurrency: "EUR",
          id: testTransactionId,
          tenantId: testTenantId,
          portfolioId: testPortfolioId,
          kind: "BUY",
          tradeDate: "2025-03-01",
          seq: 1n,
          instrumentId: created.id,
          quantity: new Decimal("10"),
          unitPrice: new Decimal("500"),
          grossAmount: new Decimal("5000"),
          txnCurrency: "GBP",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "GBP",
          cashAmount: new Decimal("5000"),
          cashAccountId: testCashAccountId,
          fxRate: new Decimal("1.15"),
          fxRateSource: "PROVIDER",
        });
      });

      await updateInstrumentDetails(appWebDb, created.id, {
        displayName: "BAE Systems plc (renamed)",
        status: "MERGED",
      });

      const linkedTransaction = await withTenant(appWebDb, testTenantId, async (tx) => {
        return tx.select().from(transaction).where(eq(transaction.id, testTransactionId));
      });

      expect(linkedTransaction).toHaveLength(1);
      expect(linkedTransaction[0]?.instrumentId).toBe(created.id);
      expect(linkedTransaction[0]?.id).toBe(testTransactionId);
    });
  });

  /**
   * Migration `0061` (2026-09-09): `setInstrumentFigi`/`updateInstrumentIdentity`
   * fill a missing `figi` as the real `app_web` role — over the pooled
   * `appWebDb` handle, exactly like every other assertion in this file, so a
   * grant regression fails here and not only in
   * `platform/db/src/instrument-figi-fill-grant.integration.test.ts`.
   */
  describe("setInstrumentFigi / updateInstrumentIdentity — fill-once figi (issue: instrument-detail identity edit)", () => {
    it("fills a missing figi, and updated_at moves", async () => {
      const created = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: nextFigiFixtureIsin(),
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Figi fixture — fills",
      });
      expect(created.figi).toBeNull();
      await waitForClockToPass(created.updatedAt);

      const filled = await updateInstrumentIdentity(appWebDb, created.id, {
        figi: "BBG000BLNNH6",
      });

      expect(filled.id).toBe(created.id);
      expect(filled.figi).toBe("BBG000BLNNH6");
      expect(filled.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    });

    it("a second fill attempt is rejected — InstrumentFigiAlreadySetError, not a silent overwrite", async () => {
      const created = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: nextFigiFixtureIsin(),
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Figi fixture — second fill",
      });
      await setInstrumentFigi(appWebDb, created.id, "BBG000BPHFP8");

      await expect(setInstrumentFigi(appWebDb, created.id, "BBG000BPHFP9")).rejects.toThrow(
        InstrumentFigiAlreadySetError,
      );

      const [row] = await ownerClient<{ figi: string | null }[]>`
        select figi from "instrument" where id = ${created.id}
      `;
      // Unchanged — the rejected second attempt never landed.
      expect(row?.figi).toBe("BBG000BPHFP8");
    });

    it("updateInstrumentIdentity renames and fills figi together, atomically", async () => {
      const created = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: nextFigiFixtureIsin(),
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Figi fixture — rename+fill (original)",
      });

      const updated = await updateInstrumentIdentity(appWebDb, created.id, {
        displayName: "Figi fixture — rename+fill (renamed)",
        figi: "BBG000BFHT79",
      });

      expect(updated.displayName).toBe("Figi fixture — rename+fill (renamed)");
      expect(updated.figi).toBe("BBG000BFHT79");
      expect(updated.isin).toBe(created.isin);
    });

    it("a rejected figi fill rolls back the paired rename too — all or nothing", async () => {
      const created = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: nextFigiFixtureIsin(),
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Figi fixture — atomic reject (original)",
      });
      await setInstrumentFigi(appWebDb, created.id, "BBG000FGPQL0");

      await expect(
        updateInstrumentIdentity(appWebDb, created.id, {
          displayName: "Figi fixture — atomic reject (should not stick)",
          figi: "BBG000FGPQL1",
        }),
      ).rejects.toThrow(InstrumentFigiAlreadySetError);

      const reread = await getInstrumentById(appWebDb, created.id);
      expect(reread?.displayName).toBe("Figi fixture — atomic reject (original)");
      expect(reread?.figi).toBe("BBG000FGPQL0");
    });

    it("setInstrumentFigi on an unknown id raises InstrumentNotFoundError, not a raw permission or empty-row surprise", async () => {
      await expect(
        setInstrumentFigi(appWebDb, "00000000-0000-7000-8000-0000000c00ff", "BBG000BLNNH6"),
      ).rejects.toThrow(InstrumentNotFoundError);
    });

    it("the app_web DB grant itself now permits UPDATE figi, and every other identity column stays refused", async () => {
      const created = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: nextFigiFixtureIsin(),
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Figi fixture — grant matrix",
      });

      await expect(
        appWebSql`update "instrument" set figi = 'BBG000B9XRY4' where id = ${created.id}`,
      ).resolves.toBeDefined();
      await expect(
        appWebSql`update "instrument" set symbol = 'OR' where id = ${created.id}`,
      ).rejects.toThrow(/permission denied/i);
    });
  });

  /**
   * T-37: the read side `GET /instruments` and
   * `GET /instruments/:id` need (`listInstruments`, `getInstrumentById`) —
   * not built by T-11 itself, added here as the natural extension of this
   * file's own identity service.
   */
  describe("T-37 — listInstruments / getInstrumentById (search + resolve reads)", () => {
    it("getInstrumentById returns the row by id, and undefined for an id that does not exist", async () => {
      const created = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000354",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "BNP Paribas SA",
      });

      const found = await getInstrumentById(appWebDb, created.id);
      expect(found?.id).toBe(created.id);
      expect(found?.displayName).toBe("BNP Paribas SA");

      const missing = await getInstrumentById(appWebDb, "00000000-0000-7000-8000-00000000dead");
      expect(missing).toBeUndefined();
    });

    it("listInstruments filters by kind and by a case-insensitive query substring against display_name/symbol/isin", async () => {
      await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "T37-DOGECOIN",
        listingCurrency: "USD",
        displayName: "T37 Dogecoin Test Fixture",
      });
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FR0000131105",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T37 Some Other Share Fixture",
      });

      const cryptoOnly = await listInstruments(appWebDb, { kind: "CRYPTO", limit: 100, offset: 0 });
      expect(cryptoOnly.every((row) => row.kind === "CRYPTO")).toBe(true);
      expect(cryptoOnly.map((row) => row.symbol)).toContain("T37-DOGECOIN");

      const byQuery = await listInstruments(appWebDb, {
        query: "dogecoin test fixture",
        limit: 100,
        offset: 0,
      });
      expect(byQuery.map((row) => row.symbol)).toContain("T37-DOGECOIN");
      expect(byQuery.map((row) => row.isin)).not.toContain("FR0000131105");

      const byIsin = await listInstruments(appWebDb, {
        query: "FR0000131105",
        limit: 100,
        offset: 0,
      });
      expect(byIsin.map((row) => row.isin)).toContain("FR0000131105");
    });

    // F5 (security review, T-37): the `?query=` ILIKE search
    // built its pattern from the raw user fragment — `%`/`_` are ILIKE
    // wildcards, so a search containing a literal underscore would also
    // match any row where that position held *any* character.
    it("escapes %/_ in the search fragment so they match literally, not as ILIKE wildcards", async () => {
      const literalUnderscore = await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "T37ESC_A",
        listingCurrency: "USD",
        displayName: "T37ESC_A",
      });
      const wildcardVictim = await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "T37ESCXA",
        listingCurrency: "USD",
        displayName: "T37ESCXA",
      });

      const results = await listInstruments(appWebDb, {
        query: "T37ESC_A",
        limit: 100,
        offset: 0,
      });
      const symbols = results.map((row) => row.symbol);
      expect(symbols).toContain(literalUnderscore.symbol);
      expect(symbols).not.toContain(wildcardVictim.symbol);
    });

    it("listInstruments respects limit/offset for stable cursor-style pagination", async () => {
      const prefix = "T37-PAGE-";
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const row = await createInstrumentBySymbol(appWebDb, {
          kind: "CRYPTO",
          symbol: `${prefix}${i}`,
          listingCurrency: "USD",
          displayName: `${prefix}${i}`,
        });
        created.push(row.id);
      }

      const firstPage = await listInstruments(appWebDb, { query: prefix, limit: 2, offset: 0 });
      const secondPage = await listInstruments(appWebDb, { query: prefix, limit: 2, offset: 2 });
      const thirdPage = await listInstruments(appWebDb, { query: prefix, limit: 2, offset: 4 });

      expect(firstPage).toHaveLength(2);
      expect(secondPage).toHaveLength(2);
      expect(thirdPage).toHaveLength(1);

      const allIds = [...firstPage, ...secondPage, ...thirdPage].map((row) => row.id);
      // No row skipped or repeated across the three windows.
      expect(new Set(allIds).size).toBe(5);
      expect(allIds.sort()).toEqual([...created].sort());
    });

    // F10 (security review, T-37, INFO): a cheap forward-compat
    // guard. `owner_tenant_id` is always NULL in phase 1, but the day a
    // writer populates it for a tenant-private instrument, `listInstruments`/
    // `getInstrumentById` must not surface it on the shared catalogue's search
    // surface — neither function receives a `tenantId` to scope by, so `IS
    // NULL` (not a tenant comparison) is the correct phase-1 guard.
    it("excludes a row whose owner_tenant_id is set (a simulated future phase-2 private instrument)", async () => {
      const privateOwnerTenantId = "00000000-0000-7000-8000-0000000f1000";
      await ownerDb.insert(tenant).values({ id: privateOwnerTenantId });

      const [privateRow] = await ownerDb
        .insert(instrument)
        .values({
          id: "00000000-0000-7000-8000-0000000f1001",
          kind: "CRYPTO",
          displayName: "T37-F10-PRIVATE",
          listingCurrency: "USD",
          symbol: "T37-F10-PRIVATE",
          primaryIdentifier: "SYMBOL",
          quotePolicy: "AUTO",
          ownerTenantId: privateOwnerTenantId,
        })
        .returning();

      const found = await getInstrumentById(appWebDb, privateRow!.id);
      expect(found).toBeUndefined();

      const results = await listInstruments(appWebDb, {
        query: "T37-F10-PRIVATE",
        limit: 100,
        offset: 0,
      });
      expect(results.map((row) => row.id)).not.toContain(privateRow!.id);
    });
  });

  // N4 (security review, T-37): `symbol` was never
  // normalised — `"SPX"`, `"spx"`, and `"SPX "` used to insert three distinct
  // rows, bypassing both `instrument_symbol_crypto_key` and migration 0021's
  // `instrument_symbol_no_isin_key` (neither index is case/whitespace
  // insensitive). `createInstrumentBySymbol`/`createInstrumentByIsin` now
  // normalise (`.trim().toUpperCase()`) before every write.
  describe("N4 — symbol normalisation (defense in depth behind api's Zod-level normalisation)", () => {
    it("createInstrumentBySymbol stores a trimmed, uppercased symbol", async () => {
      const row = await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "  n4btc  ",
        listingCurrency: "USD",
        displayName: "T-37 N4 crypto fixture",
      });
      expect(row.symbol).toBe("N4BTC");
    });

    it("a case/whitespace variant of an existing CRYPTO symbol collides, not a distinct row", async () => {
      await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "N4COLLIDE",
        listingCurrency: "USD",
        displayName: "T-37 N4 collision fixture (original)",
      });

      await expect(
        createInstrumentBySymbol(appWebDb, {
          kind: "CRYPTO",
          symbol: "  n4collide ",
          listingCurrency: "USD",
          displayName: "T-37 N4 collision fixture (case/whitespace variant)",
        }),
      ).rejects.toBeInstanceOf(InstrumentAlreadyExistsError);

      const rows = await appWebDb
        .select()
        .from(instrument)
        .where(eq(instrument.symbol, "N4COLLIDE"));
      expect(rows).toHaveLength(1);
    });

    it("a case/whitespace variant of an existing INDEX symbol collides too (the F1(c) SYMBOL_NO_ISIN key)", async () => {
      await createInstrumentBySymbol(appWebDb, {
        kind: "INDEX",
        symbol: "^N4IDX",
        listingCurrency: "USD",
        displayName: "T-37 N4 INDEX collision fixture (original)",
      });

      try {
        await createInstrumentBySymbol(appWebDb, {
          kind: "INDEX",
          symbol: " ^n4idx ",
          listingCurrency: "USD",
          displayName: "T-37 N4 INDEX collision fixture (case/whitespace variant)",
        });
        expect.fail("expected InstrumentAlreadyExistsError to have been thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(InstrumentAlreadyExistsError);
        expect((err as InstrumentAlreadyExistsError).conflict).toBe("SYMBOL_NO_ISIN");
      }
    });

    it("createInstrumentByIsin also normalises the (attribute-only) symbol field", async () => {
      const row = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FR0000131609",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        symbol: "  n4ticker ",
        displayName: "T-37 N4 ISIN-path symbol fixture",
      });
      expect(row.symbol).toBe("N4TICKER");
    });
  });

  // N10 (security review, T-37): migration 0022's
  // `instrument_isin_trgm_idx` is a GIN trigram index on the *expression*
  // `(isin::text)` (`isin` is `char(12)`/bpchar; `gin_trgm_ops` has no bpchar
  // overload). `listInstruments`'s old `ilike(instrument.isin, pattern)`
  // resolves to the native `bpchar ~~* text` operator, which never matches
  // that expression syntactically — the index was dead. Verified with
  // `EXPLAIN` against a real Postgres 17 container, per the review's own
  // instruction, rather than trusted from the schema/migration alone.
  describe("N10 — the isin search predicate actually uses instrument_isin_trgm_idx", () => {
    // Proving this without forcing `enable_seqscan = off` (which would prove
    // only that the index is *syntactically* usable, not that a real request
    // would ever actually get it) needs enough rows that a full table scan
    // is genuinely more expensive than a highly selective bitmap lookup on
    // this table's real row width — verified directly by trying several row
    // counts against the real (post-migration) `instrument` table until the
    // *unforced* planner's own choice flipped from a (parallel) seq scan to
    // a bitmap index scan; 300,000 was the smallest tried that reliably did.
    const ROW_COUNT = 300_000;
    const isinFor = (i: number): string =>
      i.toString(16).toUpperCase().padStart(12, "0").slice(-12);

    it("EXPLAIN uses a Bitmap Index Scan on instrument_isin_trgm_idx for isin::text ILIKE, not a Seq Scan for the unfixed bare-column predicate", async () => {
      // A single `.insert(instrument).values([...300_000 objects])` blows
      // drizzle-orm's own SQL-builder call stack (`mergeQueries` recurses per
      // row) — a plain `generate_series`-driven `INSERT ... SELECT` seeds the
      // same rows in one round trip instead, with `isin` computed by the
      // exact SQL equivalent of `isinFor` above (`lpad(upper(to_hex(i)), 12,
      // '0')` — every value `isinFor` ever produces is already 12 characters
      // long for `i` in this range, so its `.slice(-12)` is a no-op here,
      // kept only so the two definitions stay obviously in sync).
      //
      // A dedicated connection with a generous `statementTimeoutMs` override
      // (F5/N7, `platform/db`'s `createPostgresClient`) — `ownerDb`'s own
      // connection uses the ordinary 15s default, and 300,000 rows' worth of
      // per-row FK lock checks against `currency` can comfortably exceed that
      // under load (observed directly: reliably ~10-11s in isolation, but
      // this suite's full run showed it can breach 15s alongside every other
      // test's own Testcontainers instance competing for CPU/IO). This one
      // statement is the only thing that actually needs the extra headroom;
      // every other statement in this test uses the ordinary `ownerDb`.
      const bulkInsertClient = createPostgresClient(pg.ownerUri, {
        statementTimeoutMs: 120_000,
      });
      try {
        await bulkInsertClient`
          INSERT INTO "instrument"
            (id, kind, display_name, listing_currency, isin, primary_identifier, quote_policy)
          SELECT gen_random_uuid(), 'SHARE', 'N10 fixture ' || i, 'EUR',
                 lpad(upper(to_hex(i)), 12, '0'), 'ISIN', 'AUTO'
          FROM generate_series(0, ${ROW_COUNT - 1}) AS i
        `;
      } finally {
        await bulkInsertClient.end({ timeout: 5 });
      }
      await ownerDb.execute(sql`ANALYZE "instrument"`);

      // The last 6 characters (rather than a middle slice) are the
      // selective part of `isinFor`'s output — its zero-padding lives at the
      // front, so a middle/leading substring would match almost every row
      // (near-zero selectivity, which correctly makes the planner prefer a
      // seq scan regardless of index availability) and defeat the point of
      // this test.
      const probeTarget = Math.floor(ROW_COUNT / 2);
      const probePattern = `%${isinFor(probeTarget).slice(-6)}%`;

      // N10 red-confirm: the *unfixed* predicate shape (`ilike` against the
      // bare bpchar column, exactly what `listInstruments` used to build) —
      // proves the underlying bug this finding is about, independent of
      // whether `instrument-service.ts` itself still contains it. At this
      // row count the natural (default planner settings, no forced
      // `enable_seqscan = off`) plan is a (possibly parallel) sequential
      // scan — the bare-column predicate cannot use `instrument_isin_trgm_idx`
      // at all, so there is nothing cheaper for the planner to pick.
      const seqScanPlan = await ownerDb.execute(
        sql`EXPLAIN ${ownerDb
          .select({ id: instrument.id })
          .from(instrument)
          .where(ilike(instrument.isin, probePattern))}`,
      );
      const seqScanPlanText = seqScanPlan.map((row) => Object.values(row)[0]).join("\n");
      expect(seqScanPlanText).toContain("Seq Scan");
      expect(seqScanPlanText).not.toContain("instrument_isin_trgm_idx");

      // The fixed predicate — exactly what `listInstruments` now builds
      // (`ilike(sql\`${instrument.isin}::text\`, pattern)`). Same row count,
      // same pattern, default planner settings: the *only* change is the
      // cast, and that alone flips the chosen plan to the trigram index.
      const indexScanPlan = await ownerDb.execute(
        sql`EXPLAIN ${ownerDb
          .select({ id: instrument.id })
          .from(instrument)
          .where(ilike(sql`${instrument.isin}::text`, probePattern))}`,
      );
      const indexScanPlanText = indexScanPlan.map((row) => Object.values(row)[0]).join("\n");
      expect(indexScanPlanText).toContain("instrument_isin_trgm_idx");
      expect(indexScanPlanText).not.toContain("Seq Scan");

      // `listInstruments` itself, exercised end to end against the same
      // seeded data — functional correctness of the search, not just the
      // plan shape above.
      const results = await listInstruments(appWebDb, {
        query: isinFor(probeTarget).slice(-6),
        limit: 10,
        offset: 0,
      });
      expect(results.some((row) => row.isin === isinFor(probeTarget))).toBe(true);
    }, 120_000);

    // Ties the EXPLAIN-proven mechanism above to the actual shipped
    // predicate: the plan-shape assertions above construct both the fixed
    // and unfixed predicate shapes directly (deliberately, so they hold
    // regardless of what `instrument-service.ts` itself currently contains,
    // proving the general DB-level fact) — this closes the loop by asserting
    // `listInstruments`'s own source literally contains the `::text` cast,
    // so reverting that one line back to the unfixed `ilike(instrument.isin,
    // pattern)` shape fails this test immediately, not only a manual EXPLAIN
    // check someone has to remember to rerun.
    it("listInstruments's isin predicate source contains the ::text cast (N10 red-confirm anchor)", async () => {
      const { readFile } = await import("node:fs/promises");
      const source = await readFile(join(here, "instrument-service.ts"), "utf8");
      expect(source).toMatch(/ilike\(sql`\$\{instrument\.isin\}::text`, pattern\)/);
    });
  });

  describe("findInstrumentsByIdentity — the CSV importer's batched identity read (CI-11)", () => {
    it("matches on either identifier, over the whole set at once, and dedupes the input", async () => {
      const byIsin = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000602",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Identity read, ISIN side",
        symbol: "IDA",
      });
      const bySymbol = await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "IDBCOIN",
        listingCurrency: "EUR",
        displayName: "Identity read, symbol side",
      });

      const found = await findInstrumentsByIdentity(appWebDb, {
        // The same identifier twice, and one that matches nothing: a caller
        // hands over a whole file's references, not a curated list.
        isins: ["FRTEST000602", "FRTEST000602", "FRTEST000610"],
        symbols: ["IDBCOIN"],
      });
      expect(found.map((row) => row.id).sort()).toEqual([byIsin.id, bySymbol.id].sort());
      // Exactly the identity/routing columns, and no display or classification
      // data beyond the name the review step shows.
      expect(Object.keys(found[0]!).sort()).toEqual([
        "displayName",
        "exchangeMic",
        "id",
        "isin",
        "kind",
        "primaryIdentifier",
        "symbol",
      ]);
    });

    it("returns nothing for an empty identity set, and something for a non-empty one", async () => {
      // The positive companion: "empty in, empty out" is indistinguishable from
      // a broken query unless the same call with a real identifier answers.
      expect(await findInstrumentsByIdentity(appWebDb, { isins: [], symbols: [] })).toEqual([]);
      expect(
        await findInstrumentsByIdentity(appWebDb, { isins: ["FRTEST000602"], symbols: [] }),
      ).toHaveLength(1);
    });
  });
  /**
   * `deleteInstrument`. Two properties carry the whole feature: the
   * cascade actually reaches the three `FORCE ROW LEVEL SECURITY` children,
   * and a referenced instrument is refused **without** destroying anything.
   */
  describe("deleting an instrument", () => {
    const deleteTenantId = "00000000-0000-7000-8000-0000000d0001";

    beforeAll(async () => {
      await ownerDb.insert(tenant).values({ id: deleteTenantId });
    });

    /** A fresh instrument plus one row in every table that cascades from it. */
    async function seedWithChildren(isin: string): Promise<string> {
      const created = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin,
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: `Delete fixture ${isin}`,
      });
      // `instrument_price_daily`, `instrument_price_gap`,
      // `instrument_quote_latest`, `instrument_backfill_state` and
      // `instrument_provider_map` carry no RLS; the three below do, and are
      // the point of this suite. Seeded as owner so the fixture never depends
      // on the grants under test.
      await ownerClient`
        INSERT INTO "instrument_price_daily" (instrument_id, price_date, close_raw, currency, source_key, quality)
        VALUES (${created.id}, '2025-01-02', 10, 'EUR', 'yahoo', 'EOD')`;
      await ownerClient`
        INSERT INTO "manual_price_point" (tenant_id, instrument_id, price_date, close, currency, source_key)
        VALUES (${deleteTenantId}, ${created.id}, '2025-01-03', 11, 'EUR', 'manual')`;
      await ownerClient`
        INSERT INTO "watchlist_item" (tenant_id, instrument_id) VALUES (${deleteTenantId}, ${created.id})`;
      return created.id;
    }

    async function childCounts(
      instrumentId: string,
    ): Promise<{ prices: number; manual: number; watch: number }> {
      const [row] = await ownerClient<{ prices: string; manual: string; watch: string }[]>`
        SELECT
          (SELECT count(*) FROM "instrument_price_daily" WHERE instrument_id = ${instrumentId}) AS prices,
          (SELECT count(*) FROM "manual_price_point"     WHERE instrument_id = ${instrumentId}) AS manual,
          (SELECT count(*) FROM "watchlist_item"         WHERE instrument_id = ${instrumentId}) AS watch`;
      return {
        prices: Number(row?.prices ?? "0"),
        manual: Number(row?.manual ?? "0"),
        watch: Number(row?.watch ?? "0"),
      };
    }

    it("removes the instrument and every cascade child, including the FORCE-RLS ones", async () => {
      const id = await seedWithChildren("FRTEST000701");
      expect(await childCounts(id)).toEqual({ prices: 1, manual: 1, watch: 1 });

      expect(
        await deleteInstrument(appWebDb, { tenantId: deleteTenantId, instrumentId: id }),
      ).toEqual({
        deleted: true,
      });

      expect(await getInstrumentById(appWebDb, id)).toBeUndefined();
      // The assertion this suite exists for. `manual_price_point` and
      // `watchlist_item` both FORCE row-level security with a policy scoped
      // `TO app_web`, so a *direct* delete as the table owner removes zero
      // rows — measured. Postgres runs referential actions with RLS not
      // enforced, so the cascade reaches them anyway. An implementation that
      // swept the children itself before deleting the parent would leave both
      // of these at 1 and then fail on the foreign key.
      expect(await childCounts(id)).toEqual({ prices: 0, manual: 0, watch: 0 });
    });

    it("reports deleted: false for an id that does not exist, rather than throwing", async () => {
      expect(
        await deleteInstrument(appWebDb, {
          tenantId: deleteTenantId,
          instrumentId: "00000000-0000-7000-8000-00000000dead",
        }),
      ).toEqual({ deleted: false });
    });

    it("refuses an instrument a transaction references, and destroys nothing", async () => {
      const id = await seedWithChildren("FRTEST000719");
      const portfolioId = "00000000-0000-7000-8000-0000000d0002";
      const cashAccountId = "00000000-0000-7000-8000-0000000d0003";
      await withTenant(appWebDb, deleteTenantId, async (tx) => {
        await tx
          .insert(portfolio)
          .values({ id: portfolioId, tenantId: deleteTenantId, name: "blocked-delete" });
        await tx.insert(cashAccount).values({
          id: cashAccountId,
          tenantId: deleteTenantId,
          portfolioId,
          name: "Compte EUR",
          currency: "EUR",
        });
        await tx.insert(transaction).values({
          baseCurrency: "EUR",
          id: "00000000-0000-7000-8000-0000000d0004",
          tenantId: deleteTenantId,
          portfolioId,
          kind: "BUY",
          tradeDate: "2025-04-01",
          seq: 1n,
          instrumentId: id,
          quantity: new Decimal("3"),
          unitPrice: new Decimal("100"),
          grossAmount: new Decimal("300"),
          txnCurrency: "EUR",
          cashCurrency: "EUR",
          cashAmount: new Decimal("300"),
          cashAccountId,
          fxRate: new Decimal("1"),
          fxRateSource: "PROVIDER",
        });
      });

      await expect(
        deleteInstrument(appWebDb, { tenantId: deleteTenantId, instrumentId: id }),
      ).rejects.toBeInstanceOf(InstrumentDeleteBlockedError);

      // "Destroys nothing" is the half a weaker test would skip: the refusal
      // must leave the price history and the watchlist entry alone, not merely
      // leave the instrument row behind.
      expect(await getInstrumentById(appWebDb, id)).toBeDefined();
      expect(await childCounts(id)).toEqual({ prices: 1, manual: 1, watch: 1 });
    });

    it("names what blocks it, by count and kind", async () => {
      const blocked = await deleteInstrument(appWebDb, {
        tenantId: deleteTenantId,
        instrumentId: (
          await findInstrumentsByIdentity(appWebDb, {
            isins: ["FRTEST000719"],
            symbols: [],
          })
        )[0]!.id,
      }).catch((err: unknown) => err);

      expect(blocked).toBeInstanceOf(InstrumentDeleteBlockedError);
      const counts = (blocked as InstrumentDeleteBlockedError).counts;
      expect(counts?.transactions).toBe(1);
      // A BUY writes its postings and its holding row through the transaction
      // write service, which this hand-built fixture bypasses — so the other
      // three are legitimately 0 here, and asserting that is what proves the
      // counts are measured per-table rather than copied from one number.
      expect(counts?.holdings).toBe(0);
      expect(counts?.postings).toBe(0);
      expect(counts?.realizedGains).toBe(0);
    });
  });
});
