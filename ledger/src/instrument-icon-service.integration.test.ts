import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import {
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
} from "@kerdial/core-reference-data";
import { createDb, instrumentIcon, tenant, type Db } from "@kerdial/platform-db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInstrumentBySymbol } from "./instrument-service.js";
import {
  InstrumentIconBoundsError,
  InstrumentIconTenantCapExceededError,
  getInstrumentIcon,
  listInstrumentIdsWithIcon,
  removeInstrumentIcon,
  setInstrumentIcon,
} from "./instrument-icon-service.js";

/**
 * IK6 acceptance — the instrument-icon write service
 * (FR-295, FR-296, FR-297, FR-299, FR-301, FR-302) against a real Postgres 17,
 * authenticated as the real **`app_web`** role, the same shape
 * `manual-price-service.integration.test.ts` uses.
 *
 * `ownerDb` is the superuser handle and is used **only** for out-of-band setup
 * and for reading rows back. Every call that exercises the service under test
 * goes through `appWebDb`, the role RLS actually applies to — connecting as
 * the container superuser is what hid a grant gap for a whole feature cycle
 * elsewhere in this repo, and these are grant claims as much as logic ones.
 *
 * What each block decides:
 *
 *  - **FR-297's atomicity is structural, and it is measured on the wire.** A
 *    replace is one `INSERT … ON CONFLICT DO UPDATE` and **no `DELETE`** —
 *    counted from postgres.js's own `debug` hook, following
 *    `cash-account-balances-statement-count.integration.test.ts`, this repo's
 *    established pattern for exactly this kind of claim. Reading the code and
 *    asserting "there is no delete" is the self-report this project has a
 *    recorded history of.
 *  - **FR-302's cap, in both directions.** A cap that also blocked replaces
 *    would pass a one-sided test, and FR-302 exempts replaces explicitly.
 *  - **AC-305's runtime half.** `source` is read back off the stored row after
 *    the insert arm *and* after the conflict arm. The compile-time half —
 *    `SetInstrumentIconParams` cannot express a `source` at all — is
 *    `instrument-icon-service.test.ts`.
 *  - **The service's own bounds re-assertions.** Bypassing the HTTP schema
 *    must produce a named error, not a raw Postgres `23514` escaping as a 500.
 *  - **An icon write fans out to nothing.** Asserted, not merely stated,
 *    because every *other* write in this package fans out, so its absence
 *    would otherwise read as an omission.
 */

/** A minimal but structurally real PNG header: signature, then a 13-byte IHDR carrying the dimensions. Padded to `byteLength` with a private chunk's worth of filler so a byte-ceiling fixture is a real image and not a random buffer. */
function png(width: number, height: number, byteLength = 0): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  const head = Buffer.concat([signature, ihdr]);
  if (byteLength <= head.length) return head;
  return Buffer.concat([head, Buffer.alloc(byteLength - head.length, 0x5a)]);
}

/**
 * The statements one `setInstrumentIcon` **replace** puts on the wire, in
 * order:
 *
 *   1. `BEGIN`                                  — `withTenant`'s transaction
 *   2. `select set_config('app.tenant_id', …)`  — `withTenant`'s RLS scope
 *   3. the PK probe                             — "is there a row already?"
 *   4. the `INSERT … ON CONFLICT DO UPDATE`     — **the only write**
 *   5. `COMMIT`
 *
 * A **rise** means either the cap count was consulted on a replace (FR-302's
 * exemption broken) or a second write statement appeared; a **fall** means the
 * fixture stopped exercising the replace path and is just as much a failure —
 * hence `toBe`, never `toBeLessThanOrEqual`.
 */
const REPLACE_STATEMENTS = 5;

/** A first set costs one more: the `count(*)` the cap consults when, and only when, the row is absent. */
const FIRST_SET_STATEMENTS = 6;

