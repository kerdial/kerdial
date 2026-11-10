import { Writable } from "node:stream";
import type { ArgumentsHost } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { createLogger, setRootLoggerForTest } from "@kerdial/platform-logging";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemJsonExceptionFilter } from "./problem-json.filter.js";

/**
 * N3 (security review, T-37): unit tests for the two
 * parts of this finding that `instruments.e2e.test.ts` cannot exercise
 * through a real HTTP round trip — a non-`listingCurrency`/`currency` FK
 * violation (`instrument_id`/`tenant_id`) is unreachable through the real API
 * (the controller always checks `getInstrumentById` and takes `tenantId` from
 * the session first), so it is only reachable by fabricating the raw
 * `postgres.PostgresError` this filter's `catch` block actually branches on
 * — the same "fabricate the boundary object directly" pattern
 * `public-decorator.test.ts`'s `CsrfGuard` unit tests already use for an
 * analogous reason.
 */

function fakeHost(): { host: ArgumentsHost; reply: FastifyReply } {
  const reply = {
    status: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as FastifyReply;
  const host = {
    switchToHttp: () => ({ getResponse: () => reply }),
  } as unknown as ArgumentsHost;
  return { host, reply };
}

function fkViolation(constraintName: string): postgres.PostgresError {
  // `postgres`'s own public `.d.ts` types `PostgresError`'s constructor as
  // plain `Error`'s (a string message) — its actual runtime implementation
  // (`postgres/src/errors.js`) takes an options object and `Object.assign`s
  // it onto the instance, which is what every real driver-thrown
  // `PostgresError` (and this fixture) actually needs (`code`/
  // `constraint_name`). Constructing then assigning keeps this file
  // type-check-clean without a blanket `as unknown as PostgresError` cast.
  const error = new postgres.PostgresError(
    `insert or update on table violates foreign key constraint "${constraintName}"`,
  );
  return Object.assign(error, { code: "23503", constraint_name: constraintName });
}

describe("ProblemJsonExceptionFilter — N3 (security review)", () => {
  const filter = new ProblemJsonExceptionFilter();
  /**
   * SH-38: this filter no longer writes through `console.*`
   * (it is one of the two named sites that migrate), so the
   * assertions below read the **emitted** log lines rather than spy calls.
   * That is the stronger check anyway: it is what the line actually contains
   * that N3 cares about, not that some function was invoked.
   */
  let emitted: string[];
  let restoreLogger: () => void;

  beforeEach(() => {
    emitted = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        emitted.push(chunk.toString("utf8"));
        callback();
      },
    });
    restoreLogger = setRootLoggerForTest(createLogger({ destination, level: "debug" }));
  });

  afterEach(() => {
    restoreLogger();
  });

  const lines = (): Record<string, unknown>[] =>
    emitted
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  // N3 red-confirm target: the unfixed filter mapped *every* `23503` to 400
  // regardless of constraint — `instrument_id_instrument_id_fk`/
  // `tenant_id_tenant_id_fk` are never populated from client-controlled
  // request content, so a violation there is a server bug, not client
  // garbage, and must surface as a (logged) 500.
  /**
   * `drizzle-orm` wraps every failed query in a `DrizzleQueryError`
   * whose message is `` `Failed query: ${query}\nparams: ${params}` ``. This
   * filter's own comment named that hazard — and then logged
   * `exception.message`, which for that class *is* the query and its bound
   * parameters. On a write path those parameters are quantities and amounts,
   * which is precisely what FR-33 forbids in log output.
   *
   * Constructed by shape rather than by importing `drizzle-orm`: the withhold
   * is keyed on the two literals that constructor writes, not on `instanceof`,
   * so a test that used the real class would be checking a different rule than
   * the one that ships.
   */
  class FakeDrizzleQueryError extends Error {
    constructor() {
      super(
        'Failed query: insert into "transaction" ("gross_amount","quantity") values ($1,$2)\n' +
          "params: 154321.99,1200",
      );
      this.name = "DrizzleQueryError";
    }
  }

  it("a DrizzleQueryError's SQL and bound parameters never reach the log — the class name does", () => {
    const { host, reply } = fakeHost();
    filter.catch(new FakeDrizzleQueryError(), host);

    expect(reply.status).toHaveBeenCalledWith(500);
    const logged = lines().find((line) => line["msg"] === "unhandled error mapped to 500");
    expect(logged).toBeDefined();

    const serialised = JSON.stringify(logged);
    // The three things that must not be there, asserted individually so a
    // failure names which one leaked.
    expect(serialised).not.toContain("Failed query");
    expect(serialised).not.toContain("params:");
    expect(serialised).not.toContain("154321.99");
    // …and the line is still useful: it says what happened.
    expect(logged?.["error"]).toContain("FakeDrizzleQueryError");
    expect(logged?.["error"]).toContain("withheld");
  });

  it("positive companion: an ordinary error's message still reaches the log in full", () => {
    const { host, reply } = fakeHost();
    filter.catch(
      new TypeError("withholding.amount must be a positive, finite amount, got: 0"),
      host,
    );

    expect(reply.status).toHaveBeenCalledWith(500);
    const logged = lines().find((line) => line["msg"] === "unhandled error mapped to 500");
    // Without this, "stop logging error messages" would pass the test above —
    // and the 500 branch exists precisely to preserve that signal.
    expect(logged?.["error"]).toContain(
      "withholding.amount must be a positive, finite amount, got: 0",
    );
    expect(logged?.["error"]).toContain("TypeError");
  });

  it("a non-Error thrown value is described by type, not stringified into the line", () => {
    const { host } = fakeHost();
    filter.catch({ query: "select 1", params: [42] }, host);

    const logged = lines().find((line) => line["msg"] === "unhandled error mapped to 500");
    expect(logged?.["error"]).toBe("a non-Error value of type object was thrown");
  });

  it("a non-allowlisted FK violation (instrument_id) stays a 500, not a 400", () => {
    const { host, reply } = fakeHost();
    filter.catch(fkViolation("manual_price_point_instrument_id_instrument_id_fk"), host);

    expect(reply.status).toHaveBeenCalledWith(500);
    const body = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(body.status).toBe(500);
    // No constraint/table name ever reaches the response body.
    expect(JSON.stringify(body)).not.toContain("instrument_id");
  });

  it("a non-allowlisted FK violation (tenant_id) stays a 500, not a 400", () => {
    const { host, reply } = fakeHost();
    filter.catch(fkViolation("manual_price_point_tenant_id_tenant_id_fk"), host);

    expect(reply.status).toHaveBeenCalledWith(500);
  });

  it("the currency FK on instrument.listing_currency is still mapped to 400 (allowlisted)", () => {
    const { host, reply } = fakeHost();
    filter.catch(fkViolation("instrument_listing_currency_currency_code_fk"), host);

    expect(reply.status).toHaveBeenCalledWith(400);
    const body = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(body.code).toBe("MALFORMED_INPUT");
  });

  it("the currency FK on manual_price_point.currency is still mapped to 400 (allowlisted)", () => {
    const { host, reply } = fakeHost();
    filter.catch(fkViolation("manual_price_point_currency_currency_code_fk"), host);

    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it("logs a 500-mapped error server-side at ERROR level, with the error's own message", () => {
    const { host } = fakeHost();
    const boom = new Error("simulated unexpected failure");
    filter.catch(boom, host);

    const [line, ...rest] = lines();
    expect(rest).toEqual([]);
    expect(line?.["level"]).toBe("error");
    // The class name now prefixes the message. The message itself is
    // still there in full — the withhold applies to one class, not to logging.
    expect(line?.["error"]).toBe("Error: simulated unexpected failure");
  });

  it("logs a PG-error-mapped 400 server-side with the sqlstate and constraint name", () => {
    const { host } = fakeHost();
    filter.catch(fkViolation("instrument_listing_currency_currency_code_fk"), host);

    const [line, ...rest] = lines();
    expect(rest).toEqual([]);
    expect(line?.["level"]).toBe("warn");
    expect(line?.["sqlstate"]).toBe("23503");
    expect(line?.["constraint"]).toBe("instrument_listing_currency_currency_code_fk");
  });

  it("logs a non-allowlisted FK violation (500 path) too", () => {
    const { host } = fakeHost();
    filter.catch(fkViolation("manual_price_point_instrument_id_instrument_id_fk"), host);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]?.["level"]).toBe("error");
  });

  it("AC-29 — a DrizzleQueryError's bound parameters never reach the line, and neither does its message", () => {
    // The riskiest real shape: a failed write whose bound parameters are the
    // monetary values of the transaction being written.
    //
    // **This test's fixture used to be unrepresentative, and that is why the leak
    // survived it.** It carried the params as object *properties* while its
    // `message` was the hand-written `"Failed query: insert into transaction
    // ..."` — an ellipsis where a real `DrizzleQueryError` puts
    // `` `\nparams: ${params}` ``. So it proved the filter does not spread the
    // error object, which was true and was never the hazard, and it could not
    // fail on the one that was. The message below is now the shape the class
    // actually produces.
    const { host } = fakeHost();
    const drizzleShaped = Object.assign(
      new Error(
        'Failed query: insert into "transaction" (...) values ($1, $2)\nparams: 987654.32,42',
      ),
      {
        query: 'insert into "transaction" (...) values ($1, $2)',
        params: ["987654.32", "42"],
      },
    );
    filter.catch(drizzleShaped, host);

    const raw = emitted.join("");
    expect(raw).not.toContain("987654.32");
    expect(raw).not.toContain("insert into");
    expect(lines()[0]?.["error"]).toBe(
      "Error: [the failed query and its bound parameters are withheld]",
    );
  });
});
