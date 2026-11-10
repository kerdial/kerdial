import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import {
  createDb,
  holdingState,
  instrument,
  marketDataEpoch,
  tenant,
  watchlistItem,
  type Db,
} from "@kerdial/platform-db";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InstrumentNotFoundError } from "./instrument-service.js";
import {
  MAX_WATCHLIST_ITEMS_PER_TENANT,
  WATCHLIST_NOTE_MAX_LENGTH,
  WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES,
  WatchlistItemNotFoundError,
  WatchlistTargetPriceScaleExceededError,
  WatchlistTenantCapExceededError,
  addWatchlistItem,
  listWatchedInstrumentIds,
  removeWatchlistItem,
  updateWatchlistItem,
} from "./watchlist-service.js";

/**
 * T-64 acceptance — the watchlist write service
 * (FR-338–FR-341, FR-368,
 * FR-375, FR-376, FR-380, NFR-36) against a real Postgres 17, authenticated as
 * the real **`app_web`** role, the same shape
 * `instrument-icon-service.integration.test.ts` uses.
 *
 * `ownerDb` is the superuser handle and is used **only** for out-of-band setup
 * and for reading rows back. Every call that exercises the service under test
 * goes through `appWebDb`, the role RLS actually applies to — connecting as the
 * container superuser is what hid a grant gap for a whole feature cycle
 * elsewhere in this repo (migration `0029`), and migration `0062`'s grants are
 * a claim this suite depends on as much as any logic claim.
 *
 * What each block decides:
 *
 *  - **FR-340's cap at the real boundary, sequentially.** 199 seeded rows, the
 *    200th asserted to succeed, the 201st asserted to be refused, in that
 *    order in one test — AC-337's own sequencing rule applied at the service
 *    layer, before the HTTP layer restates it. The cap is exercised at its
 *    real value (200); there is deliberately **no testing-only
 *    `maxRowsPerTenant` override** as `setInstrumentIcon` has, because 199
 *    watchlist rows are one bulk insert of two `uuid`s each, not 199 images.
 *  - **The cap's exemption, in the other direction.** A cap that also blocked
 *    *edits* would pass a one-sided test, and FR-340 exempts them explicitly.
 *  - **The three-way field rule.** `undefined` leaves, `null` clears, a value
 *    sets — for both write paths. Getting this wrong makes a bare re-watch
 *    silently wipe the note the first watch carried, which is a data-loss bug
 *    no status code would reveal.
 *  - **The CHECK literals, read back and compared to the TypeScript
 *    constant.** `WATCHLIST_NOTE_MAX_LENGTH` versus
 *    `pg_get_constraintdef('watchlist_item_note_length')` — the
 *    both-directions drift guard `0057:55-61` records as the only kind that
 *    holds. It lives here rather than in `platform/db`'s own schema suite
 *    because `platform/db` cannot import `@kerdial/ledger` (the package edge
 *    runs the other way, and `platform/db/tsconfig.json`'s `rootDir` makes a
 *    relative test-only import a compile error); the SQL literal itself is
 *    asserted there.
 *  - **The target price's scale, on both write paths** (WL-1).
 *    The column is `numeric(38, 18)` and Postgres rounds to it *before* the
 *    positive CHECK is evaluated, so the scale is a bound the two CHECKs
 *    cannot stand in for — asserted here as a named refusal, with the
 *    unguarded behaviour (a `23514` at 1e-19, a silent truncation above it)
 *    proven directly against the table underneath it.
 *  - **A watchlist write fans out to nothing**: no
 *    `market_data_epoch` bump, no `holding_state` write. Asserted, not merely
 *    stated, because every *other* write in this package fans out.
 */

const TENANT_A = "00000000-0000-7000-8000-000000640001";
const TENANT_B = "00000000-0000-7000-8000-000000640002";
/** Dedicated to the FR-340 cap block, so its row count is deterministic rather than at the mercy of every other test in this file. */
const TENANT_CAP = "00000000-0000-7000-8000-000000640003";

