import {
  RATE_PRESET_DEFAULTS,
  RATE_PRESET_MAX_PER_RUBRIQUE,
  RATE_PRESET_RUBRIQUES,
  type RatePreset,
} from "@kerdial/api-contracts";
import { createDb, withTenant, type Db } from "@kerdial/platform-db";
import {
  deferred,
  startMigratedPostgres,
  waitUntilOrThrow,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockTenantWrites } from "./portfolio-lock.js";
import { getRatePresets, replaceRatePresets } from "./rate-preset-service.js";

/**
 * TDR-T3 — `getRatePresets` / `replaceRatePresets`
 * (FR-664, FR-667, AC-553, AC-554's state half, AC-555's ledger half).
 *
 * Every call runs as the password-authenticated `app_web` role, the role RLS
 * applies to; the superuser only seeds tenants and counts rows. Each case owns
 * its tenant, so no case depends on another's writes.
 */

const TENANT_FRESH = "00000000-0000-7000-8000-000000077001";
const TENANT_EMPTY = "00000000-0000-7000-8000-000000077002";
const TENANT_ORDER = "00000000-0000-7000-8000-000000077003";
const TENANT_IDEMPOTENT = "00000000-0000-7000-8000-000000077004";
const TENANT_LOCKED = "00000000-0000-7000-8000-000000077005";
const TENANT_UNLOCKED = "00000000-0000-7000-8000-000000077006";
const TENANT_A = "00000000-0000-7000-8000-000000077007";
const TENANT_B = "00000000-0000-7000-8000-000000077008";

const LIST: readonly RatePreset[] = [
  { rubrique: "WITHHOLDING", label: "PFU", rate: "30" },
  { rubrique: "BROKERAGE", label: "Saxo", rate: "0.08", minimum: "2" },
  { rubrique: "TAX", label: "TTF", rate: "0.4" },
  { rubrique: "BROKERAGE", label: "Bourso", rate: "0.5" },
];

