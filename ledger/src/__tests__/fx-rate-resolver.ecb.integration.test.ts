import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { EcbFxRateProvider, type EcbSourceFetcher } from "@kerdial/market-adapters";
import type { CurrencyPair, FxObservation, FxRateProvider, IsoDate } from "@kerdial/market-ports";
import { createDb, fxRateUser, tenant, type Db } from "@kerdial/platform-db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FxRateResolver, FxRateUnavailableError } from "../fx-rate-resolver.js";

/**
 * T-18 acceptance for the paths that need both halves of the real system:
 * T-15's ECB adapter behind the `FxRateProvider` port, and real Postgres 17
 * (Testcontainers) for the tenant-owned `fx_rate_user` fallback — the same
 * shape as `../portfolio-service.integration.test.ts`.
 *
 * **Why this file sits in `src/__tests__/` rather than beside the module it
 * tests.** `.dependency-cruiser.cjs`'s `ledger-no-market-adapters` rule
 * forbids *any* file under `ledger/` from
 * importing `market/adapters`, and its `options.exclude` deliberately
 * exempts `__tests__` directories — the same exemption its
 * `core-domain-purity` rule's comment relies on for test-only imports.
 * `FxRateResolver` itself depends only on the **port**: it names no adapter,
 * imports none, and cannot branch on provider identity. This file is the
 * composition step — the only place in `ledger` where a concrete adapter is
 * wired to that port, and it is a test, exactly as T-18's
 * second acceptance criterion requires ("returns PROVIDER sourced from the
 * ECB adapter (via T-15)"). The precedent is T-16, which likewise put the
 * port-level machinery in the lower package and the adapter registration
 * where an adapter may legally be named.
 *
 * No test here touches the network: the ECB adapter is driven by T-15's
 * checked-in ECB history fixture (`sdw-exr-fixture.csv`) through the injected
 * `EcbSourceFetcher` seam.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ecbFixturesDir = join(here, "..", "..", "..", "market", "adapters", "__fixtures__", "ecb");
const HIST_FIXTURE = readFileSync(join(ecbFixturesDir, "sdw-exr-fixture.csv"), "utf8");
const DAILY_FIXTURE = readFileSync(join(ecbFixturesDir, "eurofxref-daily-fixture.xml"), "utf8");

/** T-15's own fixture seam — the ECB adapter's parsing/derivation logic runs for real, its HTTP boundary does not. */
class FixtureFetcher implements EcbSourceFetcher {
  async fetchHistoricalCsv(): Promise<string> {
    return HIST_FIXTURE;
  }
  async fetchDailyXml(): Promise<string> {
    return DAILY_FIXTURE;
  }
}

/**
 * Wraps a real `FxRateProvider` and counts every call to it, so
 * "the provider was never called" is a statement about the *real* ECB
 * adapter, not only about the in-memory double used in
 * `../fx-rate-resolver.test.ts`. Implementing the port itself (rather than
 * patching methods) means a method added to the port later cannot slip past
 * the counter uncounted — this file stops compiling instead.
 */
class CountingFxRateProvider implements FxRateProvider {
  calls = 0;
  readonly #inner: FxRateProvider;

  constructor(inner: FxRateProvider) {
    this.#inner = inner;
  }

  capabilities() {
    this.calls += 1;
    return this.#inner.capabilities();
  }

  fetchDailyRates(pairs: CurrencyPair[], from: IsoDate, to: IsoDate): Promise<FxObservation[]> {
    this.calls += 1;
    return this.#inner.fetchDailyRates(pairs, from, to);
  }

  fetchLatestRates(pairs: CurrencyPair[]): Promise<FxObservation[]> {
    this.calls += 1;
    return this.#inner.fetchLatestRates(pairs);
  }
}

