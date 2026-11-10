import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  LOG_CONTEXT_FIELDS,
  REDACTED,
  createLogger,
  currentLogContext,
  logContextFields,
  runWithJobContext,
  runWithRequestContext,
  setRequestTenant,
  type Logger,
} from "./logger.js";

/**
 * SH-38 (FR-29–FR-33, AC-26–AC-29).
 *
 * **Every assertion here reads bytes that were actually emitted.** AC-28 and
 * AC-29 both say so in as many words — "verified by inspecting the actual
 * emitted output for the raw secret value, not the presence of a `redact`
 * config key" — and this project has a recorded history of tests that assert a
 * configuration exists and prove nothing about behaviour. So the stream is
 * captured, the lines are parsed, and the raw values are searched for in the
 * serialized text.
 */
function capture(): { logger: Logger; lines: () => Record<string, unknown>[]; raw: () => string } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  const logger = createLogger({ destination, level: "debug" });
  return {
    logger,
    /**
     * The emitted bytes with pino's own `"time":<epoch-ms>` removed.
     *
     * **Why the timestamp is stripped.** Every assertion below is of the strong
     * form "this value must not appear *anywhere* in the output, under any key"
     * — a substring check, deliberately, because a key-based check would miss a
     * value that leaked under a different name. But a 13-digit epoch is a long
     * run of arbitrary digits, so it collides with any short numeric value the
     * test is looking for. Observed on a CI run:
     * `not.toContain("42")` failed against `"time":1787333179542`, which ends
     * in `42` — a redaction test failing because of the clock.
     *
     * Stripping it keeps the substring form (the part that matters) and removes
     * the only span of the line the test does not control. `lines()` below still
     * parses the untouched JSON, so nothing loses access to the real field.
     */
    raw: (): string => chunks.join("").replace(/"time":\d+,?/g, ""),
    lines: (): Record<string, unknown>[] =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("AC-26 — every line under an authenticated request carries tenant_id and request_id", () => {
  it("carries both, and the tenant arrives by mutating the store the hook already opened", () => {
    const { logger, lines } = capture();

    runWithRequestContext({ request_id: "req-1", tenant_id: null }, () => {
      // Pre-auth: the guard has not run, so the tenant is legitimately null.
      logger.info("before auth");
      setRequestTenant("tenant-7");
      logger.info("after auth");
      // A frame nested below the mutation still sees it — the point of
      // mutating rather than opening a second store.
      const nested = (): void => {
        logger.warn("nested");
      };
      nested();
    });

    const [pre, post, nested] = lines();
    expect(pre?.["request_id"]).toBe("req-1");
    expect(pre?.["tenant_id"]).toBeNull();
    expect(post?.["tenant_id"]).toBe("tenant-7");
    expect(nested?.["tenant_id"]).toBe("tenant-7");
    expect(nested?.["request_id"]).toBe("req-1");
  });

  it("a call site cannot shadow the ambient tenant with one of its own", () => {
    const { logger, lines } = capture();
    runWithRequestContext({ request_id: "req-2", tenant_id: null }, () => {
      setRequestTenant("real-tenant");
      logger.info("attempted override", { tenant_id: "attacker-tenant" });
    });
    expect(lines()[0]?.["tenant_id"]).toBe("real-tenant");
  });

  it("carries the socket peer and the derived client ip as two distinct fields (SH-26, revision 4)", () => {
    const { logger, lines } = capture();
    runWithRequestContext(
      { request_id: "req-3", tenant_id: null, peer: "192.168.1.12", client_ip: "203.0.113.7" },
      () => {
        logger.info("request");
      },
    );
    const line = lines()[0];
    // The two must not collapse: the whole point of the proxy-trust checks is asking
    // who connected independently of what the trust configuration believes.
    expect(line?.["peer"]).toBe("192.168.1.12");
    expect(line?.["client_ip"]).toBe("203.0.113.7");
    // ...and neither is treated as something to redact.
    expect(JSON.stringify(line)).not.toContain(REDACTED);
  });
});

describe("AC-27 — every line during a worker job execution carries a job id and queue name", () => {
  it("carries job_id, queue and the optional instrument_id", () => {
    const { logger, lines } = capture();
    runWithJobContext({ job_id: "job-9", queue: "quote-refresh", instrument_id: "inst-1" }, () => {
      logger.info("handling");
    });
    const line = lines()[0];
    expect(line?.["job_id"]).toBe("job-9");
    expect(line?.["queue"]).toBe("quote-refresh");
    expect(line?.["instrument_id"]).toBe("inst-1");
    // A job has no tenant — it is cross-tenant by construction — so the field
    // is absent rather than a misleading null.
    expect(line).not.toHaveProperty("tenant_id");
  });

  it("nested contexts do not leak into each other", () => {
    const { logger, lines } = capture();
    runWithJobContext({ job_id: "job-a", queue: "eod-close" }, () => {
      logger.info("a");
    });
    runWithJobContext({ job_id: "job-b", queue: "fx-daily" }, () => {
      logger.info("b");
    });
    logger.info("outside");
    const [a, b, outside] = lines();
    expect(a?.["job_id"]).toBe("job-a");
    expect(b?.["job_id"]).toBe("job-b");
    expect(outside).not.toHaveProperty("job_id");
    expect(currentLogContext()).toBeUndefined();
    expect(logContextFields()).toEqual({});
  });
});

describe("AC-28 — secrets never appear verbatim in emitted output", () => {
  const SID = "s%3A9f2c1b3a-secret-session-token";
  const CSRF = "3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c";
  const DATABASE_URL = "postgres://app_web:hunter2@db.internal:5432/portfolio";

  it("a sid, a csrf_token and a DATABASE_URL-shaped value are censored in the actual bytes", () => {
    const { logger, raw } = capture();
    logger.error("connection failed", {
      // Every one of these is *also* outside the allow-list, so this asserts
      // the deny-list independently of the allow-list — both layers, not one
      // masquerading as two.
      sid: SID,
      csrf_token: CSRF,
      DATABASE_URL,
    } as never);

    const output = raw();
    expect(output).not.toContain(SID);
    expect(output).not.toContain(CSRF);
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain(DATABASE_URL);
  });

  it("an allow-listed field whose VALUE carries a secret is caught by redact, not by the allow-list", () => {
    // `error` is allow-listed on purpose — an error message is a diagnostic.
    // This is exactly the case the deny-list exists for as a second line.
    const { logger, raw } = capture();
    logger.child({ component: "db" }).error("boom", { DATABASE_URL });
    expect(raw()).not.toContain("hunter2");
  });

  it("a user email address never reaches output", () => {
    const { logger, raw } = capture();
    logger.info("login attempt", { email: "owner@example.com" } as never);
    const output = raw();
    expect(output).not.toContain("owner@example.com");
  });
});

describe("AC-29 / FR-33 — no monetary or position value ever reaches output", () => {
  it("the market-data repair summary fields reach the emitted line — they shipped once without an entry and were silently dropped in production", () => {
    const { logger, lines } = capture();
    logger.info("history-gap-repair: instrument scanned", {
      component: "market-composition",
      scanned_from: "2006-08-28",
      scanned_to: "2026-09-16",
      missing: 8,
      filled: 8,
      skipped_closed: 2,
      skipped_known_empty: 47,
      recorded_empty: 0,
    });
    logger.info("fx-daily: history coverage fetched missing ranges", {
      component: "market-composition",
      written: 4150,
      backfills: "EUR/USD INTERIOR 2010-02-15..2026-08-27",
    });
    logger.warn("fx-daily: fetched FX history is short of the requested range", {
      component: "market-composition",
      shortfalls:
        "EUR/USD TAIL requested 1999-01-04..2026-10-07 observed 1999-01-04..2010-02-14 rows 2803",
    });
    const [scan, fx, short] = lines();
    expect(scan).toMatchObject({
      scanned_from: "2006-08-28",
      scanned_to: "2026-09-16",
      missing: 8,
      filled: 8,
      skipped_closed: 2,
      skipped_known_empty: 47,
      recorded_empty: 0,
    });
    expect(fx).toMatchObject({
      written: 4150,
      backfills: "EUR/USD INTERIOR 2010-02-15..2026-08-27",
    });
    expect(short).toMatchObject({
      shortfalls:
        "EUR/USD TAIL requested 1999-01-04..2026-10-07 observed 1999-01-04..2010-02-14 rows 2803",
    });
  });

  it("drops a representative set of monetary and position fields, by allow-list not by name matching", () => {
    const { logger, raw, lines } = capture();
    // The shape a well-meaning future call site takes: hand the logger the
    // thing it is working on. Every one of these is silently dropped because
    // none is allow-listed — no rule about *these* names exists anywhere.
    logger.info("valuation materialised", {
      price: "1234.56",
      quantity: "42",
      close: "987.65",
      rate: "1.0987",
      costBasisBase: "100000.00",
      pmpUnitBase: "250.50",
      totalValueBase: "987654.32",
      amount: "-5000.00",
      realizedGain: "1234.00",
    } as never);

    const output = raw();
    for (const value of [
      "1234.56",
      "42",
      "987.65",
      "1.0987",
      "100000.00",
      "250.50",
      "987654.32",
      "-5000.00",
      "1234.00",
    ]) {
      expect(output).not.toContain(value);
    }
    // The line itself was still emitted — dropping the values is not the same
    // as losing the event.
    expect(lines()[0]?.["msg"]).toBe("valuation materialised");
  });

  it("a brand-new monetary field nobody anticipated is dropped too — the allow-list fails closed", () => {
    const { logger, raw } = capture();
    logger.info("some future handler", {
      someFieldInventedNextYear: "9999999.99",
    } as never);
    expect(raw()).not.toContain("9999999.99");
  });

  it("the diagnostics that ARE allow-listed still come through", () => {
    const { logger, lines } = capture();
    logger.warn("provider unavailable", {
      provider: "yahoo",
      count: 5,
      duration_ms: 1200,
      sqlstate: "42501",
    });
    const line = lines()[0];
    expect(line?.["provider"]).toBe("yahoo");
    expect(line?.["count"]).toBe(5);
    expect(line?.["duration_ms"]).toBe(1200);
    expect(line?.["sqlstate"]).toBe("42501");
  });
});

describe("output shape (FR-29, FR-31)", () => {
  it("is one JSON object per line with a string level, on the given destination and nowhere else", () => {
    const { logger, lines } = capture();
    logger.error("failure");
    const line = lines()[0];
    expect(line?.["level"]).toBe("error");
    expect(line?.["msg"]).toBe("failure");
    expect(typeof line?.["time"]).toBe("number");
  });

  it("the context field set is exactly what is documented", () => {
    expect([...LOG_CONTEXT_FIELDS].sort()).toEqual(
      ["client_ip", "instrument_id", "job_id", "peer", "queue", "request_id", "tenant_id"].sort(),
    );
  });
});

describe("account-setup NFR-48/NFR-49 — the admin audit line's four fields survive the allow-list", () => {
  /**
   * **This reads a real emitted line, deliberately.** This file's own
   * recorded failure direction is that an unlisted field is *silently
   * dropped* — never an error, never a warning — so a test that asserted on
   * what the caller passed to `logger.info` would pass with the allow-list
   * edit missing entirely. The same mistake is recorded twice above, for
   * `openProviders` and for the two ops-indicator counts, which is why
   * `admin.controller.ts`'s audit line gets its own emitted-output proof
   * rather than a review promise.
   */
  it("actor_user_id, target_user_id, target_tenant_id and admin_action all reach the output with their values", () => {
    const { logger, lines } = capture();

    logger.info("admin: provisioned a tenant and its user", {
      component: "api",
      admin_action: "provision_account",
      actor_user_id: "00000000-0000-7000-8000-00000000a001",
      target_user_id: "00000000-0000-7000-8000-00000000b001",
      target_tenant_id: "00000000-0000-7000-8000-00000000b000",
    });

    const line = lines()[0];
    expect(line).toBeDefined();
    expect(line?.["admin_action"]).toBe("provision_account");
    expect(line?.["actor_user_id"]).toBe("00000000-0000-7000-8000-00000000a001");
    expect(line?.["target_user_id"]).toBe("00000000-0000-7000-8000-00000000b001");
    expect(line?.["target_tenant_id"]).toBe("00000000-0000-7000-8000-00000000b000");
  });

  it("an email or a password passed alongside them is still not in the emitted bytes", () => {
    const { logger, raw } = capture();

    // `admin.controller.ts` never passes either — the discipline is not to
    // hand them over at all. This asserts the second line of defence holds
    // anyway, on the same call shape the audit line uses.
    logger.info("admin: reset a user's password", {
      admin_action: "admin_reset_password",
      actor_user_id: "00000000-0000-7000-8000-00000000a001",
      target_user_id: "00000000-0000-7000-8000-00000000b001",
      email: "victim@example.com",
      password: "correct horse battery staple",
    });

    expect(raw()).not.toContain("victim@example.com");
    expect(raw()).not.toContain("correct horse battery staple");
    expect(raw()).toContain("admin_reset_password");
  });
});
