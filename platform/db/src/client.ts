import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

/**
 * F5 (T-37): a runaway query (the
 * unindexed, leading-wildcard `ILIKE` search this same finding covers, or
 * anything else) previously had no statement-level ceiling — it would run
 * until Postgres finished it, however long that took. 15s is generous for
 * every query this codebase issues (the heaviest are the RLS-scoped list
 * endpoints and the ingestion batch jobs, none of which are expected to
 * approach that) while still bounding worst-case query duration.
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
/** `postgres.js`'s own default (`10` in Node) — declared explicitly here so it's env-overridable, not merely implicit. */
const DEFAULT_POOL_MAX = 10;

export interface CreatePostgresClientOptions {
  /** Overrides `DB_STATEMENT_TIMEOUT_MS`/{@link DEFAULT_STATEMENT_TIMEOUT_MS} (F5). */
  readonly statementTimeoutMs?: number;
  /** Overrides `DB_POOL_MAX`/{@link DEFAULT_POOL_MAX} (F5). */
  readonly max?: number;
  /** Overrides `DB_SSLMODE`/{@link resolveSslMode} (T-3b). */
  readonly sslMode?: SslMode;
}

/**
 * The `sslmode` values this factory accepts. A deliberate subset of libpq's:
 * `allow`/`prefer` are omitted because both silently fall back to cleartext,
 * which is the exact failure this control exists to prevent — a connection that
 * *looks* configured for TLS and is not.
 */
export type SslMode = "disable" | "require" | "verify-full";

/**
 * N7 (T-37): `Number("")` and
 * `Number("   ")` both evaluate to `0`, not `NaN` — the previous
 * `Number.isFinite(parsed)` check therefore treated an env var that was *set
 * but empty* (`DB_STATEMENT_TIMEOUT_MS=`, a plausible shell/CI
 * misconfiguration — an unset variable in a `.env` file, a template
 * substitution that resolved to nothing) as a perfectly valid `0`, silently
 * disabling the statement timeout entirely (F5's own protection) or the
 * connection pool (`max: 0`, no connections at all). Every one of these
 * inputs must be rejected the same way an unparseable string like `"abc"`
 * already was: fall back to the safe default, and — unlike the genuinely
 * unset case, which is normal and silent — `console.warn` so a
 * misconfiguration this consequential is visible in the deploy's own logs
 * rather than manifesting only as "queries never time out" days later.
 *
 * `Number.isInteger` (not merely `isFinite`) also now rejects a fractional
 * value; `> 0` rejects `0` and every negative value (`"-5"` used to become
 * `NaN` under the old code's plain `Number()` — wait, `Number("-5")` is a
 * valid finite number, `-5`, so the *old* code accepted it too, handing
 * `postgres.js` a negative `statement_timeout`/`max`; this closes that gap
 * as well, not only the empty-string one).
 */
export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (trimmed !== "" && Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  // SH-38 (FR-32; the `console.*` disposition table) — **this site
  // stays `console.warn`, deliberately and by name.**
  //
  // It fires during module initialisation: `createPostgresClient` is called
  // while the composition root is still being built, before any logger exists,
  // and `@kerdial/platform-logging` cannot be imported here without creating
  // a bootstrap cycle (`platform/db` is a dependency of everything, including
  // anything that would configure the logger). A warning about a database
  // misconfiguration that could not be emitted because the logger was not up
  // yet is worse than an unstructured one that is.
  //
  // The consequence is accepted and small: these two lines carry no
  // `request_id`/`tenant_id`, which is correct — there is no request and no
  // tenant at module-init time. They also carry no secret: `name` is one of two
  // literal env-var *names* and `raw` is the value of a numeric setting, never
  // `DATABASE_URL`.
  console.warn(
    `[platform-db] ${name}=${JSON.stringify(raw)} is not a positive integer — falling back to the default (${fallback}).`,
  );
  return fallback;
}

function resolveStatementTimeoutMs(options: CreatePostgresClientOptions | undefined): number {
  if (options?.statementTimeoutMs !== undefined) return options.statementTimeoutMs;
  return parsePositiveIntEnv("DB_STATEMENT_TIMEOUT_MS", DEFAULT_STATEMENT_TIMEOUT_MS);
}

function resolvePoolMax(options: CreatePostgresClientOptions | undefined): number {
  if (options?.max !== undefined) return options.max;
  return parsePositiveIntEnv("DB_POOL_MAX", DEFAULT_POOL_MAX);
}

/**
 * The request pool's effective ceiling, resolved exactly as
 * {@link createPostgresClient} resolves it — same env var, same validation,
 * same fallback.
 *
 * Exported for `AR-18`: `api`'s per-tenant concurrency budget
 * asserts that the sum of its throttle ceilings fits inside the pool those
 * throttles are protecting, and that assertion is only worth anything if it
 * reads the *same* number the pool is actually built with. The alternative —
 * mirroring `DEFAULT_POOL_MAX` by value and guarding it with a drift test —
 * is the convention `market/composition`'s `connection-budget.ts` already
 * uses, and it works, but a drift test proves two constants are equal, not
 * that either matches what `postgres.js` was handed at runtime. A caller
 * that passes `options.max` explicitly (Testcontainers suites do) diverges
 * from the mirror with no test failing anywhere.
 *
 * Takes the same `options` so a caller that overrides `max` can ask what its
 * own pool's ceiling will be, rather than what the ambient env says.
 *
 * `fallback` exists because {@link DEFAULT_POOL_MAX} is `postgres.js`'s
 * generic default, which suits this module's many small consumers (migrations
 * and most test pools run at `max: 1`) but is *not* the `api` process's
 * documented request-pool ceiling — that is 20
 * (`deploy/docker-compose.yml`). A process whose admission control is derived
 * from its pool size must state the size it means rather than inherit a
 * library default that happens to differ, or the two disagree everywhere the
 * env var is not set — which is exactly what `scripts/dev-up.sh` does.
 */
