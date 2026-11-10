import { randomUUID } from "node:crypto";
import {
  deferred,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { appUser, cashAccount, createDb, tenant, withTenant, type Db } from "@kerdial/platform-db";
import type {
  CurrencyPair,
  FxObservation,
  FxRateProvider,
  IsoDate,
  ProviderSymbol,
  QuoteProvider,
} from "@kerdial/market-ports";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rejectionOf, startRacing } from "./__tests__/racing-operation.js";
import {
  CashAccountNameAlreadyExistsError,
  CashAccountPortfolioCapExceededError,
  CashAccountPortfolioNotFoundError,
  MAX_CASH_ACCOUNTS_PER_PORTFOLIO,
  createCashAccount,
  renameCashAccount,
  setCashAccountArchived,
} from "./cash-account-service.js";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import {
  INITIAL_CASH_ACCOUNT_NAME,
  createPortfolio,
  deletePortfolio,
} from "./portfolio-service.js";
import { TransactionWriteService } from "./transaction-write-service.js";

/**
 * CA-13 — `cash-account-service.ts` against a real Postgres 17 container:
 * CD10's portfolio-row lock (asserted by statement order, then proved
 * behaviourally against a real in-flight `deletePortfolio`), CD11's
 * unconditional unique key and the un-archive it makes safe, FR-164/AC-184's
 * rename semantics, AC-172 at the service layer, and the two things this write
 * path must **not** do: bump `calc_epoch`, or disturb a balance.
 *
 * **Everything under test runs as the real, password-authenticated `app_web`
 * role**, never the Testcontainers superuser. That is not incidental: `0038`
 * grants `app_web` `UPDATE` on only `(name, archived_at, updated_at)`, so a
 * service that tried to write `currency` or `portfolio_id` would fail with
 * `42501` at *runtime* and be invisible to a superuser-connected suite —
 * exactly how the `instrument_backfill_state` grant gap survived for weeks
 * (V10). The suite proves it really is that role, and
 * not merely configured to look like it, in the grant-boundary describe at the
 * end.
 */
