import { parseDecimalString } from "@kerdial/core-decimal";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import {
  createDb,
  instrument,
  instrumentExposureWeight,
  tenant,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ExposureWeightSetRefusedError,
  ExposureWeightsNotApplicableError,
  listInstrumentExposureWeights,
  replaceInstrumentExposureWeights,
  type InstrumentExposureWeights,
} from "./instrument-exposure-weight-service.js";
import {
  InstrumentNotFoundError,
  createInstrumentByIsin,
  createInstrumentBySymbol,
  createInstrumentScpi,
  deleteInstrument,
  type InstrumentKind,
} from "./instrument-service.js";

/**
 * EW-T9 — the one writer and the one reader of `instrument_exposure_weight`
 * (FR-719, FR-720, FR-722, FR-723, FR-724, FR-747(c), NFR-100) against a real
 * Postgres, every call under test made as the real **`app_web`** role. The
 * superuser (`ownerDb`) only seeds out-of-band rows and reads rows back.
 */

type Item = { code: string; weight: string };

/** The wire form of a stored set, for whole-value assertions. */
function wire(weights: InstrumentExposureWeights): Record<string, Item[]> {
  const out: Record<string, Item[]> = {};
  if (weights.sectorWeights !== undefined) {
    out["sectorWeights"] = weights.sectorWeights.map((w) => ({
      code: w.code,
      weight: w.weight.toFixed(2),
    }));
  }
  if (weights.countryWeights !== undefined) {
    out["countryWeights"] = weights.countryWeights.map((w) => ({
      code: w.code,
      weight: w.weight.toFixed(2),
    }));
  }
  return out;
}

