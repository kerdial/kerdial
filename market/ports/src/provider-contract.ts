/**
 * The provider contract suite (T-16).
 * This is the executable definition of "being a `QuoteProvider`/
 * `FxRateProvider`" (AC16's structural half): every adapter (T-15's `ecb`
 * today; T-31/T-32's `yahoo`/`coingecko` later) is expected to satisfy the
 * exact same assertions, unchanged.
 *
 * **Deliberately framework-free.** This module asserts with `node:assert/strict`,
 * never `vitest`'s `expect`/`describe`/`it`. `market/adapters/ecb/provider.ts`
 * (and every future adapter) imports *real values* (the error classes) from
 * this package's main entry point (`index.ts`), so anything exported from
 * `index.ts` is loaded at runtime by every consumer, not only by tests — a
 * top-level `import ... from "vitest"` here would make the test framework a
 * transitive runtime dependency of every adapter and of `ledger`/`valuation`/
 * `api`, which merely import the closed error taxonomy as values. Each
 * function below instead returns a plain array of named, self-contained
 * cases (`ContractCase`); the four lines of `describe`/`it` glue needed to
 * run them live in each *test file* (already vitest-coupled by convention),
 * not here. This is what "T-31/T-32 invoke it without rewriting assertions"
 * (a design constraint) means in practice: registering a new
 * adapter is calling `quoteProviderContractCases(fixtures)` and looping
 * `it(...)` over the result — no new assertion logic.
 *
 * No provider name appears anywhere in this file.
 */
import strictAssert from "node:assert/strict";
import { Decimal } from "@kerdial/core-decimal";
import {
  ProviderMalformedResponse,
  ProviderRateLimited,
  ProviderUnavailable,
  SymbolNotFound,
} from "./errors.js";
import type { FxRateProvider } from "./fx-rate-provider.js";
import type { QuoteProvider } from "./quote-provider.js";
import type { CurrencyPair, InstrumentRef, IsoDate, ProviderSymbol } from "./types.js";

/** One named, independently runnable assertion — the unit `quoteProviderContractCases`/`fxRateProviderContractCases` produce. */
export interface ContractCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

const QUOTE_QUALITIES = ["REALTIME", "DELAYED", "EOD"] as const;

function assertNonEmptyString(value: unknown, label: string): void {
  strictAssert.strictEqual(typeof value, "string", `${label} must be a string`);
  strictAssert.ok((value as string).length > 0, `${label} must be non-empty`);
}

function assertDecimal(value: unknown, label: string): void {
  strictAssert.ok(
    value instanceof Decimal,
    `${label} must be a Decimal instance (NFR-12), got ${typeof value}: ${String(value)}`,
  );
}

function assertQuoteQuality(value: unknown, label: string): void {
  strictAssert.ok(
    (QUOTE_QUALITIES as readonly unknown[]).includes(value),
    `${label} must be one of ${QUOTE_QUALITIES.join(", ")}, got ${String(value)}`,
  );
}

/** `asOf`/`rateDate` must never be in the future — compared against real wall-clock time, since every fixture date used against this suite is necessarily in the past. */
function assertNotInFuture(isoValue: string, label: string): void {
  const parsed = new Date(isoValue);
  strictAssert.ok(
    !Number.isNaN(parsed.getTime()),
    `${label} is not a valid date/instant: "${isoValue}"`,
  );
  strictAssert.ok(
    parsed.getTime() <= Date.now(),
    `${label} must not be in the future: "${isoValue}"`,
  );
}

/** History/series contract: date-ascending, no duplicate dates — a single strict-ascending check catches both violations at once. */
function assertDateAscendingNoDuplicates(dates: readonly string[], label: string): void {
  for (let i = 1; i < dates.length; i += 1) {
    strictAssert.ok(
      dates[i]! > dates[i - 1]!,
      `${label} must be strictly date-ascending with no duplicate dates; found "${dates[i - 1]}" followed by "${dates[i]}"`,
    );
  }
}

async function assertRejectsWith(
  promise: Promise<unknown>,
  ctor: abstract new (...args: never[]) => Error,
  label: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  strictAssert.ok(
    caught instanceof ctor,
    `${label} must reject with ${ctor.name}, got ${caught instanceof Error ? caught.constructor.name : String(caught)}`,
  );
}

