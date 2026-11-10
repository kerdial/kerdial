import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKER_GRACEFUL_STOP_TIMEOUT_SECONDS } from "@kerdial/market-composition";

/**
 * SH-30 (FR-38–FR-40, AC-32) — a static gate on the
 * committed `deploy/docker-compose.yml`.
 *
 * AC-32's own method is `docker compose config`, which no test in this repo
 * can run (CI has no compose project, and a test that shells out to Docker
 * would be skipped exactly where it matters). What a test *can* do is hold
 * the properties that a future edit would silently break, cross-checked
 * against their sources of truth rather than restated copies:
 * `WORKER_GRACEFUL_STOP_TIMEOUT_SECONDS` is imported from the worker
 * entrypoint — so `stop_grace_period: 40s` is checked against the number the
 * worker actually drains with.
 *
 * This is the regression guard, not the acceptance evidence (that was the
 * observed `docker compose config` output for the committed file).
 */

const composePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "deploy",
  "docker-compose.yml",
);
const compose = readFileSync(composePath, "utf8");

/** Top-level service names, i.e. exactly two-space-indented keys under `services:`. */
function serviceNames(): string[] {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => line === "services:");
  expect(start).toBeGreaterThanOrEqual(0);
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

/**
 * One service's own lines — from its two-space-indented key to the next
 * top-level or two-space-indented key (an assertion about one
 * service must not be satisfiable by another service's settings).
 */
