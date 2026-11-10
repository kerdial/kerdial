import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Decimal } from "@kerdial/core-decimal";
import { createDb, createPostgresClient, type Db } from "@kerdial/platform-db";
import { MIGRATIONS_FOLDER, type MigratedPostgres } from "@kerdial/platform-test-support";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  IMPORT_FINGERPRINT_RECIPE,
  occurrenceOrdinals,
  planImport,
  type ImportPlan,
  type NeutralCashMovementRow,
  type ParsedRow,
  type ParseResult,
} from "../index.js";
import type { PlannedTransactionWrite } from "./plan.js";
import {
  applyAssetCatalogue,
  applyWithGenerousDeadline,
  buildWriteService,
  parsedFixture,
  planContext,
  seedTenant,
  tally,
  type HarnessIds,
} from "./__tests__/apply-harness.js";

/**
 * **FT-19 / AC-279 (Batch C) — FR-256: the importer is unchanged by phase 1,
 * and a file imported *before* it still skips every row *after* it.**
 *
 * **…and FT-43 / AC-243 (Batch G) — RF7: the
 * first re-import after phase 2 imports every row AGAIN.** The two live in one
 * suite because they need one fixture: a population of rows carrying genuine
 * pre-cycle `pp1:` fingerprints, migrated forward. Read the second half as the
 * deliberate *end* of the first half's guarantee — phase 1 preserved
 * idempotency across a migration, and phase 2 spends it on purpose.
 *
 * ## What was removed here, and why (FT-43's second criterion)
 *
 * This suite asserted `IMPORT_FINGERPRINT_RECIPE === "pp1"` and that a
 * re-import skipped every imported row. **Both are now false by design** and both
 * are gone: FT-40 bumped the recipe to `pp2` because the canonical string
 * gained `brokerFee` and `taxAmount`. Leaving the recipe assertion in place
 * against legacy rows would have made it vacuously true — it would have
 * described a column of stored strings nothing recomputes — which is the
 * "vacuous green" shape this repository's lessons flag. The `pp1:` values are
 * still here, but as the **fixture** rather than the claim: {@link legacyPp1Fingerprint}
 * reproduces the pre-cycle recipe as checked-in data, so a legacy row is a
 * real legacy row and not a prefix-swapped stand-in.
 *
 * No stored fingerprint is backfilled (L8, and the corpus is test data). The
 * revisit trigger is recorded in the release note: **the day the user imports a
 * file they care about.**
 *
 * ## FT-19's half
 *
 * A **proof, not a change**: at Batch C `git diff --exit-code importer/src` was
 * clean and `fingerprintIdentityKey` took no settlement figure. What that left
 * open —
 * and what this suite closes — is whether the *rows* a pre-phase-1 import
 * wrote, after migrations `0045` and `0046` have run over them, are still
 * matched by the fingerprints a re-import computes. `0046` **writes to every
 * one of those rows** (it backfills `cash_currency`/`cash_amount`), so "the
 * migration does not touch `import_fingerprint`" is a claim about a statement
 * that really did run over the population, not a vacuous one.
 *
 * ## The shape of the fixture, and the one thing it cannot do
 *
 * The database starts at **`0044`** — the state phase 1 found the world in —
 * using the partial-migrations-folder technique FT-3 established
 * (`platform/db/src/transaction-cash-leg-backfill.integration.test.ts`'s
 * `buildMigrationsFolderUpTo`, copied here because it is private to that file).
 * The instrument catalogue is seeded there through the importer's **own**
 * asset-file pipeline, and the investment file is **planned** there, by the
 * real `planImport`, against the real `0044` schema — so every fingerprint
 * below is one a pre-phase-1 import would genuinely have stored.
 *
 * **`applyImport` itself cannot run at `0044`, and that is a fact about the
 * new code rather than a shortcut taken here.** After Batch B every
 * `TransactionWriteService` `INSERT` names `cash_currency`/`cash_amount`
 * unconditionally, so any write against a `0044` schema dies with `42703
 * column "cash_currency" does not exist` (asserted directly, over HTTP, in
 * `api/src/transactions.e2e.test.ts`'s AC-257 pre-migration block). The rows a
 * pre-phase-1 import left behind are therefore written here with **raw SQL
 * naming pre-`0045` columns only** — the same `insertFingerprintedRows` idiom
 * `plan.integration.test.ts` already uses — carrying the fingerprints
 * `planImport` really computed. The row *shape* is a stand-in; the
 * `import_fingerprint` column, which is the only column the skip decision
 * reads, is not. Stated here rather than glossed.
 */

