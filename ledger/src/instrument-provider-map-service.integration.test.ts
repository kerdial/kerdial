import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import {
  cashAccount,
  createDb,
  instrumentProviderMap,
  portfolio,
  tenant,
  transaction,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInstrumentByIsin } from "./instrument-service.js";
import {
  ProviderMappingAlreadyExistsError,
  ProviderMappingNotFoundError,
  confirmProviderMapping,
  createProviderMapping,
  deleteProviderMapping,
  getProviderMapping,
  isUnverifiedMapping,
  listProviderMappings,
  swapProviderMapping,
} from "./instrument-provider-map-service.js";

/**
 * T-12 acceptance: the instrument provider mapping service against a real Postgres 17 container, authenticated as
 * `app_web` — the same shape as `instrument-service.integration.test.ts`
 * (T-11).
 *
 * `ownerDb`/`ownerClient` is the superuser handle, used only for
 * out-of-band setup a real request never does (seeding a tenant, an
 * instrument to map against). Every call that exercises the service under
 * test goes through `appWebDb`.
 *
 * `instrument_provider_map` is shared reference data with no `tenant_id` and
 * no RLS (see the doc comment in `instrument-provider-map-service.ts`),
 * so — like T-11's suite — none of these calls go through `withTenant` except
 * where a `transaction` row is seeded to prove AC3's "linked transaction is
 * untouched" property.
 */
