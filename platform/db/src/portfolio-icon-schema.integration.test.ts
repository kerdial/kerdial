import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
  PORTFOLIO_ACCENT_COLORS,
} from "@kerdial/core-reference-data";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient, type Db } from "./client.js";

/**
 * Migration `0068` (portfolio-details, PD-T1) — the shape of `portfolio_icon`
 * and of `portfolio`'s three new columns, asserted against the schema as
 * shipped.
 *
 * This suite builds its own container rather than using
 * `@kerdial/platform-test-support`'s `startMigratedPostgres`, because
 * `platform/test-support` **depends on** `platform/db` — taking it as a
 * dependency here would be a cycle. Same reason, and the same idiom, as
 * `name-floor-unicode-blank.integration.test.ts` beside it, and like that one it
 * migrates the **whole** folder: the subject is the schema as shipped, not one
 * migration's delta.
 *
 * What it deliberately does **not** cover: the grants and the RLS policy as the
 * real `app_web`/`app_ingest` roles. That is AC-402, proved by PD-T2's own
 * adversarial pass; everything here connects as the container superuser, which
 * is the convention the other DDL suites in this directory use and is the wrong
 * role to prove an isolation claim with.
 */
const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

const TENANT = "00000000-0000-7000-8000-000000068001";
const PORTFOLIO = "00000000-0000-7000-8000-000000068002";

