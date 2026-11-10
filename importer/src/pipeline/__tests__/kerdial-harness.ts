import {
  CryptoRateResolver,
  FxRateResolver,
  TransactionWriteService,
  type TransactionRecord,
} from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import type { MigratedPostgres } from "@kerdial/platform-test-support";

import { DEFAULT_IMPORT_LIMITS } from "../../limits.js";
import { systemClock } from "../ports.js";
import type { ImportPlan, PlanContext } from "../plan.js";
import { applyImport, type ApplyContext, type ImportResult } from "../apply.js";

/**
 * Shared setup for the Kerdial CSV write path's suites (EI-14 … EI-17).
 *
 * Under `__tests__/` because `.dependency-cruiser.cjs`'s `options.exclude`
 * skips that directory: this is test scaffolding, not a module of the package.
 *
 * **No `market/*` import anywhere below**, the same rule `apply-harness.ts`
 * states — `importer-no-market` forbids this package naming a `market/*` type
 * even in a test. The backfill scheduler the FR-557 suite counts calls on is a
 * bare object literal reached through `TransactionWriteService`'s own
 * constructor-parameter type, so no market name appears here.
 *
 * **No Kerdial column name anywhere below either.** Every row builder lives in
 * `formats/kerdial-csv/__tests__/rows.ts` and is re-exported here — see that
 * file's own header on why `pnpm import-vocabulary-gate` makes that a
 * requirement rather than a preference, and not only for the package's shipped
 * modules.
 *
 * **A fresh tenant with no portfolio at all.** AC-448 is about a transactions
 * CSV imported with *no* catalogue package beside it, into a destination that
 * does not yet hold what the file names — so the seed deliberately stops at the
 * tenant, the user and the session, and every portfolio and cash account these
 * suites observe was created by the import under test.
 */

export {
  acquisitionRow,
  cashInRow,
  disposalRow,
  distributionRow,
  exchangeRow,
  feeRow,
  interestRow,
  parseKerdial,
  parseKerdialBytes,
  reinvestmentRow,
  settledAcquisitionRow,
  shareGrantRow,
  transferInRow,
  transferOutRow,
  type Cells,
  type RowInstrument,
  type RowSite,
} from "../../formats/kerdial-csv/__tests__/rows.js";