/**
 * What a `QuoteProvider` adapter under test must supply to run the suite —
 * one factory per scenario the suite provokes (rate-limited,
 * not-found, transient network, malformed response, outage), plus a
 * happy-path factory and the fixture identifiers the happy-path instance
 * resolves. Every factory returns a **fresh** provider instance so cases do
 * not share mutable state.
 */
export interface QuoteProviderContractFixtures {
  /** Used only in case names for readability — typically the provider key under test. */
  readonly label: string;
  /** An `InstrumentRef` `resolve()` on the happy-path instance matches. */
  readonly knownRef: InstrumentRef;
  /** The symbol `fetchLatest`/`fetchDailyHistory` on the happy-path instance succeed for. */
  readonly knownSymbol: ProviderSymbol;
  /** A symbol the happy-path instance is guaranteed not to recognise. */
  readonly unknownSymbol: ProviderSymbol;
  /** `[historyFrom, historyTo]` must cover at least two of the happy-path instance's published dates for `knownSymbol`, so the ascending/no-duplicate check is non-trivial. */
  readonly historyFrom: IsoDate;
  readonly historyTo: IsoDate;
  /** Only required when the happy-path instance's `capabilities().supportsCorporateActions` is `true`. */
  readonly corporateActionsFrom?: IsoDate;
  readonly corporateActionsTo?: IsoDate;
  makeHappyPath(): QuoteProvider;
  /** Any call against this instance rejects with `ProviderRateLimited`. */
  makeRateLimited(): QuoteProvider;
  /** Any call against this instance rejects with `ProviderUnavailable`, simulating a transient network failure. */
  makeTransientNetworkFailure(): QuoteProvider;
  /** Any call against this instance rejects with `ProviderUnavailable`, simulating a full provider outage. */
  makeOutage(): QuoteProvider;
  /** Any call against this instance rejects with `ProviderMalformedResponse`. */
  makeMalformedResponse(): QuoteProvider;
}

/**
 * The reusable `QuoteProvider` conformance suite (T-16).
 * Covers every method of the port — `capabilities`, `resolve`, `fetchLatest`,
 * `fetchDailyHistory`, and (when declared supported) `fetchCorporateActions`
 * — plus the closed error taxonomy an adapter is expected to raise.
 */
