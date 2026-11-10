import { Writable } from "node:stream";
import {
  FakeClock,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { INDUSTRY_LABEL_MAX_LENGTH } from "@kerdial/api-contracts";
import { PROVIDER_SECTOR_TO_CODE } from "@kerdial/core-reference-data";
import { ProviderMappingAlreadyExistsError, createInstrumentByIsin } from "@kerdial/ledger";
import {
  YAHOO_PROVIDER_KEY,
  YahooQuoteProvider,
  type YahooChartRange,
  type YahooSourceFetcher,
} from "@kerdial/market-adapters";
import {
  CircuitBreaker,
  createDbFetchLogger,
  type RateLimitConfig,
} from "@kerdial/market-ingestion";
import type { ProviderSymbol, ProviderSymbolMatch, QuoteProvider } from "@kerdial/market-ports";
import {
  createDb,
  instrument,
  instrumentBackfillState,
  instrumentPriceDaily,
  instrumentProviderMap,
  type Db,
} from "@kerdial/platform-db";
import { createLogger, setRootLoggerForTest } from "@kerdial/platform-logging";
import { and, count, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscovery } from "./discovery.js";
import { handleGapRepairJob } from "./gap-repair-handler.js";
import { handleOneInstrumentBackfill } from "./history-backfill-handler.js";
import { createDiscoveryProvider, createWorkerProvider } from "./provider-lanes.js";
import { PROVIDER_SECTOR_LABEL_LOG_MAX_LENGTH, resolveProviderSymbol } from "./provider-symbol.js";

/**
 * IR-9 (DD24/DD25/DD26; FR-3–FR-7, AC-3, AC-4, AC-5, AC-10) — the
 * **single classification capture site**, against a real Postgres, through
 * the real `app_ingest` role.
 *
 * Every classification write below runs on {@link appIngestDb}, never on the
 * Testcontainers superuser: connecting as a superuser is what hid the `0029`
 * grant gap for a whole feature cycle. Migration `0036` grants this role
 * exactly `sector_code`, `industry_label` and `updated_at`, and the negative
 * half of that grant (`domicile_country`) is asserted here **from the
 * writer's side**, not only from the migration's.
 *
 * Everything is fixture-driven: {@link ConfigurableYahooFetcher} replaces the
 * network boundary (`YahooSourceFetcher`) entirely, so no live call is ever
 * made (NFR-7) while every layer above it — the guarded provider lanes,
 * `YahooQuoteProvider`, `resolveProviderSymbol`, `runInstrumentBackfillJob` —
 * is the real production code path.
 *
 * `applyProviderClassification` is **wrapped, not replaced**, so its calls can
 * be counted while still hitting the real database: FR-7's "a non-SHARE
 * instrument writes nothing" is asserted by zero calls *and* by row state, and
 * the failure isolation by making that same wrapper throw.
 */

const classification = vi.hoisted(() => ({
  calls: [] as { readonly instrumentId: string; readonly params: unknown }[],
  /** `"throw"` fails the write without touching the DB — the failure-isolation case. */
  behaviour: "delegate" as "delegate" | "throw",
}));

vi.mock("@kerdial/ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kerdial/ledger")>();
  return {
    ...actual,
    applyProviderClassification: async (
      db: Parameters<typeof actual.applyProviderClassification>[0],
      instrumentId: string,
      params: Parameters<typeof actual.applyProviderClassification>[2],
    ): Promise<void> => {
      classification.calls.push({ instrumentId, params });
      if (classification.behaviour === "throw") {
        throw new Error("simulated classification write failure");
      }
      await actual.applyProviderClassification(db, instrumentId, params);
    },
  };
});

/**
 * The provider's own label for a given Kerdial code, **read out of
 * `PROVIDER_SECTOR_TO_CODE` at run time rather than spelled out here**. FR-2
 * allows the provider vocabulary to appear as text in exactly one file
 * (`core/reference-data/src/sector.ts`) plus `market/adapters`, where captured
 * payloads live — and `classification-vocabulary-containment.test.ts` enforces
 * that repo-wide, this file included. The literal strings themselves are
 * pinned where they are legal: the recorded fixture
 * `market/adapters/__fixtures__/yahoo/search-materials-mtas.json` and
 * `parse-search`/`provider`'s own suites.
 */
function providerLabelFor(code: string): string {
  const entry = Object.entries(PROVIDER_SECTOR_TO_CODE).find(([, mapped]) => mapped === code);
  if (entry === undefined) throw new Error(`no provider label maps to ${code}`);
  return entry[0];
}

/** The provider label that maps to MATERIAUX — the materials-sector case AC-3 names. */
const MATERIALS_LABEL = providerLabelFor("MATERIAUX");
/** A second, *different* mapped label, for DD25's "a later resolve disagrees" case. */
const OTHER_MAPPED_LABEL = providerLabelFor("ENERGIE");

/** The pinned clock — nothing here depends on the calendar. */
const TODAY = "2026-09-01";
/** Deliberately narrow (one year-chunk): this suite counts rows and log records, never calls — that is IR-1's suite. */
const BACKFILL_REQUESTED_FROM = "2026-01-01";

/**
 * One real ISIN and one distinct provider symbol per case, so no test depends
 * on another's rows. Distinct symbols matter: `instrument_provider_map` has a
 * `UNIQUE (provider_key, provider_symbol)` index, so two instruments cannot
 * share a mapped symbol — which is exactly what the
 * {@link ProviderMappingAlreadyExistsError} case below provokes deliberately.
 */