describe("ledger — cash-account CRUD (CA-13, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  /** A second independent `app_web` physical connection — the racing writer in the CD10 interleavings. */
  let appWebSql2: postgres.Sql;
  let appWebDb2: Db;
  /** A third — the manually-held `portfolio`-row lock that forces a deterministic order. */
  let appWebSql3: postgres.Sql;
  let appWebDb3: Db;

  const tenantA = "00000000-0000-7000-8000-0000000ca130";
  const tenantB = "00000000-0000-7000-8000-0000000ca131";
  const userA = "00000000-0000-7000-8000-0000000ca132";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    appWebSql2 = postgres(pg.appWebUri, { max: 1 });
    appWebDb2 = createDb(appWebSql2);
    appWebSql3 = postgres(pg.appWebUri, { max: 1 });
    appWebDb3 = createDb(appWebSql3);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    await ownerDb.insert(appUser).values({
      id: userA,
      tenantId: tenantA,
      email: "a@ca13.example",
      passwordHash: "argon2id$placeholder",
    });
  }, 180_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appWebSql2?.end({ timeout: 5 });
    await appWebSql3?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  /** A fresh portfolio for one test, through the real writer — so it already carries CA-25's one auto-created EUR account, exactly as production does. */
  async function freshPortfolio(label: string, tenantId = tenantA): Promise<string> {
    const row = await createPortfolio(appWebDb, {
      tenantId,
      name: `CA-13 ${label} ${randomUUID()}`,
    });
    return row.id;
  }

  /** Named fields rather than an index signature, so a typo in a column name fails to compile instead of silently reading `undefined`. */
  interface RawCashAccountRow {
    readonly id: string;
    readonly tenant_id: string;
    readonly portfolio_id: string;
    readonly name: string;
    readonly currency: string;
    readonly archived_at: string | null;
    readonly updated_at: string;
  }

  /** Read straight through the superuser — a claim about physical rows, not about what RLS lets `app_web` see. */
  async function rawAccount(id: string): Promise<RawCashAccountRow | undefined> {
    const [row] = await ownerClient<RawCashAccountRow[]>`
      SELECT id::text, tenant_id::text, portfolio_id::text, name, currency,
             archived_at::text AS archived_at, updated_at::text AS updated_at
        FROM "cash_account" WHERE id = ${id}::uuid
    `;
    return row;
  }

  async function calcEpochOf(portfolioId: string): Promise<string> {
    const [row] = await ownerClient<{ calc_epoch: string }[]>`
      SELECT calc_epoch::text FROM "portfolio" WHERE id = ${portfolioId}::uuid
    `;
    return row!.calc_epoch;
  }

  /**
   * Holds the `portfolio` row's `FOR UPDATE` from a third connection, so the
   * two racers below queue behind it **in the order they are issued** — which
   * is what turns "these two operations race" into a deterministic
   * interleaving rather than a coin flip. Shared by the CD10 suite (racing
   * `deletePortfolio`) and the F1 and archive-TOCTOU suites (racing a *transaction*
   * write).
   */
  async function heldPortfolioLock(portfolioId: string) {
    const lockHeld = deferred<void>();
    const release = deferred<void>();
    const done = withTenant(appWebDb3, tenantA, async (tx) => {
      await tx.execute(
        sql`select id from "portfolio" where tenant_id = ${tenantA}::uuid and id = ${portfolioId}::uuid for update`,
      );
      lockHeld.resolve();
      await release.promise;
    });
    await lockHeld.promise;
    return { release, done };
  }

  // -------------------------------------------------------------------
  // AC-172 — the criterion this whole cycle is graded against, at the
  // service layer. (Its end-to-end HTTP half is CA-15's, in
  // `api/src/cash-accounts.e2e.test.ts`.)
  // -------------------------------------------------------------------
  describe("AC-172 — a portfolio holds two or more accounts in the SAME currency", () => {
    it("two EUR accounts with different names both persist, with distinct ids", async () => {
      const portfolioId = await freshPortfolio("ac172");

      const principal = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "CTO — EUR principal",
        currency: "EUR",
      });
      const reserve = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "CTO — EUR réserve",
        currency: "EUR",
      });

      expect(principal.id).not.toBe(reserve.id);
      expect(principal.currency).toBe("EUR");
      expect(reserve.currency).toBe("EUR");

      // Three EUR rows physically present: the two above plus CA-25's
      // auto-created one. Counted through the superuser, so this is a fact
      // about the table.
      const [row] = await ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "cash_account"
         WHERE portfolio_id = ${portfolioId}::uuid AND currency = 'EUR'
      `;
      expect(row?.n).toBe("3");
    });

    it("a third and fourth EUR account still succeed — nothing caps or de-duplicates by currency at any depth", async () => {
      const portfolioId = await freshPortfolio("ac172-more");
      for (const name of ["EUR A", "EUR B", "EUR C", "EUR D"]) {
        await createCashAccount(appWebDb, {
          tenantId: tenantA,
          portfolioId,
          name,
          currency: "EUR",
        });
      }
      const [row] = await ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "cash_account"
         WHERE portfolio_id = ${portfolioId}::uuid AND currency = 'EUR'
      `;
      expect(row?.n).toBe("5");
    });

    it("uniqueness is on the NAME, not the currency — the same name in the same currency IS refused", async () => {
      // The discriminating companion. Without it, "two EUR accounts succeed"
      // would also pass against a table with no unique key at all.
      const portfolioId = await freshPortfolio("ac172-name");
      await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Duplicated",
        currency: "EUR",
      });
      const conflict = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Duplicated",
        currency: "USD", // a *different* currency, same name — still a conflict
      }).catch((err: unknown) => err);
      expect(conflict).toBeInstanceOf(CashAccountNameAlreadyExistsError);
      expect((conflict as CashAccountNameAlreadyExistsError).cashAccountName).toBe("Duplicated");
    });

    it("AC-174 — two accounts in DIFFERENT portfolios may share the exact same name", async () => {
      const first = await freshPortfolio("ac174-a");
      const second = await freshPortfolio("ac174-b");
      const a = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId: first,
        name: "Compte espèce",
        currency: "EUR",
      });
      const b = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId: second,
        name: "Compte espèce",
        currency: "EUR",
      });
      expect(a.id).not.toBe(b.id);
      expect(a.name).toBe(b.name);
    });
  });

  // -------------------------------------------------------------------
  // CD10 — the portfolio-row FOR UPDATE, first statement, every function.
  // -------------------------------------------------------------------
  describe("CD10 — the portfolio-row FOR UPDATE is the FIRST statement of every write", () => {
    /**
     * A dedicated `app_web` connection whose statements are captured in order
     * by postgres.js's own `debug` hook — statement-order *inspection*, not a
     * reading of the source, which is what CA-13's acceptance criterion asks
     * for. `BEGIN`/`COMMIT` and `withTenant`'s own `set_config` are filtered
     * out: they are the transaction envelope, take no lock, and are not what
     * "first statement" is about.
     */
    async function statementsOf(run: (db: Db) => Promise<unknown>): Promise<string[]> {
      let captured: string[] = [];
      const sqlClient = postgres(pg.appWebUri, {
        max: 1,
        debug: (_connection, query: string) => {
          captured.push(query.replace(/\s+/g, " ").trim());
        },
      });
      try {
        // Prime, then discard: postgres.js issues its own array-type catalogue
        // lookup (`pg_catalog.pg_type`) on the first use of a connection, which
        // would otherwise be the "first statement" every assertion below saw.
        await sqlClient`select 1`;
        captured = [];
        await run(createDb(sqlClient));
      } finally {
        await sqlClient.end({ timeout: 5 });
      }
      return captured.filter(
        (statement) =>
          !/^(begin|commit|rollback)\b/i.test(statement) && !statement.includes("set_config"),
      );
    }

    it("createCashAccount locks the portfolio row first, then counts under that lock, then inserts", async () => {
      const portfolioId = await freshPortfolio("stmt-create");
      const statements = await statementsOf((db) =>
        createCashAccount(db, {
          tenantId: tenantA,
          portfolioId,
          name: "Locked create",
          currency: "EUR",
        }),
      );
      expect(statements[0]).toMatch(/select .* from "portfolio" .* for update/i);
      // Exactly three: the lock, the cap count, then the insert. A capture
      // that saw nothing would make "the first statement is a FOR UPDATE"
      // vacuously true — and the count's *position* is itself the assertion
      // that it runs under the lock (F2: that is what makes it race-free
      // rather than best-effort).
      expect(statements).toHaveLength(3);
      expect(statements[1]).toMatch(/select count\(\*\)::int from "cash_account"/i);
      expect(statements[2]).toMatch(/insert into "cash_account"/i);
    });

    it("renameCashAccount locks the portfolio row first", async () => {
      const portfolioId = await freshPortfolio("stmt-rename");
      const created = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Before",
        currency: "EUR",
      });
      const statements = await statementsOf((db) =>
        renameCashAccount(db, {
          tenantId: tenantA,
          portfolioId,
          cashAccountId: created.id,
          name: "After",
        }),
      );
      expect(statements[0]).toMatch(/select .* from "portfolio" .* for update/i);
      expect(statements[1]).toMatch(/update "cash_account"/i);
    });

    it("setCashAccountArchived locks the portfolio row first", async () => {
      const portfolioId = await freshPortfolio("stmt-archive");
      const created = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "To archive",
        currency: "EUR",
      });
      const statements = await statementsOf((db) =>
        setCashAccountArchived(db, {
          tenantId: tenantA,
          portfolioId,
          cashAccountId: created.id,
          archived: true,
        }),
      );
      expect(statements[0]).toMatch(/select .* from "portfolio" .* for update/i);
      expect(statements[1]).toMatch(/update "cash_account"/i);
    });

    it("a write against a portfolio this tenant does not own is a clean 404-shaped error, and issues NO second statement", async () => {
      const foreign = await freshPortfolio("stmt-foreign", tenantB);
      let statements: string[] = [];
      const sqlClient = postgres(pg.appWebUri, {
        max: 1,
        debug: (_connection, query: string) => {
          statements.push(query.replace(/\s+/g, " ").trim());
        },
      });
      try {
        await sqlClient`select 1`;
        statements = [];
        const raised = await createCashAccount(createDb(sqlClient), {
          tenantId: tenantA,
          portfolioId: foreign,
          name: "Should never exist",
          currency: "EUR",
        }).catch((err: unknown) => err);
        expect(raised).toBeInstanceOf(CashAccountPortfolioNotFoundError);
        // Never an unmapped FK violation, and never the misleading
        // "a transaction outside this portfolio…" 409 CD10 exists to prevent.
        expect((raised as Error).name).toBe("CashAccountPortfolioNotFoundError");
      } finally {
        await sqlClient.end({ timeout: 5 });
      }
      expect(statements.filter((s) => /insert into "cash_account"/i.test(s))).toEqual([]);

      // And the row genuinely does not exist — the rejection was not a
      // report about a write that happened anyway.
      const [row] = await ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "cash_account" WHERE name = 'Should never exist'
      `;
      expect(row?.n).toBe("0");
    });
  });

  // -------------------------------------------------------------------
  // CD10 — the no-deadlock claim, proved against a real in-flight
  // deletePortfolio (the three-connection lock-holder/delete/racing-writer
  // shape `portfolio-delete.integration.test.ts` item 7a established).
  // -------------------------------------------------------------------
  describe("CD10 — createCashAccount racing deletePortfolio, both interleavings, no deadlock", () => {
    it("interleaving A — the delete wins: the create BLOCKS, then returns a clean 404, never a 500 or a misleading 409", async () => {
      const portfolioId = await freshPortfolio("race-delete-first");
      const gate = await heldPortfolioLock(portfolioId);

      // Issued first, so it queues ahead of the create on the row lock.
      const deletePromise = deletePortfolio(appWebDb2, {
        tenantId: tenantA,
        portfolioId,
        deletedBy: userA,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const create = startRacing(
        createCashAccount(appWebDb, {
          tenantId: tenantA,
          portfolioId,
          name: "Racing create",
          currency: "EUR",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Genuinely blocked — this is what proves the lock is taken at all, and
      // that the create is not simply completing before the delete starts.
      expect(create.settled()).toBe(false);

      gate.release.resolve();
      await gate.done;

      expect((await deletePromise).deleted).toBe(true);

      const error = rejectionOf(await create.outcome, "createCashAccount");
      expect(error).toBeInstanceOf(CashAccountPortfolioNotFoundError);
      // The three failure modes CD10 exists to make unreachable, each ruled
      // out by name rather than by "it threw something":
      expect((error as Error).name).not.toBe("PortfolioDeleteBlockedByLinkedTransactionError");
      expect((error as Error).message).not.toMatch(/transaction outside this portfolio/);
      expect(extractSqlstate(error)).toBeUndefined(); // no raw 23503/23505 escaped

      const [row] = await ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "cash_account" WHERE name = 'Racing create'
      `;
      expect(row?.n).toBe("0");
    });

    it("interleaving B — the create wins: it commits, and the delete then destroys it as part of the cascade", async () => {
      const portfolioId = await freshPortfolio("race-create-first");
      const gate = await heldPortfolioLock(portfolioId);

      // This time the create is issued first, so it queues ahead.
      const createPromise = createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Winning create",
        currency: "EUR",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      let deleteSettled = false;
      const deletePromise = deletePortfolio(appWebDb2, {
        tenantId: tenantA,
        portfolioId,
        deletedBy: userA,
      }).then((result) => {
        deleteSettled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deleteSettled).toBe(false);

      gate.release.resolve();
      await gate.done;

      const created = await createPromise;
      expect(created.name).toBe("Winning create");

      expect((await deletePromise).deleted).toBe(true);
      // Zero orphans: the account the create had just committed is gone with
      // the portfolio, and the cascade did not fail on it.
      expect(await rawAccount(created.id)).toBeUndefined();
      const [row] = await ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "cash_account" WHERE portfolio_id = ${portfolioId}::uuid
      `;
      expect(row?.n).toBe("0");
    });

    it("rename and archive take the same lock, so they behave identically — a delete in flight makes each block then 404", async () => {
      const portfolioId = await freshPortfolio("race-edit-path");
      const account = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Doomed",
        currency: "EUR",
      });
      const gate = await heldPortfolioLock(portfolioId);

      const deletePromise = deletePortfolio(appWebDb2, {
        tenantId: tenantA,
        portfolioId,
        deletedBy: userA,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const rename = startRacing(
        renameCashAccount(appWebDb, {
          tenantId: tenantA,
          portfolioId,
          cashAccountId: account.id,
          name: "Doomed, renamed",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(rename.settled()).toBe(false);

      gate.release.resolve();
      await gate.done;
      expect((await deletePromise).deleted).toBe(true);

      const error = rejectionOf(await rename.outcome, "renameCashAccount");
      expect(error).toBeInstanceOf(CashAccountPortfolioNotFoundError);
      expect(extractSqlstate(error)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // FR-164 / AC-184 — rename semantics.
  // -------------------------------------------------------------------
  describe("FR-164 / AC-184 — rename", () => {
    it("renaming to the account's OWN current name is a no-op success, not a conflict", async () => {
      const portfolioId = await freshPortfolio("self-rename");
      const created = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Compte courant",
        currency: "EUR",
      });
      const renamed = await renameCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: created.id,
        name: "Compte courant",
      });
      expect(renamed?.id).toBe(created.id);
      expect(renamed?.name).toBe("Compte courant");
    });

    it("the trim makes a self-rename with surrounding whitespace a no-op too, rather than a spurious conflict with the row's own stored name", async () => {
      const portfolioId = await freshPortfolio("self-rename-trim");
      const created = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "  Compte trimmé  ",
        currency: "EUR",
      });
      expect(created.name).toBe("Compte trimmé");
      const renamed = await renameCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: created.id,
        name: "   Compte trimmé ",
      });
      expect(renamed?.name).toBe("Compte trimmé");
    });

    it("renaming onto a name another account in the SAME portfolio already holds is a named conflict, never a raw 23505", async () => {
      const portfolioId = await freshPortfolio("rename-conflict");
      await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Taken",
        currency: "EUR",
      });
      const other = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Free",
        currency: "USD",
      });

      const raised = await renameCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: other.id,
        name: "Taken",
      }).catch((err: unknown) => err);
      expect(raised).toBeInstanceOf(CashAccountNameAlreadyExistsError);
      expect(extractSqlstate(raised)).toBeUndefined();

      // Unchanged — the rejected UPDATE rolled back.
      expect((await rawAccount(other.id))?.name).toBe("Free");
    });

    it("renaming onto a name used in a DIFFERENT portfolio succeeds — AC-174's companion at the rename path", async () => {
      const first = await freshPortfolio("rename-scope-a");
      const second = await freshPortfolio("rename-scope-b");
      await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId: first,
        name: "Livret",
        currency: "EUR",
      });
      const target = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId: second,
        name: "Autre",
        currency: "EUR",
      });
      const renamed = await renameCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId: second,
        cashAccountId: target.id,
        name: "Livret",
      });
      expect(renamed?.name).toBe("Livret");
    });

    it("returns undefined for an unknown account id — the 404 contract, distinct from the portfolio's own", async () => {
      const portfolioId = await freshPortfolio("rename-unknown");
      const result = await renameCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: randomUUID(),
        name: "Nope",
      });
      expect(result).toBeUndefined();
    });

    it("returns undefined when the account belongs to a SIBLING portfolio of the same tenant — the URL's portfolio is part of the WHERE, not decoration", async () => {
      const owning = await freshPortfolio("rename-sibling-owner");
      const other = await freshPortfolio("rename-sibling-other");
      const account = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId: owning,
        name: "Belongs to owning",
        currency: "EUR",
      });

      const throughWrongPortfolio = await renameCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId: other,
        cashAccountId: account.id,
        name: "Hijacked",
      });
      expect(throughWrongPortfolio).toBeUndefined();
      expect((await rawAccount(account.id))?.name).toBe("Belongs to owning");

      // Positive companion: through its OWN portfolio the same rename works,
      // so the `undefined` above is scoping, not a broken statement.
      const throughOwnPortfolio = await renameCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId: owning,
        cashAccountId: account.id,
        name: "Renamed properly",
      });
      expect(throughOwnPortfolio?.name).toBe("Renamed properly");
    });

    it("refuses an empty/whitespace-only name before issuing any statement (the service-level guard `renamePortfolio` also carries)", async () => {
      const portfolioId = await freshPortfolio("rename-empty");
      const created = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Keep me",
        currency: "EUR",
      });
      for (const name of ["", "   "]) {
        const raised = await renameCashAccount(appWebDb, {
          tenantId: tenantA,
          portfolioId,
          cashAccountId: created.id,
          name,
        }).catch((err: unknown) => err);
        expect(raised).toBeInstanceOf(TypeError);
      }
      expect((await rawAccount(created.id))?.name).toBe("Keep me");
    });
  });

  // -------------------------------------------------------------------
  // FR-165 / OD-5(c) / CD11 — archive, un-archive, and the reserved name.
  // -------------------------------------------------------------------
  describe("FR-165 / CD11 — archive, un-archive, and the name an archived account keeps reserved", () => {
    it("archiving sets archived_at; un-archiving clears it back to NULL", async () => {
      const portfolioId = await freshPortfolio("archive-roundtrip");
      const created = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Roundtrip",
        currency: "EUR",
      });
      expect(created.archivedAt).toBeNull();

      const archived = await setCashAccountArchived(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: created.id,
        archived: true,
      });
      expect(archived?.archivedAt).toBeInstanceOf(Date);
      expect((await rawAccount(created.id))?.archived_at).not.toBeNull();

      const unarchived = await setCashAccountArchived(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: created.id,
        archived: false,
      });
      expect(unarchived?.archivedAt).toBeNull();
      expect((await rawAccount(created.id))?.archived_at).toBeNull();
    });

    it("CD11 — an archived account keeps its name RESERVED, and un-archive therefore always succeeds", async () => {
      const portfolioId = await freshPortfolio("cd11");
      const created = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Réservé",
        currency: "EUR",
      });

      await setCashAccountArchived(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: created.id,
        archived: true,
      });

      // The middle step, and the one that decides this: while it is archived,
      // nobody else can take the name. A *partial* unique index
      // (`WHERE archived_at IS NULL`) would let this create succeed and turn
      // the un-archive below into a 23505 — archive as a one-way trap.
      const stolen = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Réservé",
        currency: "EUR",
      }).catch((err: unknown) => err);
      expect(stolen).toBeInstanceOf(CashAccountNameAlreadyExistsError);

      const unarchived = await setCashAccountArchived(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: created.id,
        archived: false,
      });
      expect(unarchived?.archivedAt).toBeNull();
      expect(unarchived?.name).toBe("Réservé");
    });

    it("re-archiving an archived account, and un-archiving an active one, are both idempotent successes", async () => {
      const portfolioId = await freshPortfolio("archive-idempotent");
      const created = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Idempotent",
        currency: "EUR",
      });
      expect(
        (
          await setCashAccountArchived(appWebDb, {
            tenantId: tenantA,
            portfolioId,
            cashAccountId: created.id,
            archived: false,
          })
        )?.archivedAt,
      ).toBeNull();
      await setCashAccountArchived(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: created.id,
        archived: true,
      });
      const twice = await setCashAccountArchived(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: created.id,
        archived: true,
      });
      expect(twice?.archivedAt).toBeInstanceOf(Date);
    });

    it("archiving is scoped to the URL's portfolio too — a sibling portfolio's account is untouched, and returns undefined", async () => {
      const owning = await freshPortfolio("archive-sibling-owner");
      const other = await freshPortfolio("archive-sibling-other");
      const account = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId: owning,
        name: "Sibling-scoped",
        currency: "EUR",
      });
      expect(
        await setCashAccountArchived(appWebDb, {
          tenantId: tenantA,
          portfolioId: other,
          cashAccountId: account.id,
          archived: true,
        }),
      ).toBeUndefined();
      expect((await rawAccount(account.id))?.archived_at).toBeNull();

      expect(
        (
          await setCashAccountArchived(appWebDb, {
            tenantId: tenantA,
            portfolioId: owning,
            cashAccountId: account.id,
            archived: true,
          })
        )?.archivedAt,
      ).toBeInstanceOf(Date);
    });

    it("AC-185 under OD-5(c) — archiving an account that HAS attributed transactions succeeds, and its balance is untouched", async () => {
      // Read this one against the report's flagged contradiction: AC-185's
      // "rejected, stating the blocking transaction count" clause describes
      // OD-5 option (a), which is not the option that was locked. Under (c)
      // archive is a *visibility* change — refusing it for an account with
      // history would refuse it for exactly the accounts users want archived,
      // and excluding an archived account's money from the portfolio total
      // would make that total wrong.
      const portfolioId = await freshPortfolio("archive-with-history");
      const account = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Has history",
        currency: "EUR",
      });

      // A `cash_balance` row for that account, seeded out of band (the writer
      // that produces one is `recomputeAndInvalidate`, exercised elsewhere;
      // what is under test here is that archiving does not disturb it).
      await ownerClient`
        INSERT INTO "cash_balance" (tenant_id, portfolio_id, cash_account_id, currency, amount, calc_epoch)
        VALUES (${tenantA}::uuid, ${portfolioId}::uuid, ${account.id}::uuid, 'EUR', 1234.56, 1)
      `;
      const balanceBefore = await ownerClient<{ amount: string }[]>`
        SELECT amount::text FROM "cash_balance" WHERE cash_account_id = ${account.id}::uuid
      `;

      const archived = await setCashAccountArchived(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: account.id,
        archived: true,
      });
      expect(archived?.archivedAt).toBeInstanceOf(Date);

      const balanceAfter = await ownerClient<{ amount: string }[]>`
        SELECT amount::text FROM "cash_balance" WHERE cash_account_id = ${account.id}::uuid
      `;
      // Byte-identical, and still exactly one row — the money did not move and
      // did not vanish from the table the per-currency total is folded from.
      expect(balanceAfter).toHaveLength(1);
      expect(balanceAfter[0]!.amount).toBe(balanceBefore[0]!.amount);
      expect(new Decimal(balanceAfter[0]!.amount).toFixed(2)).toBe("1234.56");
    });
  });

  // -------------------------------------------------------------------
  // No cash-account write bumps calc_epoch.
  // -------------------------------------------------------------------
  describe("create/rename/archive move no money, so calc_epoch must NOT move", () => {
    it("all three writes leave the portfolio's calc_epoch exactly where it was", async () => {
      const portfolioId = await freshPortfolio("calc-epoch");
      const before = await calcEpochOf(portfolioId);

      const created = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Epoch probe",
        currency: "EUR",
      });
      expect(await calcEpochOf(portfolioId)).toBe(before);

      await renameCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: created.id,
        name: "Epoch probe renamed",
      });
      expect(await calcEpochOf(portfolioId)).toBe(before);

      await setCashAccountArchived(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: created.id,
        archived: true,
      });
      expect(await calcEpochOf(portfolioId)).toBe(before);

      await setCashAccountArchived(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: created.id,
        archived: false,
      });
      expect(await calcEpochOf(portfolioId)).toBe(before);

      // …and the column is not simply frozen: a direct bump on this very
      // portfolio moves it, so the four assertions above are about the
      // writes, not about a counter nothing ever increments.
      await withTenant(appWebDb, tenantA, async (tx) => {
        await tx.execute(
          sql`update "portfolio" set calc_epoch = calc_epoch + 1 where tenant_id = ${tenantA}::uuid and id = ${portfolioId}::uuid`,
        );
      });
      expect(BigInt(await calcEpochOf(portfolioId))).toBe(BigInt(before) + 1n);
    });
  });

  // -------------------------------------------------------------------
  // The column-level grant boundary, proved on the very connection the
  // suite above used — so "runs as app_web" is measured, not configured.
  // -------------------------------------------------------------------
  describe("the app_web column-grant boundary (0038), on this suite's own connection", () => {
    it("the service's rename succeeds while a hand-written UPDATE of `currency` on the same connection fails 42501 — so this suite is genuinely NOT the superuser", async () => {
      const portfolioId = await freshPortfolio("grant-boundary");
      const account = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Grant probe",
        currency: "EUR",
      });

      // Positive half: the granted columns are writable through the service.
      expect(
        (
          await renameCashAccount(appWebDb, {
            tenantId: tenantA,
            portfolioId,
            cashAccountId: account.id,
            name: "Grant probe renamed",
          })
        )?.name,
      ).toBe("Grant probe renamed");

      // Negative half, same role, same connection: `currency` and
      // `portfolio_id` are outside the column-level UPDATE grant, so a service
      // that ever tried to write either would fail here at runtime rather than
      // at compile time. This is the assertion that would have caught it.
      for (const statement of [
        sql`update "cash_account" set currency = 'USD' where id = ${account.id}::uuid`,
        sql`update "cash_account" set portfolio_id = ${portfolioId}::uuid where id = ${account.id}::uuid`,
      ]) {
        const raised = await withTenant(appWebDb, tenantA, async (tx) => {
          await tx.execute(statement);
        }).catch((err: unknown) => err);
        expect(extractSqlstate(raised)).toBe("42501");
      }

      expect((await rawAccount(account.id))?.currency).toBe("EUR");
    });

    it("`CashAccountRecord` round-trips through the real row — the auto-created CA-25 account is readable as app_web with the shape this service returns", async () => {
      const portfolioId = await freshPortfolio("record-shape");
      const [row] = await withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .select()
          .from(cashAccount)
          .where(
            and(
              eq(cashAccount.portfolioId, portfolioId),
              eq(cashAccount.name, INITIAL_CASH_ACCOUNT_NAME),
            ),
          ),
      );
      expect(row).toBeDefined();
      expect(row!.currency).toBe("EUR");
      expect(row!.archivedAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // F1 — the interleaving the CD10 suite above was missing.
  //
  // Its two racers are a cash-account write and `deletePortfolio`, which take
  // the `portfolio` row in the *same* order and therefore could never have
  // caught this. The pair whose order inverted is a cash-account write against
  // a **transaction** write, and nothing in this repository raced those two
  // until now.
  //
  // The deadlock, reproduced against the pre-fix code with exactly the
  // interleaving in the first test below:
  //
  //     ERROR:  deadlock detected
  //     DETAIL:  Process 299 waits for ShareLock on transaction 1078;
  //              blocked by process 300.
  //     Process 300 waits for ShareLock on transaction 1077;
  //              blocked by process 299.
  //     CONTEXT:  while updating tuple (0,6) in relation "cash_account"
  // -------------------------------------------------------------------
  describe("a cash-account write racing a TRANSACTION write, the one pair that inverted", () => {
    /**
     * Every FX/quote dependency is a stub that throws if called: a EUR deposit
     * under a EUR base resolves no rate. Copied in shape from
     * `portfolio-delete.integration.test.ts`'s own `serviceFor`, which exists
     * for the same reason (its items 7a-7c race this service too).
     */
    function serviceFor(db: Db): TransactionWriteService {
      const fxProvider = {
        capabilities: vi.fn(() => ({
          key: "ca-f1-unreachable-fx",
          publishedPairs: [],
          baseCurrency: "EUR",
          publicationTimeUtc: "15:00",
          maxHistoryYears: "unbounded" as const,
        })),
        fetchDailyRates: vi.fn(async (_pairs: CurrencyPair[], _from: IsoDate, _to: IsoDate) => {
          throw new Error("no FX lookup is legitimate for a EUR deposit under a EUR base");
        }),
        fetchLatestRates: vi.fn(async (_pairs: CurrencyPair[]): Promise<FxObservation[]> => []),
      } satisfies FxRateProvider;
      const quoteProvider = {
        capabilities: vi.fn(() => ({
          key: "ca-f1-unreachable-quote",
          assetKinds: ["CRYPTO"] as const,
          supportsLatestQuote: true,
          supportsDailyHistory: true,
          supportsCorporateActions: false,
          maxHistoryYears: 1,
          quoteQuality: "REALTIME" as const,
          delayMinutes: 0,
          batchSize: 20,
        })),
        resolve: vi.fn(async () => []),
        fetchLatest: vi.fn(async () => []),
        fetchDailyHistory: vi.fn(async (_symbol: ProviderSymbol, _from: IsoDate, _to: IsoDate) => {
          throw new Error("no quote lookup is legitimate for a plain deposit");
        }),
      } satisfies QuoteProvider;
      const fxRateResolver = new FxRateResolver({
        db,
        provider: fxProvider,
        tenantId: tenantA,
        baseCurrency: "EUR",
      });
      return new TransactionWriteService({
        db,
        fxRateResolver,
        cryptoRateResolver: new CryptoRateResolver({
          db,
          provider: quoteProvider,
          fxRateResolver,
        }),
      });
    }

    /** A portfolio with two EUR accounts and one DEPOSIT attributed to the first — the shape `PATCH /transactions/:id {"cashAccountId": …}` (CA-11) re-attributes. */
    async function seedDepositAndSibling(label: string): Promise<{
      portfolioId: string;
      sourceId: string;
      targetId: string;
      transactionId: string;
    }> {
      const portfolioId = await freshPortfolio(label);
      const source = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: `Source ${label}`,
        currency: "EUR",
      });
      const target = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: `Target ${label}`,
        currency: "EUR",
      });
      const written = await serviceFor(appWebDb).recordDeposit({
        portfolioId,
        tradeDate: "2024-03-01",
        amount: new Decimal("100"),
        currency: "EUR",
        cashAccountId: source.id,
      });
      return {
        portfolioId,
        sourceId: source.id,
        targetId: target.id,
        transactionId: written.id,
      };
    }

    async function rawTransactionCashAccount(transactionId: string): Promise<string | null> {
      const [row] = await ownerClient<{ cash_account_id: string | null }[]>`
        SELECT cash_account_id::text FROM "transaction" WHERE id = ${transactionId}::uuid
      `;
      return row!.cash_account_id;
    }

    it("rename queued first, re-attributing edit second: both commit, and neither is a 40P01 deadlock victim", async () => {
      const seeded = await seedDepositAndSibling("f1-deadlock");
      const gate = await heldPortfolioLock(seeded.portfolioId);

      // Issued first, so it holds the front of the `portfolio` row's wait
      // queue: it will take that row `FOR UPDATE` the moment the gate lets go,
      // and only *then* ask for the `cash_account` row it is renaming.
      const rename = startRacing(
        renameCashAccount(appWebDb, {
          tenantId: tenantA,
          portfolioId: seeded.portfolioId,
          cashAccountId: seeded.targetId,
          name: "Target renamed mid-edit",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(rename.settled()).toBe(false);

      // Issued second. **Before the fix** this call did not want the
      // `portfolio` row until `#writePostings`, so it ran straight past the
      // gate: it locked the `transaction` row, then took `FOR KEY SHARE` on the
      // very `cash_account` row the rename was queued to key-update, and only
      // then joined the queue for the `portfolio` row *behind* the rename.
      // Releasing the gate then closed the cycle. After the fix it asks for the
      // `portfolio` row first and simply waits its turn.
      const edit = startRacing(
        serviceFor(appWebDb2).editTransaction({
          id: seeded.transactionId,
          changes: { cashAccountId: seeded.targetId },
          changedBy: userA,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(edit.settled()).toBe(false);

      gate.release.resolve();
      await gate.done;

      const renameOutcome = await rename.outcome;
      const editOutcome = await edit.outcome;

      // Discriminating on the SQLSTATE, not on "it threw something": `40P01`
      // is the deadlock, and it is the only failure this test is about.
      // Reported per racer, so a failure names which one was the victim.
      expect({
        rename: extractSqlstate(
          renameOutcome.status === "rejected" ? renameOutcome.reason : undefined,
        ),
        edit: extractSqlstate(editOutcome.status === "rejected" ? editOutcome.reason : undefined),
      }).toEqual({ rename: undefined, edit: undefined });

      // The positive companion: an absence-of-deadlock assertion is worthless
      // unless both operations actually did their work.
      expect(renameOutcome.status).toBe("fulfilled");
      expect(editOutcome.status).toBe("fulfilled");
      expect((await rawAccount(seeded.targetId))?.name).toBe("Target renamed mid-edit");
      expect(await rawTransactionCashAccount(seeded.transactionId)).toBe(seeded.targetId);

      // …and so did the derived ledger the edit regenerates: the CASH posting
      // follows the transaction's new attribution, which is what the composite
      // FK `0040` adds now also enforces.
      const postings = await ownerClient<{ cash_account_id: string | null }[]>`
        SELECT cash_account_id::text FROM "transaction_posting"
         WHERE transaction_id = ${seeded.transactionId}::uuid AND leg = 'CASH'
      `;
      expect(postings.map((p) => p.cash_account_id)).toEqual([seeded.targetId]);
    });

    it("the other order — edit queued first, rename second — was always safe and still is", async () => {
      const seeded = await seedDepositAndSibling("f1-other-order");
      const gate = await heldPortfolioLock(seeded.portfolioId);

      const edit = startRacing(
        serviceFor(appWebDb2).editTransaction({
          id: seeded.transactionId,
          changes: { cashAccountId: seeded.targetId },
          changedBy: userA,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(edit.settled()).toBe(false);

      const rename = startRacing(
        renameCashAccount(appWebDb, {
          tenantId: tenantA,
          portfolioId: seeded.portfolioId,
          cashAccountId: seeded.targetId,
          name: "Target renamed after edit",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(rename.settled()).toBe(false);

      gate.release.resolve();
      await gate.done;

      const editOutcome = await edit.outcome;
      const renameOutcome = await rename.outcome;
      expect({
        edit: extractSqlstate(editOutcome.status === "rejected" ? editOutcome.reason : undefined),
        rename: extractSqlstate(
          renameOutcome.status === "rejected" ? renameOutcome.reason : undefined,
        ),
      }).toEqual({ edit: undefined, rename: undefined });
      expect(editOutcome.status).toBe("fulfilled");
      expect(renameOutcome.status).toBe("fulfilled");
      expect(await rawTransactionCashAccount(seeded.transactionId)).toBe(seeded.targetId);
      expect((await rawAccount(seeded.targetId))?.name).toBe("Target renamed after edit");
    });

    // -----------------------------------------------------------------
    // The archive TOCTOU, tested as a *consequence* of the lock
    // order above rather than as a mechanism of its own.
    //
    // `#assertCashAccountsUsable` reads `archived_at` without a lock and
    // nothing re-checks it. That read is now issued while the writer already
    // holds the `portfolio` row `FOR UPDATE`, and `setCashAccountArchived`
    // takes that same row — so the archive can no longer commit inside the
    // window. Both interleavings below place the archive *first* in the
    // queue, which is the losing order: before the fix the writer's unlocked
    // read ran ahead of the gate entirely, saw an active account, and then
    // committed an attribution to an account archived in the meantime.
    // -----------------------------------------------------------------
    it("create path — an archive committing first is SEEN by the create, which is refused rather than attributing to it", async () => {
      const portfolioId = await freshPortfolio("f1-toctou-create");
      const account = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Archived under the create",
        currency: "EUR",
      });
      const gate = await heldPortfolioLock(portfolioId);

      const archive = startRacing(
        setCashAccountArchived(appWebDb, {
          tenantId: tenantA,
          portfolioId,
          cashAccountId: account.id,
          archived: true,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(archive.settled()).toBe(false);

      const create = startRacing(
        serviceFor(appWebDb2).recordDeposit({
          portfolioId,
          tradeDate: "2024-03-02",
          amount: new Decimal("42"),
          currency: "EUR",
          cashAccountId: account.id,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Both racers really are queued behind the gate — without this the test
      // could pass on a create that finished before the archive even started.
      expect(create.settled()).toBe(false);

      gate.release.resolve();
      await gate.done;

      const archiveOutcome = await archive.outcome;
      expect(archiveOutcome.status).toBe("fulfilled");
      expect((await rawAccount(account.id))?.archived_at).not.toBeNull();

      const createError = rejectionOf(await create.outcome, "recordDeposit");
      expect((createError as Error).name).toBe("CashAccountArchivedError");

      // The assertion that matters: no row was written naming the account that
      // was archived while this create was in flight.
      const [row] = await ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "transaction" WHERE cash_account_id = ${account.id}::uuid
      `;
      expect(row?.n).toBe("0");
    });

    it("edit path — the same, for a re-attributing PATCH", async () => {
      const seeded = await seedDepositAndSibling("f1-toctou-edit");
      const gate = await heldPortfolioLock(seeded.portfolioId);

      const archive = startRacing(
        setCashAccountArchived(appWebDb, {
          tenantId: tenantA,
          portfolioId: seeded.portfolioId,
          cashAccountId: seeded.targetId,
          archived: true,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(archive.settled()).toBe(false);

      const edit = startRacing(
        serviceFor(appWebDb2).editTransaction({
          id: seeded.transactionId,
          changes: { cashAccountId: seeded.targetId },
          changedBy: userA,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(edit.settled()).toBe(false);

      gate.release.resolve();
      await gate.done;

      expect((await archive.outcome).status).toBe("fulfilled");
      const editError = rejectionOf(await edit.outcome, "editTransaction");
      expect((editError as Error).name).toBe("CashAccountArchivedError");
      // Unchanged: the edit rolled back whole, so the transaction still names
      // the account it was created with.
      expect(await rawTransactionCashAccount(seeded.transactionId)).toBe(seeded.sourceId);
    });
  });

  // -------------------------------------------------------------------
  // F2 — the per-portfolio cash-account cap.
  // -------------------------------------------------------------------
  describe("MAX_CASH_ACCOUNTS_PER_PORTFOLIO", () => {
    it("refuses the account that would exceed the cap, and the one before it still succeeds", async () => {
      const portfolioId = await freshPortfolio("f2-cap");
      // The portfolio already carries CA-25's auto-created EUR account, so a
      // cap of 3 leaves room for exactly two more.
      const before = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Second of three",
        currency: "EUR",
        maxCashAccountsPerPortfolio: 3,
      });
      expect(before.name).toBe("Second of three");
      await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Third of three",
        currency: "EUR",
        maxCashAccountsPerPortfolio: 3,
      });

      const raised = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Fourth, over the cap",
        currency: "EUR",
        maxCashAccountsPerPortfolio: 3,
      }).catch((err: unknown) => err);
      expect(raised).toBeInstanceOf(CashAccountPortfolioCapExceededError);
      expect((raised as CashAccountPortfolioCapExceededError).cap).toBe(3);
      // Never a raw constraint failure, and never a name conflict (the name is
      // free — it is the count that refused it).
      expect(extractSqlstate(raised)).toBeUndefined();

      const [row] = await ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "cash_account" WHERE portfolio_id = ${portfolioId}::uuid
      `;
      expect(row?.n).toBe("3");
    });

    it("counts archived accounts too — archiving is a visibility change, not a way to buy another slot", async () => {
      const portfolioId = await freshPortfolio("f2-cap-archived");
      const second = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Soon archived",
        currency: "EUR",
        maxCashAccountsPerPortfolio: 2,
      });
      await setCashAccountArchived(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        cashAccountId: second.id,
        archived: true,
      });
      expect((await rawAccount(second.id))?.archived_at).not.toBeNull();

      const raised = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId,
        name: "Third, after archiving the second",
        currency: "EUR",
        maxCashAccountsPerPortfolio: 2,
      }).catch((err: unknown) => err);
      expect(raised).toBeInstanceOf(CashAccountPortfolioCapExceededError);
    });

    it("the cap is enforced per portfolio, not per tenant — a sibling portfolio at its own cap does not block this one", async () => {
      const full = await freshPortfolio("f2-cap-sibling-full");
      await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId: full,
        name: "Filling the sibling",
        currency: "EUR",
        maxCashAccountsPerPortfolio: 2,
      });
      const other = await freshPortfolio("f2-cap-sibling-free");
      const created = await createCashAccount(appWebDb, {
        tenantId: tenantA,
        portfolioId: other,
        name: "Unaffected by the sibling",
        currency: "EUR",
        maxCashAccountsPerPortfolio: 2,
      });
      expect(created.portfolioId).toBe(other);
    });

    it("the shipped default is 200, and it is what bounds GET /portfolios/:id/cash", () => {
      // Stated as a test because `listCashAccountsWithBalances` has no `LIMIT`
      // of its own **by design** (a `LIMIT` would silently omit accounts from
      // FR-161's per-currency total): this constant is that route's only bound,
      // so moving it moves the route's worst case, and the reliance is asserted
      // rather than left in prose.
      expect(MAX_CASH_ACCOUNTS_PER_PORTFOLIO).toBe(200);
    });
  });
});

/** The SQLSTATE of a raw Postgres error, or `undefined` when the value is a domain error (which is what every assertion above wants to see). */
function extractSqlstate(err: unknown): string | undefined {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) return err.cause.code;
  return undefined;
}