export function quoteProviderContractCases(
  fixtures: QuoteProviderContractFixtures,
): ContractCase[] {
  const cases: ContractCase[] = [
    {
      name: `${fixtures.label}: capabilities() declares a non-empty key and at least one asset kind`,
      run: async () => {
        const capabilities = fixtures.makeHappyPath().capabilities();
        assertNonEmptyString(capabilities.key, "capabilities().key");
        strictAssert.ok(
          capabilities.assetKinds.length > 0,
          "capabilities().assetKinds must be non-empty",
        );
      },
    },
    {
      name: `${fixtures.label}: resolve() finds the known instrument with currency and matchQuality populated`,
      run: async () => {
        const matches = await fixtures.makeHappyPath().resolve(fixtures.knownRef);
        strictAssert.ok(
          matches.length > 0,
          "resolve() must return at least one match for a known instrument",
        );
        for (const match of matches) {
          assertNonEmptyString(match.providerSymbol, "ProviderSymbolMatch.providerSymbol");
          assertNonEmptyString(match.currency, "ProviderSymbolMatch.currency");
          strictAssert.ok(
            match.matchQuality === "EXACT" || match.matchQuality === "PROBABLE",
            `ProviderSymbolMatch.matchQuality must be EXACT or PROBABLE, got ${String(match.matchQuality)}`,
          );
        }
      },
    },
    {
      name: `${fixtures.label}: resolve() candidates only ever carry a non-empty string for tickerSymbol/providerExchangeCode when present (additive DD9 fields)`,
      run: async () => {
        const matches = await fixtures.makeHappyPath().resolve(fixtures.knownRef);
        for (const match of matches) {
          if (match.tickerSymbol !== undefined) {
            assertNonEmptyString(match.tickerSymbol, "ProviderSymbolMatch.tickerSymbol");
          }
          if (match.providerExchangeCode !== undefined) {
            assertNonEmptyString(
              match.providerExchangeCode,
              "ProviderSymbolMatch.providerExchangeCode",
            );
          }
        }
      },
    },
    {
      name: `${fixtures.label}: resolve() candidates carry the provider's own classification labels verbatim, never a mapped code (additive DD21 fields)`,
      run: async () => {
        const matches = await fixtures.makeHappyPath().resolve(fixtures.knownRef);
        for (const match of matches) {
          if (match.providerIndustryLabel !== undefined) {
            assertNonEmptyString(
              match.providerIndustryLabel,
              "ProviderSymbolMatch.providerIndustryLabel",
            );
          }
          if (match.providerSectorLabel === undefined) continue;
          assertNonEmptyString(
            match.providerSectorLabel,
            "ProviderSymbolMatch.providerSectorLabel",
          );
          // DD20/DD21: the *label* crosses this port, never a code. A
          // Kerdial sector code is exactly ASCII uppercase snake
          // (`SECTOR_CODES`, `core/reference-data/src/sector.ts` — which this
          // framework-free package deliberately does not import, so the
          // check is on shape, not membership), so a label arriving in that
          // shape means an adapter mapped the vocabulary itself, which is
          // the one thing this field exists to prevent. If a real provider
          // taxonomy is ever genuinely all-caps, loosening this case is the
          // deliberate decision that has to be taken — not a silent pass.
          strictAssert.ok(
            !/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(match.providerSectorLabel),
            `ProviderSymbolMatch.providerSectorLabel must be the provider's own label, not a mapped Kerdial sector code; got "${match.providerSectorLabel}"`,
          );
        }
      },
    },
    {
      name: `${fixtures.label}: fetchLatest() returns a Decimal price with sourceKey/quality populated and asOf not in the future`,
      run: async () => {
        const [observation] = await fixtures.makeHappyPath().fetchLatest([fixtures.knownSymbol]);
        strictAssert.ok(
          observation !== undefined,
          "fetchLatest() must return one observation per requested symbol",
        );
        assertDecimal(observation!.price, "QuoteObservation.price");
        assertNonEmptyString(observation!.sourceKey, "QuoteObservation.sourceKey");
        assertQuoteQuality(observation!.quality, "QuoteObservation.quality");
        assertNotInFuture(observation!.asOf, "QuoteObservation.asOf");
      },
    },
    {
      name: `${fixtures.label}: fetchDailyHistory() returns Decimal closes, date-ascending with no duplicates, sourceKey/quality populated`,
      run: async () => {
        const history = await fixtures
          .makeHappyPath()
          .fetchDailyHistory(fixtures.knownSymbol, fixtures.historyFrom, fixtures.historyTo);
        strictAssert.ok(
          history.length > 0,
          "fetchDailyHistory() must return at least one observation",
        );
        assertDateAscendingNoDuplicates(
          history.map((observation) => observation.priceDate),
          "fetchDailyHistory() PriceObservation.priceDate series",
        );
        for (const observation of history) {
          assertDecimal(observation.close, "PriceObservation.close");
          assertNonEmptyString(observation.sourceKey, "PriceObservation.sourceKey");
          assertQuoteQuality(observation.quality, "PriceObservation.quality");
        }
      },
    },
    {
      name: `${fixtures.label}: an unknown symbol yields SymbolNotFound from fetchLatest(), never an empty array`,
      run: async () => {
        await assertRejectsWith(
          fixtures.makeHappyPath().fetchLatest([fixtures.unknownSymbol]),
          SymbolNotFound,
          "fetchLatest() with an unknown symbol",
        );
      },
    },
    {
      name: `${fixtures.label}: an unknown symbol yields SymbolNotFound from fetchDailyHistory(), never an empty array`,
      run: async () => {
        await assertRejectsWith(
          fixtures
            .makeHappyPath()
            .fetchDailyHistory(fixtures.unknownSymbol, fixtures.historyFrom, fixtures.historyTo),
          SymbolNotFound,
          "fetchDailyHistory() with an unknown symbol",
        );
      },
    },
    {
      name: `${fixtures.label}: a rate-limited upstream condition maps to ProviderRateLimited`,
      run: async () => {
        await assertRejectsWith(
          fixtures.makeRateLimited().fetchLatest([fixtures.knownSymbol]),
          ProviderRateLimited,
          "fetchLatest() under a rate-limited condition",
        );
      },
    },
    {
      name: `${fixtures.label}: a transient network failure maps to ProviderUnavailable`,
      run: async () => {
        await assertRejectsWith(
          fixtures.makeTransientNetworkFailure().fetchLatest([fixtures.knownSymbol]),
          ProviderUnavailable,
          "fetchLatest() under a transient network failure",
        );
      },
    },
    {
      name: `${fixtures.label}: a full outage maps to ProviderUnavailable`,
      run: async () => {
        await assertRejectsWith(
          fixtures.makeOutage().fetchLatest([fixtures.knownSymbol]),
          ProviderUnavailable,
          "fetchLatest() under a full outage",
        );
      },
    },
    {
      name: `${fixtures.label}: a malformed upstream response maps to ProviderMalformedResponse`,
      run: async () => {
        await assertRejectsWith(
          fixtures
            .makeMalformedResponse()
            .fetchDailyHistory(fixtures.knownSymbol, fixtures.historyFrom, fixtures.historyTo),
          ProviderMalformedResponse,
          "fetchDailyHistory() against a malformed upstream response",
        );
      },
    },
  ];

  const happyPathCapabilities = fixtures.makeHappyPath().capabilities();
  if (happyPathCapabilities.supportsCorporateActions) {
    strictAssert.ok(
      fixtures.corporateActionsFrom !== undefined && fixtures.corporateActionsTo !== undefined,
      `${fixtures.label}: capabilities().supportsCorporateActions is true, so corporateActionsFrom/corporateActionsTo fixtures are required`,
    );
    cases.push({
      name: `${fixtures.label}: fetchCorporateActions() returns Decimal ratios, ex-date-ascending with no duplicates, sourceKey populated`,
      run: async () => {
        const provider = fixtures.makeHappyPath();
        strictAssert.ok(
          typeof provider.fetchCorporateActions === "function",
          "capabilities().supportsCorporateActions is true but fetchCorporateActions is not implemented",
        );
        const actions = await provider.fetchCorporateActions!(
          fixtures.knownSymbol,
          fixtures.corporateActionsFrom!,
          fixtures.corporateActionsTo!,
        );
        assertDateAscendingNoDuplicates(
          actions.map((action) => action.exDate),
          "fetchCorporateActions() CorporateActionObservation.exDate series",
        );
        for (const action of actions) {
          assertDecimal(action.ratioNum, "CorporateActionObservation.ratioNum");
          assertDecimal(action.ratioDen, "CorporateActionObservation.ratioDen");
          assertNonEmptyString(action.sourceKey, "CorporateActionObservation.sourceKey");
        }
      },
    });
  }

  return cases;
}