const CASES = {
  materials: { isin: "US0378331005", symbol: "MT.AS" },
  unmapped: { isin: "FR0000120073", symbol: "AI.PA" },
  bare: { isin: "NL0000235190", symbol: "AIR.PA" },
  userSet: { isin: "FR0000121014", symbol: "MC.PA" },
  nullSector: { isin: "DE0007164600", symbol: "SAP.DE" },
  etf: { isin: "IE00B4L5Y983", symbol: "IWDA.AS" },
  isolation: { isin: "FR0000120271", symbol: "TTE.PA" },
  domicile: { isin: "FR0000131104", symbol: "BNP.PA" },
  mappingConflict: { isin: "FR0000121972", symbol: "SU.PA" },
  mappingConflictOther: { isin: "DE0005557508", symbol: "DTE.DE" },
  discovery: { isin: "ES0113900J37", symbol: "SAN.MC" },
  overLongIndustry: { isin: "FR0000120628", symbol: "CS.PA" },
  atBoundIndustry: { isin: "DE0007236101", symbol: "SIE.DE" },
  // Synthetic ISINs (the `TEST` NSIN keeps the ISO 6166 check digit valid and
  // can never be a real identifier) and invented symbols — these three cases
  // are about a *label shape*, not about any real listing, so they need no
  // relationship to one.
  blankIndustry: { isin: "USTEST000016", symbol: "BLNK.AS" },
  whitespaceIndustry: { isin: "USTEST000024", symbol: "WSPC.AS" },
  paddedIndustry: { isin: "USTEST000032", symbol: "PADD.AS" },
  overLongSector: { isin: "USTEST000040", symbol: "OLSL.AS" },
  // The deployment-fault pair: the write is refused by the deployment (a revoked grant) and
  // by a transient fault. Neither is about a real listing either.
  grantRevoked: { isin: "USTEST000057", symbol: "GRNT.AS" },
  transientFailure: { isin: "USTEST000065", symbol: "TRNS.AS" },
  // The gap-repair lane, the *second* caller of
  // `resolveProviderSymbol` and the reason SH-12 extracted it. One SHARE case
  // and one ETF case, because the `kind === "SHARE"` gate has to be asserted
  // on this path too rather than inherited by argument.
  gapRepairShare: { isin: "USTEST000073", symbol: "GAPS.AS" },
  gapRepairEtf: { isin: "USTEST000081", symbol: "GAPE.AS" },
  // A third row for the isolation case: instruments persist across cases in
  // this suite (`createInstrumentByIsin` refuses a duplicate ISIN on the same
  // exchange), so reusing `gapRepairShare` fails on setup rather than on the
  // property under test.
  gapRepairIsolation: { isin: "USTEST000099", symbol: "GAPI.AS" },
} as const;

type CaseKey = keyof typeof CASES;

/**
 * A `v1/finance/search` body in the shape `search-realshape.json` was captured
 * in (`market/adapters/__fixtures__/yahoo/`) — the shape this adapter's parser
 * is written against. `null` for either label omits the key entirely, which is
 * that same capture's own "unclassified `EQUITY` hit" shape (`AAPLC.BA`).
 */
function searchBody(
  symbol: string,
  sector: string | null,
  industry: string | null,
  /** `YAHOO_QUOTE_TYPES_BY_KIND` filters a candidate by this before enrichment — `"ETF"` for the FR-7 non-SHARE case, `"EQUITY"` otherwise. */
  quoteType: "EQUITY" | "ETF" = "EQUITY",
): string {
  return JSON.stringify({
    explains: [],
    count: 1,
    quotes: [
      {
        exchange: "AMS",
        shortname: "Test Issuer",
        quoteType,
        symbol,
        longname: "Test Issuer S.A.",
        exchDisp: "Amsterdam",
        ...(sector !== null ? { sector, sectorDisp: sector } : {}),
        ...(industry !== null ? { industry, industryDisp: industry } : {}),
      },
    ],
    news: [],
  });
}

const CHART_META = {
  currency: "EUR",
  priceHint: 2,
  regularMarketPrice: 27.45,
  regularMarketTime: 1_767_225_600,
};

function chartLatestBody(symbol: string): string {
  return JSON.stringify({
    chart: { result: [{ meta: { ...CHART_META, symbol } }], error: null },
  });
}

/** Two bars inside {@link BACKFILL_REQUESTED_FROM}'s year, so a backfill genuinely writes `instrument_price_daily` rows. */
function chartHistoryBody(symbol: string): string {
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: { ...CHART_META, symbol },
          timestamp: [1_767_225_600, 1_767_312_000],
          indicators: { quote: [{ close: [27.45, 27.9] }] },
        },
      ],
      error: null,
    },
  });
}

class ConfigurableYahooFetcher implements YahooSourceFetcher {
  search = "";

  async fetchSearch(_query: string): Promise<string> {
    return this.search;
  }

  async fetchChart(symbol: ProviderSymbol, range: YahooChartRange): Promise<string> {
    return range.kind === "history" ? chartHistoryBody(symbol) : chartLatestBody(symbol);
  }
}

/** Generous enough that no call ever blocks on a token against a deliberately non-advancing {@link FakeClock}. */
const UNCONSTRAINED_RATE_LIMITS: Readonly<Record<string, RateLimitConfig>> = {
  [YAHOO_PROVIDER_KEY]: { capacity: 64, refillPerSecond: 64 },
};

