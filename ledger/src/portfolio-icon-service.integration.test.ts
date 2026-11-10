import {
  deferred,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import {
  appUser,
  createDb,
  portfolioIcon,
  tenant,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejectionOf, startRacing } from "./__tests__/racing-operation.js";
import {
  PortfolioIconPortfolioNotFoundError,
  getPortfolioIcon,
  removePortfolioIcon,
  setPortfolioIcon,
} from "./portfolio-icon-service.js";
import { createPortfolio, deletePortfolio } from "./portfolio-service.js";

/**
 * PD-T5 acceptance — the `portfolio_icon` lifetime service
 * (FR-461–FR-463,
 * FR-465, FR-479, PD-7) against a real Postgres 17, authenticated as the real
 * **`app_web`** role. `ownerDb` is the superuser handle and is used only for
 * out-of-band setup and for reading rows back — connecting as the container
 * superuser is what hid a grant gap for a whole feature cycle elsewhere in this
 * repo, and `portfolio_icon`'s grants are `app_web`-only by design (`0068`).
 *
 * What each block decides:
 *
 *  - **FR-461's atomicity is one statement.** A replace is one `INSERT … ON
 *    CONFLICT DO UPDATE` and never a delete-then-insert pair, so the old bytes
 *    are gone only because the new ones replaced them.
 *  - **PD-7's lock, raced on purpose.** The load-bearing case: a concurrent
 *    `deletePortfolio` must produce a named `404`-mapped error, never the raw
 *    `23503` that `problem-json.filter.ts` would turn into a **500**. GATE-2
 *    re-derives this independently (PD-T6); this is the implementation-level
 *    version that must be green before that gate runs.
 *  - **FR-465's ninth ordered delete**, seen from this side: an iconed
 *    portfolio deletes cleanly and leaves no icon row. The release-gated
 *    query-verified version with its positive companion is PD-T6's.
 *  - **The reads touch nothing else.** `getPortfolioIcon` never reads
 *    `portfolio` (FR-463/SD-5) and no write here moves `calc_epoch` — both
 *    asserted off the wire, because "there is no such statement" is exactly the
 *    claim a code reading cannot settle.
 */

/** A minimal but structurally real PNG header — signature plus a 13-byte IHDR carrying the dimensions, padded so each fixture has a distinct length. */
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

describe("ledger — portfolio icon service (PD-T5, real app_web role)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  /** A second `app_web` connection, its own physical socket — the racing `deletePortfolio` runs here. */
  let appWebSql2: postgres.Sql;
  let appWebDb2: Db;
  /** A third, which holds the `portfolio` row's `FOR UPDATE` so the race below is a deterministic interleaving rather than a coin flip (`cash-account-service.integration.test.ts`'s own shape). */
  let appWebSql3: postgres.Sql;
  let appWebDb3: Db;
  /** A dedicated connection whose statements are captured, so nothing a fixture issues is ever attributed to a measured call. */
  let countedSql: postgres.Sql;
  let countedDb: Db;
  let statements: string[] = [];

  const tenantA = "00000000-0000-7000-8000-00000068000a";
  const userA = "00000000-0000-7000-8000-0000006800a1";

  let portfolioCounter = 0;
  async function freshPortfolio(label: string): Promise<string> {
    portfolioCounter += 1;
    const created = await createPortfolio(appWebDb, {
      tenantId: tenantA,
      name: `PD-T5 ${label} ${portfolioCounter}`,
    });
    return created.id;
  }

  /** The stored row, read as the owner. A return value is never the evidence for a persistence claim. */
  async function row(portfolioId: string) {
    const [found] = await ownerDb
      .select()
      .from(portfolioIcon)
      .where(and(eq(portfolioIcon.tenantId, tenantA), eq(portfolioIcon.portfolioId, portfolioId)));
    return found;
  }

  async function iconRowCount(portfolioId: string): Promise<number> {
    const rows = await ownerDb
      .select({ n: sql<number>`count(*)::int` })
      .from(portfolioIcon)
      .where(eq(portfolioIcon.portfolioId, portfolioId));
    return rows[0]?.n ?? 0;
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    appWebSql2 = postgres(pg.appWebUri, { max: 1 });
    appWebDb2 = createDb(appWebSql2);
    appWebSql3 = postgres(pg.appWebUri, { max: 1 });
    appWebDb3 = createDb(appWebSql3);
    countedSql = postgres(pg.appWebUri, {
      max: 1,
      debug: (_connection, query) => statements.push(query),
    });
    countedDb = createDb(countedSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }]);
    await ownerDb.insert(appUser).values([
      {
        id: userA,
        tenantId: tenantA,
        email: "a@pd-t5-portfolio-icon.example",
        passwordHash: "argon2id$x",
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appWebSql2?.end({ timeout: 5 });
    await appWebSql3?.end({ timeout: 5 });
    await countedSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  describe("FR-461 — one row per portfolio, bytes stored verbatim, replace is not delete-then-insert", () => {
    it("a first set stores the bytes byte-for-byte and returns the metadata without them", async () => {
      const portfolioId = await freshPortfolio("first set");
      const bytes = png(128, 96, 3182);

      const meta = await setPortfolioIcon(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        bytes: new Uint8Array(bytes),
        contentType: "image/png",
        widthPx: 128,
        heightPx: 96,
      });

      expect(meta).toMatchObject({
        tenantId: tenantA,
        portfolioId,
        contentType: "image/png",
        byteLength: 3182,
        widthPx: 128,
        heightPx: 96,
      });
      // The caller just sent up to 256 KiB; echoing it back would double every
      // upload for no consumer.
      expect("bytes" in meta).toBe(false);
      // FR-462/SD-2: there is no provenance column on this table at all.
      expect("source" in meta).toBe(false);

      const stored = await row(portfolioId);
      // Byte identity, not length equality: "stored verbatim" survives a
      // re-encode or a metadata strip only if the bytes themselves are compared.
      expect(Buffer.from(stored!.bytes)).toEqual(bytes);

      const fetched = await getPortfolioIcon(appWebDb, { tenantId: tenantA, portfolioId });
      expect(Buffer.from(fetched!.bytes)).toEqual(bytes);
      expect(fetched!.contentType).toBe("image/png");
    });

    it("a set on a portfolio that already has an icon REPLACES it — one row, the new bytes, no DELETE on the wire", async () => {
      const portfolioId = await freshPortfolio("replace");
      const alpha = png(64, 64, 900);
      const beta = png(200, 150, 4096);

      await setPortfolioIcon(countedDb, {
        tenantId: tenantA,
        portfolioId,
        bytes: new Uint8Array(alpha),
        contentType: "image/png",
        widthPx: 64,
        heightPx: 64,
      });

      statements = [];
      await setPortfolioIcon(countedDb, {
        tenantId: tenantA,
        portfolioId,
        bytes: new Uint8Array(beta),
        contentType: "image/png",
        widthPx: 200,
        heightPx: 150,
      });

      expect(await iconRowCount(portfolioId)).toBe(1);
      const stored = await row(portfolioId);
      expect(Buffer.from(stored!.bytes)).toEqual(beta);
      expect(stored!.widthPx).toBe(200);

      // FR-461 measured on the wire rather than read off the source: a
      // delete-then-insert pair would leave the portfolio iconless for the
      // window between them, which is precisely what the requirement forbids.
      expect(statements.some((statement) => /delete/i.test(statement))).toBe(false);
      expect(
        statements.filter((statement) => /insert into "portfolio_icon"/i.test(statement)),
      ).toHaveLength(1);
    });
  });

  describe("PD-7 — the portfolio row is locked before the write, so a concurrent delete is a 404 and never a 500", () => {
    it("a set racing a deletePortfolio that wins resolves to PortfolioIconPortfolioNotFoundError, never a raw 23503", async () => {
      const portfolioId = await freshPortfolio("race");

      // A third connection holds the `portfolio` row, so the two racers queue
      // behind it in the order they are issued.
      const lockHeld = deferred<void>();
      const release = deferred<void>();
      const holder = withTenant(appWebDb3, tenantA, async (tx) => {
        await tx.execute(
          sql`select id from "portfolio" where tenant_id = ${tenantA}::uuid and id = ${portfolioId}::uuid for update`,
        );
        lockHeld.resolve();
        await release.promise;
      });
      await lockHeld.promise;

      const deletePromise = deletePortfolio(appWebDb2, {
        tenantId: tenantA,
        portfolioId,
        deletedBy: userA,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const set = startRacing(
        setPortfolioIcon(appWebDb, {
          tenantId: tenantA,
          portfolioId,
          bytes: new Uint8Array(png(48, 48, 600)),
          contentType: "image/png",
          widthPx: 48,
          heightPx: 48,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Genuinely blocked: this is what proves the lock is taken at all, rather
      // than the set simply finishing before the delete starts.
      expect(set.settled()).toBe(false);

      release.resolve();
      await holder;
      expect((await deletePromise).deleted).toBe(true);

      const error = rejectionOf(await set.outcome, "setPortfolioIcon");
      expect(error).toBeInstanceOf(PortfolioIconPortfolioNotFoundError);
      // The two failure modes PD-7 exists to make unreachable, ruled out by
      // name rather than by "it threw something": the unmapped FK violation
      // (a 500) and the misleading delete-blocked 409.
      expect(sqlstateOf(error)).toBeUndefined();
      expect((error as Error).name).not.toBe("PortfolioDeleteBlockedByLinkedTransactionError");

      // And nothing was written for the portfolio that no longer exists.
      expect(await iconRowCount(portfolioId)).toBe(0);
    });

    it("a set for an unknown portfolio id is the same named error — the lock is the probe", async () => {
      const raised = await setPortfolioIcon(appWebDb, {
        tenantId: tenantA,
        portfolioId: "00000000-0000-7000-8000-0000006800ff",
        bytes: new Uint8Array(png(16, 16, 100)),
        contentType: "image/png",
        widthPx: 16,
        heightPx: 16,
      }).catch((err: unknown) => err);
      expect(raised).toBeInstanceOf(PortfolioIconPortfolioNotFoundError);
    });
  });

  describe("FR-463/FR-465 — remove is idempotent, get reads one table, the cascade takes the row with it", () => {
    it("remove answers with no error whether or not a row existed, and leaves get returning null", async () => {
      const portfolioId = await freshPortfolio("remove");
      await setPortfolioIcon(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        bytes: new Uint8Array(png(24, 24, 300)),
        contentType: "image/png",
        widthPx: 24,
        heightPx: 24,
      });

      await removePortfolioIcon(appWebDb, { tenantId: tenantA, portfolioId });
      expect(await getPortfolioIcon(appWebDb, { tenantId: tenantA, portfolioId })).toBeNull();
      // Twice: two tabs or a double-click must not make the second attempt an
      // error for having succeeded.
      await expect(
        removePortfolioIcon(appWebDb, { tenantId: tenantA, portfolioId }),
      ).resolves.toBeUndefined();
      expect(await iconRowCount(portfolioId)).toBe(0);
    });

    it("FR-463/SD-5: a get issues one PK lookup and never reads `portfolio`", async () => {
      const portfolioId = await freshPortfolio("get statements");
      await setPortfolioIcon(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        bytes: new Uint8Array(png(20, 20, 200)),
        contentType: "image/png",
        widthPx: 20,
        heightPx: 20,
      });

      statements = [];
      await getPortfolioIcon(countedDb, { tenantId: tenantA, portfolioId });

      // `from "portfolio"` with the closing quote, so `portfolio_icon` does not
      // match it: the claim is that no existence probe was added on a mistaken
      // analogy with `getInstrumentIcon`'s own (which exists for a reason that
      // does not transfer).
      expect(statements.some((statement) => /from "portfolio"/i.test(statement))).toBe(false);
      expect(
        statements.filter((statement) => /from "portfolio_icon"/i.test(statement)),
      ).toHaveLength(1);
    });

    it("FR-465: deleting an iconed portfolio succeeds and leaves zero icon rows", async () => {
      const portfolioId = await freshPortfolio("cascade");
      await setPortfolioIcon(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        bytes: new Uint8Array(png(40, 40, 500)),
        contentType: "image/png",
        widthPx: 40,
        heightPx: 40,
      });
      expect(await iconRowCount(portfolioId)).toBe(1);

      const result = await deletePortfolio(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        deletedBy: userA,
      });

      // Not a 409 from the `23503` backstop: the ninth ordered delete is what
      // makes the delete of an iconed portfolio an ordinary success.
      expect(result.deleted).toBe(true);
      expect(await iconRowCount(portfolioId)).toBe(0);
    });
  });

  it("an icon write fans out to nothing — no calc_epoch bump on either a set or a remove", async () => {
    const portfolioId = await freshPortfolio("fan-out");
    const epochBefore = await calcEpochOf(portfolioId);

    await setPortfolioIcon(appWebDb, {
      tenantId: tenantA,
      portfolioId,
      bytes: new Uint8Array(png(36, 36, 400)),
      contentType: "image/png",
      widthPx: 36,
      heightPx: 36,
    });
    expect(await calcEpochOf(portfolioId)).toBe(epochBefore);

    await removePortfolioIcon(appWebDb, { tenantId: tenantA, portfolioId });
    // Asserted rather than merely stated, because every *other* write in this
    // package fans out, so an absence reads as an omission until it is pinned.
    expect(await calcEpochOf(portfolioId)).toBe(epochBefore);
  });

  async function calcEpochOf(portfolioId: string): Promise<string> {
    const [found] = await ownerDb.execute<{ calc_epoch: string }>(
      sql`select calc_epoch::text from "portfolio" where id = ${portfolioId}::uuid`,
    );
    return found!.calc_epoch;
  }
});

/** The SQLSTATE of a raw Postgres error, or `undefined` when the value is a domain error — which is what the race assertion wants to see. */
function sqlstateOf(err: unknown): string | undefined {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) return err.cause.code;
  return undefined;
}