const IDS: HarnessIds = {
  tenantId: "00000000-0000-7000-8000-0000000f1901",
  userId: "00000000-0000-7000-8000-0000000f1902",
  sessionId: "00000000-0000-7000-8000-0000000f1903",
  portfolioId: "00000000-0000-7000-8000-0000000f1904",
  cashAccountIds: ["00000000-0000-7000-8000-0000000f1905"],
};
const ACCOUNT = IDS.cashAccountIds[0]!;
const DESTINATION = { portfolioId: IDS.portfolioId, cashAccountId: ACCOUNT };

/**
 * The investment file's own imported count against this fixture — CI-13 pins
 * the same number.
 *
 * **Cashless-distribution support added four.** The fixture's four
 * cashless-distribution rows were `UNSUPPORTED_ROW_TYPE` until
 * `SHARE_DISTRIBUTION` existed to hold them (migration `0056`); they now
 * import, and the file rejects nothing but the three trades of its
 * unresolvable `NESM.F` listing: 30 trades + 4 distributions = 34.
 */
const INVESTMENT_IMPORTED = 34;
const INVESTMENT_UNRESOLVED = 3;

/**
 * A temporary migrations folder holding only the journal entries (and their
 * `.sql` files) whose tag is `<= upTo` — FT-3's technique, verbatim in shape.
 * Drizzle records the applied set by `when` timestamp, so migrating with the
 * `<= 0044` folder, then the `<= 0045` folder, then the real folder applies
 * exactly `0045` and then exactly `0046`.
 */