function serviceBlock(name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  expect(start, `service ${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^ {0,2}\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** Every `KEY: value` pair inside an `environment:` block, as written — of one service's block, or of the whole file. */
function environmentPairs(source: string = compose): { key: string; value: string }[] {
  const pairs: { key: string; value: string }[] = [];
  let inEnvironment = false;
  for (const line of source.split("\n")) {
    if (/^ {4}environment:\s*$/.test(line)) {
      inEnvironment = true;
      continue;
    }
    if (inEnvironment && /^ {0,4}\S/.test(line)) inEnvironment = false;
    if (!inEnvironment) continue;
    const match = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      pairs.push({ key: match[1], value: match[2] });
    }
  }
  return pairs;
}

describe("deploy/docker-compose.yml — AC-32/FR-38–FR-40 (SH-30)", () => {
  it("defines exactly the stack this project ships", () => {
    expect(serviceNames().sort()).toEqual(["api", "migrate", "postgres", "worker"]);
  });

  it("names the project kerdial and defaults POSTGRES_DB to kerdial — renaming either strands an install's data", () => {
    // The project name is part of the volume name (`kerdial_pgdata`), so a
    // rename points every existing install at a new, empty volume — the 0.1.x
    // → 0.2.0 move had to ship with a dump/restore procedure for exactly that.
    expect(compose).toMatch(/^name: kerdial$/m);
    const envExample = readFileSync(join(dirname(composePath), ".env.example"), "utf8");
    expect(envExample).toMatch(/^POSTGRES_DB=kerdial$/m);
  });

  it("defines no reverse-proxy and no ACME/certificate service — those are owner-operated (NG11)", () => {
    // Checked explicitly, per AC-32's own wording. Both as a *service name* and
    // as an *image*, because either would be a stack this repo does not ship.
    const forbidden =
      /nginx|caddy|traefik|apache|httpd|haproxy|envoy|certbot|acme|lets-?encrypt|swag|cert-manager/i;
    for (const name of serviceNames()) expect(name).not.toMatch(forbidden);
    for (const line of compose.split("\n")) {
      const image = /^ {4}image:\s*(.*)$/.exec(line);
      if (image?.[1] !== undefined) expect(image[1]).not.toMatch(forbidden);
    }
  });

  it("uses named volumes only — no host bind-mount and no absolute host path anywhere", () => {
    // FR-38/FR-40 and the Synology-portability reason behind them. A mount
    // source that starts with `/`, `.` or `~` is a host path; a named volume is
    // a bare identifier that must also be declared under top-level `volumes:`.
    const declared = new Set<string>();
    let inVolumesBlock = false;
    for (const line of compose.split("\n")) {
      if (line === "volumes:") {
        inVolumesBlock = true;
        continue;
      }
      if (inVolumesBlock && /^\S/.test(line)) inVolumesBlock = false;
      const named = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
      if (inVolumesBlock && named?.[1] !== undefined) declared.add(named[1]);
    }
    expect(declared.size).toBeGreaterThan(0);

    // Scoped to service-level `volumes:` blocks: `ports:` entries sit at the
    // same indentation and are not mounts.
    const mounts: string[] = [];
    let inServiceVolumes = false;
    for (const line of compose.split("\n")) {
      if (/^ {4}volumes:\s*$/.test(line)) {
        inServiceVolumes = true;
        continue;
      }
      if (inServiceVolumes && !/^ {6}- /.test(line)) inServiceVolumes = false;
      const entry = /^ {6}- "([^"]+:[^"]+)"$/.exec(line);
      if (inServiceVolumes && entry?.[1] !== undefined) mounts.push(entry[1]);
    }
    expect(mounts.length).toBeGreaterThan(0);
    for (const mount of mounts) {
      const source = mount.split(":")[0]!;
      expect(source, `${mount} must not be a host path`).not.toMatch(/^[/.~$]/);
      expect(declared, `${mount} must name a declared volume`).toContain(source);
    }
    expect(compose).not.toMatch(/type:\s*bind/);
  });

  it("quotes every environment value (FR-39) — an unquoted YAML boolean is not the string it looks like", () => {
    const pairs = environmentPairs();
    expect(pairs.length).toBeGreaterThan(10);
    for (const { key, value } of pairs) {
      expect(value, `${key} must be a quoted string`).toMatch(/^".*"$/);
    }
  });

  it.each(["api", "worker"])(
    "caps the %s's memory twice, with the cgroup ceiling strictly above the V8 heap",
    (service) => {
      // The pair only works in this order. `mem_limit` at or below
      // `--max-old-space-size` means the cgroup kills the container before V8
      // ever refuses an allocation — which is the OOM-killer failure the two
      // ceilings exist to replace with a clean restart, re-created by the very
      // settings meant to prevent it. Held here because the next person to raise
      // one of these numbers will not be reading the comment beside the other.
      //
      // Read from the service's own block: with a pair on two
      // services, a file-wide search could pair one service's limit with the
      // other's heap.
      const block = serviceBlock(service);
      const memLimit = /^ {4}mem_limit:\s*(\d+)m\s*$/m.exec(block);
      expect(memLimit?.[1], `${service} must declare mem_limit in megabytes`).toBeDefined();

      const nodeOptions = environmentPairs(block).find((pair) => pair.key === "NODE_OPTIONS");
      expect(nodeOptions?.value).toMatch(/^"--max-old-space-size=\d+"$/);
      const heapMb = Number(/max-old-space-size=(\d+)/.exec(nodeOptions!.value)![1]);

      expect(Number(memLimit![1])).toBeGreaterThan(heapMb);
    },
  );

  it("passes WORKER_IN_PROCESS as the literal string the api actually tests for", () => {
    // `resolveWorkerInProcess` compares against `"false"`; a YAML boolean would
    // reach the process as `"true"` and silently make the api a second consumer.
    expect(environmentPairs()).toContainEqual({ key: "WORKER_IN_PROCESS", value: '"false"' });
  });

  it('carries DB_POOL_MAX: "40" on the api (the pool budget)', () => {
    // 20 -> 22 when the valuation-read per-tenant ceiling went 2 -> 4: AR-18's
    // sum reached 21, so the api would refuse to boot against a pool of 20.
    // 22 -> 24 when the two public write routes were capped
    // (`POST /auth/setup`, `POST /auth/login`) at 2 concurrent: AR-18's sum
    // reached 24, and the previous raise had left no headroom at all.
    // 24 -> 40 with ADR-0016: the per-tenant ceilings and their exact
    // sum are gone; the pool is sized with headroom and the admission bound
    // derives from it.
    expect(environmentPairs()).toContainEqual({ key: "DB_POOL_MAX", value: '"40"' });
  });

  it("AR-17: gives the api and the worker the same two budget values, because the assertion is deployment-wide", () => {
    // The worker opens no request pool but counts the api's, so it needs the
    // api's `DB_POOL_MAX` too. If these drift, the two processes disagree about
    // the same deployment — and the api, the one that actually opens that pool,
    // is the one that refuses. Safe direction, but still a misconfiguration, so
    // it is gated here rather than left to whoever next edits this file.
    const pairs = environmentPairs();
    for (const key of ["DB_POOL_MAX", "PGMAX"]) {
      const values = pairs.filter((pair) => pair.key === key).map((pair) => pair.value);
      expect(values, `${key} must appear on both the api and the worker`).toHaveLength(2);
      expect(new Set(values).size, `${key} must be identical on both`).toBe(1);
    }
    // ADR-0016: the multi-replica divisor is gone with C28.
    expect(pairs.map((pair) => pair.key)).not.toContain("REPLICA_COUNT");
  });

  it("passes TRUST_PROXY through to the api, blank meaning unset, and nothing of the retired PROXY_TOPOLOGY control", () => {
    const keys = environmentPairs().map((p) => p.key);
    expect(keys).toContain("TRUST_PROXY");
    expect(keys).not.toContain("PROXY_TOPOLOGY");
    expect(keys).not.toContain("PROXY_ADDRESS");
    expect(compose).toContain('TRUST_PROXY: "${TRUST_PROXY:-}"');
  });

  it("publishes the api on ${API_BIND}, loopback by default, never a literal address", () => {
    const publish = "${API_BIND:-127.0.0.1}:${API_PORT:-3000}:3000";
    expect(compose).toContain(`- "${publish}"`);
    // No hardcoded publish of any kind could survive alongside that.
    const published = [...compose.matchAll(/^ {6}- "([^"]*:[^"]*:\d+)"$/gm)].map((m) => m[1]!);
    expect(published).toEqual([publish]);
  });

  it("never publishes the postgres port, in either topology", () => {
    const postgresBlock = compose.slice(
      compose.indexOf("\n  postgres:"),
      compose.indexOf("\n  migrate:") > compose.indexOf("\n  postgres:")
        ? compose.indexOf("\n  migrate:")
        : compose.length,
    );
    expect(postgresBlock).not.toMatch(/^ {4}ports:/m);
  });

  it("gives the worker a stop_grace_period that strictly exceeds its own drain timeout", () => {
    const match = /^ {4}stop_grace_period: (\d+)s$/m.exec(
      compose.slice(compose.indexOf("\n  worker:"), compose.indexOf("\n  api:")),
    );
    expect(match?.[1]).toBeDefined();
    const gracePeriod = Number(match![1]);
    expect(gracePeriod).toBe(40);
    // The number the worker actually drains with, imported rather than restated:
    // a 25 s drain inside compose's 10 s default is completely inert.
    expect(gracePeriod).toBeGreaterThan(WORKER_GRACEFUL_STOP_TIMEOUT_SECONDS);
  });

  it("runs the migration gate as a one-shot that api and worker wait on (FR-47)", () => {
    expect(compose).toContain('command: ["node", "/app/platform/db/dist/migrate-main.js"]');
    // Every consumer of the gate, and the gate's own no-restart policy. Two
    // since the backup sidecar was retired, which was the third — it waited on
    // the migration that created the role it authenticated as.
    expect([...compose.matchAll(/^ {8}condition: service_completed_successfully$/gm)]).toHaveLength(
      2,
    );
    expect(compose.slice(compose.indexOf("\n  migrate:"), compose.indexOf("\n  worker:"))).toMatch(
      /^ {4}restart: "no"$/m,
    );
  });

  it("ships no backup service, volume or credential", () => {
    // The retirement, asserted rather than assumed: a re-added sidecar, a
    // re-added `backups` volume or a stray `BACKUP_*` value would otherwise
    // come back silently with a copy-pasted block, and `.env.example` would be
    // the only place saying it should not exist.
    expect(serviceNames()).not.toContain("backup");
    expect(compose).not.toContain("backups:");
    expect(environmentPairs().map(({ key }) => key)).not.toContain("APP_BACKUP_PASSWORD");
    expect(compose).not.toMatch(/BACKUP_|RCLONE_CONFIG_/);
    // No service is profile-gated either — the sidecar was the last candidate.
    expect(compose).not.toMatch(/^ {4}profiles:/m);
    // SH-28's reason for never setting `user:` (the sidecar ran as uid 999 and
    // a fresh named volume would arrive root-owned) is gone with it, but the
    // property is still the one this stack wants: ownership comes from images.
    expect(compose).not.toMatch(/^ {4}user:/m);
  });

  it("orders api behind worker's readiness, and gives both init: true and restart: unless-stopped", () => {
    expect(compose.slice(compose.indexOf("\n  api:"))).toMatch(
      /worker:\n\s+condition: service_healthy/,
    );
    for (const service of ["worker", "api"] as const) {
      const block = compose.slice(
        compose.indexOf(`\n  ${service}:`),
        compose.indexOf(`\n  ${service}:`) + 2000,
      );
      expect(block).toMatch(/^ {4}init: true$/m);
      expect(block).toMatch(/^ {4}restart: unless-stopped$/m);
    }
  });
});
