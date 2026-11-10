import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { extractPostgresError } from "@kerdial/platform-db";
import { loggableErrorDetail, rootLogger } from "@kerdial/platform-logging";
import type { ProblemDetails } from "./problem.js";

/**
 * F2 (security review, T-37): defense in depth *behind* the
 * Zod-level fixes (per-field validation should catch these first) — a
 * shared, generic mapping from a handful of Postgres SQLSTATEs that mean
 * "the input was malformed/out of range", not "something is broken", to a
 * 400 rather than a raw 500. Deliberately small and generic: this is a
 * last-resort net, not a replacement for a per-field Zod error.
 *
 * - `22P02` invalid_text_representation (e.g. a malformed UUID/enum literal
 *   reaching a raw query).
 * - `22008` datetime_field_overflow (e.g. a shaped-but-nonexistent calendar
 *   date reaching a `date` column).
 * - `23503` foreign_key_violation — see {@link CLIENT_CAUSED_FK_CONSTRAINTS}
 *   below (N3, security review): only a specific allowlist of
 *   constraints maps to 400 here, not every `23503`.
 * - `22003` numeric_value_out_of_range (a decimal exceeding a column's
 *   declared precision/scale).
 */
const MALFORMED_INPUT_SQLSTATES: ReadonlySet<string> = new Set(["22P02", "22008", "22003"]);

/**
 * N3 (security review, T-37): F2's original `23503`
 * (foreign_key_violation) -> 400 mapping was too broad — a `tenant_id` or
 * `instrument_id` FK violation can only happen because of a server-side bug
 * (a stale/forged tenant context, or a caller passing an internally-sourced
 * id that no longer exists), not because of anything the client's *request
 * body* supplied. Mapping those to 400 would hide a real defect behind a
 * generic client-error response and never get logged as the incident it is.
 * Only a currency code is ever taken verbatim from a client-controlled
 * request field and used as an FK target (`POST /instruments`'s
 * `listingCurrency`, `POST /instruments/:id/prices`'s `currency`) — every
 * other FK on these tables (`tenant_id`, `instrument_id`, ...) is populated
 * from server-side context, never from request body content. Constraint
 * names taken from `platform/db/migrations/0001_auth-and-reference-schema.sql`
 * (`instrument_listing_currency_currency_code_fk`) and `0005_market-reference-
 * schema.sql` (`manual_price_point_currency_currency_code_fk`) — NEW-6
 * (security review, T-37): the first constraint was
 * mis-attributed to 0005 alone, though it actually lives in 0001.
 */
const CLIENT_CAUSED_FK_CONSTRAINTS: ReadonlySet<string> = new Set([
  "instrument_listing_currency_currency_code_fk",
  "manual_price_point_currency_currency_code_fk",
]);

/**
 * Global exception filter: every error response is
 * RFC 9457 `application/problem+json`, not a bare Nest default error body.
 * Applied once, app-wide (`app.ts`'s `APP_FILTER`), so every controller
 * built here or in T-37/T-38/T-39 gets this for free.
 *
 * `AuthGuard`/`CsrfGuard`/`AuthController` all throw via `problemException`
 * (already problem-shaped `HttpException`s); any other thrown `HttpException`
 * (e.g. Nest's own validation errors) is normalised into the same shape so
 * every error response — not only auth's — has a uniform `content-type` and
 * body. An unexpected non-`HttpException` error is checked against
 * {@link MALFORMED_INPUT_SQLSTATES}/{@link CLIENT_CAUSED_FK_CONSTRAINTS} (F2,
 * N3) before finally becoming a generic 500 with no internal detail leaked
 * to the client.
 *
 * N3 (security review): every 500 and every PG-error-mapped 400 is
 * logged server-side. **Not** NestJS's own `Logger` class, and that finding's
 * reasoning still stands verbatim: `app.ts` builds this app with
 * `{ logger: false }`, and `NestFactory`'s `registerLoggerConfiguration`
 * responds by calling `Logger.overrideLogger(false)`, which sets `Logger`'s
 * *static* instance reference to `undefined` for the whole process — not
 * merely a bootstrap-only setting. Verified directly at the time (a throwaway
 * script instantiating a Fastify-adapter Nest app the same way `app.ts` does,
 * then calling `new Logger(...).error(...)`, produced no output at all under
 * `{ logger: false }`, while a plain `console.error` next to it did). Using
 * `Logger` here would look correct while being a silent no-op in the one
 * configuration this app actually runs under.
 *
 * **SH-38 (FR-32, the `console.*` disposition table)** replaces the
 * `console.error`/`console.warn` those findings settled on with the structured
 * logger, **request-scoped via `AsyncLocalStorage`** — this filter is named in
 * the table as one of the two sites that migrate, and it is the one that most
 * needed to: an unhandled 500 with no `request_id`/`tenant_id` is the hardest
 * line in the system to correlate with the request that caused it, and it is
 * also (with the ingestion job bodies) one of the two riskiest sites for a
 * monetary value to escape into logs — AC-29's own representative set. The
 * exception is passed as an **allow-listed** `error` string, never spread, so
 * whatever a `DrizzleQueryError` happens to carry on it cannot ride along.
 */