function buildMigrationsFolderUpTo(upTo: string): string {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  const kept = journal.entries.filter((entry) => entry.tag <= upTo);
  expect(kept.length, `no journal entry at or before ${upTo}`).toBeGreaterThan(0);
  expect(kept.length, `${upTo} is not a partial set`).toBeLessThan(journal.entries.length);

  const tempDir = mkdtempSync(join(tmpdir(), `ft19-migrations-upto-${upTo}-`));
  mkdirSync(join(tempDir, "meta"), { recursive: true });
  for (const file of readdirSync(MIGRATIONS_FOLDER)) {
    if (!file.endsWith(".sql")) continue;
    const tag = file.replace(/\.sql$/, "");
    if (kept.some((entry) => entry.tag === tag)) {
      writeFileSync(join(tempDir, file), readFileSync(join(MIGRATIONS_FOLDER, file)));
    }
  }
  writeFileSync(
    join(tempDir, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  return tempDir;
}

/**
 * **The pre-cycle recipe, checked in as data.** FT-40 bumped
 * `IMPORT_FINGERPRINT_RECIPE` to `pp2` and added two slots, so the production
 * code can no longer produce the value a pre-cycle import stored — and this
 * suite needs exactly that value, or its legacy population is a costume rather
 * than a fixture.
 *
 * Twelve slots, `pp1` first, no `brokerFee` and no `taxAmount`, the same
 * `U+001F` separator and the same 12-dp normalisation. Transcribed from
 * `fingerprint.ts` as it stood before phase 1, and deliberately **not** imported
 * from anywhere: a helper that shared code with the current recipe would move
 * when the current recipe moved, and then a "legacy" row would silently stop
 * being one.
 */
function legacyPp1Fingerprint(
  write: {
    readonly kind: string;
    readonly tradeDate: string;
    readonly instrumentId: string | null;
    readonly quantity: Decimal | null;
    readonly unitPrice: Decimal | null;
    readonly amount: Decimal | null;
    readonly currency: string;
    readonly feeAmount: Decimal | null;
    readonly withholdingAmount: Decimal | null;
    readonly cashAccountId: string;
  },
  occurrence: number,
): string {
  const digest = createHash("sha256")
    .update(`${legacyPp1IdentityKey(write)}${LEGACY_SEPARATOR}${String(occurrence)}`, "utf8")
    .digest("hex");
  return `pp1:${digest}`;
}

const LEGACY_SEPARATOR = "\u001F";

function legacyPp1IdentityKey(write: {
  readonly kind: string;
  readonly tradeDate: string;
  readonly instrumentId: string | null;
  readonly quantity: Decimal | null;
  readonly unitPrice: Decimal | null;
  readonly amount: Decimal | null;
  readonly currency: string;
  readonly feeAmount: Decimal | null;
  readonly withholdingAmount: Decimal | null;
  readonly cashAccountId: string;
}): string {
  const fixed = (value: Decimal | null): string => (value === null ? "" : value.toFixed(12));
  return [
    "pp1",
    write.kind,
    write.tradeDate,
    write.instrumentId ?? "",
    fixed(write.quantity),
    fixed(write.unitPrice),
    fixed(write.amount),
    write.currency,
    fixed(write.feeAmount),
    fixed(write.withholdingAmount),
    write.cashAccountId,
  ].join(LEGACY_SEPARATOR);
}

describe("FT-19 / AC-279 + FT-43 / AC-243 — a pre-cycle import across phase 1, then the pp2 bump", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: Db;

  /** The fingerprints the real `planImport` computed **at `0044`** — a pre-phase-1 import's own. */
  let fingerprintsBefore: string[] = [];
  /** That same plan, kept so its counts can be compared against the post-migration re-plan. */
  let planBefore: ImportPlan;
  /** What the **current** recipe computes for those same writes — the `pp2:` values FT-43's second import stores. */
  let plannedPp2Fingerprints: string[] = [];

  async function storedFingerprints(): Promise<string[]> {
    const rows = await client.unsafe<{ import_fingerprint: string }[]>(
      `select import_fingerprint from "transaction"
        where import_fingerprint is not null order by import_fingerprint`,
    );
    return rows.map((row) => row.import_fingerprint);
  }

  async function countTransactions(): Promise<number> {
    const [row] = await client.unsafe<{ n: number }[]>(
      `select count(*)::int as n from "transaction"`,
    );
    return Number(row!.n);
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off"])
      .start();
    client = createPostgresClient(container.getConnectionUri());
    db = createDb(client);

    // ------------------------------------------------------------------
    // (1) The world as it stood at `0044`.
    // ------------------------------------------------------------------
    await migrate(db, { migrationsFolder: buildMigrationsFolderUpTo("0044_zzz") });
    const columnsAt0044 = await client.unsafe<{ column_name: string }[]>(
      `select column_name from information_schema.columns
        where table_name = 'transaction' and column_name in ('cash_currency', 'cash_amount')`,
    );
    expect(columnsAt0044, "the fixture must start before 0045, or it proves nothing").toHaveLength(
      0,
    );

    // `seedTenant` and `applyAssetCatalogue` want a `MigratedPostgres`; only
    // `ownerClient`/`ownerDb` are reachable from either, so the rest is stated
    // as unreachable rather than invented.
    const pg = {
      ownerUri: container.getConnectionUri(),
      ownerClient: client,
      ownerDb: db,
      appWebUri: "",
      appIngestUri: "",
      stop: async () => {},
    } as unknown as MigratedPostgres;
    await seedTenant(pg, IDS);

    // `scpi` cycle (migration `0074`): `instrument` gained two columns after
    // `0044`, and the ledger code below inserts and returns *every* column the
    // current schema module declares. They are added here, exactly as `0074`
    // types them, for steps (1)–(2) only, and dropped again before step (3), so
    // the forward migration still adds them for real. They carry no part of a
    // transaction fingerprint.
    await client.unsafe(
      `alter table "instrument" add column "management_company" text,
                                add column "subscription_fee_pct" numeric(5, 2)`,
    );

    // The catalogue, seeded through the importer's **own** asset pipeline —
    // it writes `instrument` rows and no `transaction` row, so it runs at
    // `0044` unchanged (bar the two `0074` columns above).
    const writes = buildWriteService(db, IDS.tenantId);
    await applyAssetCatalogue(db, IDS, writes);

    // ------------------------------------------------------------------
    // (2) The pre-phase-1 import: planned for real, against `0044`.
    // ------------------------------------------------------------------
    planBefore = await planImport(
      parsedFixture("investment.csv", "INVESTMENT_ACCOUNT_TRANSACTIONS"),
      planContext(db, IDS, DESTINATION),
    );
    // The writes the pre-cycle plan produced, re-fingerprinted under the
    // **pp1** recipe (see {@link legacyPp1Fingerprint}). `planImport` itself now
    // computes `pp2:` values, so taking `importFingerprint` verbatim would give
    // this fixture post-cycle hashes and quietly turn both halves of the suite
    // into tautologies. The occurrence ordinals are recomputed the same way
    // `plan` assigns them — per identity key, in file order — because a
    // legitimately identical pair must get 1 and 2 here too or two of the 34
    // legacy rows would collide.
    const legacyWrites = planBefore.outcomes
      .filter((outcome) => outcome.outcome === "IMPORT")
      .map((outcome) => (outcome as { write: PlannedTransactionWrite }).write);
    const legacyOrdinals = occurrenceOrdinals(legacyWrites.map(legacyPp1IdentityKey));
    fingerprintsBefore = legacyWrites.map((write, index) =>
      legacyPp1Fingerprint(write, legacyOrdinals[index]!),
    );
    plannedPp2Fingerprints = legacyWrites.map((write) => write.importFingerprint);

    // …and the rows it left behind. Pre-`0045` columns only — see this file's
    // header for why the shape is a stand-in and the fingerprint is not.
    let seq = 1;
    for (const fingerprint of fingerprintsBefore) {
      seq += 1;
      await client.unsafe(
        `insert into "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                                    gross_amount, txn_currency, fx_rate, fx_rate_source,
                                    cash_account_id, import_fingerprint)
         values (gen_random_uuid(), $1::uuid, $2::uuid, 'DEPOSIT', '2026-06-21', $3,
                 '100', 'EUR', '1', 'IMPLIED_BASE', $4::uuid, $5)`,
        [IDS.tenantId, IDS.portfolioId, seq, ACCOUNT, fingerprint],
      );
    }

    // The `0074` stand-ins go before anything migrates forward (see step (1)).
    await client.unsafe(
      `alter table "instrument" drop column "management_company",
                                drop column "subscription_fee_pct"`,
    );

    // ------------------------------------------------------------------
    // (3) Phase 1 lands: `0045`, then `0046`, over that population.
    // ------------------------------------------------------------------
    await migrate(db, { migrationsFolder: buildMigrationsFolderUpTo("0045_zzz") });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 300_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("the pre-cycle population is non-trivial, and every one of its fingerprints is a genuine pp1 one", () => {
    // FR-260 (shape change): this asserted `IMPORT_FINGERPRINT_RECIPE ===
    // "pp1"` until FT-40. The recipe is now `pp2` — that is the bump — and the
    // claim that survives is about the **fixture**, not the constant: these 34
    // values were produced by the pre-cycle recipe, so the rows below are the
    // rows a pre-cycle import really left behind.
    expect(IMPORT_FINGERPRINT_RECIPE).toBe("pp2");
    expect(fingerprintsBefore).toHaveLength(INVESTMENT_IMPORTED);
    // Not "they all look like fingerprints": each one is checked against
    // `0042`'s own stored shape, and the set is checked to hold no duplicate,
    // because a set that collapsed to one value would skip just as happily.
    for (const fingerprint of fingerprintsBefore) {
      expect(fingerprint).toMatch(/^pp1:[0-9a-f]{64}$/);
    }
    expect(new Set(fingerprintsBefore).size).toBe(INVESTMENT_IMPORTED);
  });

  it("the migrations really ran over those rows — every one is now D1/D2, by query", async () => {
    const [row] = await client.unsafe<
      {
        total: number;
        degenerate: number;
        unfilled: number;
      }[]
    >(
      `select count(*)::int as total,
              count(*) filter (where cash_currency = txn_currency
                                 and cash_amount = gross_amount)::int as degenerate,
              count(*) filter (where cash_currency is null or cash_amount is null)::int as unfilled
         from "transaction" where import_fingerprint is not null`,
    );

    // Every imported row is the degenerate case — settlement currency = the
    // transaction's own, settled amount = the gross — which is FR-256's whole
    // claim about what an imported row is: `apply.ts` submits neither field,
    // and `0046` backfilled the pre-existing ones the same way.
    expect(Number(row!.total)).toBe(INVESTMENT_IMPORTED);
    expect(Number(row!.degenerate)).toBe(INVESTMENT_IMPORTED);
    expect(Number(row!.unfilled)).toBe(0);
  });

  it("every stored fingerprint is byte-identical to the one computed before the migration", async () => {
    const after = await storedFingerprints();

    // FT-19's claim, unchanged and still true: `0045`/`0046` wrote to every one
    // of these rows and moved none of their fingerprints. That the values are
    // `pp1:` is now a statement about the fixture, not about the recipe.
    expect(after).toEqual([...fingerprintsBefore].sort());
    for (const fingerprint of after) {
      expect(fingerprint.startsWith("pp1:")).toBe(true);
    }
  });

  /**
   * **FT-43 / AC-243, rewritten (RF7).** Where phase 1 preserved the skip, phase
   * 2 spends it: the stored fingerprints are `pp1:` and every fingerprint the
   * current recipe computes is `pp2:`, so nothing matches and the whole file
   * imports a second time. This is the accepted consequence of the bump, and it
   * is asserted rather than discovered — including the row count, as an exact
   * literal, because `> 0` would pass just as well if only one row duplicated.
   */
  it("FT-43 — the FIRST re-import after the pp2 bump imports every row AGAIN, and the count doubles", async () => {
    expect(await countTransactions()).toBe(INVESTMENT_IMPORTED);

    const replanned = await planImport(
      parsedFixture("investment.csv", "INVESTMENT_ACCOUNT_TRANSACTIONS"),
      planContext(db, IDS, DESTINATION),
    );

    // Not one ALREADY_IMPORTED among them — the pp1 rows are invisible to a
    // pp2 lookup, which is precisely RF7.
    expect(tally(replanned.outcomes)).toEqual({
      IMPORT: INVESTMENT_IMPORTED,
      INSTRUMENT_NOT_RESOLVED: INVESTMENT_UNRESOLVED,
    });
    // The rejected rows are the same rows for the same reasons — what changed
    // is the fingerprint match, not a file that stopped parsing.
    expect(replanned.summary.rejected).toBe(planBefore.summary.rejected);
    // Every fingerprint it would write is a `pp2:` one, and none of them
    // collides with a stored `pp1:` value.
    const wouldWrite = replanned.outcomes
      .filter((outcome) => outcome.outcome === "IMPORT")
      .map((outcome) => (outcome as { write: PlannedTransactionWrite }).write.importFingerprint);
    expect(wouldWrite).toEqual(plannedPp2Fingerprints);
    for (const fingerprint of wouldWrite) {
      expect(fingerprint).toMatch(/^pp2:[0-9a-f]{64}$/);
      expect(fingerprintsBefore).not.toContain(fingerprint);
    }

    // …and it is not a claim about a plan. The rows are written.
    const applied = await applyWithGenerousDeadline(
      replanned,
      db,
      IDS,
      buildWriteService(db, IDS.tenantId),
      DESTINATION,
    );
    expect(applied.summary.imported).toBe(INVESTMENT_IMPORTED);
    expect(await countTransactions()).toBe(INVESTMENT_IMPORTED * 2);
    // The legacy rows are untouched: no backfill, no rewrite (L8).
    const stored = await storedFingerprints();
    expect(stored.filter((value) => value.startsWith("pp1:")).sort()).toEqual(
      [...fingerprintsBefore].sort(),
    );
    expect(stored.filter((value) => value.startsWith("pp2:")).sort()).toEqual(
      [...plannedPp2Fingerprints].sort(),
    );
  }, 300_000);

  /**
   * The positive companion, and the half that makes the duplication a *one-time
   * transition* rather than a broken fingerprint: with `pp2` now on both sides,
   * the very next re-import skips everything again.
   */
  it("FT-43 — the SECOND re-import, pp2 on both sides, skips every row and the count does not move", async () => {
    const before = await countTransactions();
    expect(before).toBe(INVESTMENT_IMPORTED * 2);

    const replanned = await planImport(
      parsedFixture("investment.csv", "INVESTMENT_ACCOUNT_TRANSACTIONS"),
      planContext(db, IDS, DESTINATION),
    );

    expect(tally(replanned.outcomes)).toEqual({
      ALREADY_IMPORTED: INVESTMENT_IMPORTED,
      INSTRUMENT_NOT_RESOLVED: INVESTMENT_UNRESOLVED,
    });
    expect(replanned.summary.imported).toBe(0);
    expect(await countTransactions()).toBe(before);
  }, 120_000);

  it("a row APPENDED to that same file still imports, so the skip is matching and not a blanket refusal", async () => {
    const original = parsedFixture("investment.csv", "INVESTMENT_ACCOUNT_TRANSACTIONS");
    const appendedRow: NeutralCashMovementRow = {
      shape: "CASH_MOVEMENT",
      direction: "IN",
      tradeDate: "2026-07-01",
      tradeTs: null,
      amount: new Decimal("137.42"),
      currency: "EUR",
      note: null,
    };
    const appended: ParsedRow = {
      at: { line: original.rowCount + 2, index: original.rowCount },
      ok: true,
      row: appendedRow,
    };
    const withOneMore: ParseResult = {
      fileType: original.fileType,
      rowCount: original.rowCount + 1,
      rows: [...original.rows, appended],
    };

    const replanned = await planImport(withOneMore, planContext(db, IDS, DESTINATION));

    expect(tally(replanned.outcomes)).toEqual({
      IMPORT: 1,
      ALREADY_IMPORTED: INVESTMENT_IMPORTED,
      INSTRUMENT_NOT_RESOLVED: INVESTMENT_UNRESOLVED,
    });
    // …and the one row it would write is the appended one, carrying a `pp2:`
    // fingerprint of its own (FR-260: this read `pp1:` before FT-40).
    const toImport = replanned.outcomes.filter((outcome) => outcome.outcome === "IMPORT");
    expect(toImport).toHaveLength(1);
    const write = (toImport[0] as { write: { importFingerprint: string; amount: Decimal | null } })
      .write;
    expect(write.amount?.toString()).toBe("137.42");
    expect(write.importFingerprint).toMatch(/^pp2:[0-9a-f]{64}$/);
    expect(fingerprintsBefore).not.toContain(write.importFingerprint);
    expect(plannedPp2Fingerprints).not.toContain(write.importFingerprint);
  });
});