describe("migration 0068 — portfolio_icon and the three portfolio detail columns", () => {
  let container: StartedPostgreSqlContainer;
  let ownerClient: ReturnType<typeof createPostgresClient>;
  let ownerDb: Db;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    ownerClient = createPostgresClient(container.getConnectionUri());
    ownerDb = createDb(ownerClient);
    await migrate(ownerDb, { migrationsFolder });

    await ownerClient`INSERT INTO "tenant" (id) VALUES (${TENANT}::uuid)`;
    await ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name)
      VALUES (${PORTFOLIO}::uuid, ${TENANT}::uuid, 'Portefeuille 0068')`;
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end({ timeout: 5 });
    await container?.stop();
  });

  const constraintDefinition = async (conname: string): Promise<string> => {
    const [row] = await ownerClient<{ definition: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c WHERE c.conname = ${conname}`;
    if (row === undefined) throw new Error(`no constraint named ${conname}`);
    return row.definition;
  };

  it("is owned by app_owner", async () => {
    // Asserted directly, and NOT left to `roles-and-rls.integration.test.ts`'s
    // catalogue-driven "app_owner owns every tenant-owned and shared table".
    // That suite does cover this table with no edit — but its failure message
    // never mentions ownership, so a missing `ALTER TABLE ... OWNER TO
    // app_owner` (which every table created after `0007` must carry for itself)
    // surfaces there as an unexplained list mismatch. This is the assertion that
    // names the problem.
    const [row] = await ownerClient<{ owner: string }[]>`
      SELECT r.rolname AS owner
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE c.relname = 'portfolio_icon' AND c.relnamespace = 'public'::regnamespace`;
    expect(row?.owner).toBe("app_owner");
  });

  it("mirrors instrument_icon column for column, minus `source` (FR-462, SD-2)", async () => {
    const columns = await ownerClient<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'portfolio_icon' ORDER BY ordinal_position`;
    expect(columns.map((c) => c.column_name)).toEqual([
      "tenant_id",
      "portfolio_id",
      "bytes",
      "content_type",
      "byte_length",
      "width_px",
      "height_px",
      "created_at",
      "updated_at",
    ]);
    // Every column is NOT NULL: there is no partially-stored icon.
    expect(columns.every((c) => c.is_nullable === "NO")).toBe(true);

    // `content_type` reuses the SAME pg enum type as `instrument_icon` rather
    // than a second one with the same two labels: a parallel
    // `portfolio_icon_content_type` would be a second vocabulary free to drift
    // from the first, while L2 requires the same closed format set.
    const [contentType] = await ownerClient<{ udt_name: string }[]>`
      SELECT udt_name FROM information_schema.columns
      WHERE table_name = 'portfolio_icon' AND column_name = 'content_type'`;
    expect(contentType?.udt_name).toBe("instrument_icon_content_type");
    const parallelTypes = await ownerClient<{ typname: string }[]>`
      SELECT typname FROM pg_type WHERE typname = 'portfolio_icon_content_type'`;
    expect(parallelTypes).toEqual([]);
  });

  it("keys on (tenant_id, portfolio_id) and adds no secondary index", async () => {
    const indexes = await ownerClient<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'portfolio_icon' ORDER BY indexname`;
    expect(indexes.map((i) => i.indexname)).toEqual(["portfolio_icon_tenant_id_portfolio_id_pk"]);
    expect(indexes[0]?.indexdef).toContain("(tenant_id, portfolio_id)");
  });

  it("references portfolio with ON DELETE NO ACTION, not CASCADE (FR-465, SD-3, PD-6)", async () => {
    // The decision this asserts is the one most likely to be "fixed" by a later
    // author copying `instrument_icon`'s own `ON DELETE cascade`. Every child of
    // `portfolio` is `no action` so that `deletePortfolio`'s final
    // `DELETE FROM portfolio` is itself the no-orphans proof — a forgotten child
    // delete makes it raise 23503 and the ordered chain fail loudly, whereas a
    // cascading child is exactly the one it would never notice.
    const fks = await ownerClient<{ conname: string; confdeltype: string }[]>`
      SELECT conname, confdeltype FROM pg_constraint
      WHERE conrelid = 'portfolio_icon'::regclass AND contype = 'f'
      ORDER BY conname`;
    expect(fks).toEqual([
      { conname: "portfolio_icon_portfolio_id_portfolio_id_fk", confdeltype: "a" },
      { conname: "portfolio_icon_tenant_id_tenant_id_fk", confdeltype: "a" },
    ]);
  });

  it("carries instrument_icon's three CHECKs, on the same two numbers", async () => {
    // The both-directions drift guard (`0057:55-61`): the literals are read back
    // out of the database and compared to the constants the schema module spread
    // them from, so neither the migration nor `core/reference-data` can move
    // alone. L2's "the same numbers as instrument icons" is then a fact about
    // this database, not a claim about a shared import.
    const isReal = await constraintDefinition("portfolio_icon_byte_length_is_real");
    expect(isReal).toBe("CHECK ((byte_length = octet_length(bytes)))");

    const byteBound = await constraintDefinition("portfolio_icon_byte_length_bound");
    expect(byteBound).toContain(String(INSTRUMENT_ICON_MAX_BYTES));
    const dimensionsBound = await constraintDefinition("portfolio_icon_dimensions_bound");
    expect(dimensionsBound).toContain(String(INSTRUMENT_ICON_MAX_PIXELS));

    // …and rendered identically to `instrument_icon`'s own, so a hand-edit to
    // one migration and not the other fails here even if both still mention the
    // right number.
    for (const suffix of ["byte_length_is_real", "byte_length_bound", "dimensions_bound"]) {
      expect(await constraintDefinition(`portfolio_icon_${suffix}`)).toBe(
        await constraintDefinition(`instrument_icon_${suffix}`),
      );
    }
  });

  it("creates portfolio_accent_color with PORTFOLIO_ACCENT_COLORS' labels, in order", async () => {
    // Member order is load-bearing: the tuple is spread into
    // `pgEnum`, so this is what proves the migration actually created the type
    // from that tuple rather than from a transcribed copy.
    const labels = await ownerClient<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'portfolio_accent_color'
      ORDER BY e.enumsortorder`;
    expect(labels.map((l) => l.enumlabel)).toEqual([...PORTFOLIO_ACCENT_COLORS]);
  });

  it("REFUSES a non-member accent value outright — never coerces it (FR-451)", async () => {
    // The mechanism this distinguishes: an enum column refuses at the type, so
    // there is no nearest-value coercion and no free-hex-plus-validation path
    // that could be bypassed by a caller reaching the table directly. Both a hex
    // string and a plausible-looking hue word fail with 22P02, invalid input
    // value for enum.
    for (const value of ["#FF00FF", "TEAL"]) {
      await expect(
        ownerClient`UPDATE "portfolio" SET accent_color = ${value} WHERE id = ${PORTFOLIO}::uuid`,
      ).rejects.toMatchObject({ code: "22P02" });
    }
    await ownerClient`
      UPDATE "portfolio" SET accent_color = 'CHART_3' WHERE id = ${PORTFOLIO}::uuid`;
  });

  it("leaves broker/description/accent_color independently optional (FR-449)", async () => {
    // Nullable, no default: `NOT NULL DEFAULT ''` would manufacture a value for
    // every existing portfolio and make "unset" unrepresentable, which is what
    // FR-453's clear-to-unset needs. And the two new CHECKs are NULL-safe for
    // free — `NULL ~ '…'` is NULL and a CHECK passes on NULL — so an all-NULL
    // row inserts, and one field can be set without the others.
    const columns = await ownerClient<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'portfolio'
        AND column_name IN ('broker', 'description', 'accent_color')
      ORDER BY column_name`;
    expect(columns).toEqual([
      { column_name: "accent_color", is_nullable: "YES", column_default: null },
      { column_name: "broker", is_nullable: "YES", column_default: null },
      { column_name: "description", is_nullable: "YES", column_default: null },
    ]);

    await ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name)
      VALUES (gen_random_uuid(), ${TENANT}::uuid, 'Tout NULL')`;
    await ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name, broker)
      VALUES (gen_random_uuid(), ${TENANT}::uuid, 'Courtier seul', 'Boursorama')`;
  });

  it("refuses a broker/description blank only under the Unicode floor, and one over the bound", async () => {
    // The floor itself is `name-floor-unicode-blank.integration.test.ts`'s
    // subject — including the assertion that all four rendered definitions are
    // the same expression. What is checked here is that the two new columns are
    // actually wired to it: a lone U+200B (one of the ten codepoints `0028`'s
    // original `~ '\S'` admitted) and an over-length value are both refused, by
    // the named constraint.
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    const cases: readonly [column: string, constraint: string, value: string][] = [
      ["broker", "portfolio_broker_length", zeroWidthSpace],
      ["broker", "portfolio_broker_length", "b".repeat(201)],
      ["description", "portfolio_description_length", zeroWidthSpace],
      ["description", "portfolio_description_length", "d".repeat(2001)],
    ];
    for (const [column, constraint, value] of cases) {
      await expect(
        ownerClient`
          UPDATE "portfolio" SET ${ownerClient(column)} = ${value} WHERE id = ${PORTFOLIO}::uuid`,
      ).rejects.toMatchObject({ code: "23514", constraint_name: constraint });
    }
    // The bounds themselves are accepted — the ceilings are inclusive (L5).
    await ownerClient`
      UPDATE "portfolio"
      SET broker = ${"b".repeat(200)}, description = ${"d".repeat(2000)}
      WHERE id = ${PORTFOLIO}::uuid`;
  });
});
