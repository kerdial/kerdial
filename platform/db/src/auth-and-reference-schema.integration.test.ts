import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal, toDecimalString } from "@kerdial/core-decimal";
import { sql } from "drizzle-orm";
import { pgTable } from "drizzle-orm/pg-core";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ISO_4217_CURRENCIES } from "./seed-data/iso-4217-currencies.js";
import { createDb, createPostgresClient, type Db } from "./client.js";
import { decimalCol } from "./decimal-column.js";
import { appUser, currency, instrument, session, tenant } from "./schema/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

/**
 * T-5 acceptance: migrations apply cleanly from empty against a real
 * Postgres 17 container; the auth & reference schema's constraints hold;
 * the ISO 4217 seed lands; and `decimalCol` round-trips an 18dp and an 8dp
 * value byte-identically (AC53).
 */
describe("platform/db — auth & reference schema (T-5, Testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: Db;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    client = createPostgresClient(container.getConnectionUri());
    db = createDb(client);
    await migrate(db, { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  }, 30_000);

  it("applies every migration cleanly from an empty database", async () => {
    const tables = await client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const tableNames = tables.map((t) => t.table_name);
    // Asserts T-5's auth/reference tables are present. Not an
    // exact-equality check against the full table set: T-6's ledger tables
    // and T-7's market/reference-data tables extend this same migrations
    // directory and are out of this suite's scope to enumerate here.
    expect(tableNames).toEqual(
      expect.arrayContaining([
        "app_user",
        "currency",
        "instrument",
        "instrument_provider_map",
        "session",
        "tenant",
      ]),
    );
  });

  describe("currency — ISO 4217 seed data", () => {
    it("is seeded with exactly the checked-in ISO 4217 currency list (row-count assertion)", async () => {
      const rows = await db.select().from(currency);
      expect(rows).toHaveLength(ISO_4217_CURRENCIES.length);
    });

    it("spot-checks minor_unit for a 2dp, a 0dp, and a 3dp currency", async () => {
      const rows = await db.select().from(currency);
      const byCode = new Map(rows.map((r) => [r.code, r]));
      expect(byCode.get("USD")?.minorUnit).toBe(2);
      expect(byCode.get("JPY")?.minorUnit).toBe(0);
      expect(byCode.get("BHD")?.minorUnit).toBe(3);
      expect(byCode.get("USD")?.isActive).toBe(true);
    });
  });

  describe("tenant / app_user / session — tenant_id NOT NULL (FR-45, NFR-8, AC33)", () => {
    it("declares tenant_id NOT NULL on every user-owned table (schema-level half of AC33)", async () => {
      const rows = await client<{ table_name: string; column_name: string; is_nullable: string }[]>`
        SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'tenant_id'
          AND table_name IN ('app_user', 'session')
      `;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.is_nullable).toBe("NO");
      }
    });

    it("tenant itself is the tenant root (its own id is the primary key, not a tenant_id column)", async () => {
      const rows = await client<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tenant' AND column_name = 'tenant_id'
      `;
      expect(rows).toHaveLength(0);
    });

    it("supports the full FK chain tenant -> app_user -> session, with citext/bytea/inet working", async () => {
      const [createdTenant] = await db
        .insert(tenant)
        .values({ id: "00000000-0000-7000-8000-000000000100" })
        .returning();
      expect(createdTenant?.baseCurrency).toBe("EUR");

      const [createdUser] = await db
        .insert(appUser)
        .values({
          id: "00000000-0000-7000-8000-000000000101",
          tenantId: "00000000-0000-7000-8000-000000000100",
          email: "Alice@Example.com",
          passwordHash: "argon2id$placeholder",
        })
        .returning();
      expect(createdUser?.email).toBe("Alice@Example.com");

      // citext: a case-insensitive lookup by a differently-cased email finds
      // the same row.
      const [foundByLowercase] = await db
        .select()
        .from(appUser)
        .where(sql`${appUser.email} = 'alice@example.com'`);
      expect(foundByLowercase?.id).toBe("00000000-0000-7000-8000-000000000101");

      const tokenHash = Buffer.from(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85",
        "hex",
      );
      const [createdSession] = await db
        .insert(session)
        .values({
          id: "00000000-0000-7000-8000-000000000102",
          tenantId: "00000000-0000-7000-8000-000000000100",
          userId: "00000000-0000-7000-8000-000000000101",
          tokenHash,
          expiresAt: new Date("2026-08-20T00:00:00Z"),
          ip: "203.0.113.10",
        })
        .returning();
      expect(createdSession?.tokenHash).toEqual(tokenHash);
      expect(createdSession?.ip).toBe("203.0.113.10");
    });
  });

  describe("instrument — shared catalogue, no tenant_id", () => {
    it("has no tenant_id column, and owner_tenant_id is nullable defaulting to NULL", async () => {
      const tenantIdRows = await client<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'instrument' AND column_name = 'tenant_id'
      `;
      expect(tenantIdRows).toHaveLength(0);

      const ownerRows = await client<{ is_nullable: string; column_default: string | null }[]>`
        SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'instrument' AND column_name = 'owner_tenant_id'
      `;
      expect(ownerRows).toHaveLength(1);
      expect(ownerRows[0]?.is_nullable).toBe("YES");
      expect(ownerRows[0]?.column_default).toBeNull();

      const [row] = await db
        .insert(instrument)
        .values({
          id: "00000000-0000-7000-8000-000000000001",
          kind: "SHARE",
          displayName: "TotalEnergies SE",
          listingCurrency: "EUR",
          exchangeMic: "XPAR",
          // IR-22 — a **synthetic** ISIN, not a real listing. Migration `0037` seeds the
          // real large-cap identifiers into the shared catalogue, so a fixture reusing one
          // collides with the seeded row on `instrument_isin_exchange_mic_key`. The `TEST`
          // NSIN keeps the ISO 6166 check digit valid and can never be a real identifier.
          isin: "FRTEST000438",
          primaryIdentifier: "ISIN",
          quotePolicy: "AUTO",
        })
        .returning();
      expect(row?.ownerTenantId).toBeNull();
    });

    it("rejects a duplicate (isin, exchange_mic) pair, but accepts the same ISIN on a different exchange_mic (AC1, FR-3)", async () => {
      await db.insert(instrument).values({
        id: "00000000-0000-7000-8000-000000000010",
        kind: "SHARE",
        displayName: "Duplicate test SA",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FRTEST000446",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      });

      await expect(
        db.insert(instrument).values({
          id: "00000000-0000-7000-8000-000000000011",
          kind: "SHARE",
          displayName: "Duplicate test SA (again)",
          listingCurrency: "EUR",
          exchangeMic: "XPAR",
          isin: "FRTEST000446",
          primaryIdentifier: "ISIN",
          quotePolicy: "AUTO",
        }),
      ).rejects.toThrow();

      // Same ISIN, different exchange_mic: a distinct, valid dual listing.
      const [row] = await db
        .insert(instrument)
        .values({
          id: "00000000-0000-7000-8000-000000000012",
          kind: "SHARE",
          displayName: "Duplicate test SA (NYSE listing)",
          listingCurrency: "USD",
          exchangeMic: "XNYS",
          isin: "FRTEST000446",
          primaryIdentifier: "ISIN",
          quotePolicy: "AUTO",
        })
        .returning();
      expect(row?.isin).toBe("FRTEST000446");
      expect(row?.exchangeMic).toBe("XNYS");
    });

    it("accepts a CRYPTO instrument with a NULL isin, and rejects a duplicate crypto symbol (AC2)", async () => {
      await db.insert(instrument).values({
        id: "00000000-0000-7000-8000-000000000020",
        kind: "CRYPTO",
        displayName: "Bitcoin",
        listingCurrency: "USD",
        symbol: "BTC",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "AUTO",
      });

      await expect(
        db.insert(instrument).values({
          id: "00000000-0000-7000-8000-000000000021",
          kind: "CRYPTO",
          displayName: "Bitcoin (duplicate symbol)",
          listingCurrency: "USD",
          symbol: "BTC",
          primaryIdentifier: "SYMBOL",
          quotePolicy: "AUTO",
        }),
      ).rejects.toThrow();
    });
  });

  describe("decimalCol — Postgres round-trip fidelity (AC53)", () => {
    // A scratch table exercising decimalCol at both the 18dp (crypto
    // quantity) and 12dp-storing-an-8dp-value (FX rate) widths — the exact same two example
    // values the full-stack AC53 test uses.
    const decimalRoundtripScratch = pgTable("decimal_roundtrip_scratch", {
      quantity: decimalCol("quantity", 38, 18).notNull(),
      fxRate: decimalCol("fx_rate", 28, 12).notNull(),
    });

    beforeAll(async () => {
      await client`
        CREATE TABLE decimal_roundtrip_scratch (
          quantity numeric(38, 18) NOT NULL,
          fx_rate numeric(28, 12) NOT NULL
        )
      `;
    });

    it("round-trips an 18dp crypto quantity and an 8dp FX rate byte-identically, with zero float coercion", async () => {
      const quantity = new Decimal("1.234567890123456789");
      const fxRate = new Decimal("0.12345678");

      await db.insert(decimalRoundtripScratch).values({ quantity, fxRate });

      const [row] = await db.select().from(decimalRoundtripScratch);
      expect(row).toBeDefined();
      expect(row?.quantity).toBeInstanceOf(Decimal);
      expect(row?.fxRate).toBeInstanceOf(Decimal);

      // Byte-identical string round-trip — the exact AC53 assertion shape.
      // (Postgres pads the wire value to the column's declared scale, e.g.
      // "0.123456780000" for numeric(28,12) — decimal.js normalizes that
      // back to the value's own significant digits, so the round-tripped
      // string matches the *originally supplied* value exactly, not the
      // storage padding.)
      expect(toDecimalString(row!.quantity)).toBe("1.234567890123456789");
      expect(toDecimalString(row!.fxRate)).toBe("0.12345678");
      expect(row!.quantity.equals(quantity)).toBe(true);
      expect(row!.fxRate.equals(fxRate)).toBe(true);

      // The raw driver value was never coerced through a JS number: reading
      // the same column via a raw query still yields a string, never a
      // JS `number`, proving postgres.js carries no numeric parser override.
      const [raw] = await client<{ quantity: string; fx_rate: string }[]>`
        SELECT quantity, fx_rate FROM decimal_roundtrip_scratch
      `;
      expect(typeof raw?.quantity).toBe("string");
      expect(typeof raw?.fx_rate).toBe("string");
      expect(raw?.quantity).toBe("1.234567890123456789");
    });
  });
});