describe("ledger — instrument provider mapping service (T-12, Testcontainers)", () => {
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

  describe("CRUD over instrument_provider_map (FR-5)", () => {
    it("creates a HEURISTIC mapping and reads it back distinguishable from CONFIRMED", async () => {
      const instr = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000313",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "BNP Paribas SA",
      });

      const heuristic = await createProviderMapping(appWebDb, {
        instrumentId: instr.id,
        providerKey: "yahoo",
        providerSymbol: "BNP.PA",
        confidence: "HEURISTIC",
      });
      expect(heuristic.confidence).toBe("HEURISTIC");
      expect(heuristic.lastVerifiedAt).toBeNull();
      expect(isUnverifiedMapping(heuristic)).toBe(true);

      const confirmedInstr = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000230",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "L'Air Liquide SA",
      });
      const confirmed = await createProviderMapping(appWebDb, {
        instrumentId: confirmedInstr.id,
        providerKey: "yahoo",
        providerSymbol: "AI.PA",
        confidence: "CONFIRMED",
      });
      expect(confirmed.confidence).toBe("CONFIRMED");
      expect(confirmed.lastVerifiedAt).not.toBeNull();
      expect(isUnverifiedMapping(confirmed)).toBe(false);

      const fetched = await getProviderMapping(appWebDb, instr.id, "yahoo");
      expect(fetched?.confidence).toBe("HEURISTIC");

      const listed = await listProviderMappings(appWebDb, instr.id);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.providerKey).toBe("yahoo");
    });

    it("deleteProviderMapping removes the row; a second delete raises ProviderMappingNotFoundError", async () => {
      const instr = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000297",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Vinci SA",
      });
      await createProviderMapping(appWebDb, {
        instrumentId: instr.id,
        providerKey: "yahoo",
        providerSymbol: "DG.PA",
        confidence: "HEURISTIC",
      });

      await deleteProviderMapping(appWebDb, instr.id, "yahoo");
      expect(await getProviderMapping(appWebDb, instr.id, "yahoo")).toBeUndefined();

      await expect(deleteProviderMapping(appWebDb, instr.id, "yahoo")).rejects.toThrow(
        ProviderMappingNotFoundError,
      );
    });
  });

  describe("PRIMARY KEY (instrument_id, provider_key) — at most one mapping per instrument+provider", () => {
    it("a second mapping for the same (instrument, provider) raises a clear domain error, not a raw constraint failure", async () => {
      const instr = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000263",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "LVMH Moet Hennessy",
      });
      await createProviderMapping(appWebDb, {
        instrumentId: instr.id,
        providerKey: "yahoo",
        providerSymbol: "MC.PA",
        confidence: "HEURISTIC",
      });

      try {
        await createProviderMapping(appWebDb, {
          instrumentId: instr.id,
          providerKey: "yahoo",
          providerSymbol: "MC.PA-alt",
          confidence: "HEURISTIC",
        });
        expect.fail("expected ProviderMappingAlreadyExistsError to have been thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderMappingAlreadyExistsError);
        expect((err as ProviderMappingAlreadyExistsError).conflict).toBe("INSTRUMENT_PROVIDER");
        expect(err).not.toBeInstanceOf(postgres.PostgresError);
      }
    });
  });

  describe("UNIQUE (provider_key, provider_symbol) — enforced at the DB layer (T-12 acceptance)", () => {
    it("mapping two different instruments to the same (provider, symbol) pair is rejected with a clear domain error", async () => {
      const first = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000321",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Renault SA",
      });
      const second = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FR0000121261",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Renault SA (duplicate-symbol test double)",
      });

      await createProviderMapping(appWebDb, {
        instrumentId: first.id,
        providerKey: "yahoo",
        providerSymbol: "RNO.PA",
        confidence: "HEURISTIC",
      });

      try {
        await createProviderMapping(appWebDb, {
          instrumentId: second.id,
          providerKey: "yahoo",
          providerSymbol: "RNO.PA",
          confidence: "HEURISTIC",
        });
        expect.fail("expected ProviderMappingAlreadyExistsError to have been thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderMappingAlreadyExistsError);
        expect((err as ProviderMappingAlreadyExistsError).conflict).toBe("PROVIDER_SYMBOL");
        expect(err).not.toBeInstanceOf(postgres.PostgresError);
      }

      // Verifying the constraint itself rejects it at the database layer,
      // independent of the service's try/catch translation.
      await expect(
        ownerClient`
          insert into "instrument_provider_map"
            (instrument_id, provider_key, provider_symbol, confidence)
          values (${second.id}, 'yahoo', 'RNO.PA', 'HEURISTIC')
        `,
      ).rejects.toThrow(/duplicate key value violates unique constraint/i);
    });
  });

  describe("HEURISTIC -> CONFIRMED state transition", () => {
    it("confirmProviderMapping flips confidence and stamps last_verified_at; unconfirmed mappings stay distinguishable in a query", async () => {
      const confirmedLater = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000248",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Danone SA",
      });
      const staysHeuristic = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000222",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Carrefour SA",
      });

      await createProviderMapping(appWebDb, {
        instrumentId: confirmedLater.id,
        providerKey: "yahoo",
        providerSymbol: "BN.PA",
        confidence: "HEURISTIC",
      });
      await createProviderMapping(appWebDb, {
        instrumentId: staysHeuristic.id,
        providerKey: "yahoo",
        providerSymbol: "CA.PA",
        confidence: "HEURISTIC",
      });

      const confirmed = await confirmProviderMapping(appWebDb, confirmedLater.id, "yahoo");
      expect(confirmed.confidence).toBe("CONFIRMED");
      expect(confirmed.lastVerifiedAt).not.toBeNull();

      // Distinguishable via the read API, without inferring it: query both
      // and check isUnverifiedMapping directly.
      const all = await appWebDb.select().from(instrumentProviderMap);
      const stillUnverified = all.filter((row) => isUnverifiedMapping(row));
      expect(stillUnverified.some((row) => row.instrumentId === staysHeuristic.id)).toBe(true);
      expect(stillUnverified.some((row) => row.instrumentId === confirmedLater.id)).toBe(false);
    });

    it("confirmProviderMapping raises ProviderMappingNotFoundError for an unmapped instrument", async () => {
      const instr = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000305",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Sanofi SA",
      });
      await expect(confirmProviderMapping(appWebDb, instr.id, "yahoo")).rejects.toThrow(
        ProviderMappingNotFoundError,
      );
    });
  });

  describe("AC3 — swapping the underlying provider changes nothing about the instrument or a linked transaction", () => {
    it("swapProviderMapping replaces the yahoo mapping with an eodhd one, leaving id/display_name/linked transaction untouched", async () => {
      const testTenantId = "00000000-0000-7000-8000-0000000d0000";
      const testPortfolioId = "00000000-0000-7000-8000-0000000d0001";
      const testTransactionId = "00000000-0000-7000-8000-0000000d0002";
      const testCashAccountId = "00000000-0000-7000-8000-0000000d0003";

      const instr = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        // IR-22 — a **synthetic** ISIN, not a real listing. Migration `0037` seeds the
        // real large-cap identifiers into the shared catalogue, so a fixture reusing one
        // collides with the seeded row on `instrument_isin_exchange_mic_key`. The `TEST`
        // NSIN keeps the ISO 6166 check digit valid and can never be a real identifier.
        isin: "FRTEST000214",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Air France-KLM SA",
      });

      await createProviderMapping(appWebDb, {
        instrumentId: instr.id,
        providerKey: "yahoo",
        providerSymbol: "AF.PA",
        confidence: "HEURISTIC",
      });

      await ownerDb.insert(tenant).values({ id: testTenantId });
      await withTenant(appWebDb, testTenantId, async (tx) => {
        await tx.insert(portfolio).values({
          id: testPortfolioId,
          tenantId: testTenantId,
          name: "T-12 provider-swap linked-row stability test",
        });
        // CA-9/`0039`: a fiat-settled row names the cash account its money
        // moved through, so this hand-built fixture needs one.
        await tx.insert(cashAccount).values({
          id: testCashAccountId,
          tenantId: testTenantId,
          portfolioId: testPortfolioId,
          name: "Compte EUR",
          currency: "EUR",
        });
        await tx.insert(transaction).values({
          baseCurrency: "EUR",
          id: testTransactionId,
          tenantId: testTenantId,
          portfolioId: testPortfolioId,
          kind: "BUY",
          tradeDate: "2025-04-01",
          seq: 1n,
          instrumentId: instr.id,
          quantity: new Decimal("15"),
          unitPrice: new Decimal("12.5"),
          grossAmount: new Decimal("187.5"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("187.5"),
          cashAccountId: testCashAccountId,
          fxRate: new Decimal("1"),
          fxRateSource: "IMPLIED_BASE",
        });
      });

      const beforeSwap = await getProviderMapping(appWebDb, instr.id, "yahoo");
      expect(beforeSwap).toBeDefined();

      // The headline swap: a real provider change performed entirely
      // through this service, in a test configuration mapping the same
      // instrument to a different provider_key ('eodhd').
      const swapped = await swapProviderMapping(appWebDb, instr.id, {
        fromProviderKey: "yahoo",
        toProviderKey: "eodhd",
        toProviderSymbol: "AF-FR",
        confidence: "CONFIRMED",
      });
      expect(swapped.providerKey).toBe("eodhd");
      expect(swapped.providerSymbol).toBe("AF-FR");
      expect(swapped.confidence).toBe("CONFIRMED");

      // Old provider mapping is gone; new one is in place.
      expect(await getProviderMapping(appWebDb, instr.id, "yahoo")).toBeUndefined();
      const afterSwap = await getProviderMapping(appWebDb, instr.id, "eodhd");
      expect(afterSwap?.providerSymbol).toBe("AF-FR");

      // The instrument's own identity is untouched by the swap.
      const [instrRow] = await appWebSql<{ id: string; display_name: string }[]>`
        select id, display_name from "instrument" where id = ${instr.id}
      `;
      expect(instrRow?.id).toBe(instr.id);
      expect(instrRow?.display_name).toBe("Air France-KLM SA");

      // The linked transaction is untouched by the swap.
      const linkedTransaction = await withTenant(appWebDb, testTenantId, async (tx) => {
        return tx.select().from(transaction).where(eq(transaction.id, testTransactionId));
      });
      expect(linkedTransaction).toHaveLength(1);
      expect(linkedTransaction[0]?.instrumentId).toBe(instr.id);
      expect(linkedTransaction[0]?.id).toBe(testTransactionId);
    });

    it("swapProviderMapping raises ProviderMappingNotFoundError when the source mapping does not exist", async () => {
      const instr = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000271",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "EssilorLuxottica SA",
      });

      await expect(
        swapProviderMapping(appWebDb, instr.id, {
          fromProviderKey: "yahoo",
          toProviderKey: "eodhd",
          toProviderSymbol: "EL-FR",
          confidence: "CONFIRMED",
        }),
      ).rejects.toThrow(ProviderMappingNotFoundError);

      // Nothing was left half-swapped: no mapping row exists at all for
      // this instrument (the delete-then-insert is one transaction).
      const rows = await listProviderMappings(appWebDb, instr.id);
      expect(rows).toHaveLength(0);
    });

    it("swapProviderMapping raises ProviderMappingAlreadyExistsError, and the original mapping survives, when the target (provider, symbol) is already claimed", async () => {
      const claimant = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000255",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Pernod Ricard SA",
      });
      await createProviderMapping(appWebDb, {
        instrumentId: claimant.id,
        providerKey: "eodhd",
        providerSymbol: "RI-FR",
        confidence: "CONFIRMED",
      });

      const swapping = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000289",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Veolia Environnement SA",
      });
      await createProviderMapping(appWebDb, {
        instrumentId: swapping.id,
        providerKey: "yahoo",
        providerSymbol: "VIE.PA",
        confidence: "HEURISTIC",
      });

      await expect(
        swapProviderMapping(appWebDb, swapping.id, {
          fromProviderKey: "yahoo",
          toProviderKey: "eodhd",
          toProviderSymbol: "RI-FR", // already claimed by `claimant`
          confidence: "CONFIRMED",
        }),
      ).rejects.toThrow(ProviderMappingAlreadyExistsError);

      // The whole swap rolled back: the original yahoo mapping is still
      // there, not half-deleted.
      const original = await getProviderMapping(appWebDb, swapping.id, "yahoo");
      expect(original?.providerSymbol).toBe("VIE.PA");
      expect(await getProviderMapping(appWebDb, swapping.id, "eodhd")).toBeUndefined();
    });
  });
});