/**
 * What an `FxRateProvider` adapter under test must supply — the same shape
 * of scenario factories as {@link QuoteProviderContractFixtures}, applied to
 * currency pairs instead of symbols (T-15's `ecb` is the first real adapter
 * this runs against, per T-16).
 */
export interface FxRateProviderContractFixtures {
  readonly label: string;
  /** A pair the happy-path instance publishes rates for. */
  readonly knownPair: CurrencyPair;
  /** A pair the happy-path instance is guaranteed not to recognise. */
  readonly unknownPair: CurrencyPair;
  /** `[historyFrom, historyTo]` must cover at least two of the happy-path instance's published dates for `knownPair`. */
  readonly historyFrom: IsoDate;
  readonly historyTo: IsoDate;
  makeHappyPath(): FxRateProvider;
  makeRateLimited(): FxRateProvider;
  makeTransientNetworkFailure(): FxRateProvider;
  makeOutage(): FxRateProvider;
  makeMalformedResponse(): FxRateProvider;
}

/** The reusable `FxRateProvider` conformance suite (T-16) — covers `capabilities`, `fetchDailyRates`, `fetchLatestRates`, and the closed error taxonomy. */
export function fxRateProviderContractCases(
  fixtures: FxRateProviderContractFixtures,
): ContractCase[] {
  return [
    {
      name: `${fixtures.label}: capabilities() declares a base currency and at least one published pair`,
      run: async () => {
        const capabilities = fixtures.makeHappyPath().capabilities();
        assertNonEmptyString(capabilities.baseCurrency, "capabilities().baseCurrency");
        strictAssert.ok(
          capabilities.publishedPairs.length > 0,
          "capabilities().publishedPairs must be non-empty",
        );
      },
    },
    {
      name: `${fixtures.label}: fetchDailyRates() returns Decimal rates, date-ascending with no duplicates for the known pair, sourceKey populated, rateDate not in the future`,
      run: async () => {
        const observations = await fixtures
          .makeHappyPath()
          .fetchDailyRates([fixtures.knownPair], fixtures.historyFrom, fixtures.historyTo);
        strictAssert.ok(
          observations.length > 0,
          "fetchDailyRates() must return at least one observation",
        );
        assertDateAscendingNoDuplicates(
          observations.map((observation) => observation.rateDate),
          "fetchDailyRates() FxObservation.rateDate series",
        );
        for (const observation of observations) {
          assertDecimal(observation.rate, "FxObservation.rate");
          assertNonEmptyString(observation.sourceKey, "FxObservation.sourceKey");
          assertNotInFuture(observation.rateDate, "FxObservation.rateDate");
        }
      },
    },
    {
      name: `${fixtures.label}: fetchLatestRates() returns a Decimal rate with sourceKey populated and rateDate not in the future`,
      run: async () => {
        const [observation] = await fixtures.makeHappyPath().fetchLatestRates([fixtures.knownPair]);
        strictAssert.ok(
          observation !== undefined,
          "fetchLatestRates() must return one observation per requested pair",
        );
        assertDecimal(observation!.rate, "FxObservation.rate");
        assertNonEmptyString(observation!.sourceKey, "FxObservation.sourceKey");
        assertNotInFuture(observation!.rateDate, "FxObservation.rateDate");
      },
    },
    {
      name: `${fixtures.label}: an unknown pair yields SymbolNotFound from fetchDailyRates(), never an empty array`,
      run: async () => {
        await assertRejectsWith(
          fixtures
            .makeHappyPath()
            .fetchDailyRates([fixtures.unknownPair], fixtures.historyFrom, fixtures.historyTo),
          SymbolNotFound,
          "fetchDailyRates() with an unknown pair",
        );
      },
    },
    {
      name: `${fixtures.label}: an unknown pair yields SymbolNotFound from fetchLatestRates(), never an empty array`,
      run: async () => {
        await assertRejectsWith(
          fixtures.makeHappyPath().fetchLatestRates([fixtures.unknownPair]),
          SymbolNotFound,
          "fetchLatestRates() with an unknown pair",
        );
      },
    },
    {
      name: `${fixtures.label}: a rate-limited upstream condition maps to ProviderRateLimited`,
      run: async () => {
        await assertRejectsWith(
          fixtures.makeRateLimited().fetchLatestRates([fixtures.knownPair]),
          ProviderRateLimited,
          "fetchLatestRates() under a rate-limited condition",
        );
      },
    },
    {
      name: `${fixtures.label}: a transient network failure maps to ProviderUnavailable`,
      run: async () => {
        await assertRejectsWith(
          fixtures.makeTransientNetworkFailure().fetchLatestRates([fixtures.knownPair]),
          ProviderUnavailable,
          "fetchLatestRates() under a transient network failure",
        );
      },
    },
    {
      name: `${fixtures.label}: a full outage maps to ProviderUnavailable`,
      run: async () => {
        await assertRejectsWith(
          fixtures.makeOutage().fetchLatestRates([fixtures.knownPair]),
          ProviderUnavailable,
          "fetchLatestRates() under a full outage",
        );
      },
    },
    {
      name: `${fixtures.label}: a malformed upstream response maps to ProviderMalformedResponse`,
      run: async () => {
        await assertRejectsWith(
          fixtures
            .makeMalformedResponse()
            .fetchDailyRates([fixtures.knownPair], fixtures.historyFrom, fixtures.historyTo),
          ProviderMalformedResponse,
          "fetchDailyRates() against a malformed upstream response",
        );
      },
    },
  ];
}