/** Never inserted into `instrument` — the 404 case. */
const GHOST_INSTRUMENT = "00000000-0000-7000-8000-0000006400ff";

function instrumentRow(index: number, ownerTenantId: string | null = null) {
  const suffix = String(index).padStart(4, "0");
  return {
    id: `00000000-0000-7000-8000-00000064${suffix}`,
    kind: "SHARE" as const,
    displayName: `T-64 Co ${suffix}`,
    listingCurrency: "EUR",
    exchangeMic: "XPAR",
    isin: `FR${suffix}000064`,
    primaryIdentifier: "ISIN" as const,
    quotePolicy: "AUTO" as const,
    ownerTenantId,
  };
}

/** 1..212 shared-catalogue instruments — 199 for the cap fixture, the rest for the behavioural cases (211/212 are WL-1's scale cases). */
const INSTRUMENTS = Array.from({ length: 212 }, (unused, index) => instrumentRow(index + 1));
const instrumentId = (index: number): string => INSTRUMENTS[index - 1]!.id;
/** A **tenant-owned** catalogue row (`owner_tenant_id` set) — the excluded case. */
const TENANT_OWNED = instrumentRow(900, TENANT_A);

describe("ledger — watchlist service (T-64, real app_web role)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 2 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: TENANT_A }, { id: TENANT_B }, { id: TENANT_CAP }]);
    await ownerDb.insert(instrument).values([...INSTRUMENTS, TENANT_OWNED]);
  }, 180_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  async function storedRow(
    tenantId: string,
    id: string,
  ): Promise<{ targetPrice: Decimal | null; note: string | null } | undefined> {
    const [row] = await ownerDb
      .select({ targetPrice: watchlistItem.targetPrice, note: watchlistItem.note })
      .from(watchlistItem)
      .where(and(eq(watchlistItem.tenantId, tenantId), eq(watchlistItem.instrumentId, id)));
    return row;
  }

  async function rowCount(tenantId: string): Promise<number> {
    const [row] = await ownerDb
      .select({ count: sql<number>`count(*)::int` })
      .from(watchlistItem)
      .where(eq(watchlistItem.tenantId, tenantId));
    return row?.count ?? 0;
  }

  describe("addWatchlistItem — FR-339's idempotence is a database property", () => {
    it("watches an instrument, returning the row, with both optional fields null", async () => {
      const record = await addWatchlistItem(appWebDb, {
        tenantId: TENANT_A,
        instrumentId: instrumentId(200),
      });
      expect(record.tenantId).toBe(TENANT_A);
      expect(record.instrumentId).toBe(instrumentId(200));
      expect(record.targetPrice).toBeNull();
      expect(record.note).toBeNull();
      expect(record.createdAt).toBeInstanceOf(Date);
      // The row is really there, read back outside the service.
      expect(await storedRow(TENANT_A, instrumentId(200))).toEqual({
        targetPrice: null,
        note: null,
      });
    });

    it("a second watch of the same instrument SUCCEEDS and leaves exactly one row (FR-339, FR-380)", async () => {
      const again = await addWatchlistItem(appWebDb, {
        tenantId: TENANT_A,
        instrumentId: instrumentId(200),
      });
      expect(again.instrumentId).toBe(instrumentId(200));
      const [row] = await ownerDb
        .select({ count: sql<number>`count(*)::int` })
        .from(watchlistItem)
        .where(
          and(
            eq(watchlistItem.tenantId, TENANT_A),
            eq(watchlistItem.instrumentId, instrumentId(200)),
          ),
        );
      expect(row?.count).toBe(1);
    });

    it("carries a target price and a note when given them (FR-341)", async () => {
      const record = await addWatchlistItem(appWebDb, {
        tenantId: TENANT_A,
        instrumentId: instrumentId(201),
        targetPrice: new Decimal("123.456789012345678"),
        note: "buy under 120",
      });
      expect(record.targetPrice?.toString()).toBe("123.456789012345678");
      expect(record.note).toBe("buy under 120");
      const stored = await storedRow(TENANT_A, instrumentId(201));
      // Read back through `decimalCol`, so this is the stored numeric, not the
      // value the caller passed in.
      expect(stored?.targetPrice?.toFixed(18)).toBe("123.456789012345678000");
    });

    /**
     * The data-loss case a one-sided idempotence test would miss: a re-watch
     * from a UI toggle carries no fields, and if the conflict arm wrote
     * `EXCLUDED` unconditionally it would erase the note and target the user
     * had entered.
     */
    it("a re-watch with NO fields leaves an existing target price and note untouched", async () => {
      await addWatchlistItem(appWebDb, { tenantId: TENANT_A, instrumentId: instrumentId(201) });
      const stored = await storedRow(TENANT_A, instrumentId(201));
      expect(stored?.note).toBe("buy under 120");
      expect(stored?.targetPrice?.toString()).toBe("123.456789012345678");
    });

    it("an add naming a field DOES overwrite that field, and only that one", async () => {
      await addWatchlistItem(appWebDb, {
        tenantId: TENANT_A,
        instrumentId: instrumentId(201),
        note: "buy under 110",
      });
      const stored = await storedRow(TENANT_A, instrumentId(201));
      expect(stored?.note).toBe("buy under 110");
      expect(stored?.targetPrice?.toString()).toBe("123.456789012345678");
    });

    it("REFUSES an instrument that does not exist (404-class, InstrumentNotFoundError)", async () => {
      await expect(
        addWatchlistItem(appWebDb, { tenantId: TENANT_A, instrumentId: GHOST_INSTRUMENT }),
      ).rejects.toBeInstanceOf(InstrumentNotFoundError);
      expect(await storedRow(TENANT_A, GHOST_INSTRUMENT)).toBeUndefined();
    });

    it("REFUSES a tenant-OWNED catalogue row — the shared-catalogue filter", async () => {
      // The positive control is every other case in this block: the same call
      // against a shared row succeeds. Without this filter a watchlist row
      // could point at a row the shared reads never return, whose every metric
      // would be unavailable forever.
      await expect(
        addWatchlistItem(appWebDb, { tenantId: TENANT_A, instrumentId: TENANT_OWNED.id }),
      ).rejects.toBeInstanceOf(InstrumentNotFoundError);
    });

    it("re-asserts the two CHECKs itself, as named errors rather than a raw 23514", async () => {
      await expect(
        addWatchlistItem(appWebDb, {
          tenantId: TENANT_A,
          instrumentId: instrumentId(202),
          note: "x".repeat(WATCHLIST_NOTE_MAX_LENGTH + 1),
        }),
      ).rejects.toBeInstanceOf(RangeError);
      for (const target of ["0", "-1"]) {
        await expect(
          addWatchlistItem(appWebDb, {
            tenantId: TENANT_A,
            instrumentId: instrumentId(202),
            targetPrice: new Decimal(target),
          }),
        ).rejects.toBeInstanceOf(RangeError);
      }
      // Nothing landed, and a note at exactly the bound does — the positive
      // companion, so the refusals above cannot be "this instrument was
      // unwatchable for some other reason".
      expect(await storedRow(TENANT_A, instrumentId(202))).toBeUndefined();
      const atBound = await addWatchlistItem(appWebDb, {
        tenantId: TENANT_A,
        instrumentId: instrumentId(202),
        note: "y".repeat(WATCHLIST_NOTE_MAX_LENGTH),
      });
      expect(atBound.note?.length).toBe(WATCHLIST_NOTE_MAX_LENGTH);
    });
  });

  /**
   * WL-1 (security review). The positive CHECK and
   * the column's **scale** are two different bounds, and the second one is not
   * a CHECK at all: Postgres rounds to `numeric(38, 18)` *before* the CHECK is
   * evaluated, so a 19-dp target either becomes `0` (a raw `23514`, i.e. a 500
   * on a figure the user typed) or is stored silently truncated. Both write
   * paths are walked, because both call `assertStorableFields` and a guard
   * added to one of them is the shape this cycle already shipped once.
   */
  describe("WL-1 — the target price's scale, on BOTH write paths", () => {
    /** 19 fractional digits, 1e-19: positive as parsed, `0` as stored. */
    const TOO_MANY_DP = new Decimal("0.0000000000000000001");
    /** Exactly at the bound — the positive companion, so the refusals cannot be "this instrument was unwatchable". */
    const AT_BOUND = new Decimal("1.234567890123456789");

    it("the two fixtures really are 19 and 18 decimal places — the premise, before anything is asserted on it", () => {
      expect(TOO_MANY_DP.decimalPlaces()).toBe(WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES + 1);
      expect(AT_BOUND.decimalPlaces()).toBe(WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES);
      expect(TOO_MANY_DP.greaterThan(0)).toBe(true);
    });

    it("addWatchlistItem REFUSES 19 fractional digits with the named error, and stores nothing", async () => {
      const refusal = await addWatchlistItem(appWebDb, {
        tenantId: TENANT_A,
        instrumentId: instrumentId(211),
        targetPrice: TOO_MANY_DP,
      }).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(WatchlistTargetPriceScaleExceededError);
      expect(refusal).toMatchObject({
        instrumentId: instrumentId(211),
        maxDecimalPlaces: WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES,
      });
      // Not a `RangeError` wearing a different message: the API maps this
      // class specifically, and the positive guard's `RangeError` is a
      // different refusal.
      expect(refusal).not.toBeInstanceOf(RangeError);
      expect(await storedRow(TENANT_A, instrumentId(211))).toBeUndefined();
    });

    it("addWatchlistItem stores a target at exactly 18 places VERBATIM — no rounding, no drift", async () => {
      const record = await addWatchlistItem(appWebDb, {
        tenantId: TENANT_A,
        instrumentId: instrumentId(211),
        targetPrice: AT_BOUND,
      });
      expect(record.targetPrice?.toString()).toBe("1.234567890123456789");
      // Read back outside the service, from the column itself.
      const stored = await storedRow(TENANT_A, instrumentId(211));
      expect(stored?.targetPrice?.toString()).toBe("1.234567890123456789");
    });

    it("updateWatchlistItem REFUSES the same value, and leaves the stored target untouched", async () => {
      const refusal = await updateWatchlistItem(appWebDb, {
        tenantId: TENANT_A,
        instrumentId: instrumentId(211),
        targetPrice: TOO_MANY_DP,
      }).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(WatchlistTargetPriceScaleExceededError);
      // The refusal happens before the `UPDATE`, so the 18-dp value the
      // previous test stored is still exactly what the row holds.
      const stored = await storedRow(TENANT_A, instrumentId(211));
      expect(stored?.targetPrice?.toString()).toBe("1.234567890123456789");
    });

    it("updateWatchlistItem accepts 18 places on a row that already exists (the positive companion)", async () => {
      const record = await updateWatchlistItem(appWebDb, {
        tenantId: TENANT_A,
        instrumentId: instrumentId(211),
        targetPrice: new Decimal("0.000000000000000001"),
      });
      expect(record.targetPrice?.toString()).toBe("0.000000000000000001");
    });

    it("the premise, in the database: an unguarded 19-dp target rounds to 0 (23514) or truncates silently", async () => {
      // This is what the guard above prevents, proven rather than described —
      // the same "the CHECK bites in the database too" shape the note bound
      // has. A caller that bypassed the service entirely gets exactly the two
      // failure modes recorded earlier.
      await expect(
        pg.ownerClient`
          INSERT INTO "watchlist_item" (tenant_id, instrument_id, target_price)
          VALUES (${TENANT_B}::uuid, ${instrumentId(212)}::uuid, 0.0000000000000000001)
        `,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "watchlist_item_target_price_positive",
      });

      await pg.ownerClient`
        INSERT INTO "watchlist_item" (tenant_id, instrument_id, target_price)
        VALUES (${TENANT_B}::uuid, ${instrumentId(212)}::uuid, 1.2345678901234567891)
      `;
      const stored = await storedRow(TENANT_B, instrumentId(212));
      // Sent 19 digits, stored 18 — the silent alteration half of the finding.
      expect(stored?.targetPrice?.toString()).toBe("1.234567890123456789");
    });
  });

  describe("updateWatchlistItem — a PATCH is not a create (FR-341)", () => {
    beforeAll(async () => {
      await addWatchlistItem(appWebDb, {
        tenantId: TENANT_A,
        instrumentId: instrumentId(203),
        targetPrice: new Decimal("42"),
        note: "watch the dividend",
      });
    });

    it("updates ONLY the field it names, leaving the other alone", async () => {
      const record = await updateWatchlistItem(appWebDb, {
        tenantId: TENANT_A,
        instrumentId: instrumentId(203),
        note: "watch the split",
      });
      expect(record.note).toBe("watch the split");
      expect(record.targetPrice?.toString()).toBe("42");
    });

    it("an explicit null CLEARS the field it names — 'editable' includes 'editable back to empty'", async () => {
      const record = await updateWatchlistItem(appWebDb, {
        tenantId: TENANT_A,
        instrumentId: instrumentId(203),
        targetPrice: null,
      });
      expect(record.targetPrice).toBeNull();
      expect(record.note).toBe("watch the split");
      expect(await storedRow(TENANT_A, instrumentId(203))).toEqual({
        targetPrice: null,
        note: "watch the split",
      });
    });

    it("does NOT un-watch: the row is still there after both edits", async () => {
      const ids = await listWatchedInstrumentIds(appWebDb, TENANT_A);
      expect(ids).toContain(instrumentId(203));
    });

    it("THROWS WatchlistItemNotFoundError for an unwatched instrument, and creates nothing", async () => {
      await expect(
        updateWatchlistItem(appWebDb, {
          tenantId: TENANT_A,
          instrumentId: instrumentId(204),
          note: "should not appear",
        }),
      ).rejects.toBeInstanceOf(WatchlistItemNotFoundError);
      expect(await storedRow(TENANT_A, instrumentId(204))).toBeUndefined();
    });

    it("THROWS for a row that belongs to ANOTHER tenant — RLS makes it indistinguishable from absent", async () => {
      await addWatchlistItem(appWebDb, { tenantId: TENANT_B, instrumentId: instrumentId(205) });
      await expect(
        updateWatchlistItem(appWebDb, {
          tenantId: TENANT_A,
          instrumentId: instrumentId(205),
          note: "cross-tenant",
        }),
      ).rejects.toBeInstanceOf(WatchlistItemNotFoundError);
      // …and B's row is untouched, which is the half a 404 alone would not say.
      expect(await storedRow(TENANT_B, instrumentId(205))).toEqual({
        targetPrice: null,
        note: null,
      });
    });
  });

  describe("removeWatchlistItem — idempotent both directions (FR-375, FR-376)", () => {
    it("removes the row and reports removed: true", async () => {
      await addWatchlistItem(appWebDb, { tenantId: TENANT_A, instrumentId: instrumentId(206) });
      expect(
        await removeWatchlistItem(appWebDb, {
          tenantId: TENANT_A,
          instrumentId: instrumentId(206),
        }),
      ).toEqual({ removed: true });
      expect(await storedRow(TENANT_A, instrumentId(206))).toBeUndefined();
    });

    it("a second removal is a SUCCESS reporting removed: false — never an error", async () => {
      expect(
        await removeWatchlistItem(appWebDb, {
          tenantId: TENANT_A,
          instrumentId: instrumentId(206),
        }),
      ).toEqual({ removed: false });
    });

    it("removing an instrument ANOTHER tenant watches touches only this tenant's row (FR-376)", async () => {
      await addWatchlistItem(appWebDb, { tenantId: TENANT_A, instrumentId: instrumentId(207) });
      await addWatchlistItem(appWebDb, {
        tenantId: TENANT_B,
        instrumentId: instrumentId(207),
        note: "B's own note",
      });

      expect(
        await removeWatchlistItem(appWebDb, {
          tenantId: TENANT_A,
          instrumentId: instrumentId(207),
        }),
      ).toEqual({ removed: true });

      expect(await storedRow(TENANT_A, instrumentId(207))).toBeUndefined();
      // The positive companion: B still watches it, with its own note.
      expect(await storedRow(TENANT_B, instrumentId(207))).toEqual({
        targetPrice: null,
        note: "B's own note",
      });
    });

    it("removing a row that only ANOTHER tenant has reports removed: false and deletes nothing", async () => {
      expect(
        await removeWatchlistItem(appWebDb, {
          tenantId: TENANT_A,
          instrumentId: instrumentId(207),
        }),
      ).toEqual({ removed: false });
      expect(await storedRow(TENANT_B, instrumentId(207))).not.toBeUndefined();
    });
  });

  describe("listWatchedInstrumentIds — tenant-scoped and ordered", () => {
    it("returns this tenant's ids, ascending, and none of the other tenant's", async () => {
      const ids = await listWatchedInstrumentIds(appWebDb, TENANT_A);
      expect(ids).toEqual([...ids].sort());
      expect(new Set(ids).size).toBe(ids.length);
      // B watches instrument 205 and 207; A does not.
      expect(ids).not.toContain(instrumentId(205));
      expect(ids).not.toContain(instrumentId(207));
      // Non-empty, so the two absences above are not vacuous.
      expect(ids).toContain(instrumentId(200));
      expect(ids.length).toBe(await rowCount(TENANT_A));
    });

    it("is empty for a tenant that watches nothing — no error, no other tenant's rows", async () => {
      expect(await listWatchedInstrumentIds(appWebDb, TENANT_CAP)).toEqual([]);
    });
  });

  describe("FR-340 — the cap at its real boundary, 199 → 200 → 201, sequentially", () => {
    beforeAll(async () => {
      // Seeded as the superuser, which bypasses RLS: 199 rows of two uuids,
      // not 199 service calls, so the boundary is exercised at the constant's
      // real value rather than through a testing-only override.
      await ownerDb.insert(watchlistItem).values(
        Array.from({ length: MAX_WATCHLIST_ITEMS_PER_TENANT - 1 }, (unused, index) => ({
          tenantId: TENANT_CAP,
          instrumentId: instrumentId(index + 1),
        })),
      );
      expect(await rowCount(TENANT_CAP)).toBe(MAX_WATCHLIST_ITEMS_PER_TENANT - 1);
    }, 60_000);

    it("the 200th add SUCCEEDS and the 201st is REFUSED, in that order, in one test", async () => {
      const twoHundredth = await addWatchlistItem(appWebDb, {
        tenantId: TENANT_CAP,
        instrumentId: instrumentId(MAX_WATCHLIST_ITEMS_PER_TENANT),
      });
      expect(twoHundredth.instrumentId).toBe(instrumentId(MAX_WATCHLIST_ITEMS_PER_TENANT));
      expect(await rowCount(TENANT_CAP)).toBe(MAX_WATCHLIST_ITEMS_PER_TENANT);

      const refusal = await addWatchlistItem(appWebDb, {
        tenantId: TENANT_CAP,
        instrumentId: instrumentId(MAX_WATCHLIST_ITEMS_PER_TENANT + 1),
      }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(WatchlistTenantCapExceededError);
      expect(refusal).toMatchObject({
        tenantId: TENANT_CAP,
        cap: MAX_WATCHLIST_ITEMS_PER_TENANT,
      });
      // The refusal is not a silent drop and not an eviction: the count is
      // unchanged and the 201st instrument is absent.
      expect(await rowCount(TENANT_CAP)).toBe(MAX_WATCHLIST_ITEMS_PER_TENANT);
      expect(
        await storedRow(TENANT_CAP, instrumentId(MAX_WATCHLIST_ITEMS_PER_TENANT + 1)),
      ).toBeUndefined();
    }, 60_000);

    it("at the cap, EDITING an existing row still succeeds — the exemption, in the other direction", async () => {
      const edited = await addWatchlistItem(appWebDb, {
        tenantId: TENANT_CAP,
        instrumentId: instrumentId(1),
        note: "still editable at the cap",
      });
      expect(edited.note).toBe("still editable at the cap");
      const patched = await updateWatchlistItem(appWebDb, {
        tenantId: TENANT_CAP,
        instrumentId: instrumentId(1),
        targetPrice: new Decimal("7.5"),
      });
      expect(patched.targetPrice?.toString()).toBe("7.5");
      expect(await rowCount(TENANT_CAP)).toBe(MAX_WATCHLIST_ITEMS_PER_TENANT);
    });

    it("another tenant is unaffected by this tenant's cap — the count is per tenant", async () => {
      const record = await addWatchlistItem(appWebDb, {
        tenantId: TENANT_B,
        instrumentId: instrumentId(208),
      });
      expect(record.instrumentId).toBe(instrumentId(208));
    });
  });

  describe("DRIFT: the CHECK literals, read back and compared to the TypeScript constant", () => {
    async function constraintDef(conname: string): Promise<string | undefined> {
      const [row] = await pg.ownerClient<{ definition: string }[]>`
        SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
        WHERE c.conrelid = 'watchlist_item'::regclass AND c.conname = ${conname}
      `;
      return row?.definition;
    }

    it("watchlist_item_note_length's bound IS WATCHLIST_NOTE_MAX_LENGTH", async () => {
      const definition = await constraintDef("watchlist_item_note_length");
      expect(definition).toBeDefined();
      expect(definition).toContain(`char_length(note) <= ${WATCHLIST_NOTE_MAX_LENGTH}`);
    });

    it("watchlist_item_target_price_positive bounds the price ABOVE zero, not at it", async () => {
      const definition = await constraintDef("watchlist_item_target_price_positive");
      expect(definition).toContain("target_price > (0)");
    });

    it("the note CHECK bites in the database too, for a caller that bypasses this service", async () => {
      // The service's own re-assertion is asserted above; this is the backstop
      // underneath it, and the reason the constant may not drift from the DDL.
      await expect(
        pg.ownerClient`
          INSERT INTO "watchlist_item" (tenant_id, instrument_id, note)
          VALUES (${TENANT_B}::uuid, ${instrumentId(209)}::uuid,
                  ${"z".repeat(WATCHLIST_NOTE_MAX_LENGTH + 1)})
        `,
      ).rejects.toMatchObject({ code: "23514", constraint_name: "watchlist_item_note_length" });
      await expect(
        pg.ownerClient`
          INSERT INTO "watchlist_item" (tenant_id, instrument_id, target_price)
          VALUES (${TENANT_B}::uuid, ${instrumentId(209)}::uuid, 0)
        `,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "watchlist_item_target_price_positive",
      });
    });
  });

  describe("a watchlist write fans out to nothing", () => {
    it("bumps no market_data_epoch and writes no holding_state", async () => {
      const epochBefore = await ownerDb.select().from(marketDataEpoch);
      const [holdingsBefore] = await ownerDb
        .select({ count: sql<number>`count(*)::int` })
        .from(holdingState);

      await addWatchlistItem(appWebDb, {
        tenantId: TENANT_B,
        instrumentId: instrumentId(210),
        targetPrice: new Decimal("11"),
      });
      await updateWatchlistItem(appWebDb, {
        tenantId: TENANT_B,
        instrumentId: instrumentId(210),
        note: "no fan-out",
      });
      await removeWatchlistItem(appWebDb, {
        tenantId: TENANT_B,
        instrumentId: instrumentId(210),
      });

      expect(await ownerDb.select().from(marketDataEpoch)).toEqual(epochBefore);
      const [holdingsAfter] = await ownerDb
        .select({ count: sql<number>`count(*)::int` })
        .from(holdingState);
      expect(holdingsAfter?.count).toBe(holdingsBefore?.count);
    });
  });
});