describe("ledger — instrument icon service (IK6, real app_web role)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  /** A second, dedicated connection whose statements are counted — so nothing the fixture does is ever attributed to a measured call. */
  let countedSql: postgres.Sql;
  let countedDb: Db;
  let statementCount = 0;
  let statements: string[] = [];

  const tenantA = "00000000-0000-7000-8000-0000000ec00a";
  const tenantB = "00000000-0000-7000-8000-0000000ec00b";
  /** Dedicated to the FR-302 cap block, so its row count is deterministic rather than at the mercy of every other test in this file. */
  const tenantC = "00000000-0000-7000-8000-0000000ec00c";
  /** Dedicated to the statement-count block, for the same reason. */
  const tenantD = "00000000-0000-7000-8000-0000000ec00d";

  let symbolCounter = 0;
  /** A shared-catalogue CRYPTO instrument (`owner_tenant_id IS NULL`) — FR-299's "one code path for both kinds" means this service never asks. */
  async function newInstrument(): Promise<string> {
    symbolCounter += 1;
    const row = await createInstrumentBySymbol(ownerDb, {
      kind: "CRYPTO",
      symbol: `IK6${String(symbolCounter).padStart(4, "0")}`,
      listingCurrency: "EUR",
      displayName: `IK-6 icon fixture ${symbolCounter}`,
    });
    return row.id;
  }

  /** The stored row, read as the owner. A response body is never the evidence for a persistence claim. */
  async function row(tenantId: string, instrumentId: string) {
    const [found] = await ownerDb
      .select()
      .from(instrumentIcon)
      .where(
        and(eq(instrumentIcon.tenantId, tenantId), eq(instrumentIcon.instrumentId, instrumentId)),
      );
    return found;
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    countedSql = postgres(pg.appWebUri, {
      max: 1,
      debug: (_connection, query) => {
        statementCount += 1;
        statements.push(query);
      },
    });
    countedDb = createDb(countedSql);

    await ownerDb
      .insert(tenant)
      .values([{ id: tenantA }, { id: tenantB }, { id: tenantC }, { id: tenantD }]);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await countedSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  describe("FR-295/FR-296 — one row per (tenant, instrument), bytes stored verbatim", () => {
    it("a first set stores the bytes byte-for-byte, with the metadata read off the stored row", async () => {
      const instrumentId = await newInstrument();
      const bytes = png(128, 96, 3182);

      const meta = await setInstrumentIcon(appWebDb, {
        tenantId: tenantA,
        instrumentId,
        bytes: new Uint8Array(bytes),
        contentType: "image/png",
        widthPx: 128,
        heightPx: 96,
      });

      expect(meta).toMatchObject({
        tenantId: tenantA,
        instrumentId,
        contentType: "image/png",
        byteLength: 3182,
        widthPx: 128,
        heightPx: 96,
        source: "MANUAL",
      });

      const stored = await row(tenantA, instrumentId);
      // Byte identity, not length equality: SD-4 is "stored verbatim", and a
      // re-encode or a metadata strip would keep the length plausible.
      expect(Buffer.from(stored!.bytes)).toEqual(bytes);
      expect(stored!.byteLength).toBe(bytes.length);

      // …and the read path returns those same bytes, so "stored verbatim" is a
      // fact about what comes back out and not only about what went in.
      const fetched = await getInstrumentIcon(appWebDb, { tenantId: tenantA, instrumentId });
      expect(Buffer.from(fetched!.bytes)).toEqual(bytes);
      expect(fetched!.contentType).toBe("image/png");
    });

    it("a set on an instrument that already has an icon REPLACES it — one row, the new bytes", async () => {
      const instrumentId = await newInstrument();
      const alpha = png(64, 64, 900);
      const beta = png(200, 150, 4096);

      await setInstrumentIcon(appWebDb, {
        tenantId: tenantA,
        instrumentId,
        bytes: new Uint8Array(alpha),
        contentType: "image/png",
        widthPx: 64,
        heightPx: 64,
      });
      await setInstrumentIcon(appWebDb, {
        tenantId: tenantA,
        instrumentId,
        bytes: new Uint8Array(beta),
        contentType: "image/jpeg",
        widthPx: 200,
        heightPx: 150,
      });

      const all = await ownerDb
        .select()
        .from(instrumentIcon)
        .where(
          and(eq(instrumentIcon.tenantId, tenantA), eq(instrumentIcon.instrumentId, instrumentId)),
        );
      // FR-296: a replace, never a second row.
      expect(all).toHaveLength(1);
      expect(Buffer.from(all[0]!.bytes)).toEqual(beta);
      expect(all[0]!.contentType).toBe("image/jpeg");
      expect(all[0]!.widthPx).toBe(200);
      expect(all[0]!.heightPx).toBe(150);
    });

    it("two tenants hold different icons for the SAME shared-catalogue instrument", async () => {
      // FR-299: the icon's scope is the tenant that uploaded it, independently
      // of who owns the instrument — and this instrument is owned by nobody.
      const instrumentId = await newInstrument();
      const alpha = png(32, 32, 512);
      const beta = png(48, 48, 640);

      await setInstrumentIcon(appWebDb, {
        tenantId: tenantA,
        instrumentId,
        bytes: new Uint8Array(alpha),
        contentType: "image/png",
        widthPx: 32,
        heightPx: 32,
      });
      await setInstrumentIcon(appWebDb, {
        tenantId: tenantB,
        instrumentId,
        bytes: new Uint8Array(beta),
        contentType: "image/png",
        widthPx: 48,
        heightPx: 48,
      });

      const forA = await getInstrumentIcon(appWebDb, { tenantId: tenantA, instrumentId });
      const forB = await getInstrumentIcon(appWebDb, { tenantId: tenantB, instrumentId });
      expect(Buffer.from(forA!.bytes)).toEqual(alpha);
      expect(Buffer.from(forB!.bytes)).toEqual(beta);
    });

    it("listInstrumentIdsWithIcon reports presence for exactly the tenant's own rows", async () => {
      const withIcon = await newInstrument();
      const withoutIcon = await newInstrument();
      await setInstrumentIcon(appWebDb, {
        tenantId: tenantB,
        instrumentId: withIcon,
        bytes: new Uint8Array(png(16, 16, 300)),
        contentType: "image/png",
        widthPx: 16,
        heightPx: 16,
      });

      const present = await listInstrumentIdsWithIcon(appWebDb, {
        tenantId: tenantB,
        instrumentIds: [withIcon, withoutIcon],
      });
      expect([...present]).toEqual([withIcon]);

      // The absence half, from another tenant's point of view on the same ids.
      const forA = await listInstrumentIdsWithIcon(appWebDb, {
        tenantId: tenantA,
        instrumentIds: [withIcon, withoutIcon],
      });
      expect([...forA]).toEqual([]);
    });
  });

  describe("FR-297 — the replace is ONE statement, counted on the wire, with no DELETE", () => {
    it(`a first set issues ${FIRST_SET_STATEMENTS} statements and a replace issues ${REPLACE_STATEMENTS} — no DELETE in either`, async () => {
      const instrumentId = await newInstrument();
      const alpha = png(70, 70, 1024);
      const beta = png(90, 90, 2048);
      await countedSql`select 1 as warm`;

      statementCount = 0;
      statements = [];
      await setInstrumentIcon(countedDb, {
        tenantId: tenantD,
        instrumentId,
        bytes: new Uint8Array(alpha),
        contentType: "image/png",
        widthPx: 70,
        heightPx: 70,
      });
      const firstSet = [...statements];
      const firstSetCount = statementCount;

      statementCount = 0;
      statements = [];
      await setInstrumentIcon(countedDb, {
        tenantId: tenantD,
        instrumentId,
        bytes: new Uint8Array(beta),
        contentType: "image/png",
        widthPx: 90,
        heightPx: 90,
      });
      const replace = [...statements];
      const replaceCount = statementCount;

      // The *shape* assertions come first, deliberately. The two counts below
      // would also move if a `DELETE` were introduced, and a red on a count is
      // not a red on "there is no delete-then-insert window" — one mechanism
      // masking another is a recorded way a watch-it-fail silently passes.
      const writes = replace.filter((sql) => /insert into|update |delete from/i.test(sql));
      // FR-297's last sentence: there is no delete-then-insert window in which
      // an instrument could be left iconless. The absence is what matters, so
      // the positive companion is stated in the same breath — exactly one
      // write statement, and it is the upsert.
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(/insert into "instrument_icon"/i);
      expect(writes[0]).toMatch(/on conflict/i);
      expect(replace.some((sql) => /delete/i.test(sql))).toBe(false);

      // …and only now the totals, which pin the *cause* rather than the shape.
      expect(firstSetCount).toBe(FIRST_SET_STATEMENTS);
      expect(replaceCount).toBe(REPLACE_STATEMENTS);

      // FR-302's exemption, measured rather than argued: the `count(*)` the
      // cap consults appears on the first set and NOT on the replace — which
      // is why the two totals differ by exactly one.
      expect(firstSet.some((sql) => /count\(\*\)/i.test(sql))).toBe(true);
      expect(replace.some((sql) => /count\(\*\)/i.test(sql))).toBe(false);
      expect(FIRST_SET_STATEMENTS - REPLACE_STATEMENTS).toBe(1);
    });

    it("an icon write touches no other table and bumps no epoch", async () => {
      // Every *other* write in this package fans out
      // (`invalidateForInstrumentPrice`, `recomputeAndInvalidate`, a
      // `portfolio.calc_epoch` bump), so the absence here has to be asserted
      // or it reads as an omission. Measured over the statements actually put
      // on the wire, so a fan-out added later fails by name.
      const instrumentId = await newInstrument();
      await countedSql`select 1 as warm`;

      statementCount = 0;
      statements = [];
      await setInstrumentIcon(countedDb, {
        tenantId: tenantD,
        instrumentId,
        bytes: new Uint8Array(png(40, 40, 700)),
        contentType: "image/png",
        widthPx: 40,
        heightPx: 40,
      });
      await removeInstrumentIcon(countedDb, { tenantId: tenantD, instrumentId });
      const seen = statements.join("\n").toLowerCase();

      for (const forbidden of [
        "calc_epoch",
        "market_data_epoch",
        "portfolio_daily_valuation",
        "holding_state",
        "cash_balance",
        "realized_gain",
        // FR-300: no `instrument` write on this feature's path. Matched with
        // the quotes drizzle emits, so `instrument_icon` does not trip it.
        'update "instrument"',
        'insert into "instrument"',
      ]) {
        expect(seen, `an icon write must not mention ${forbidden}`).not.toContain(forbidden);
      }
      // The positive companion: the statements really were the icon write's.
      expect(seen).toContain('insert into "instrument_icon"');
      expect(seen).toContain('delete from "instrument_icon"');
    });
  });

  describe("FR-302 — the per-tenant row cap, in both directions", () => {
    it("refuses a fourth DISTINCT instrument at maxRowsPerTenant: 3, while a replace of any of the three still succeeds", async () => {
      const three = [await newInstrument(), await newInstrument(), await newInstrument()];
      const fourth = await newInstrument();
      const bytes = new Uint8Array(png(24, 24, 400));
      const set = (instrumentId: string, maxRowsPerTenant?: number) =>
        setInstrumentIcon(appWebDb, {
          tenantId: tenantC,
          instrumentId,
          bytes,
          contentType: "image/png",
          widthPx: 24,
          heightPx: 24,
          ...(maxRowsPerTenant !== undefined ? { maxRowsPerTenant } : {}),
        });

      for (const instrumentId of three) await set(instrumentId, 3);

      // Direction 1: the fourth distinct instrument is refused.
      await expect(set(fourth, 3)).rejects.toBeInstanceOf(InstrumentIconTenantCapExceededError);
      expect(await row(tenantC, fourth)).toBeUndefined();

      // Direction 2 — the half a one-sided test would miss: a **replace** in
      // the very same state succeeds, because it adds no net-new row
      // (FR-302's explicit exemption). Without this, a cap that also blocked
      // replaces would pass.
      const replaced = await set(three[0]!, 3);
      expect(replaced.instrumentId).toBe(three[0]);

      // …and the refusal really was the cap and not the state: raising the
      // ceiling by one lets the same fourth instrument through unchanged.
      const admitted = await set(fourth, 4);
      expect(admitted.instrumentId).toBe(fourth);
    });

    it("the error carries the cap that was applied, not the production constant", async () => {
      const instrumentId = await newInstrument();
      const error = await setInstrumentIcon(appWebDb, {
        tenantId: tenantC,
        instrumentId,
        bytes: new Uint8Array(png(24, 24, 400)),
        contentType: "image/png",
        widthPx: 24,
        heightPx: 24,
        maxRowsPerTenant: 1,
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(InstrumentIconTenantCapExceededError);
      expect((error as InstrumentIconTenantCapExceededError).cap).toBe(1);
      expect((error as InstrumentIconTenantCapExceededError).tenantId).toBe(tenantC);
    });
  });

  describe("FR-301/AC-305 — every write arm stores source = 'MANUAL'", () => {
    it("reads MANUAL back off the stored row after the insert arm AND after the conflict arm", async () => {
      const instrumentId = await newInstrument();
      const set = (bytes: Buffer) =>
        setInstrumentIcon(appWebDb, {
          tenantId: tenantA,
          instrumentId,
          bytes: new Uint8Array(bytes),
          contentType: "image/png",
          widthPx: 50,
          heightPx: 50,
        });

      const inserted = await set(png(50, 50, 600));
      expect(inserted.source).toBe("MANUAL");
      expect((await row(tenantA, instrumentId))!.source).toBe("MANUAL");

      // The conflict arm sets `source` to the literal too, so a row that had
      // somehow been made `PROVIDER` out of band is *corrected* by a replace
      // rather than preserved — which is why the arm writes the literal and
      // not `excluded.source`.
      await ownerDb
        .update(instrumentIcon)
        .set({ source: "PROVIDER" })
        .where(
          and(eq(instrumentIcon.tenantId, tenantA), eq(instrumentIcon.instrumentId, instrumentId)),
        );
      expect((await row(tenantA, instrumentId))!.source).toBe("PROVIDER");

      const replaced = await set(png(50, 50, 800));
      expect(replaced.source).toBe("MANUAL");
      expect((await row(tenantA, instrumentId))!.source).toBe("MANUAL");
    });
  });

  describe("the service re-asserts its own bounds — a named error, never a raw 23514", () => {
    const cases: readonly [string, { bytes: Buffer; widthPx: number; heightPx: number }][] = [
      [
        "bytes over INSTRUMENT_ICON_MAX_BYTES",
        { bytes: png(64, 64, INSTRUMENT_ICON_MAX_BYTES + 1), widthPx: 64, heightPx: 64 },
      ],
      ["zero bytes", { bytes: Buffer.alloc(0), widthPx: 64, heightPx: 64 }],
      [
        "a width over INSTRUMENT_ICON_MAX_PIXELS",
        { bytes: png(513, 512, 900), widthPx: INSTRUMENT_ICON_MAX_PIXELS + 1, heightPx: 512 },
      ],
      [
        "a height over INSTRUMENT_ICON_MAX_PIXELS",
        { bytes: png(512, 513, 900), widthPx: 512, heightPx: INSTRUMENT_ICON_MAX_PIXELS + 1 },
      ],
      ["a zero dimension", { bytes: png(0, 64, 900), widthPx: 0, heightPx: 64 }],
    ];

    it.each(cases)("%s throws InstrumentIconBoundsError and stores nothing", async (_, params) => {
      const instrumentId = await newInstrument();
      const error = await setInstrumentIcon(appWebDb, {
        tenantId: tenantA,
        instrumentId,
        bytes: new Uint8Array(params.bytes),
        contentType: "image/png",
        widthPx: params.widthPx,
        heightPx: params.heightPx,
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(InstrumentIconBoundsError);
      // Not a Postgres error: the point of the duplicated guard is that the
      // table's CHECKs are not the *only* backstop, since a `23514` escaping
      // this far would be a 500 on a user-supplied upload.
      expect((error as { code?: string }).code).toBeUndefined();
      expect(await row(tenantA, instrumentId)).toBeUndefined();
    });

    it("a content type outside the closed set throws too — the type says it cannot happen, the guard says it anyway", async () => {
      const instrumentId = await newInstrument();
      const error = await setInstrumentIcon(appWebDb, {
        tenantId: tenantA,
        instrumentId,
        bytes: new Uint8Array(png(64, 64, 900)),
        // The cast is the point: this service's stated reason for existing is
        // the caller that is not the Zod-validated route, and such a caller
        // could be JavaScript with no types at all.
        contentType: "image/gif" as "image/png",
        widthPx: 64,
        heightPx: 64,
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(InstrumentIconBoundsError);
      expect((error as InstrumentIconBoundsError).violation).toBe("CONTENT_TYPE");
      expect(await row(tenantA, instrumentId)).toBeUndefined();

      // The positive companion: the same call with an accepted type succeeds,
      // so the refusal above is about the content type and nothing else.
      const ok = await setInstrumentIcon(appWebDb, {
        tenantId: tenantA,
        instrumentId,
        bytes: new Uint8Array(png(64, 64, 900)),
        contentType: "image/png",
        widthPx: 64,
        heightPx: 64,
      });
      expect(ok.contentType).toBe("image/png");
    });

    it("the boundary is INCLUSIVE — exactly INSTRUMENT_ICON_MAX_BYTES and exactly 512 x 512 are accepted", async () => {
      const instrumentId = await newInstrument();
      const meta = await setInstrumentIcon(appWebDb, {
        tenantId: tenantA,
        instrumentId,
        bytes: new Uint8Array(png(512, 512, INSTRUMENT_ICON_MAX_BYTES)),
        contentType: "image/png",
        widthPx: INSTRUMENT_ICON_MAX_PIXELS,
        heightPx: INSTRUMENT_ICON_MAX_PIXELS,
      });
      expect(meta.byteLength).toBe(INSTRUMENT_ICON_MAX_BYTES);
      expect(meta.widthPx).toBe(INSTRUMENT_ICON_MAX_PIXELS);
      expect(meta.heightPx).toBe(INSTRUMENT_ICON_MAX_PIXELS);
      // Read back, because the CHECK `byte_length = octet_length(bytes)` is
      // what makes the ceiling mean anything and only the stored row proves it.
      expect((await row(tenantA, instrumentId))!.byteLength).toBe(INSTRUMENT_ICON_MAX_BYTES);
    });
  });

  describe("removeInstrumentIcon — idempotent", () => {
    it("removing a non-existent row resolves without error, and removing twice does too", async () => {
      const neverIconed = await newInstrument();
      // The TOCTOU this feature's own removal capability creates: two tabs, or
      // a double-click, must not make the second attempt an error for having
      // succeeded.
      await expect(
        removeInstrumentIcon(appWebDb, { tenantId: tenantA, instrumentId: neverIconed }),
      ).resolves.toBeUndefined();

      const iconed = await newInstrument();
      await setInstrumentIcon(appWebDb, {
        tenantId: tenantA,
        instrumentId: iconed,
        bytes: new Uint8Array(png(28, 28, 500)),
        contentType: "image/png",
        widthPx: 28,
        heightPx: 28,
      });
      expect(await row(tenantA, iconed)).toBeDefined();

      await removeInstrumentIcon(appWebDb, { tenantId: tenantA, instrumentId: iconed });
      expect(await row(tenantA, iconed)).toBeUndefined();
      await expect(
        removeInstrumentIcon(appWebDb, { tenantId: tenantA, instrumentId: iconed }),
      ).resolves.toBeUndefined();
      expect(await row(tenantA, iconed)).toBeUndefined();
    });

    it("removes only the calling tenant's row, never the other tenant's for the same instrument", async () => {
      const instrumentId = await newInstrument();
      const forA = png(20, 20, 350);
      const forB = png(22, 22, 360);
      await setInstrumentIcon(appWebDb, {
        tenantId: tenantA,
        instrumentId,
        bytes: new Uint8Array(forA),
        contentType: "image/png",
        widthPx: 20,
        heightPx: 20,
      });
      await setInstrumentIcon(appWebDb, {
        tenantId: tenantB,
        instrumentId,
        bytes: new Uint8Array(forB),
        contentType: "image/png",
        widthPx: 22,
        heightPx: 22,
      });

      await removeInstrumentIcon(appWebDb, { tenantId: tenantA, instrumentId });

      expect(await row(tenantA, instrumentId)).toBeUndefined();
      expect(Buffer.from((await row(tenantB, instrumentId))!.bytes)).toEqual(forB);
    });
  });
});