export function resolveRequestPoolMax(
  options?: CreatePostgresClientOptions & { readonly fallback?: number },
): number {
  if (options?.max !== undefined) return options.max;
  return parsePositiveIntEnv("DB_POOL_MAX", options?.fallback ?? DEFAULT_POOL_MAX);
}

/**
 * `postgres.js`'s own default pool ceiling, re-exported so a consumer can
 * name it in a message or a test without re-typing `10`. Prefer
 * {@link resolveRequestPoolMax} for anything that needs the *effective*
 * value — this is the fallback, not the answer.
 */
export const REQUEST_POOL_MAX_DEFAULT = DEFAULT_POOL_MAX;

/**
 * T-3b (ADR-0014): `sslmode` enforcement lands in code now, not as a phase-2
 * retrofit — see NFR-7 (`sslmode=verify-full` on the
 * database connection).
 *
 * Phase 1's topology makes TLS to Postgres genuinely moot: the api and the
 * database share an on-host container network and the database publishes no
 * port. Requiring TLS there would be theatre. But "moot today" is precisely how
 * a control becomes a retrofit later, so the rule is written in terms of the
 * *host*, not the phase:
 *
 * - loopback (`localhost`, `127.0.0.0/8`, `::1`) or a single-label hostname (a
 *   Docker network alias such as `postgres`) — the phase-1 case — connects
 *   without TLS, explicitly rather than by omission;
 * - **any other host** must state `DB_SSLMODE` explicitly, or the process
 *   refuses to start.
 *
 * The day the database moves off-host — a managed instance, another machine,
 * phase 2 — this throws instead of silently connecting in cleartext, and no one
 * has to remember that it was deferred.
 *
 * Note `allow`/`prefer` are not accepted ({@link SslMode}): both downgrade to
 * cleartext without saying so.
 */
function isLocalDatabaseHost(connectionString: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    // An unparseable connection string cannot be classified, so it cannot be
    // waved through: fall through to the explicit-decision branch below.
    return false;
  }

  // `new URL` keeps IPv6 literals bracketed.
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return true;

  // A single-label name with no dots is a container/network alias (compose's
  // `postgres`), never a routable internet host.
  return host !== "" && !host.includes(".") && !host.includes(":");
}

function resolveSslMode(
  connectionString: string,
  options: CreatePostgresClientOptions | undefined,
): SslMode {
  const explicit = options?.sslMode ?? process.env["DB_SSLMODE"]?.trim();

  if (explicit !== undefined && explicit !== "") {
    if (explicit !== "disable" && explicit !== "require" && explicit !== "verify-full") {
      throw new Error(
        `[platform-db] DB_SSLMODE=${JSON.stringify(explicit)} is not a supported sslmode. ` +
          `Use "disable", "require" or "verify-full" ("allow"/"prefer" are rejected because they ` +
          `silently fall back to cleartext).`,
      );
    }
    if (explicit === "disable" && !isLocalDatabaseHost(connectionString)) {
      throw new Error(
        `[platform-db] DB_SSLMODE=disable is refused for a non-local database host. ` +
          `Connections that leave the host must be encrypted (NFR-7): use "require", or ` +
          `"verify-full" to also validate the server certificate.`,
      );
    }
    return explicit;
  }

  if (isLocalDatabaseHost(connectionString)) return "disable";

  throw new Error(
    `[platform-db] the database host is not loopback or a container-network alias, and DB_SSLMODE ` +
      `is not set. Refusing to connect in cleartext (NFR-7, ADR-0014 T-3b). Set ` +
      `DB_SSLMODE=verify-full (preferred) or DB_SSLMODE=require.`,
  );
}

/**
 * `postgres.js` connection factory: "`postgres.js` is
 * additionally configured with no numeric parser override, so even a raw-SQL
 * path yields strings rather than JS numbers." `postgres.js` already returns
 * `numeric` as a string by default; the requirement here is purely negative
 * (never add a `types: { numeric: { ... parseFloat ... } }` override to this
 * factory), which is exactly why this function accepts no such option.
 *
 * This is the shared low-level connection T-9's tenant-scoped
 * `db.withTenant` factory builds on; T-5's job is only that it exists and is
 * configured correctly, not the tenant-scoping behaviour itself.
 *
 * F5 additionally sets an explicit connection pool size and a per-statement
 * timeout, both env-overridable (`DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`)
 * with safe defaults matching `postgres.js`'s own prior implicit behaviour
 * (`max: 10`) plus a new 15s statement ceiling — deliberately not a
 * behaviour change for every existing caller (this repo's Testcontainers
 * suites included), only a named, tunable one where previously it was
 * neither.
 */
export function createPostgresClient(
  connectionString: string,
  options?: CreatePostgresClientOptions,
): postgres.Sql {
  const sslMode = resolveSslMode(connectionString, options);
  return postgres(connectionString, {
    max: resolvePoolMax(options),
    // `postgres.js` takes `false` for "no TLS" and the libpq mode string
    // otherwise; `disable` is passed as `false` rather than omitted so the
    // decision is visible in this object rather than implied by its absence.
    ssl: sslMode === "disable" ? false : sslMode,
    connection: {
      statement_timeout: resolveStatementTimeoutMs(options),
    },
  });
}

export type Db = PostgresJsDatabase<typeof schema>;

/** Binds a `postgres.js` client to the full Drizzle schema. */
export function createDb(sql: postgres.Sql): Db {
  return drizzle(sql, { schema });
}
