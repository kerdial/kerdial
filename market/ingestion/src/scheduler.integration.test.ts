import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IngestionScheduler } from "./scheduler.js";

/**
 * T-33 acceptance criteria 1 and 3, against a real
 * Postgres 17 container — `pg-boss` stores its own job state in Postgres,
 * so these are genuine end-to-end proofs, not
 * mocked-queue approximations.
 *
 * `pg-boss` connects here using the Testcontainers bootstrap connection
 * (the same one other integration tests in this repo use to run Drizzle
 * migrations, e.g. `ledger/src/*.integration.test.ts`) because creating its
 * own schema/tables ("pg-boss ... stores jobs in Postgres") needs
 * `CREATE` privilege on the database — none of this project's three
 * application roles (`app_owner`/`app_web`/`app_ingest`,
 * `platform/db/migrations/0007_roles-grants-rls.sql`) carry that today, and
 * granting it (or pre-creating pg-boss's schema via a migration) is a
 * T-2/T-3 deployment decision, deferred pending user approval — this suite
 * proves the scheduling mechanism, not production provisioning.
 * `fetch-log.integration.test.ts` is where this package's own writes
 * (`provider_fetch_log`) are proved against the `app_ingest`-scoped
 * connection instead.
 */
describe("IngestionScheduler — T-33 acceptance criteria 1 and 3 (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let boss: PgBoss;
  let scheduler: IngestionScheduler;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    boss = new PgBoss(pg.ownerUri);
    boss.on("error", () => {
      // Swallow background maintenance-loop errors here — this suite drives
      // job state manually via fetch/fail/complete, never boss.work(), so
      // there is no in-test handler for pg-boss's own error event otherwise.
    });
    scheduler = new IngestionScheduler({
      boss,
      retryLimit: 5,
      retryDelaySeconds: 0,
      retryBackoff: false,
    });
    await scheduler.start();
  }, 120_000);

  afterAll(async () => {
    await scheduler.stop();
    await pg.stop();
  }, 30_000);

  describe("AC1 — singleton job keys (FR-21)", () => {
    it("enqueuing the same quote:refresh:{instrument_id}:{bucket} key twice within the same bucket window results in exactly one job, not two", async () => {
      const instrumentId = "11111111-1111-7111-8111-111111111111";
      const bucket = "2024-01-01T00:00:00.000Z";

      const firstId = await scheduler.enqueueQuoteRefresh({ instrumentId, bucket });
      const secondId = await scheduler.enqueueQuoteRefresh({ instrumentId, bucket });

      expect(firstId).not.toBeNull();
      // The duplicate is suppressed outright — not silently merged, not
      // separately queued — exactly pg-boss's `exclusive` queue policy's
      // `ON CONFLICT DO NOTHING` on (name, singleton_key) for any
      // non-terminal job.
      expect(secondId).toBeNull();

      const jobs = await scheduler.boss.fetch(scheduler.queueName, { batchSize: 10 });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.id).toBe(firstId);

      await scheduler.boss.complete(scheduler.queueName, jobs[0]!.id);

      // Once the original job has actually finished (terminal state), the
      // same literal key is free again — this is "no duplicate execution",
      // not "this key can never be sent again".
      const thirdId = await scheduler.enqueueQuoteRefresh({ instrumentId, bucket });
      expect(thirdId).not.toBeNull();
      const thirdJobs = await scheduler.boss.fetch(scheduler.queueName, { batchSize: 10 });
      expect(thirdJobs).toHaveLength(1);
      await scheduler.boss.complete(scheduler.queueName, thirdJobs[0]!.id);
    });

    it("a different instrument, or a different bucket for the same instrument, is not deduped against an unrelated key", async () => {
      const instrumentId = "33333333-3333-7333-8333-333333333333";
      const bucketA = "2024-03-01T00:00:00.000Z";
      const bucketB = "2024-03-01T00:05:00.000Z";

      const idA = await scheduler.enqueueQuoteRefresh({ instrumentId, bucket: bucketA });
      const idB = await scheduler.enqueueQuoteRefresh({ instrumentId, bucket: bucketB });

      expect(idA).not.toBeNull();
      expect(idB).not.toBeNull();
      expect(idA).not.toBe(idB);

      const jobs = await scheduler.boss.fetch(scheduler.queueName, { batchSize: 10 });
      expect(jobs.map((j) => j.id).sort()).toEqual([idA, idB].sort());
      for (const job of jobs) {
        await scheduler.boss.complete(scheduler.queueName, job.id);
      }
    });
  });

  describe("AC3 — dead-letter queue after 5 failed retry attempts", () => {
    it("a job that fails every attempt lands in the dead-letter queue, visible via pg-boss's own job state", async () => {
      const instrumentId = "22222222-2222-7222-8222-222222222222";
      const bucket = "2024-02-02T00:00:00.000Z";

      const jobId = await scheduler.enqueueQuoteRefresh({ instrumentId, bucket });
      expect(jobId).not.toBeNull();

      let attempts = 0;
      for (let i = 0; i < 20; i++) {
        const jobs = await scheduler.boss.fetch(scheduler.queueName, { batchSize: 1 });
        if (jobs.length === 0) break;
        attempts += 1;
        await scheduler.boss.fail(scheduler.queueName, jobs[0]!.id, { error: "simulated failure" });
      }

      // retryLimit: 5 => 1 initial attempt + 5 retries = 6 executions total
      // before the 6th failure is terminal and dead-letters the job — this
      // number is a direct, empirical proof against pg-boss's own retry
      // semantics (`retry_count < retry_limit` keeps retrying), not an
      // assumption.
      expect(attempts).toBe(6);

      // Drained from the main queue...
      const remaining = await scheduler.boss.fetch(scheduler.queueName, { batchSize: 10 });
      expect(remaining).toHaveLength(0);

      // ...and now present in the dead-letter queue, traceable back to the
      // original job id — this is pg-boss's own job state, queried directly,
      // not an inference.
      const deadLettered = await scheduler.boss.fetch(scheduler.deadLetterQueueName, {
        batchSize: 10,
        includeMetadata: true,
      });
      expect(deadLettered).toHaveLength(1);
      expect(deadLettered[0]!.sourceId).toBe(jobId);
      expect(deadLettered[0]!.sourceName).toBe(scheduler.queueName);
    });
  });
});