describe("ledger — FxRateResolver against the ECB adapter and real Postgres (T-18, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-00000018000a";
  const tenantB = "00000000-0000-7000-8000-00000018000b";

  const ecb = new CountingFxRateProvider(new EcbFxRateProvider(new FixtureFetcher()));

  function resolver(tenantId: string = tenantA, baseCurrency = "EUR"): FxRateResolver {
    return new FxRateResolver({ db: appWebDb, provider: ecb, tenantId, baseCurrency });
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);

    // NFR-13's manually-supplied-currency path: two pairs ECB cannot serve —
    // MAD (never published) and RUB (suspended since 2022-03-01) — for
    // tenant A only. The 2024-01-05 date is deliberately earlier than the
    // dates resolved below, so LOCF is exercised on this table too.
    await ownerDb.insert(fxRateUser).values([
      {
        tenantId: tenantA,
        baseCurrency: "EUR",
        quoteCurrency: "MAD",
        rateDate: "2024-01-05",
        rate: new Decimal("0.09150000"),
      },
      {
        tenantId: tenantA,
        baseCurrency: "EUR",
        quoteCurrency: "RUB",
        rateDate: "2024-01-05",
        rate: new Decimal("0.01020000"),
      },
      {
        tenantId: tenantB,
        baseCurrency: "EUR",
        quoteCurrency: "JPY",
        rateDate: "2024-01-05",
        rate: new Decimal("0.00620000"),
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  describe("FR-57(b) / AC46 — the PROVIDER path", () => {
    it("returns the ECB rate for the exact date, in the canonical direction, with its provider key and observedOn", async () => {
      const resolved = await resolver().resolve("PRINCIPAL", "USD", "2024-01-10");

      expect(resolved.source).toBe("PROVIDER");
      // ECB published "1 EUR = 1.0850 USD" on 2024-01-10; the canonical
      // direction (amount_base = amount_native × rate) is EUR per USD.
      expect(resolved.rate.toFixed(10)).toBe("0.9216589862");
      expect(resolved.providerKey).toBe("ecb");
      expect(resolved.observedOn).toBe("2024-01-10");
      expect(resolved.userInput).toBeNull();
      // An inverted rate (1.0850) would differ by more than a factor of two —
      // R12's "single most common FX bug" cannot pass this assertion.
      expect(resolved.rate.lessThan(new Decimal(1))).toBe(true);
    });

    it("resolves a cross-rate pair (a non-EUR base currency) through the same path (NFR-13: no hardcoded currency)", async () => {
      // USD-based tenant pricing a GBP trade: EUR/GBP ÷ EUR/USD, derived by
      // the adapter. 0.8590 / 1.0850 GBP-per-EUR ... in canonical
      // direction: USD per GBP = (1/0.8590) / (1/1.0850) = 1.0850 / 0.8590.
      const resolved = await resolver(tenantA, "USD").resolve("PRINCIPAL", "GBP", "2024-01-10");

      expect(resolved.source).toBe("PROVIDER");
      expect(resolved.rate.toFixed(10)).toBe("1.2630966240");
      expect(resolved.observedOn).toBe("2024-01-10");
    });
  });

  describe("Saturday resolves to Friday's rate via LOCF, auditably", () => {
    it("returns Friday 2024-01-05's rate for Saturday 2024-01-06, with observedOn set to the Friday", async () => {
      const saturday = await resolver().resolve("PRINCIPAL", "USD", "2024-01-06");

      expect(saturday.source).toBe("PROVIDER");
      // ECB published "1 EUR = 1.0900 USD" on Friday 2024-01-05 and nothing
      // on the Saturday.
      expect(saturday.rate.toFixed(10)).toBe("0.9174311927");
      // The auditable half: a reviewer can see the Saturday trade used
      // Friday's published rate, not a fabricated Saturday one.
      expect(saturday.observedOn).toBe("2024-01-05");
      expect(saturday.observedOn).not.toBe("2024-01-06");
    });

    it("never looks ahead: Sunday 2024-01-07 also uses Friday's rate, not Monday 2024-01-08's", async () => {
      const sunday = await resolver().resolve("PRINCIPAL", "USD", "2024-01-07");
      const monday = await resolver().resolve("PRINCIPAL", "USD", "2024-01-08");

      expect(sunday.observedOn).toBe("2024-01-05");
      expect(sunday.rate.toFixed(10)).toBe("0.9174311927");
      expect(monday.observedOn).toBe("2024-01-08");
      expect(monday.rate.toFixed(10)).not.toBe(sunday.rate.toFixed(10));
    });
  });

  describe("NFR-13 — fx_rate_user covers the pairs the configured provider does not", () => {
    it("uses this tenant's manual rate for a currency ECB never publishes (MAD), recording its provenance", async () => {
      const resolved = await resolver().resolve("PRINCIPAL", "MAD", "2024-01-10");

      expect(resolved.rate.toFixed(8)).toBe("0.09150000");
      // `source_key` defaults to 'user' (FR-58), so the stored row says
      // where the rate came from without a join. It is *not* `USER_PINNED`:
      // no rate was supplied for this transaction, so `userInput` stays null
      // and `fx_rate_user_input` will be NULL on the row T-19 writes.
      expect(resolved.providerKey).toBe("user");
      expect(resolved.userInput).toBeNull();
      expect(resolved.source).toBe("PROVIDER");
      // LOCF applies to the manual series too — one rule, one implementation.
      expect(resolved.observedOn).toBe("2024-01-05");
    });

    it("uses the manual rate for a pair ECB has suspended (EUR/RUB after 2022-03-01), exactly as the LOCF rule directs", async () => {
      const resolved = await resolver().resolve("PRINCIPAL", "RUB", "2024-01-10");

      expect(resolved.rate.toFixed(8)).toBe("0.01020000");
      expect(resolved.providerKey).toBe("user");
      expect(resolved.observedOn).toBe("2024-01-05");
    });

    it("the tenant's manual rate now wins over a pair ECB does publish — ADR-0004's recorded precedence (AR-7)", async () => {
      // Tenant B has a manual EUR/JPY rate; ECB publishes EUR/JPY. Until
      // AR-7 the live provider won here; ADR-0004 reversed it deliberately:
      // "user rows win, mirroring resolvePrice's manual-over-automated
      // precedence and FR-56's principle. Recorded so the implementer does
      // not have to infer it." The local step (fx_rate_user first) runs
      // before any live call, so the manual rate is the resolution.
      const resolved = await resolver(tenantB).resolve("PRINCIPAL", "JPY", "2024-01-10");

      expect(resolved.providerKey).toBe("user");
    });

    it("scopes manual rates to their own tenant (FR-45, AC33): tenant B cannot resolve tenant A's MAD rate", async () => {
      await expect(
        resolver(tenantB).resolve("PRINCIPAL", "MAD", "2024-01-10"),
      ).rejects.toBeInstanceOf(FxRateUnavailableError);
    });
  });

  describe("fail closed: no user rate, no provider rate, no manual rate", () => {
    it("raises a validation error for a currency ECB does not publish with no fx_rate_user row, rather than defaulting to any rate", async () => {
      // Tenant B has no manual rates for MAD; ECB never publishes it.
      const error = await resolver(tenantB)
        .resolve("PRINCIPAL", "MAD", "2024-01-10")
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(FxRateUnavailableError);
      const failure = error as FxRateUnavailableError;
      expect(failure.currency).toBe("MAD");
      expect(failure.baseCurrency).toBe("EUR");
      expect(failure.date).toBe("2024-01-10");
      expect(failure.leg).toBe("PRINCIPAL");
      // The remedy FR-56/NFR-13 give the user is in the message.
      expect(failure.message).toMatch(/Supply an explicit FX rate/);
      // Never 1, never a neighbouring currency: nothing was returned at all.
    });

    it("raises rather than carrying a rate forward from beyond the provider's lookback window", async () => {
      // ECB's fixture publishes nothing between 2022-03-02 and 2024-01-03.
      // A 2023-06-15 trade is a fortnight past any publication, so the
      // provider reports a gap and — with no manual EUR/USD row on file —
      // the write is rejected instead of being priced off a months-old rate.
      await expect(resolver().resolve("PRINCIPAL", "USD", "2023-06-15")).rejects.toBeInstanceOf(
        FxRateUnavailableError,
      );
    });
  });

  describe("FR-57(b) / AC45 — the user-pinned rate wins against the real adapter too", () => {
    it("never calls the ECB adapter when a rate is pinned, and stores the pinned rate verbatim", async () => {
      const callsBefore = ecb.calls;

      const resolved = await resolver().resolve(
        "PRINCIPAL",
        "USD",
        "2024-01-10",
        new Decimal("0.95000000"),
      );

      // The code-path assertion over the real adapter (AC45's "demonstrably
      // not used"): zero calls, not "a different number came back".
      expect(ecb.calls).toBe(callsBefore);
      expect(resolved.source).toBe("USER_PINNED");
      expect(resolved.rate.toFixed(8)).toBe("0.95000000");
      expect(resolved.userInput?.toFixed(8)).toBe("0.95000000");
      expect(resolved.providerKey).toBeNull();
      expect(resolved.observedOn).toBeNull();
      // ECB's own rate for that date, which is materially different and must
      // not have been used.
      expect(resolved.rate.toFixed(10)).not.toBe("0.9216589862");
    });

    it("never calls the ECB adapter for a base-currency leg either (IMPLIED_BASE)", async () => {
      const callsBefore = ecb.calls;

      // FR-260: this named the `FEE` leg until FT-34, then
      // `WITHHOLDING_TAX` until `0079`; `PRINCIPAL` is the only member left. The
      // claim is about a **base-currency** leg, which is leg-independent.
      const resolved = await resolver().resolve("PRINCIPAL", "EUR", "2024-01-10");

      expect(ecb.calls).toBe(callsBefore);
      expect(resolved.source).toBe("IMPLIED_BASE");
      expect(resolved.rate.toString()).toBe("1");
    });
  });
});
