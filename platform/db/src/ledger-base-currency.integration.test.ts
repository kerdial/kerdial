import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient } from "./client.js";

/**
 * **AR-5 (ADR-0002) — ledger facts carry their base currency, and
 * the tenant's ledger base is immutable once history exists (migration
 * `0055`).**
 *
 * Three claims, each asserted from both sides:
 *
 *  1. `transaction` / `transaction_posting` rows are stamped with the owning
 *     tenant's `base_currency` at insert time by
 *     `trg_*_base_currency_fill` — proven against a **USD** tenant, so the
 *     fill cannot be a disguised `DEFAULT 'EUR'`.
 *  2. A writer that states a *disagreeing* base is refused (23514) — at
 *     insert time the fact's base is the tenant's, always.
 *  3. `tenant.base_currency` is freely settable until the first transaction
 *     exists, and trigger-refused after — including for a session that
 *     `transaction`'s FORCE RLS would otherwise blind: the immutability
 *     check is SECURITY DEFINER precisely so an `app_owner` maintenance
 *     session without `app.tenant_id` set cannot flip a ledger's base while
 *     the invoker-rights EXISTS sees zero rows. That case is the sharpest
 *     one here and is tested as the real `app_owner` role.
 *
 * This suite boots its own container rather than using
 * `@kerdial/platform-test-support` (TS5055 — same idiom as the sibling
 * suites in this package).
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

const OWNER_PASSWORD = "ar5-base-currency-test-only";

const TENANT_EUR = "00000000-0000-7000-8000-0000005500a1";
const TENANT_USD = "00000000-0000-7000-8000-0000005500a2";
const TENANT_FRESH = "00000000-0000-7000-8000-0000005500a3";
const PF_EUR = "00000000-0000-7000-8000-0000005500b1";
const PF_USD = "00000000-0000-7000-8000-0000005500b2";
const ACC_EUR = "00000000-0000-7000-8000-0000005500c1";
const ACC_USD = "00000000-0000-7000-8000-0000005500c2";

interface Refusal {
  readonly code: string | undefined;
  readonly message: string;
}

describe("AR-5 — base_currency fill/verify triggers and the tenant-base immutability trigger (0055)", () => {
  let container: StartedPostgreSqlContainer;
  let ownerClient: postgres.Sql;
  let appOwnerSql: postgres.Sql;
  let seq = 5500;

  async function refusal(run: () => Promise<unknown>): Promise<Refusal> {
    try {
      await run();
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { code: e.code, message: e.message ?? "" };
    }
    throw new Error("expected the statement to be refused, but it succeeded");
  }

  async function insertDeposit(params: {
    id: string;
    tenant: string;
    portfolio: string;
    account: string;
    currency: string;
    /** Explicit base_currency to state on the INSERT; omitted when undefined. */
    base?: string;
  }): Promise<{ base_currency: string }> {
    seq += 1;
    const [row] = await ownerClient<{ base_currency: string }[]>`
      INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                                 gross_amount, txn_currency, cash_currency, cash_amount,
                                 fx_rate, fx_rate_source, cash_account_id, base_currency)
      VALUES (${params.id}::uuid, ${params.tenant}::uuid, ${params.portfolio}::uuid, 'DEPOSIT',
              '2026-05-01', ${seq}, '1000', ${params.currency}, ${params.currency}, '1000',
              '1', 'IMPLIED_BASE', ${params.account}::uuid, ${params.base ?? null})
      RETURNING base_currency
    `;
    return row!;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off"])
      .start();
    ownerClient = createPostgresClient(container.getConnectionUri());
    await migrate(createDb(ownerClient), { migrationsFolder });

    // `app_owner` is created by 0007 with no password; give it one so the
    // SECURITY DEFINER case below can run as the real role, not the
    // RLS-bypassing superuser.
    await ownerClient.unsafe(`ALTER ROLE app_owner WITH LOGIN PASSWORD '${OWNER_PASSWORD}'`);
    const base = `${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
    appOwnerSql = postgres(`postgres://app_owner:${OWNER_PASSWORD}@${base}`, { max: 2 });

    await ownerClient`
      INSERT INTO "tenant" (id, base_currency) VALUES
        (${TENANT_EUR}::uuid, 'EUR'),
        (${TENANT_USD}::uuid, 'USD'),
        (${TENANT_FRESH}::uuid, 'EUR')
    `;
    await ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name) VALUES
        (${PF_EUR}::uuid, ${TENANT_EUR}::uuid, 'AR-5 EUR'),
        (${PF_USD}::uuid, ${TENANT_USD}::uuid, 'AR-5 USD')
    `;
    await ownerClient`
      INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency) VALUES
        (${ACC_EUR}::uuid, ${TENANT_EUR}::uuid, ${PF_EUR}::uuid, 'Courant EUR', 'EUR'),
        (${ACC_USD}::uuid, ${TENANT_USD}::uuid, ${PF_USD}::uuid, 'Courant USD', 'USD')
    `;
  }, 180_000);

  afterAll(async () => {
    await appOwnerSql?.end({ timeout: 5 });
    await ownerClient?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("a transaction inserted without base_currency is stamped with its tenant's — USD tenant gets USD, so the fill is per-tenant, not a default", async () => {
    const eurRow = await insertDeposit({
      id: "00000000-0000-7000-8000-0000005500d1",
      tenant: TENANT_EUR,
      portfolio: PF_EUR,
      account: ACC_EUR,
      currency: "EUR",
    });
    expect(eurRow.base_currency).toBe("EUR");

    const usdRow = await insertDeposit({
      id: "00000000-0000-7000-8000-0000005500d2",
      tenant: TENANT_USD,
      portfolio: PF_USD,
      account: ACC_USD,
      currency: "USD",
    });
    expect(usdRow.base_currency).toBe("USD");
  });

  it("a posting inserted without base_currency is stamped the same way", async () => {
    const [row] = await ownerClient<{ base_currency: string }[]>`
      INSERT INTO "transaction_posting" (id, tenant_id, transaction_id, portfolio_id, seq, leg,
                                         currency, amount_native, amount_base, fx_rate_applied,
                                         fx_rate_source, flow_class, cash_account_id)
      VALUES ('00000000-0000-7000-8000-0000005500e1'::uuid, ${TENANT_USD}::uuid,
              '00000000-0000-7000-8000-0000005500d2'::uuid, ${PF_USD}::uuid, 1, 'CASH',
              'USD', '1000', '1000', '1', 'IMPLIED_BASE', 'EXTERNAL', ${ACC_USD}::uuid)
      RETURNING base_currency
    `;
    expect(row!.base_currency).toBe("USD");
  });

  it("a writer stating the tenant's own base explicitly still succeeds — the trigger verifies, it does not forbid", async () => {
    const row = await insertDeposit({
      id: "00000000-0000-7000-8000-0000005500d3",
      tenant: TENANT_EUR,
      portfolio: PF_EUR,
      account: ACC_EUR,
      currency: "EUR",
      base: "EUR",
    });
    expect(row.base_currency).toBe("EUR");
  });

  it("a writer stating a DISAGREEING base is refused with 23514 naming both currencies", async () => {
    const r = await refusal(() =>
      insertDeposit({
        id: "00000000-0000-7000-8000-0000005500d4",
        tenant: TENANT_EUR,
        portfolio: PF_EUR,
        account: ACC_EUR,
        currency: "EUR",
        base: "USD",
      }),
    );
    expect(r.code).toBe("23514");
    expect(r.message).toContain("disagrees with the tenant ledger base");
    expect(r.message).toContain("USD");
    expect(r.message).toContain("EUR");
  });

  it("a tenant with no transactions may change its base freely — a brand-new tenant picking USD at signup is supported", async () => {
    await ownerClient`UPDATE "tenant" SET base_currency = 'USD' WHERE id = ${TENANT_FRESH}::uuid`;
    const [row] = await ownerClient<
      { base_currency: string }[]
    >`SELECT base_currency FROM "tenant" WHERE id = ${TENANT_FRESH}::uuid`;
    expect(row!.base_currency).toBe("USD");
    // Restore, so this case leaves no surprise for a later one.
    await ownerClient`UPDATE "tenant" SET base_currency = 'EUR' WHERE id = ${TENANT_FRESH}::uuid`;
  });

  it("once a transaction exists, flipping the base is refused — 23514, even for the superuser", async () => {
    const r = await refusal(
      () => ownerClient`UPDATE "tenant" SET base_currency = 'USD' WHERE id = ${TENANT_EUR}::uuid`,
    );
    expect(r.code).toBe("23514");
    expect(r.message).toContain("immutable once the tenant's first transaction exists");
  });

  it("the refusal holds for app_owner with NO app.tenant_id set — transaction's FORCE RLS cannot blind the SECURITY DEFINER check", async () => {
    // The sharp case: an invoker-rights EXISTS over "transaction" from this
    // session sees zero rows (FORCE RLS, no tenant GUC), which would wave the
    // flip through. Red-confirmable by dropping SECURITY DEFINER from
    // trg_tenant_base_currency_immutable_fn: this case then fails.
    const [visible] = await appOwnerSql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM "transaction"`;
    expect(visible!.n).toBe(0); // the blindness is real, not hypothetical

    const r = await refusal(
      () => appOwnerSql`UPDATE "tenant" SET base_currency = 'USD' WHERE id = ${TENANT_EUR}::uuid`,
    );
    expect(r.code).toBe("23514");
    expect(r.message).toContain("immutable once the tenant's first transaction exists");
  });

  it("an unrelated tenant UPDATE (not touching base_currency) is untouched by the trigger", async () => {
    // `status` was the probe column until it was dropped; `created_at` is the
    // other non-key column and equally outside the trigger's interest.
    await ownerClient`UPDATE "tenant" SET created_at = created_at WHERE id = ${TENANT_EUR}::uuid`;
  });
});