describe("ledger — exposure weights: the one writer and the one reader (EW-T9, real app_web role)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  /** Two more `app_web` connections for the race, pre-warmed before any `Promise.all`. */
  let raceSqlA: postgres.Sql;
  let raceSqlB: postgres.Sql;
  let raceDbA: Db;
  let raceDbB: Db;
  /** A dedicated connection whose statements are counted, so nothing the fixture does is attributed to a measured call. */
  let countedSql: postgres.Sql;
  let countedDb: Db;
  let statements: string[] = [];

  const deleteTenant = "00000000-0000-7000-8000-0000000e9d01";

  let counter = 0;
  async function newInstrument(kind: InstrumentKind): Promise<string> {
    counter += 1;
    const tag = String(counter).padStart(5, "0");
    if (kind === "SCPI") {
      return (
        await createInstrumentScpi(ownerDb, {
          symbol: `EWSCPI${tag}`,
          listingCurrency: "EUR",
          displayName: `EW-T9 SCPI ${tag}`,
        })
      ).id;
    }
    if (kind === "CRYPTO" || kind === "INDEX") {
      return (
        await createInstrumentBySymbol(ownerDb, {
          kind,
          symbol: `EW${kind}${tag}`,
          listingCurrency: "EUR",
          displayName: `EW-T9 ${kind} ${tag}`,
        })
      ).id;
    }
    return (
      await createInstrumentByIsin(ownerDb, {
        kind,
        isin: `ZZEW9${tag}000`.slice(0, 12),
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: `EW-T9 ${kind} ${tag}`,
      })
    ).id;
  }

  async function stored(instrumentId: string): Promise<Record<string, Item[]>> {
    const read = await listInstrumentExposureWeights(ownerDb, [instrumentId]);
    return wire(read.get(instrumentId) ?? {});
  }

  async function rejection(attempt: Promise<unknown>): Promise<unknown> {
    return attempt.then(
      () => undefined,
      (err: unknown) => err,
    );
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    raceSqlA = postgres(pg.appWebUri, { max: 1 });
    raceSqlB = postgres(pg.appWebUri, { max: 1 });
    raceDbA = createDb(raceSqlA);
    raceDbB = createDb(raceSqlB);
    countedSql = postgres(pg.appWebUri, {
      max: 1,
      debug: (_connection, query) => {
        statements.push(query);
      },
    });
    countedDb = createDb(countedSql);
    await ownerDb.insert(tenant).values({ id: deleteTenant });
  }, 120_000);

  afterAll(async () => {
    await Promise.all(
      [appWebSql, raceSqlA, raceSqlB, countedSql].map((client) => client?.end({ timeout: 5 })),
    );
    await pg?.stop();
  }, 30_000);

  it("R-2: two concurrent replaces of one dimension leave exactly one whole set, never the union", async () => {
    // Pre-warmed: a `Promise.all` over lazily-connected postgres.js clients is
    // not concurrent until both connections exist.
    await raceSqlA`SELECT 1`;
    await raceSqlB`SELECT 1`;
    const setA = [
      { code: "US", weight: "30.00" },
      { code: "JP", weight: "30.00" },
    ];
    const setB = [
      { code: "GB", weight: "30.00" },
      { code: "FR", weight: "30.00" },
    ];
    for (let round = 0; round < 10; round += 1) {
      const id = await newInstrument("ETF");
      // A stored row to delete makes the two transactions overlap: the second
      // DELETE waits on the first one's row lock.
      await replaceInstrumentExposureWeights(appWebDb, id, {
        countryWeights: [{ code: "DE", weight: "50.00" }],
      });
      await Promise.all([
        replaceInstrumentExposureWeights(raceDbA, id, { countryWeights: setA }),
        replaceInstrumentExposureWeights(raceDbB, id, { countryWeights: setB }),
      ]);
      // Exactly one of the two sets, whole (stored order: weight desc, code asc).
      // The union — four rows, 120 % — is what a missing row lock produces.
      expect(
        [{ countryWeights: [setA[1], setA[0]] }, { countryWeights: [setB[1], setB[0]] }],
        `round ${round}`,
      ).toContainEqual(await stored(id));
    }
  });

  it("AC-619: an invalid set on either dimension stores neither; naming one dimension leaves the other alone", async () => {
    const id = await newInstrument("ETF");
    await replaceInstrumentExposureWeights(appWebDb, id, {
      sectorWeights: [{ code: "FINANCE", weight: "40.00" }],
      countryWeights: [{ code: "DE", weight: "70.00" }],
    });
    const before = await stored(id);

    const error = await rejection(
      replaceInstrumentExposureWeights(appWebDb, id, {
        sectorWeights: [{ code: "TECHNOLOGIE", weight: "50.00" }],
        countryWeights: [
          { code: "US", weight: "60" },
          { code: "JP", weight: "30" },
          { code: "GB", weight: "15" },
        ],
      }),
    );
    expect(error).toBeInstanceOf(ExposureWeightSetRefusedError);
    expect(error).toMatchObject({ dimension: "country", reason: "TOTAL_ABOVE_100", index: 2 });
    expect(await stored(id)).toEqual(before);

    await replaceInstrumentExposureWeights(appWebDb, id, {
      sectorWeights: [{ code: "SANTE", weight: "25.00" }],
    });
    expect(await stored(id)).toEqual({
      sectorWeights: [{ code: "SANTE", weight: "25.00" }],
      countryWeights: [{ code: "DE", weight: "70.00" }],
    });
  });

  describe("AC-620 at the service: the kind gate, every kind", () => {
    const sector = [{ code: "ENERGIE", weight: "10.00" }];
    const country = [{ code: "FR", weight: "10.00" }];
    const cases: readonly [InstrumentKind, "sector" | "country", boolean][] = [
      ["ETF", "sector", true],
      ["ETF", "country", true],
      ["FUND", "sector", true],
      ["FUND", "country", true],
      ["SCPI", "sector", false],
      ["SCPI", "country", true],
      ["SHARE", "sector", false],
      ["SHARE", "country", false],
      ["CRYPTO", "sector", false],
      ["CRYPTO", "country", false],
      ["INDEX", "sector", false],
      ["INDEX", "country", false],
    ];
    it.each(cases)("%s, %s weights: accepted = %s", async (kind, dimension, accepted) => {
      const id = await newInstrument(kind);
      const params =
        dimension === "sector" ? { sectorWeights: sector } : { countryWeights: country };
      const outcome = await rejection(replaceInstrumentExposureWeights(appWebDb, id, params));
      if (accepted) {
        expect(outcome).toBeUndefined();
        expect(await stored(id)).toEqual(
          dimension === "sector" ? { sectorWeights: sector } : { countryWeights: country },
        );
      } else {
        expect(outcome).toBeInstanceOf(ExposureWeightsNotApplicableError);
        expect(outcome).toMatchObject({ kind, dimension });
        expect(await stored(id)).toEqual({});
      }
    });
  });

  it("FR-722: a second write replaces the whole set; [] clears one dimension and leaves the other", async () => {
    const id = await newInstrument("FUND");
    await replaceInstrumentExposureWeights(appWebDb, id, {
      sectorWeights: [
        { code: "FINANCE", weight: "50.00" },
        { code: "SANTE", weight: "30.00" },
      ],
      countryWeights: [{ code: "FR", weight: "100.00" }],
    });
    const replaced = await replaceInstrumentExposureWeights(appWebDb, id, {
      sectorWeights: [{ code: "ENERGIE", weight: "20.00" }],
    });
    expect(wire(replaced)).toEqual({
      sectorWeights: [{ code: "ENERGIE", weight: "20.00" }],
      countryWeights: [{ code: "FR", weight: "100.00" }],
    });

    const cleared = await replaceInstrumentExposureWeights(appWebDb, id, { sectorWeights: [] });
    expect(wire(cleared)).toEqual({ countryWeights: [{ code: "FR", weight: "100.00" }] });
    expect(await stored(id)).toEqual({ countryWeights: [{ code: "FR", weight: "100.00" }] });
  });

  it("NFR-100: a PROVIDER row is invisible to the reader and untouched by a replace", async () => {
    const id = await newInstrument("ETF");
    await ownerDb.insert(instrumentExposureWeight).values({
      instrumentId: id,
      origin: "PROVIDER",
      countryCode: "US",
      weight: parseDecimalString("40"),
    });
    expect(await stored(id)).toEqual({});

    await replaceInstrumentExposureWeights(appWebDb, id, {
      countryWeights: [{ code: "JP", weight: "10.00" }],
    });
    expect(await stored(id)).toEqual({ countryWeights: [{ code: "JP", weight: "10.00" }] });
    const providerRows = await ownerDb
      .select({
        origin: instrumentExposureWeight.origin,
        code: instrumentExposureWeight.countryCode,
      })
      .from(instrumentExposureWeight)
      .where(eq(instrumentExposureWeight.instrumentId, id));
    expect(providerRows).toContainEqual({ origin: "PROVIDER", code: "US" });
  });

  it("deleting the instrument cascades its weights; a write racing the delete cascades or is not found", async () => {
    const id = await newInstrument("ETF");
    await replaceInstrumentExposureWeights(appWebDb, id, {
      countryWeights: [{ code: "US", weight: "60.00" }],
    });
    await raceSqlA`SELECT 1`;
    await raceSqlB`SELECT 1`;
    const [write, removal] = await Promise.all([
      rejection(
        replaceInstrumentExposureWeights(raceDbA, id, {
          countryWeights: [{ code: "JP", weight: "20.00" }],
        }),
      ),
      deleteInstrument(raceDbB, { tenantId: deleteTenant, instrumentId: id }),
    ]);
    expect(removal).toEqual({ deleted: true });
    if (write !== undefined) expect(write).toBeInstanceOf(InstrumentNotFoundError);
    const orphans = await ownerDb
      .select()
      .from(instrumentExposureWeight)
      .where(eq(instrumentExposureWeight.instrumentId, id));
    expect(orphans).toEqual([]);
    expect(
      await rejection(replaceInstrumentExposureWeights(appWebDb, id, { countryWeights: [] })),
    ).toBeInstanceOf(InstrumentNotFoundError);
  });

  it("the reader: one statement for many instruments, none for an empty list", async () => {
    const ids = [
      await newInstrument("ETF"),
      await newInstrument("FUND"),
      await newInstrument("SCPI"),
    ];
    for (const id of ids) {
      await replaceInstrumentExposureWeights(appWebDb, id, {
        countryWeights: [{ code: "FR", weight: "5.00" }],
      });
    }
    await countedSql`SELECT 1`;

    statements = [];
    const many = await listInstrumentExposureWeights(countedDb, ids);
    expect(statements).toHaveLength(1);
    expect([...many.keys()].sort()).toEqual([...ids].sort());

    statements = [];
    const none = await listInstrumentExposureWeights(countedDb, []);
    expect(statements).toHaveLength(0);
    expect(none.size).toBe(0);
  });

  it("FR-747(c): an ETF created with a sector stores it as a 100 % weight, never in sector_code", async () => {
    const etf = await createInstrumentByIsin(appWebDb, {
      kind: "ETF",
      isin: "ZZEW9C000001",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "EW-T9 created ETF",
      sectorCode: "TECHNOLOGIE",
    });
    expect(etf.sectorCode).toBeNull();
    const [row] = await ownerDb.select().from(instrument).where(eq(instrument.id, etf.id));
    expect(row?.sectorCode).toBeNull();
    expect(await stored(etf.id)).toEqual({
      sectorWeights: [{ code: "TECHNOLOGIE", weight: "100.00" }],
    });

    const share = await createInstrumentByIsin(appWebDb, {
      kind: "SHARE",
      isin: "ZZEW9C000002",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "EW-T9 created share",
      sectorCode: "SANTE",
    });
    expect(share.sectorCode).toBe("SANTE");
    expect(await stored(share.id)).toEqual({});
  });
});
