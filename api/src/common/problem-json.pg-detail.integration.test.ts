import { Writable } from "node:stream";
import type { ArgumentsHost } from "@nestjs/common";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { createLogger, setRootLoggerForTest } from "@kerdial/platform-logging";
import type { FastifyReply } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ProblemJsonExceptionFilter } from "./problem-json.filter.js";

/**
 * **A `CHECK` violation carries the offending row's values in
 * `PostgresError.detail`, and nothing may put them in output.**
 *
 * This was filed as a *latent* risk rather than a shipped defect, and it stays
 * latent only because two independent things hold: `extractPostgresError`
 * projects a `PostgresError` down to `sqlstate` + `constraintName` and never
 * reads `.detail`, and `platform/logging` drops any field its allow-list does
 * not name. Both are easy to undo by accident — surfacing `.detail` in a
 * problem+json body reads as a straightforward improvement to error messages,
 * and the `DrizzleQueryError` log leak is the proof that this class of mistake ships: that filter's comment
 * named its hazard and the line beneath it did the thing the comment described.
 *
 * So this suite exists to make the guarantee **falsifiable**, against a real
 * error from a real constraint rather than a hand-built fixture — which is the
 * other half of that leak's lesson, where the guarding test's fixture had been
 * written so it could not fail.
 */
describe("PostgresError.detail never reaches output", () => {
  let pg: MigratedPostgres;
  /** The canary: a distinctive monetary value, present in the row and therefore in `detail`. */
  const OFFENDING_AMOUNT = "-987654.321987654321";
  let pgError: postgres.PostgresError;

  const TENANT = "00000000-0000-7000-8000-000000000071";
  const PORTFOLIO = "00000000-0000-7000-8000-000000000072";
  const ACCOUNT = "00000000-0000-7000-8000-000000000073";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    const sql = pg.ownerClient;
    await sql`INSERT INTO "tenant" (id) VALUES (${TENANT}::uuid)`;
    await sql`INSERT INTO "portfolio" (id, tenant_id, name) VALUES (${PORTFOLIO}::uuid, ${TENANT}::uuid, 'issue-71')`;
    await sql`
      INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency)
      VALUES (${ACCOUNT}::uuid, ${TENANT}::uuid, ${PORTFOLIO}::uuid, 'issue-71 EUR', 'EUR')
    `;

    // A real violating INSERT, as the real role would issue it. No fixture: the
    // whole point is that `detail` is written by Postgres, not by this test.
    try {
      await sql`
        INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                                   gross_amount, txn_currency, cash_currency, cash_amount,
                                   fx_rate, fx_rate_source, cash_account_id)
        VALUES ('00000000-0000-7000-8000-000000000074'::uuid, ${TENANT}::uuid, ${PORTFOLIO}::uuid,
                'DEPOSIT', '2026-05-01', 1,
                ${OFFENDING_AMOUNT}, 'EUR', 'EUR', ${OFFENDING_AMOUNT},
                '1', 'IMPLIED_BASE', ${ACCOUNT}::uuid)
      `;
      throw new Error("the INSERT was expected to violate a CHECK and did not");
    } catch (error) {
      if (!(error instanceof postgres.PostgresError)) throw error;
      pgError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it("the hazard is real: Postgres puts the offending monetary value in `detail`", () => {
    // If this ever stops holding, the three tests below are measuring nothing —
    // they would pass against any error at all. Asserted first, deliberately.
    expect(pgError.detail).toBeDefined();
    expect(pgError.detail).toContain(OFFENDING_AMOUNT);
    expect(pgError.code).toBe("23514");
  });

  describe("the response body", () => {
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

    /**
     * **Which branch this lands in matters, and it is not the obvious one.**
     * `23514` is not in `MALFORMED_INPUT_SQLSTATES` (`22P02`/`22008`/`22003`),
     * so a `CHECK` violation is not mapped to a 400 — it falls through to the
     * generic 500. The mutation-confirm for this assertion therefore has to be
     * applied to the **500** body, not to the `MALFORMED_INPUT` one: surfacing
     * `.detail` there reddens this test, while surfacing it in the 400 branch
     * changes nothing, because this error never reaches it.
     *
     * Recorded because the first mutation-confirm attempt targeted the 400
     * branch, saw the test still pass, and would have been read as "the
     * assertion holds" when it meant "the mutation was unreachable".
     */
    it("carries no part of the offending value", () => {
      const { host, reply } = fakeHost();
      new ProblemJsonExceptionFilter().catch(pgError, host);

      const body = JSON.stringify(
        (reply.send as unknown as { mock: { calls: unknown[][] } }).mock.calls,
      );
      expect(body).not.toContain(OFFENDING_AMOUNT);
      // Also the bare digits, so a reformatting of the number cannot slip past
      // an exact-string match.
      expect(body).not.toContain("987654");
    });
  });

  describe("the log line", () => {
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

    it("the filter's own 500 line carries no part of it", () => {
      const reply = {
        status: vi.fn().mockReturnThis(),
        header: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      } as unknown as FastifyReply;
      const host = {
        switchToHttp: () => ({ getResponse: () => reply }),
      } as unknown as ArgumentsHost;
      new ProblemJsonExceptionFilter().catch(pgError, host);

      expect(emitted.join("")).not.toContain(OFFENDING_AMOUNT);
      expect(emitted.join("")).not.toContain("987654");
    });

    /**
     * **The "whole error object" case is not tested here, because it cannot be
     * written.** The issue names it as the most plausible accident — handing
     * the logger a caught `PostgresError` wholesale rather than reading
     * `.detail` deliberately — and the protection against it is the type, not
     * a runtime check:
     *
     * ```
     * error: pgError
     * //     ^ TS2322: Type 'PostgresError' is not assignable to type
     * //       'string | number | boolean | null | undefined'
     * ```
     *
     * `LogFields` admits primitives only, so pino never sees an object it could
     * serialise `.detail` out of. A runtime coercion in `allowListed` was
     * written and then deliberately removed: it defended a path the compiler
     * already closes, and an unreachable guard is a guard nobody maintains and
     * a future reader has to reason about.
     *
     * What holds the guarantee, in order: `extractPostgresError` projects a
     * `PostgresError` to `sqlstate` + `constraintName` and reads nothing else;
     * `LogFields` forbids a non-primitive value; the allow-list drops any field
     * name nobody listed. The two assertions above cover the first at runtime.
     * If a future change types a log field as `unknown`, this comment is the
     * reason to re-open the question.
     */
  });
});
