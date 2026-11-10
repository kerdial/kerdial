import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CryptoRateResolver, FxRateResolver, TransactionWriteService } from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import type { MigratedPostgres } from "@kerdial/platform-test-support";

import {
  applyImport,
  DEFAULT_IMPORT_LIMITS,
  planImport,
  portfolioPerformanceImporter,
  systemClock,
  type ApplyContext,
  type ImportFileType,
  type ImportPlan,
  type AppliedRowOutcome,
  type ImportResult,
  type ParseResult,
  type PlanContext,
  type PlannedRowOutcome,
} from "../../index.js";

/**
 * Shared setup for CI-13/CI-14/CI-15's three apply suites — the same tenant
 * shape, the same write service, the same fixture readers, so the three files
 * differ only in what they assert.
 *
 * Lives under `__tests__/` because `.dependency-cruiser.cjs`'s
 * `options.exclude` skips that directory: this is test scaffolding, not a
 * module of the package, and it should add nothing to the cruise graph.
 * `ledger/src/__tests__/racing-operation.ts` is the precedent.
 *
 * **No `market/*` import anywhere below, deliberately.** `FxRateResolver` and
 * `CryptoRateResolver` each want a provider, and both providers here are
 * written as bare object literals checked structurally against the parameter
 * type rather than against an imported interface — `importer-no-market`
 * (`.dependency-cruiser.cjs`) forbids this package naming a `market/*` type
 * even in a test, and `@kerdial/market-ports` is not one of its
 * dependencies. Both throw on every fetch: every leg in these fixtures is EUR,
 * which is the tenant base currency, so `FxRateResolver.resolve`
 * short-circuits to `IMPLIED_BASE` and must never reach a provider. An
 * accidental off-base leg therefore fails loudly instead of quietly measuring
 * something else.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "__fixtures__", "portfolio-performance");

/** Committed fixture bytes, read raw — never through any importer code. */
function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixtureDir, name)));
}

/** `parse` + `validate` over a committed fixture, the two stages `planImport` takes as input. */
export function parsedFixture(name: string, fileType: ImportFileType): ParseResult {
  return portfolioPerformanceImporter.validate(
    portfolioPerformanceImporter.parse({ bytes: fixtureBytes(name), fileType }),
  );
}

/** `IMPORT`, or the reason code — the one-word label every count in these suites is taken over. */
const outcomeLabel = (outcome: PlannedRowOutcome | AppliedRowOutcome): string =>
  outcome.outcome === "IMPORT" ? "IMPORT" : outcome.reason;

/**
 * Counts by outcome label. Deliberately accepts a plan's outcomes **and** an
 * apply's, through the same function: a dry-run tally and a real tally are only
 * comparable if they are counted the same way, and two near-identical local
 * helpers are how they stop being.
 */