export interface KerdialIds {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * Tenant, user and session — and **no portfolio**. A real `session` row rather
 * than an invented uuid because `transaction.updated_by_session_id` carries a
 * foreign key, and an invented one would surface as an unmapped `23503` on
 * every row and turn a whole suite into an `APPLY_FAILED` count.
 */
export async function seedBareTenant(pg: MigratedPostgres, ids: KerdialIds): Promise<void> {
  await pg.ownerClient`INSERT INTO "tenant" (id) VALUES (${ids.tenantId}::uuid)`;
  await pg.ownerClient`
    INSERT INTO "app_user" (id, tenant_id, email, password_hash)
    VALUES (${ids.userId}::uuid, ${ids.tenantId}::uuid, ${`${ids.userId}@kerdial.test`}, 'argon2id$placeholder')
  `;
  await pg.ownerClient`
    INSERT INTO "session" (id, tenant_id, user_id, token_hash, expires_at)
    VALUES (${ids.sessionId}::uuid, ${ids.tenantId}::uuid, ${ids.userId}::uuid,
            ${Buffer.from(ids.sessionId)}, '2099-01-01T00:00:00Z')
  `;
}

/** The type of `TransactionWriteService`'s optional backfill scheduler, named without naming its package. */
type BackfillScheduler = NonNullable<
  ConstructorParameters<typeof TransactionWriteService>[0]["instrumentBackfillScheduler"]
>;

export interface WriteServiceHarness {
  readonly writes: TransactionWriteService;
  /** Every instrument id `#triggerInstrumentBackfill` reached the enrolment path for, in call order (FR-557). */
  readonly backfillCalls: string[];
}

/**
 * The shipped write service, with both rate providers throwing — every leg in
 * these suites is EUR, which is the tenant base currency, so `FxRateResolver`
 * short-circuits to `IMPLIED_BASE` and must never reach a provider. An
 * accidental off-base leg therefore fails loudly instead of quietly measuring
 * something else.
 *
 * The backfill scheduler is a **counting stub**, which is what makes FR-557's
 * "the CSV path needs no new wiring" a measurement rather than a claim: every
 * instrument-referencing `record*` calls `#triggerInstrumentBackfill`, a write
 * batch defers those calls and drains them after its commit, and the drain is
 * what lands in {@link WriteServiceHarness.backfillCalls}.
 */
export function buildKerdialWriteService(db: Db, tenantId: string): WriteServiceHarness {
  const fxRateResolver = new FxRateResolver({
    db,
    provider: {
      capabilities: () => ({
        key: "kerdial-suite-unreachable-fx",
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
  const backfillCalls: string[] = [];
  const scheduler = {
    enqueueInstrumentBackfill: (params: { readonly instrumentId: string }) => {
      backfillCalls.push(params.instrumentId);
      return Promise.resolve("stub-job-id");
    },
  };
  const writes = new TransactionWriteService({
    db,
    fxRateResolver,
    cryptoRateResolver: new CryptoRateResolver({
      db,
      provider: {
        capabilities: () => ({
          key: "kerdial-suite-unreachable-quote",
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
          throw new Error("no settlement leg in this suite is priced against a provider");
        },
      },
      fxRateResolver,
    }),
    instrumentBackfillScheduler: scheduler as unknown as BackfillScheduler,
  });
  return { writes, backfillCalls };
}

/**
 * A write service that records **which portfolios each write batch touched**.
 *
 * KD9's property is that a chunk's lock set is exactly one portfolio — for a
 * file with no stated transfer pair; a transfer row with a destination locks
 * its target's portfolio too (`security-transfer` F-7), which this proxy does
 * not see, because it notes the `portfolioId` a write names. The lock
 * itself is taken inside `record*`, under `portfolio-lock.ts`'s rung order, one
 * rung-2 lock per portfolio written; so "every `inWriteBatch` call wrote rows
 * of exactly one portfolio" is the same statement, observed one level above the
 * `FOR UPDATE`. Recorded by delegation rather than by reading the plan, because
 * reading the plan would be asserting that the chunking function agrees with
 * itself.
 */
export function recordingBatches(writes: TransactionWriteService): {
  readonly writes: TransactionWriteService;
  readonly batches: string[][];
} {
  const batches: string[][] = [];
  let current: string[] | null = null;
  const note = (portfolioId: string): void => {
    if (current !== null && !current.includes(portfolioId)) current.push(portfolioId);
  };
  const wrap =
    <P extends { readonly portfolioId: string }>(
      method: (params: P) => Promise<TransactionRecord>,
    ) =>
    async (params: P): Promise<TransactionRecord> => {
      note(params.portfolioId);
      return method.call(writes, params);
    };
  const proxy = new Proxy(writes, {
    get(target, property, receiver) {
      if (property === "inWriteBatch") {
        return async (run: (batch: unknown) => Promise<void>): Promise<void> => {
          const opened: string[] = [];
          batches.push(opened);
          current = opened;
          try {
            await target.inWriteBatch(run as Parameters<typeof target.inWriteBatch>[0]);
          } finally {
            current = null;
          }
        };
      }
      // Deliberately **not** `Reflect.get(target, property, receiver)`:
      // `TransactionWriteService` carries `#private` fields, and a method
      // reached through the proxy as its `this` cannot read them. Every method
      // is bound to the real service instead.
      void receiver;
      const value: unknown = Reflect.get(target, property) as unknown;
      if (typeof property === "string" && property.startsWith("record")) {
        return wrap(
          value as (params: { readonly portfolioId: string }) => Promise<TransactionRecord>,
        );
      }
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
  return { writes: proxy, batches };
}

export function kerdialPlanContext(
  db: Db,
  tenantId: string,
  overrides: Partial<PlanContext> = {},
): PlanContext {
  return {
    db,
    tenantId,
    // A Kerdial file names its own destination on every row, so
    // the request supplies none — `planImport` refuses one that does.
    destination: null,
    mode: "DRY_RUN",
    resolutions: [],
    discovery: null,
    limits: DEFAULT_IMPORT_LIMITS,
    clock: systemClock,
    ...overrides,
  };
}

/** `applyImport` with a deadline far enough out that it cannot be the thing under test. */
export async function applyKerdial(
  plan: ImportPlan,
  db: Db,
  ids: KerdialIds,
  writes: TransactionWriteService,
  overrides: Partial<ApplyContext> = {},
): Promise<ImportResult> {
  return applyImport({
    plan,
    db,
    writes,
    destination: null,
    tenantId: ids.tenantId,
    updatedBySessionId: ids.sessionId,
    deadlineAt: new Date(Date.now() + 600_000),
    clock: systemClock,
    chunkRows: DEFAULT_IMPORT_LIMITS.applyChunkRows,
    ...overrides,
  });
}

/** `IMPORT`, or the reason code — the one-word label every count in these suites is taken over. */
export function kerdialTally(
  outcomes: readonly { readonly outcome: string; readonly reason?: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const one of outcomes) {
    const key = one.outcome === "IMPORT" ? "IMPORT" : (one.reason ?? "UNNAMED");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
