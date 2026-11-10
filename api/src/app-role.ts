/**
 * SH-21 (`self-hosted-deploy` FR-2, AC-2) — the
 * `APP_ROLE` role selector.
 *
 * One image, two processes: `api` serves the SPA **and** `/api/v1/*`; `worker`
 * runs every `boss.work()` registration and **binds no HTTP port and serves no
 * static asset** (a deliberate tradeoff — `APP_ROLE` is the only
 * difference between the two containers).
 *
 * **Two layers, on purpose, and they must agree.** The image carries a tiny
 * `docker-entrypoint.sh` in the image that `exec`s the right Node entrypoint per
 * role so signals reach Node directly (that script is Batch H's). This module is
 * the same decision expressed *in the application*, so that (a) FR-2 is a
 * property of the code and is provable now, before any image exists, and (b) a
 * `worker` container that somehow reaches `main.ts` — a hand-run `node
 * dist/main.js`, a compose `command:` override, a future entrypoint edit — still
 * refuses to become an HTTP server rather than quietly starting a second one
 * against the same database.
 *
 * **Fail closed on an unrecognised value.** A typo'd `APP_ROLE=api-server` must
 * not fall back to a default: silently starting the API in a container the
 * operator meant as a worker leaves every queue unowned while the deployment
 * looks healthy, which is precisely the failure mode SH-16's readiness marker
 * exists to prevent. Unset/blank *is* `api`, because that is the role every
 * pre-T-3a invocation of this entrypoint (and every existing dev script) already
 * means.
 */

export const APP_ROLES = ["api", "worker"] as const;

export type AppRole = (typeof APP_ROLES)[number];

/** The env var the entrypoint script and this module both read. */
export const APP_ROLE_ENV_VAR = "APP_ROLE";

/**
 * Parses `APP_ROLE`. Unset or blank ⇒ `"api"`; `api`/`worker` ⇒ themselves;
 * anything else throws.
 *
 * Case and surrounding whitespace are tolerated (`APP_ROLE=" worker "` from a
 * hand-edited compose file is unambiguous), but no other spelling is — no
 * `api-server`, no `web`, no `WORKER_ROLE`.
 */
export function parseAppRole(raw: string | undefined): AppRole {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "") return "api";
  const match = APP_ROLES.find((role) => role === value);
  if (match === undefined) {
    throw new Error(
      `${APP_ROLE_ENV_VAR}: unrecognised role ${JSON.stringify(raw)} — expected one of ` +
        `${APP_ROLES.join(", ")} (or unset for "api"). Refusing to guess: starting the API in a ` +
        `container meant to be the worker leaves every ingestion queue unowned while the ` +
        `deployment reports itself healthy.`,
    );
  }
  return match;
}

export interface RoleEntrypoints {
  /** Builds the Nest/Fastify app, registers the static tier, and listens. */
  readonly runApi: () => Promise<void>;
  /** `market/composition`'s `workerMain` — registrations, then the readiness marker. Never listens. */
  readonly runWorker: () => Promise<void>;
}

/**
 * Runs exactly one of the two entrypoints. Split out of `main.ts` so a test can
 * prove the dispatch itself — that `worker` never reaches the HTTP half, which is
 * AC-2's code-level half. AC-2's behavioural half (a *connection refusal*
 * against a running `APP_ROLE=worker` container) needs the image and belongs to
 * Batch H/GATE-5.
 */
export async function runRole(role: AppRole, entrypoints: RoleEntrypoints): Promise<void> {
  if (role === "worker") {
    await entrypoints.runWorker();
    return;
  }
  await entrypoints.runApi();
}