describe("the classification capture site (IR-9, Testcontainers, real app_ingest role)", () => {
  let pg: MigratedPostgres;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  const clock = new FakeClock(new Date(`${TODAY}T00:00:00.000Z`));
  const fetcher = new ConfigurableYahooFetcher();

  /** Points the process logger at a stream this suite holds — pino writes to fd 1 via `sonic-boom`, which no `process.stdout.write` spy can see (`ops-indicator-sweep.integration.test.ts`'s idiom). */
  let logLines: () => Record<string, unknown>[];
  let restoreLogger: () => void;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    appIngestSql = postgres(pg.appIngestUri, { max: 1 });
    appIngestDb = createDb(appIngestSql);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  beforeEach(() => {
    classification.calls.length = 0;
    classification.behaviour = "delegate";

    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        chunks.push(chunk.toString("utf8"));
        callback();
      },
    });
    restoreLogger = setRootLoggerForTest(createLogger({ destination, level: "debug" }));
    logLines = () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
  });

  afterEach(() => {
    restoreLogger();
  });

  /**
   * Creates the case's instrument as the real `app_web` role — the way
   * `POST /instruments` does, never as the superuser — and arms the fetcher
   * with the provider labels this case is about.
   */
  async function setUpCase(
    caseKey: CaseKey,
    kind: "SHARE" | "ETF",
    labels: { sector: string | null; industry: string | null },
  ): Promise<string> {
    const { isin, symbol } = CASES[caseKey];
    fetcher.search = searchBody(
      symbol,
      labels.sector,
      labels.industry,
      kind === "ETF" ? "ETF" : "EQUITY",
    );
    const row = await createInstrumentByIsin(appWebDb, {
      kind,
      isin,
      exchangeMic: "XAMS",
      listingCurrency: "EUR",
      displayName: "Test Issuer",
      symbol,
    });
    return row.id;
  }

  async function instrumentRow(id: string) {
    const [row] = await appIngestDb.select().from(instrument).where(eq(instrument.id, id));
    return row;
  }

  function workerProvider() {
    return createWorkerProvider({
      inner: new YahooQuoteProvider(fetcher),
      providerKey: YAHOO_PROVIDER_KEY,
      clock,
      breaker: new CircuitBreaker(clock),
      rateLimits: UNCONSTRAINED_RATE_LIMITS,
      logFetch: createDbFetchLogger(appIngestDb),
    });
  }

  /** The production function both worker lanes converge on, driven directly, as `app_ingest`. */
  async function resolveAs(
    id: string,
    caseKey: CaseKey,
    kind: "SHARE" | "ETF",
  ): Promise<string | null> {
    return resolveProviderSymbol(appIngestDb, workerProvider(), YAHOO_PROVIDER_KEY, {
      id,
      kind,
      isin: null,
      symbol: CASES[caseKey].symbol,
      exchangeMic: "XAMS",
      listingCurrency: "EUR",
    });
  }

  /** Records naming the unmapped provider string (FR-3's structured log), whatever else was logged. */
  function unmappedSectorLogLines(): Record<string, unknown>[] {
    return logLines().filter((line) => line["provider_sector_label"] !== undefined);
  }

  /** Records naming the length of a dropped over-long industry label — the bound's own structured log. */
  function overLongIndustryLogLines(): Record<string, unknown>[] {
    return logLines().filter((line) => line["provider_industry_label_length"] !== undefined);
  }

  /** The Postgres `SQLSTATE` a rejected query carried, unwrapped from drizzle's own wrapper, or `"resolved"` when it did not reject at all. */
  async function rejectionSqlState(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
      return "resolved";
    } catch (err) {
      let current: unknown = err;
      while (current instanceof Error) {
        const code = (current as { code?: unknown }).code;
        if (typeof code === "string") return code;
        current = current.cause;
      }
      return "no-sqlstate";
    }
  }

  it("AC-3: a mapped provider sector lands on the row as the Kerdial code, with the industry label verbatim", async () => {
    const id = await setUpCase("materials", "SHARE", {
      sector: MATERIALS_LABEL,
      industry: "Steel",
    });

    await expect(resolveAs(id, "materials", "SHARE")).resolves.toBe(CASES.materials.symbol);

    const row = await instrumentRow(id);
    // MATERIAUX is the code whose French label is « Matériaux »
    // (`SECTOR_LABELS`, `core/reference-data/src/sector.ts`).
    expect(row?.sectorCode).toBe("MATERIAUX");
    expect(row?.industryLabel).toBe("Steel");
    // AC-10's structural half, from the writer's side: the provider lane
    // never invents a domicile (DD24 — and could not if it tried; see below).
    expect(row?.domicileCountry).toBeNull();
    expect(unmappedSectorLogLines()).toHaveLength(0);
  });

  it("AC-4: an unmapped provider sector leaves sector_code NULL, appears in no column, and is logged exactly once", async () => {
    const raw = "Widget Conglomerates";
    const id = await setUpCase("unmapped", "SHARE", {
      sector: raw,
      industry: "Novelty Widgets",
    });

    await expect(resolveAs(id, "unmapped", "SHARE")).resolves.toBe(CASES.unmapped.symbol);

    const row = await instrumentRow(id);
    expect(row?.sectorCode).toBeNull();
    // Per column, not just `sector_code` (AC-4's own wording): the raw
    // provider string is nowhere in the persisted row at all.
    for (const [column, value] of Object.entries(row!)) {
      expect(
        typeof value === "string" && value.includes(raw),
        `instrument.${column} must not carry the raw provider sector string`,
      ).toBe(false);
    }
    // The *industry* label is still written: FR-6's opaque label does not
    // depend on the sector mapping having succeeded.
    expect(row?.industryLabel).toBe("Novelty Widgets");

    // **Exactly one** record, counted — not merely "at least one".
    const logged = unmappedSectorLogLines();
    expect(logged).toHaveLength(1);
    expect(logged[0]?.["provider_sector_label"]).toBe(raw);
    expect(logged[0]?.["instrument_id"]).toBe(id);
    expect(logged[0]?.["level"]).toBe("warn");
  });

  it("an unmapped provider sector label over the log bound is truncated, not logged raw or dropped", async () => {
    const raw = `${"z".repeat(PROVIDER_SECTOR_LABEL_LOG_MAX_LENGTH)}-overflow`;
    const id = await setUpCase("overLongSector", "SHARE", {
      sector: raw,
      industry: "Novelty Widgets",
    });

    await expect(resolveAs(id, "overLongSector", "SHARE")).resolves.toBe(
      CASES.overLongSector.symbol,
    );

    const logged = unmappedSectorLogLines();
    expect(logged).toHaveLength(1);
    expect(logged[0]?.["provider_sector_label"]).toBe(
      raw.slice(0, PROVIDER_SECTOR_LABEL_LOG_MAX_LENGTH),
    );
    expect((logged[0]?.["provider_sector_label"] as string).length).toBe(
      PROVIDER_SECTOR_LABEL_LOG_MAX_LENGTH,
    );
  });

  it("AC-5, persistence half: an EQUITY hit carrying neither sector nor industry leaves both columns NULL", async () => {
    const id = await setUpCase("bare", "SHARE", { sector: null, industry: null });

    await expect(resolveAs(id, "bare", "SHARE")).resolves.toBe(CASES.bare.symbol);

    const row = await instrumentRow(id);
    expect(row?.sectorCode).toBeNull();
    expect(row?.industryLabel).toBeNull();
    // Nothing to log: FR-3's record is for an unmapped *string*, not an
    // absent one.
    expect(unmappedSectorLogLines()).toHaveLength(0);
  });

  /**
   * Migration `0035`'s `instrument_industry_label_length` CHECK bounds
   * `industry_label`, and the write sets both classification columns in **one**
   * UPDATE: an over-long label would therefore fail the whole statement, the
   * isolating `catch` would swallow it, and `sector_code` would be lost with it —
   * the aggregatable field sacrificed for a display-only one. The bound comes
   * from {@link INDUSTRY_LABEL_MAX_LENGTH}, i.e. from `industryLabelSchema`'s
   * own `.max()`, so these two cases also pin that derived number against the
   * database's real CHECK: a drifted value makes one of them fail.
   */
  describe("the stored industry-label bound", () => {
    it("drops an over-long provider industry label, still persists sector_code, and warns exactly once", async () => {
      const overLong = "z".repeat(INDUSTRY_LABEL_MAX_LENGTH + 1);
      const id = await setUpCase("overLongIndustry", "SHARE", {
        sector: MATERIALS_LABEL,
        industry: overLong,
      });

      await expect(resolveAs(id, "overLongIndustry", "SHARE")).resolves.toBe(
        CASES.overLongIndustry.symbol,
      );

      const row = await instrumentRow(id);
      // The valuable half survived…
      expect(row?.sectorCode).toBe("MATERIAUX");
      // …and the label is absent, not truncated to a silently altered string.
      expect(row?.industryLabel).toBeNull();

      // The write really was attempted with `null` — not attempted with the
      // long string and then swallowed by the CHECK.
      const params = classification.calls
        .filter((call) => call.instrumentId === id)
        .map((call) => call.params as { industryLabel: string | null });
      expect(params).toHaveLength(1);
      expect(params[0]?.industryLabel).toBeNull();
      expect(
        logLines().filter(
          (line) =>
            typeof line["msg"] === "string" &&
            line["msg"].includes("best-effort classification write failed"),
        ),
      ).toHaveLength(0);

      // **Exactly one** record, counted, carrying the length and not the label.
      const logged = overLongIndustryLogLines();
      expect(logged).toHaveLength(1);
      expect(logged[0]?.["provider_industry_label_length"]).toBe(overLong.length);
      expect(logged[0]?.["instrument_id"]).toBe(id);
      expect(logged[0]?.["level"]).toBe("warn");
      for (const [field, value] of Object.entries(logged[0]!)) {
        expect(
          typeof value === "string" && value.includes(overLong),
          `the log record's ${field} must not carry the over-long label itself`,
        ).toBe(false);
      }
    });

    it("stores a label of exactly the bound's length verbatim, with no warning", async () => {
      const atBound = "y".repeat(INDUSTRY_LABEL_MAX_LENGTH);
      const id = await setUpCase("atBoundIndustry", "SHARE", {
        sector: MATERIALS_LABEL,
        industry: atBound,
      });

      await expect(resolveAs(id, "atBoundIndustry", "SHARE")).resolves.toBe(
        CASES.atBoundIndustry.symbol,
      );

      const row = await instrumentRow(id);
      expect(row?.sectorCode).toBe("MATERIAUX");
      expect(row?.industryLabel).toBe(atBound);
      expect(overLongIndustryLogLines()).toHaveLength(0);
    });
  });

  /**
   * Security review (LOW): the write site applies
   * **`industryLabelSchema` itself** — `z.string().trim().min(1).max(120)` —
   * not merely the `INDUSTRY_LABEL_MAX_LENGTH` bound read off it. A
   * length-only check applies `.max()` and silently drops `.trim()` and
   * `.min(1)`, and migration `0035`'s CHECK is `char_length(…) <= 120` only,
   * which tolerates a blank: a provider `"industry": ""` or `"   "` therefore
   * persisted as a **non-NULL blank**, `applyProviderClassification`'s
   * `coalesce(industry_label, $1)` treated that as present *forever* (so DD25's
   * fill-if-absent could never correct it), and every read surface rendered an
   * empty cell. `sector_code` must still land in that case, exactly as it does
   * for the over-long label above — same property, second input class.
   *
   * The label used below is invented, like `"Novelty Widgets"` above: FR-2
   * confines the provider vocabulary to `core/reference-data/src/sector.ts` and
   * `market/adapters`, and an *industry* label is opaque here anyway (never
   * mapped, never a key), so nothing is proven by using a real one.
   */
  describe("the stored industry-label rule, not only its bound", () => {
    const PADDED_LABEL = "Widget Assembly";

    it("persists a blank provider industry label as NULL, with sector_code still written, and warns exactly once", async () => {
      const id = await setUpCase("blankIndustry", "SHARE", {
        sector: MATERIALS_LABEL,
        industry: "",
      });

      await expect(resolveAs(id, "blankIndustry", "SHARE")).resolves.toBe(
        CASES.blankIndustry.symbol,
      );

      const row = await instrumentRow(id);
      // NULL — never a non-NULL blank `coalesce` would then treat as present.
      expect(row?.industryLabel).toBeNull();
      // The aggregatable half is untouched by the label being unusable.
      expect(row?.sectorCode).toBe("MATERIAUX");

      // The write really was attempted with `null`, not attempted with `""`.
      const params = classification.calls
        .filter((call) => call.instrumentId === id)
        .map((call) => call.params as { industryLabel: string | null });
      expect(params).toHaveLength(1);
      expect(params[0]?.industryLabel).toBeNull();

      const logged = overLongIndustryLogLines();
      expect(logged).toHaveLength(1);
      expect(logged[0]?.["provider_industry_label_length"]).toBe(0);
      expect(logged[0]?.["instrument_id"]).toBe(id);
      expect(logged[0]?.["level"]).toBe("warn");
    });

    it("persists a whitespace-only provider industry label as NULL, with sector_code still written", async () => {
      const whitespace = "   ";
      const id = await setUpCase("whitespaceIndustry", "SHARE", {
        sector: MATERIALS_LABEL,
        industry: whitespace,
      });

      await expect(resolveAs(id, "whitespaceIndustry", "SHARE")).resolves.toBe(
        CASES.whitespaceIndustry.symbol,
      );

      const row = await instrumentRow(id);
      expect(row?.industryLabel).toBeNull();
      expect(row?.sectorCode).toBe("MATERIAUX");

      const params = classification.calls
        .filter((call) => call.instrumentId === id)
        .map((call) => call.params as { industryLabel: string | null });
      expect(params).toHaveLength(1);
      expect(params[0]?.industryLabel).toBeNull();

      const logged = overLongIndustryLogLines();
      expect(logged).toHaveLength(1);
      expect(logged[0]?.["provider_industry_label_length"]).toBe(whitespace.length);
    });

    it("trims a padded provider industry label and persists it, with no warning", async () => {
      const id = await setUpCase("paddedIndustry", "SHARE", {
        sector: MATERIALS_LABEL,
        industry: `  ${PADDED_LABEL}\t`,
      });

      await expect(resolveAs(id, "paddedIndustry", "SHARE")).resolves.toBe(
        CASES.paddedIndustry.symbol,
      );

      const row = await instrumentRow(id);
      // Trimmed, exactly as `buildClassificationPatch` already trims the user's
      // own input — one rule for both writers, so a provider-sourced and a
      // user-sourced label cannot differ by surrounding whitespace.
      expect(row?.industryLabel).toBe(PADDED_LABEL);
      expect(row?.sectorCode).toBe("MATERIAUX");
      expect(overLongIndustryLogLines()).toHaveLength(0);
    });
  });

  it("FR-7/NG14: a non-SHARE instrument reaching this site writes nothing, and applyProviderClassification is never called", async () => {
    const id = await setUpCase("etf", "ETF", { sector: MATERIALS_LABEL, industry: "Steel" });

    await expect(resolveAs(id, "etf", "ETF")).resolves.toBe(CASES.etf.symbol);

    // The mapping row is still written — only classification is gated.
    const [mapping] = await appIngestDb
      .select()
      .from(instrumentProviderMap)
      .where(
        and(
          eq(instrumentProviderMap.instrumentId, id),
          eq(instrumentProviderMap.providerKey, YAHOO_PROVIDER_KEY),
        ),
      );
    expect(mapping?.providerSymbol).toBe(CASES.etf.symbol);

    const row = await instrumentRow(id);
    expect(row?.sectorCode).toBeNull();
    expect(row?.industryLabel).toBeNull();
    expect(classification.calls).toHaveLength(0);
  });

  describe("DD25 — fill-if-absent, proven on both sides", () => {
    it("leaves a user-set sector_code untouched under a subsequent resolve carrying a different provider sector", async () => {
      const id = await setUpCase("userSet", "SHARE", {
        sector: MATERIALS_LABEL,
        industry: "Steel",
      });

      // The user's own correction, written the way `PATCH /instruments/:id/
      // classification` will write it — as `app_web`, the role migration
      // `0036` grants this column to.
      await appWebDb
        .update(instrument)
        .set({ sectorCode: "TECHNOLOGIE" })
        .where(eq(instrument.id, id));

      // First resolve — the provider disagrees (its materials label -> MATERIAUX).
      await resolveAs(id, "userSet", "SHARE");
      const afterFirst = await instrumentRow(id);
      expect(afterFirst?.sectorCode).toBe("TECHNOLOGIE");
      // …and the column that *was* NULL got filled, in the same statement:
      // the two columns COALESCE independently.
      expect(afterFirst?.industryLabel).toBe("Steel");

      // A genuinely *subsequent* resolve: `resolveProviderSymbol` returns
      // early while a mapping row exists, so the harness (as the owner, never
      // production code) removes it to force a second one.
      await pg.ownerDb
        .delete(instrumentProviderMap)
        .where(eq(instrumentProviderMap.instrumentId, id));
      fetcher.search = searchBody(CASES.userSet.symbol, OTHER_MAPPED_LABEL, "Steel Rolling");
      await resolveAs(id, "userSet", "SHARE");

      const row = await instrumentRow(id);
      expect(row?.sectorCode).toBe("TECHNOLOGIE");
      // Idempotent for the industry label too — the provider's second,
      // different value does not clobber the stored one.
      expect(row?.industryLabel).toBe("Steel");
      // Both resolves really did attempt the write, so the assertions above
      // are about COALESCE and not about a call that never happened.
      expect(classification.calls.filter((call) => call.instrumentId === id)).toHaveLength(2);
    });

    it("fills a NULL sector_code", async () => {
      const id = await setUpCase("nullSector", "SHARE", {
        sector: MATERIALS_LABEL,
        industry: "Steel",
      });
      expect((await instrumentRow(id))?.sectorCode).toBeNull();

      await resolveAs(id, "nullSector", "SHARE");

      expect((await instrumentRow(id))?.sectorCode).toBe("MATERIAUX");
    });
  });

  it("DD24/AC-10: the lane that just wrote sector_code cannot write domicile_country at all", async () => {
    const id = await setUpCase("domicile", "SHARE", {
      sector: MATERIALS_LABEL,
      industry: "Steel",
    });
    await resolveAs(id, "domicile", "SHARE");
    // The granted write really did land through this exact `Db`/role…
    expect((await instrumentRow(id))?.sectorCode).toBe("MATERIAUX");

    // …and the ungranted one on the same row, through the same `Db`, is
    // refused by Postgres itself (42501), not by application discipline.
    await expect(
      rejectionSqlState(
        appIngestDb.update(instrument).set({ domicileCountry: "LU" }).where(eq(instrument.id, id)),
      ),
    ).resolves.toBe("42501");
    expect((await instrumentRow(id))?.domicileCountry).toBeNull();
  });

  it("failure isolation: a throwing classification write never fails the backfill job — prices are still written, with one warn", async () => {
    const id = await setUpCase("isolation", "SHARE", {
      sector: MATERIALS_LABEL,
      industry: "Steel",
    });
    await appWebDb.insert(instrumentBackfillState).values({
      instrumentId: id,
      requestedFrom: BACKFILL_REQUESTED_FROM,
      status: "PENDING",
    });
    classification.behaviour = "throw";

    await handleOneInstrumentBackfill(
      { db: appIngestDb, clock, workerProviders: { [YAHOO_PROVIDER_KEY]: workerProvider() } },
      id,
    );

    // The job completed…
    const [state] = await appIngestDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, id));
    expect(state?.status).toBe("COMPLETE");
    // …and really wrote prices (a swallowed failure over a no-op job would
    // pass a status-only assertion vacuously).
    const [prices] = await appIngestDb
      .select({ total: count() })
      .from(instrumentPriceDaily)
      .where(eq(instrumentPriceDaily.instrumentId, id));
    expect(Number(prices?.total ?? 0)).toBeGreaterThan(0);
    // Nothing was persisted by the failed write itself.
    const row = await instrumentRow(id);
    expect(row?.sectorCode).toBeNull();
    expect(row?.industryLabel).toBeNull();

    const failureLines = logLines().filter(
      (line) =>
        typeof line["msg"] === "string" &&
        line["msg"].includes("best-effort classification write failed"),
    );
    expect(failureLines).toHaveLength(1);
    expect(failureLines[0]?.["level"]).toBe("warn");
    expect(failureLines[0]?.["instrument_id"]).toBe(id);
  });

  /**
   * **The gap-repair lane, exercised for classification.**
   *
   * `gap-repair-handler.ts`'s `handleOneGapRepair` is the **second** caller of
   * `resolveProviderSymbol`, and the reason SH-12 extracted that function in
   * the first place: so the two lanes could not diverge. Every case above
   * drives either the direct call or the `history-backfill-handler` path, so
   * this entry point was outside the suite entirely — flagged by the GATE-2
   * tester of the `instrument-reference-data` cycle rather than assumed safe.
   *
   * The risk was always small (same shared function, same `app_ingest` db from
   * `worker-registrations.ts`) and that is an argument for the risk being low,
   * not for the path being tested. The shape — "second caller of a shared
   * component, covered only through the first" — is a recurring source of
   * surprises here, and the fixtures already existed.
   *
   * Driven through the real **`handleGapRepairJob`** entry point with a
   * per-instrument job body, not through `handleOneGapRepair` directly: the
   * `instrumentId`-present branch is part of what routes a job to this lane,
   * and calling the private function would skip it.
   */
  describe("the gap-repair lane classifies too, on the same shared function", () => {
    /** The per-instrument job shape: `instrumentId` present is what selects this lane. */
    function gapRepairDeps() {
      return {
        db: appIngestDb,
        clock,
        workerProviders: { [YAHOO_PROVIDER_KEY]: workerProvider() },
        // The fan-out shape is the only consumer of `scheduler`; a
        // per-instrument job must never reach it, so a throwing stub is the
        // assertion that it does not.
        scheduler: {
          enqueueGapRepair: () => {
            throw new Error("a per-instrument gap-repair job must not fan out");
          },
        } as unknown as Parameters<typeof handleGapRepairJob>[0]["scheduler"],
      };
    }

    it("a gap-repair job for an unclassified SHARE instrument lands the classification, as the real app_ingest role", async () => {
      const id = await setUpCase("gapRepairShare", "SHARE", {
        sector: MATERIALS_LABEL,
        industry: "Steel",
      });
      // The premise: unclassified before the job. Asserted, so "the
      // classification landed" is a change rather than a pre-existing state.
      expect((await instrumentRow(id))?.sectorCode).toBeNull();
      expect((await instrumentRow(id))?.industryLabel).toBeNull();
      const callsBefore = classification.calls.length;

      await handleGapRepairJob(gapRepairDeps(), [
        { data: { instrumentId: id } } as Parameters<typeof handleGapRepairJob>[1][number],
      ]);

      const row = await instrumentRow(id);
      expect(row?.sectorCode).toBe("MATERIAUX");
      expect(row?.industryLabel).toBe("Steel");
      // And it went through the one capture site, on this lane — not through a
      // second copy of the rule that happens to agree.
      expect(classification.calls.length).toBeGreaterThan(callsBefore);
      expect(classification.calls.at(-1)?.instrumentId).toBe(id);
    });

    it("FR-7's kind gate holds on this lane too: an ETF reaching gap repair writes nothing and never calls the capture site", async () => {
      const id = await setUpCase("gapRepairEtf", "ETF", {
        sector: MATERIALS_LABEL,
        industry: "Steel",
      });
      const callsBefore = classification.calls.length;

      await handleGapRepairJob(gapRepairDeps(), [
        { data: { instrumentId: id } } as Parameters<typeof handleGapRepairJob>[1][number],
      ]);

      // Zero calls **and** row state, the same double assertion FR-7/NG14's
      // own case above makes for the backfill lane: either alone could pass
      // for the wrong reason.
      expect(classification.calls.length).toBe(callsBefore);
      const row = await instrumentRow(id);
      expect(row?.sectorCode).toBeNull();
      expect(row?.industryLabel).toBeNull();
    });

    it("the swallow-and-log isolation holds on this lane: a throwing classification write does not fail the gap-repair job", async () => {
      const id = await setUpCase("gapRepairIsolation", "SHARE", {
        sector: MATERIALS_LABEL,
        industry: "Steel",
      });
      classification.behaviour = "throw";

      // Resolves rather than rejects — the property, on this path, asserted
      // rather than inherited from the shared function's other caller.
      await expect(
        handleGapRepairJob(gapRepairDeps(), [
          { data: { instrumentId: id } } as Parameters<typeof handleGapRepairJob>[1][number],
        ]),
      ).resolves.toBeUndefined();
    });
  });

  it("a revoked grant is logged at error with its sqlstate, not swallowed into the same warn as a transient failure", async () => {
    const id = await setUpCase("grantRevoked", "SHARE", {
      sector: MATERIALS_LABEL,
      industry: "Steel",
    });

    // Watch it fail, against the real role: migration `0036` grants
    // `app_ingest` UPDATE on exactly these columns, and this is the deployment
    // in which that grant was lost (or `0036` never ran). No fake, no injected
    // error — the write below really is refused by Postgres with `42501`.
    await pg.ownerClient`revoke update ("sector_code", "industry_label", "updated_at") on "instrument" from app_ingest`;
    try {
      // The isolation property, unchanged and non-negotiable: the resolve
      // still succeeds and still returns its symbol, because the mapping row —
      // which the backfill job depends on — is written outside the catch.
      await expect(resolveAs(id, "grantRevoked", "SHARE")).resolves.toBe(CASES.grantRevoked.symbol);
    } finally {
      await pg.ownerClient`grant update ("sector_code", "industry_label", "updated_at") on "instrument" to app_ingest`;
    }

    const lines = logLines().filter(
      (line) => typeof line["msg"] === "string" && line["msg"].includes("classification cannot be"),
    );
    expect(lines).toHaveLength(1);
    // The three things that make a mis-deployed grant distinguishable from a
    // catalogue nobody has classified yet. Pre-fix all three were absent: one
    // `warn`, no sqlstate, and a message that said the backfill was unaffected
    // — true, and useless for telling the two states apart.
    expect(lines[0]?.["level"]).toBe("error");
    expect(lines[0]?.["sqlstate"]).toBe("42501");
    expect(lines[0]?.["instrument_id"]).toBe(id);

    // …and it did not *also* emit the transient-failure line. One failure, one
    // record, at the level that says which kind it was.
    const transient = logLines().filter(
      (line) =>
        typeof line["msg"] === "string" &&
        line["msg"].includes("best-effort classification write failed"),
    );
    expect(transient).toHaveLength(0);

    // Nothing landed, which is the permanent consequence the line exists to
    // announce: in this state no instrument is ever classified.
    const row = await instrumentRow(id);
    expect(row?.sectorCode).toBeNull();
    expect(row?.industryLabel).toBeNull();
  });

  it("a transient classification failure keeps its warn — the split does not promote everything to error", async () => {
    const id = await setUpCase("transientFailure", "SHARE", {
      sector: MATERIALS_LABEL,
      industry: "Steel",
    });
    // Not a `PostgresError` at all: a dropped connection, a timeout, anything
    // that will be fine on the next resolve. Without this case the fix could
    // pass its sibling above by simply raising the level of everything, which
    // would make `error` mean nothing on the one line that needs it to mean
    // something.
    classification.behaviour = "throw";

    await expect(resolveAs(id, "transientFailure", "SHARE")).resolves.toBe(
      CASES.transientFailure.symbol,
    );

    const transient = logLines().filter(
      (line) =>
        typeof line["msg"] === "string" &&
        line["msg"].includes("best-effort classification write failed"),
    );
    expect(transient).toHaveLength(1);
    expect(transient[0]?.["level"]).toBe("warn");
    expect(
      logLines().filter(
        (line) =>
          typeof line["msg"] === "string" && line["msg"].includes("classification cannot be"),
      ),
    ).toHaveLength(0);
  });

  it("failure isolation, the other half: a createProviderMapping failure still propagates — the catch covers the classification write only", async () => {
    const id = await setUpCase("mappingConflict", "SHARE", {
      sector: MATERIALS_LABEL,
      industry: "Steel",
    });
    const otherId = await setUpCase("mappingConflictOther", "SHARE", {
      sector: MATERIALS_LABEL,
      industry: "Steel",
    });
    // Occupy `(provider_key, provider_symbol)`'s unique index with the *other*
    // instrument's mapping, so `createProviderMapping` — and nothing else —
    // fails on the resolve below.
    await pg.ownerDb.insert(instrumentProviderMap).values({
      instrumentId: otherId,
      providerKey: YAHOO_PROVIDER_KEY,
      providerSymbol: CASES.mappingConflict.symbol,
      confidence: "HEURISTIC",
    });
    fetcher.search = searchBody(CASES.mappingConflict.symbol, MATERIALS_LABEL, "Steel");

    await expect(resolveAs(id, "mappingConflict", "SHARE")).rejects.toBeInstanceOf(
      ProviderMappingAlreadyExistsError,
    );

    // The classification write is never even attempted: the mapping row is
    // what the job depends on, so its failure must not be swallowed.
    expect(classification.calls.filter((call) => call.instrumentId === id)).toHaveLength(0);
    expect((await instrumentRow(id))?.sectorCode).toBeNull();
  });

  it("the discovery lane logs nothing and writes nothing — it runs per keystroke", async () => {
    const id = await setUpCase("discovery", "SHARE", {
      sector: "Widget Conglomerates",
      industry: "Novelty Widgets",
    });

    const discovery = createDiscovery({
      [YAHOO_PROVIDER_KEY]: createDiscoveryProvider({
        inner: new YahooQuoteProvider(fetcher),
        providerKey: YAHOO_PROVIDER_KEY,
        clock,
        breaker: new CircuitBreaker(clock),
        rateLimits: UNCONSTRAINED_RATE_LIMITS,
      }),
    });
    const candidates = await discovery.search({
      kind: "SHARE",
      query: CASES.discovery.symbol,
    });

    // The candidate really did carry the unmapped label — a discovery call
    // that returned nothing would log nothing either, vacuously.
    expect(candidates[0]?.providerSectorLabel).toBe("Widget Conglomerates");
    expect(unmappedSectorLogLines()).toHaveLength(0);
    expect(classification.calls).toHaveLength(0);
    // …and the interactive lane wrote nothing at all.
    const row = await instrumentRow(id);
    expect(row?.sectorCode).toBeNull();
    expect(row?.industryLabel).toBeNull();
  });

  /*
   * The listing the resolver picks, not merely the issuer it matches.
   *
   * `resolve()` matches an *issuer*: an ISIN-level `EXACT` hit returns whichever
   * line the provider considers primary, which for a cross-listed company is its
   * home venue. Taking the first `EXACT` therefore mapped a Xetra instrument to
   * its Copenhagen line — observed live: `DK0062498333` / `NOV.DE` /
   * `exchange_mic XETR` / `listing_currency EUR` resolved to `NOVO-B.CO`, and
   * 4 993 days of **DKK** prices were stored against an instrument declaring EUR.
   * Valuation then needed a DKK→EUR rate that `fx-daily` would never fetch,
   * because that job shopped from `listing_currency` and saw only EUR.
   *
   * Driven with a stub `QuoteProvider` rather than the real adapter + fetcher:
   * what changed is the *selection* among candidates, so the test states the
   * candidates directly instead of routing them through Yahoo's search parsing.
   */
  describe("resolveProviderSymbol picks the listing that matches the instrument's declared currency", () => {
    function stubProvider(matches: readonly ProviderSymbolMatch[]): QuoteProvider {
      return {
        capabilities: () => {
          throw new Error("capabilities() is not part of the resolution path");
        },
        resolve: () => Promise.resolve([...matches]),
        fetchLatest: () => {
          throw new Error("fetchLatest() is not part of the resolution path");
        },
        fetchDailyHistory: () => {
          throw new Error("fetchDailyHistory() is not part of the resolution path");
        },
      };
    }

    const copenhagen: ProviderSymbolMatch = {
      providerSymbol: "NOVO-B.CO",
      displayName: "Novo Nordisk A/S",
      currency: "DKK",
      exchangeMic: "XCSE",
      matchQuality: "EXACT",
    };
    const xetra: ProviderSymbolMatch = {
      providerSymbol: "NOVC.DE",
      displayName: "Novo Nordisk A/S",
      currency: "EUR",
      exchangeMic: "XETR",
      matchQuality: "EXACT",
    };

    async function resolveWith(
      matches: readonly ProviderSymbolMatch[],
      isin: string,
    ): Promise<{ chosen: string | null; stored: string | undefined }> {
      const row = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin,
        exchangeMic: "XETR",
        listingCurrency: "EUR",
        displayName: "Novo Nordisk A/S",
        symbol: "NOV",
      });
      const chosen = await resolveProviderSymbol(
        appIngestDb,
        stubProvider(matches),
        YAHOO_PROVIDER_KEY,
        {
          id: row.id,
          kind: "SHARE",
          isin,
          symbol: "NOV",
          exchangeMic: "XETR",
          listingCurrency: "EUR",
        },
      );
      const [mapping] = await appIngestDb
        .select()
        .from(instrumentProviderMap)
        .where(eq(instrumentProviderMap.instrumentId, row.id));
      return { chosen, stored: mapping?.providerSymbol };
    }

    it("prefers the EUR line over an equally EXACT home-venue line in another currency", async () => {
      // Copenhagen first in the candidate list, so the old
      // `find(EXACT) ?? candidates[0]` would have taken it.
      const { chosen, stored } = await resolveWith([copenhagen, xetra], "DK0062498330");
      expect(chosen).toBe("NOVC.DE");
      expect(stored).toBe("NOVC.DE");
    });

    it("still maps when nothing quotes in the declared currency, rather than leaving the instrument priceless", async () => {
      // The fallback is deliberate: a mapping in an unexpected currency yields
      // correct figures once the rate exists, whereas no mapping yields no prices
      // at all. `fetchHeldCurrencies` is what stops that case being
      // unrecoverable, by reading the currency prices are stored in.
      const { chosen, stored } = await resolveWith([copenhagen], "DK0062498348");
      expect(chosen).toBe("NOVO-B.CO");
      expect(stored).toBe("NOVO-B.CO");
    });

    it("is unchanged when every candidate already agrees — match quality still decides", async () => {
      // The positive companion: currency preference must not reorder a list that
      // was already correct, or it would be picking on the wrong axis.
      // Distinct provider symbols per case: `instrument_provider_map` is
      // UNIQUE on `(provider_key, provider_symbol)`, so reusing the first
      // case's symbol here raised ProviderMappingAlreadyExistsError rather
      // than testing the ordering.
      const probableEur: ProviderSymbolMatch = {
        ...xetra,
        providerSymbol: "NOVC3P.DE",
        matchQuality: "PROBABLE",
      };
      const exactEur: ProviderSymbolMatch = { ...xetra, providerSymbol: "NOVC3E.DE" };
      const { chosen } = await resolveWith([probableEur, exactEur], "DK0062498355");
      expect(chosen).toBe("NOVC3E.DE");
    });
  });
});
