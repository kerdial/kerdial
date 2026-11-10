import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresClient } from "./client.js";

/**
 * N7 (T-37): `Number("")` and
 * `Number("   ")` are both `0`, not `NaN` — the old `Number.isFinite(parsed)`
 * check silently accepted an env var that was *set but empty* as a valid
 * `0`, disabling `statement_timeout` (F5's own protection) or the connection
 * pool (`max: 0`) entirely. `"0"`/`"-5"`/`"abc"` are covered too — none of
 * these needs a real Postgres connection to prove; `postgres.js` exposes the
 * resolved config on `sql.options` before any connection is ever attempted
 * (`createPostgresClient` never awaits anything), which is what these tests
 * inspect. `client.integration.test.ts` (Testcontainers) separately proves
 * `DB_STATEMENT_TIMEOUT_MS` is enforced by a real server, not merely parsed.
 */
describe("platform/db — createPostgresClient env parsing (N7)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const previousTimeout = process.env["DB_STATEMENT_TIMEOUT_MS"];
  const previousPoolMax = process.env["DB_POOL_MAX"];

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (previousTimeout === undefined) delete process.env["DB_STATEMENT_TIMEOUT_MS"];
    else process.env["DB_STATEMENT_TIMEOUT_MS"] = previousTimeout;
    if (previousPoolMax === undefined) delete process.env["DB_POOL_MAX"];
    else process.env["DB_POOL_MAX"] = previousPoolMax;
  });

  function statementTimeoutFor(envValue: string | undefined): number {
    if (envValue === undefined) delete process.env["DB_STATEMENT_TIMEOUT_MS"];
    else process.env["DB_STATEMENT_TIMEOUT_MS"] = envValue;
    const sql = createPostgresClient("postgres://localhost:5432/placeholder");
    const timeout = sql.options.connection["statement_timeout"] as number;
    void sql.end();
    return timeout;
  }

  function poolMaxFor(envValue: string | undefined): number {
    if (envValue === undefined) delete process.env["DB_POOL_MAX"];
    else process.env["DB_POOL_MAX"] = envValue;
    const sql = createPostgresClient("postgres://localhost:5432/placeholder");
    const max = sql.options.max;
    void sql.end();
    return max;
  }

  describe.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["zero", "0"],
    ["negative", "-5"],
    ["non-numeric", "abc"],
  ])("DB_STATEMENT_TIMEOUT_MS=%s (%s)", (_label, value) => {
    it("falls back to the 15s default rather than accepting the invalid value", () => {
      expect(statementTimeoutFor(value)).toBe(15_000);
    });

    it("logs a console.warn naming the invalid value", () => {
      statementTimeoutFor(value);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] ?? [];
      expect(message).toContain("DB_STATEMENT_TIMEOUT_MS");
    });
  });

  describe.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["zero", "0"],
    ["negative", "-5"],
    ["non-numeric", "abc"],
  ])("DB_POOL_MAX=%s (%s)", (_label, value) => {
    it("falls back to the default pool size of 10 rather than accepting the invalid value", () => {
      expect(poolMaxFor(value)).toBe(10);
    });

    it("logs a console.warn naming the invalid value", () => {
      poolMaxFor(value);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] ?? [];
      expect(message).toContain("DB_POOL_MAX");
    });
  });

  it("accepts a genuinely unset DB_STATEMENT_TIMEOUT_MS silently (no warning) — distinct from a set-but-empty one", () => {
    expect(statementTimeoutFor(undefined)).toBe(15_000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("accepts a genuinely unset DB_POOL_MAX silently (no warning)", () => {
    expect(poolMaxFor(undefined)).toBe(10);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("accepts a valid positive integer for both env vars, with no warning", () => {
    expect(statementTimeoutFor("5000")).toBe(5000);
    expect(poolMaxFor("3")).toBe(3);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace around an otherwise-valid value", () => {
    expect(statementTimeoutFor("  5000  ")).toBe(5000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("an explicit options override always wins over the environment, valid or not", () => {
    process.env["DB_STATEMENT_TIMEOUT_MS"] = "abc";
    const sql = createPostgresClient("postgres://localhost:5432/placeholder", {
      statementTimeoutMs: 42,
    });
    try {
      expect(sql.options.connection["statement_timeout"]).toBe(42);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      void sql.end();
    }
  });
});

/**
 * T-3b (ADR-0014): `sslmode` enforcement. Nothing here needs a
 * real server — `postgres.js` resolves `ssl` onto `sql.options` before any
 * connection is attempted, same as the parsing tests above.
 *
 * The property under test is deliberately about the **host**, not the phase:
 * phase 1's on-host container network is exempt because TLS there is moot, and
 * the day the database moves anywhere else the factory must refuse rather than
 * connect in cleartext. A test that only asserted "phase 1 works" would go
 * green for a build that had quietly lost the control.
 */
describe("platform/db — createPostgresClient sslmode enforcement (T-3b)", () => {
  const previousSslMode = process.env["DB_SSLMODE"];

  afterEach(() => {
    if (previousSslMode === undefined) delete process.env["DB_SSLMODE"];
    else process.env["DB_SSLMODE"] = previousSslMode;
  });

  function sslFor(url: string, envValue?: string): unknown {
    if (envValue === undefined) delete process.env["DB_SSLMODE"];
    else process.env["DB_SSLMODE"] = envValue;
    const sql = createPostgresClient(url);
    const ssl = sql.options.ssl;
    void sql.end();
    return ssl;
  }

  it.each([
    ["postgres://u:p@localhost:5432/db", "localhost"],
    ["postgres://u:p@127.0.0.1:5432/db", "IPv4 loopback"],
    ["postgres://u:p@127.9.9.9:5432/db", "the rest of 127.0.0.0/8"],
    ["postgres://u:p@[::1]:5432/db", "IPv6 loopback"],
    ["postgres://u:p@postgres:5432/db", "a compose network alias"],
  ])("connects without TLS for %s (%s) — phase 1's on-host topology", (url) => {
    expect(sslFor(url)).toBe(false);
  });

  it("refuses to boot for a non-local host when DB_SSLMODE is unset", () => {
    expect(() => sslFor("postgres://u:p@db.example.com:5432/db")).toThrow(/DB_SSLMODE is not set/);
  });

  it("refuses DB_SSLMODE=disable for a non-local host — the escape hatch is not a bypass", () => {
    expect(() => sslFor("postgres://u:p@db.example.com:5432/db", "disable")).toThrow(
      /refused for a non-local database host/,
    );
  });

  it.each(["require", "verify-full"])("honours DB_SSLMODE=%s for a non-local host", (mode) => {
    expect(sslFor("postgres://u:p@db.example.com:5432/db", mode)).toBe(mode);
  });

  it("still honours an explicit DB_SSLMODE on a local host (opt-in TLS is allowed)", () => {
    expect(sslFor("postgres://u:p@localhost:5432/db", "verify-full")).toBe("verify-full");
  });

  it.each(["allow", "prefer"])(
    "rejects %s — libpq accepts it, but it downgrades to cleartext silently",
    (mode) => {
      expect(() => sslFor("postgres://u:p@db.example.com:5432/db", mode)).toThrow(
        /not a supported sslmode/,
      );
    },
  );

  it("treats an unparseable connection string as non-local rather than waving it through", () => {
    expect(() => sslFor("not a url", undefined)).toThrow(/DB_SSLMODE is not set/);
  });

  it("an explicit options override wins over the environment", () => {
    process.env["DB_SSLMODE"] = "require";
    const sql = createPostgresClient("postgres://u:p@db.example.com:5432/db", {
      sslMode: "verify-full",
    });
    try {
      expect(sql.options.ssl).toBe("verify-full");
    } finally {
      void sql.end();
    }
  });
});
