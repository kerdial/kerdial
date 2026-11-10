import { describe, expect, it } from "vitest";
import { APP_ROLES, APP_ROLE_ENV_VAR, parseAppRole, runRole } from "./app-role.js";

/**
 * SH-21 (FR-2, AC-2's code-level half) — `APP_ROLE` parsing and dispatch.
 *
 * AC-2's *behavioural* half — a connection refusal against a running
 * `APP_ROLE=worker` container — needs the image and belongs to Batch H/GATE-5.
 * What is provable here, and is the property that makes that outcome possible at
 * all: the `worker` role never runs the HTTP entrypoint, and an unrecognised role
 * runs neither.
 */
describe("parseAppRole (FR-2)", () => {
  it("unset or blank is the api role — every pre-T-3a invocation of this entrypoint", () => {
    expect(parseAppRole(undefined)).toBe("api");
    expect(parseAppRole("")).toBe("api");
    expect(parseAppRole("   ")).toBe("api");
  });

  it("accepts exactly the two documented roles, case- and whitespace-tolerantly", () => {
    expect(parseAppRole("api")).toBe("api");
    expect(parseAppRole("worker")).toBe("worker");
    expect(parseAppRole(" WORKER ")).toBe("worker");
    expect(parseAppRole("Api")).toBe("api");
    expect(APP_ROLES).toStrictEqual(["api", "worker"]);
  });

  it("fails closed on anything else rather than defaulting to api", () => {
    for (const bogus of ["api-server", "web", "workers", "worker api", "WORKER_ROLE", "none"]) {
      expect(() => parseAppRole(bogus)).toThrowError(
        new RegExp(`${APP_ROLE_ENV_VAR}: unrecognised role`),
      );
    }
  });

  it("names the offending value and the accepted set in the message an operator will read", () => {
    let message = "";
    try {
      parseAppRole("api-server");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('"api-server"');
    expect(message).toContain("api, worker");
    // The *reason* it refuses to guess, not just that it refused.
    expect(message).toContain("unowned");
  });
});

describe("runRole (FR-2, AC-2's code-level half)", () => {
  function spies(): {
    calls: string[];
    entrypoints: { runApi: () => Promise<void>; runWorker: () => Promise<void> };
  } {
    const calls: string[] = [];
    return {
      calls,
      entrypoints: {
        runApi: async () => {
          calls.push("api");
        },
        runWorker: async () => {
          calls.push("worker");
        },
      },
    };
  }

  it("the worker role runs the worker entrypoint and NEVER the HTTP one", async () => {
    const { calls, entrypoints } = spies();
    await runRole("worker", entrypoints);
    expect(calls).toStrictEqual(["worker"]);
    expect(calls).not.toContain("api");
  });

  it("the api role runs the HTTP entrypoint and never the worker", async () => {
    const { calls, entrypoints } = spies();
    await runRole("api", entrypoints);
    expect(calls).toStrictEqual(["api"]);
  });

  it("propagates the chosen entrypoint's failure instead of falling through to the other one", async () => {
    const calls: string[] = [];
    await expect(
      runRole("worker", {
        runApi: async () => {
          calls.push("api");
        },
        runWorker: async () => {
          throw new Error("worker-main: INGESTION_DATABASE_URL is required");
        },
      }),
    ).rejects.toThrow("INGESTION_DATABASE_URL is required");
    // A worker that cannot start must stay dead, not silently become an API.
    expect(calls).toStrictEqual([]);
  });
});
