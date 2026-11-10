import { defineConfig } from "drizzle-kit";

/**
 * `drizzle-kit` migration tooling (T-5's "migration
 * tooling wired up"). `drizzle-kit generate` diffs `./src/schema` against the
 * migration journal in `./migrations` and writes new SQL files there — this
 * is the mechanism the no-floats schema gate (`tools/no-floats-schema-gate`,
 * T-1) scans. `dbCredentials` is only consulted by `push`/`migrate`/`studio`,
 * not `generate`; phase-1 usage of this config is `generate` in development
 * and `migrate` in CI/deploy (T-3), reading `DATABASE_URL` from the
 * environment at that time.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/placeholder",
  },
});