describe("ledger — rate-preset service (TDR-T3, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let serviceSql: postgres.Sql;
  let db: Db;
  let holderSql: postgres.Sql;
  let holderDb: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    serviceSql = postgres(pg.appWebUri, { max: 4 });
    db = createDb(serviceSql);
    holderSql = postgres(pg.appWebUri, { max: 1 });
    holderDb = createDb(holderSql);
    await pg.ownerClient`
      INSERT INTO "tenant" (id) SELECT unnest(${[
        TENANT_FRESH,
        TENANT_EMPTY,
        TENANT_ORDER,
        TENANT_IDEMPOTENT,
        TENANT_LOCKED,
        TENANT_UNLOCKED,
        TENANT_A,
        TENANT_B,
      ]}::uuid[])`;
  }, 180_000);

  afterAll(async () => {
    await Promise.all([serviceSql?.end({ timeout: 5 }), holderSql?.end({ timeout: 5 })]);
    await pg?.stop();
  }, 30_000);

  async function rowCount(tenantId: string): Promise<number> {
    const [row] = await pg.ownerClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "rate_preset_list" WHERE tenant_id = ${tenantId}::uuid`;
    return row!.n;
  }

  async function rowVersion(tenantId: string): Promise<{ xmin: string; updatedAt: string }> {
    const [row] = await pg.ownerClient<{ xmin: string; updatedAt: string }[]>`
      SELECT xmin::text AS xmin, updated_at::text AS "updatedAt"
      FROM "rate_preset_list" WHERE tenant_id = ${tenantId}::uuid`;
    return row!;
  }

  it("a fresh tenant reads the four defaults, and two reads write no row (FR-664)", async () => {
    expect(await getRatePresets(db, TENANT_FRESH)).toEqual(RATE_PRESET_DEFAULTS);
    expect(await getRatePresets(db, TENANT_FRESH)).toEqual(RATE_PRESET_DEFAULTS);
    expect(await rowCount(TENANT_FRESH)).toBe(0);
  });

  it("replace([]) is stored, and a later read returns [] — never re-seeded (AC-553)", async () => {
    expect(await replaceRatePresets(db, TENANT_EMPTY, [])).toEqual([]);
    expect(await getRatePresets(db, TENANT_EMPTY)).toEqual([]);
    expect(await rowCount(TENANT_EMPTY)).toBe(1);
  });

  it("replace returns the stored list, and a read returns exactly it, in order (AC-554)", async () => {
    expect(await replaceRatePresets(db, TENANT_ORDER, LIST)).toEqual(LIST);
    expect(await getRatePresets(db, TENANT_ORDER)).toEqual(LIST);
    const reordered = [LIST[3]!, LIST[0]!, LIST[2]!, LIST[1]!];
    await replaceRatePresets(db, TENANT_ORDER, reordered);
    expect(await getRatePresets(db, TENANT_ORDER)).toEqual(reordered);
  });

  it("a second identical replace leaves the row untouched — same xmin, same updated_at (FR-667)", async () => {
    await replaceRatePresets(db, TENANT_IDEMPOTENT, LIST);
    const first = await rowVersion(TENANT_IDEMPOTENT);
    // Let the clock move, so an unconditional UPDATE would show in updated_at too.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await replaceRatePresets(db, TENANT_IDEMPOTENT, LIST)).toEqual(LIST);
    expect(await rowVersion(TENANT_IDEMPOTENT)).toEqual(first);

    // Positive control: a different list does move both.
    await replaceRatePresets(db, TENANT_IDEMPOTENT, LIST.slice(1));
    const changed = await rowVersion(TENANT_IDEMPOTENT);
    expect(changed.xmin).not.toBe(first.xmin);
    expect(changed.updatedAt).not.toBe(first.updatedAt);
  });

  it("replace waits on the tenant's write lock, and only that tenant's (FR-667)", async () => {
    // Pre-warm every pooled connection: `Promise.all` over lazy postgres.js
    // clients is not concurrent until they are open.
    await Promise.all(Array.from({ length: 4 }, () => serviceSql`SELECT 1`));
    await holderSql`SELECT 1`;

    const locked = deferred();
    const release = deferred();
    const holder = withTenant(holderDb, TENANT_LOCKED, async (tx) => {
      await lockTenantWrites(tx, TENANT_LOCKED);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    let settled = false;
    const blocked = replaceRatePresets(db, TENANT_LOCKED, LIST).then((stored) => {
      settled = true;
      return stored;
    });
    try {
      // The replace is observably parked on an ungranted advisory lock in this database.
      await waitUntilOrThrow(
        async () => {
          const [row] = await pg.ownerClient<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_locks l
            JOIN pg_database d ON d.oid = l.database
            WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = current_database()`;
          return row!.n === 1;
        },
        10_000,
        "replaceRatePresets waiting on the tenant advisory lock",
      );
      expect(settled).toBe(false);

      // Another tenant is not blocked: the lock is per tenant, not global.
      expect(await replaceRatePresets(db, TENANT_UNLOCKED, LIST)).toEqual(LIST);
      expect(settled).toBe(false);
      expect(await rowCount(TENANT_LOCKED)).toBe(0);
    } finally {
      release.resolve();
      await holder;
    }
    expect(await blocked).toEqual(LIST);
    expect(await rowCount(TENANT_LOCKED)).toBe(1);
  });

  it("two tenants never see each other's list (AC-555, ledger half)", async () => {
    await replaceRatePresets(db, TENANT_A, LIST.slice(0, 1));
    await replaceRatePresets(db, TENANT_B, LIST.slice(1, 2));
    expect(await getRatePresets(db, TENANT_A)).toEqual(LIST.slice(0, 1));
    expect(await getRatePresets(db, TENANT_B)).toEqual(LIST.slice(1, 2));
  });

  it("rate_preset_list_bound's literal IS RATE_PRESET_MAX_PER_RUBRIQUE × RATE_PRESET_RUBRIQUES.length (drift guard, both directions)", async () => {
    const [row] = await pg.ownerClient<{ definition: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      WHERE c.conrelid = 'rate_preset_list'::regclass AND c.conname = 'rate_preset_list_bound'`;
    const bound = /jsonb_array_length\(presets\) <= (\d+)/.exec(row!.definition)?.[1];
    expect(bound).toBeDefined();
    expect(Number(bound)).toBe(RATE_PRESET_MAX_PER_RUBRIQUE * RATE_PRESET_RUBRIQUES.length);
  });
});