/**
 * Resolved per call, not held as a field: this filter is instantiated by Nest
 * as `APP_FILTER` with `useClass`, so a constructor parameter would have to be
 * a resolvable DI token — and the *context* that matters (`request_id`,
 * `tenant_id`) comes from `AsyncLocalStorage` per request, not from the
 * instance.
 */
function log(): ReturnType<typeof rootLogger> {
  return rootLogger();
}

@Catch()
export class ProblemJsonExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const { status, body } = this.toProblem(exception);
    void reply.status(status).header("content-type", "application/problem+json").send(body);
  }

  private toProblem(exception: unknown): { status: number; body: ProblemDetails } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (this.isProblemShaped(response)) {
        return { status, body: { ...response, status } };
      }
      const title = typeof response === "string" ? response : exception.message;
      return { status, body: { type: "about:blank", title, status } };
    }

    // **`.detail` is not surfaced here, and must not be.** A
    // `CHECK` violation's `PostgresError.detail` is
    // `"Failing row contains (…)"`: every column of the rejected row, which on
    // this schema means the monetary values FR-33 forbids in output. Adding it
    // to a problem+json body reads as an obvious improvement to error
    // messages — that is exactly why the note is here rather than only in the
    // issue. `extractPostgresError` projects to `sqlstate` + `constraintName`
    // and nothing else; keep it that way.
    const pgError = extractPostgresError(exception);
    if (pgError) {
      const isClientCausedFk =
        pgError.sqlstate === "23503" &&
        pgError.constraintName !== undefined &&
        CLIENT_CAUSED_FK_CONSTRAINTS.has(pgError.constraintName);
      if (MALFORMED_INPUT_SQLSTATES.has(pgError.sqlstate) || isClientCausedFk) {
        // N3: logged with the SQLSTATE and constraint name (never in the
        // response body — that property is unchanged) so an operator can
        // still see which constraint a client keeps tripping, without the
        // client itself learning the schema's internal shape.
        log().warn("malformed request data mapped to 400", {
          sqlstate: pgError.sqlstate,
          constraint: pgError.constraintName ?? "<none>",
        });
        return {
          status: HttpStatus.BAD_REQUEST,
          body: {
            type: "about:blank",
            title: "Malformed request data",
            status: HttpStatus.BAD_REQUEST,
            code: "MALFORMED_INPUT",
          },
        };
      }
    }

    // N3: every other unexpected error — including a `23503` against any FK
    // *not* in {@link CLIENT_CAUSED_FK_CONSTRAINTS} — is a server bug, not
    // client garbage: logged with the full error and stack, and returned as
    // a generic 500 with no internal detail leaked to the client.
    log().error("unhandled error mapped to 500", {
      // The message and the stack, named — never the exception object spread.
      //
      // This comment used to end here, correctly naming the hazard
      // — a `DrizzleQueryError` carries the failed query's bound `parameters`,
      // which for any write path is exactly the monetary values FR-33 forbids
      // in output — and then log `exception.message`, which for that class *is*
      // the query and its parameters. The warning was accurate and the line
      // below it did the thing the warning describes.
      //
      // {@link loggableErrorDetail} withholds that one class's message and
      // keeps its class name, so this line still tells what happened. Every
      // other error's message is logged exactly as before: the fix is a
      // subtraction of one class, not a retreat from logging errors.
      error: loggableErrorDetail(exception),
    });
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        type: "about:blank",
        title: "Internal Server Error",
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      },
    };
  }

  private isProblemShaped(value: unknown): value is ProblemDetails {
    return (
      typeof value === "object" &&
      value !== null &&
      "title" in value &&
      typeof (value as { title: unknown }).title === "string"
    );
  }
}