export function tally(
  outcomes: readonly (PlannedRowOutcome | AppliedRowOutcome)[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    const key = outcomeLabel(outcome);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export interface HarnessIds {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly portfolioId: string;
  readonly cashAccountIds: readonly string[];
}

/**
 * One tenant, one user, one session, one portfolio and as many EUR cash
 * accounts as the caller asks for. A real `session` row (rather than a made-up
 * uuid) because `transaction.updated_by_session_id` carries a foreign key —
 * an invented id would surface as an unmapped `23503` on every single row and
 * turn the whole suite into an `APPLY_FAILED` count.
 */
export async function seedTenant(pg: MigratedPostgres, ids: HarnessIds): Promise<void> {
  await pg.ownerClient`INSERT INTO "tenant" (id) VALUES (${ids.tenantId}::uuid)`;
  await pg.ownerClient`
    INSERT INTO "app_user" (id, tenant_id, email, password_hash)
    VALUES (${ids.userId}::uuid, ${ids.tenantId}::uuid, ${`${ids.userId}@import.test`}, 'argon2id$placeholder')
  `;
  await pg.ownerClient`
    INSERT INTO "session" (id, tenant_id, user_id, token_hash, expires_at)
    VALUES (${ids.sessionId}::uuid, ${ids.tenantId}::uuid, ${ids.userId}::uuid,
            ${Buffer.from(ids.sessionId)}, '2099-01-01T00:00:00Z')
  `;
  await pg.ownerClient`
    INSERT INTO "portfolio" (id, tenant_id, name)
    VALUES (${ids.portfolioId}::uuid, ${ids.tenantId}::uuid, 'csv-import apply suite')
  `;
  let index = 0;
  for (const cashAccountId of ids.cashAccountIds) {
    index += 1;
    await pg.ownerClient`
      INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency)
      VALUES (${cashAccountId}::uuid, ${ids.tenantId}::uuid, ${ids.portfolioId}::uuid,
              ${`Account ${String(index)}`}, 'EUR')
    `;
  }
}

/** A second portfolio in the same tenant, with one EUR account — for the suites that must not perturb the main portfolio's counts. */
export async function seedPortfolio(
  pg: MigratedPostgres,
  tenantId: string,
  portfolioId: string,
  cashAccountId: string,
  name: string,
): Promise<void> {
  await pg.ownerClient`
    INSERT INTO "portfolio" (id, tenant_id, name)
    VALUES (${portfolioId}::uuid, ${tenantId}::uuid, ${name})
  `;
  await pg.ownerClient`
    INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency)
    VALUES (${cashAccountId}::uuid, ${tenantId}::uuid, ${portfolioId}::uuid, ${name}, 'EUR')
  `;
}

/** See this module's header on why both providers are bare literals that throw. */
export function buildWriteService(db: Db, tenantId: string): TransactionWriteService {
  const fxRateResolver = new FxRateResolver({
    db,
    provider: {
      capabilities: () => ({
        key: "apply-suite-unreachable-fx",
        publishedPairs: [],
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded",
      }),
      fetchDailyRates: () => {
        throw new Error("every leg in this suite is EUR — no FX provider call may happen");
      },
      fetchLatestRates: () => {
        throw new Error("every leg in this suite is EUR — no FX provider call may happen");
      },
    },
    tenantId,
    baseCurrency: "EUR",
  });
  return new TransactionWriteService({
    db,
    fxRateResolver,
    cryptoRateResolver: new CryptoRateResolver({
      db,
      provider: {
        capabilities: () => ({
          key: "apply-suite-unreachable-quote",
          assetKinds: ["CRYPTO"],
          supportsLatestQuote: true,
          supportsDailyHistory: true,
          supportsCorporateActions: false,
          maxHistoryYears: 1,
          quoteQuality: "REALTIME",
          delayMinutes: 0,
          batchSize: 20,
        }),
        resolve: async () => [],
        fetchLatest: async () => [],
        fetchDailyHistory: () => {
          throw new Error("no settlement leg in this suite is priced in an asset");
        },
      },
      fxRateResolver,
    }),
  });
}

export function planContext(
  db: Db,
  ids: HarnessIds,
  destination: PlanContext["destination"],
): PlanContext {
  return {
    db,
    tenantId: ids.tenantId,
    destination,
    // `"DRY_RUN"`, and these suites then hand the resulting plan to
    // `applyImport` directly. That pairing is **only** reachable from a test:
    // through HTTP a dry run never writes, and an `APPLY` is a confirm whose
    // asset rows come from `resolutions[]`. It is kept because these
    // suites are about `apply`'s own behaviour — write order, per-row failure,
    // the deadline — and building each plan through a second, echoed-back
    // request would test the round trip instead. `imports-discovery.e2e.test.ts`
    // is what covers the round trip, over real HTTP.
    mode: "DRY_RUN",
    resolutions: [],
    discovery: null,
    limits: DEFAULT_IMPORT_LIMITS,
    clock: systemClock,
  };
}

/**
 * `applyImport` with a deadline far enough out that it cannot be the thing
 * under test. Suites that *are* testing the deadline build their own context.
 */
export async function applyWithGenerousDeadline(
  plan: ImportPlan,
  db: Db,
  ids: HarnessIds,
  writes: TransactionWriteService,
  destination: ApplyContext["destination"],
  chunkRows: number = DEFAULT_IMPORT_LIMITS.applyChunkRows,
): Promise<ImportResult> {
  return applyImport({
    plan,
    db,
    writes,
    destination,
    updatedBySessionId: ids.sessionId,
    deadlineAt: new Date(Date.now() + 600_000),
    clock: systemClock,
    chunkRows,
  });
}

/**
 * Seeds the instrument catalogue **from the asset file's own plan applied
 * through `applyImport`**, so every instrument the transaction files resolve
 * against is one this pipeline actually created — not a hand-written list that
 * could disagree with what an assets import would produce.
 *
 * Returns the applied result so the caller can assert on it.
 */
export async function applyAssetCatalogue(
  db: Db,
  ids: HarnessIds,
  writes: TransactionWriteService,
): Promise<ImportResult> {
  const plan = await planImport(parsedFixture("assets.csv", "ASSETS"), planContext(db, ids, null));
  return applyWithGenerousDeadline(plan, db, ids, writes, null);
}
