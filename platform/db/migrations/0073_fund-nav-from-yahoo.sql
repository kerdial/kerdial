-- ADR-0018 — FUND NAV comes from Yahoo's Morningstar-sourced lines
-- (`0P0001DKPM.F`, quoteType MUTUALFUND); FUND joins `BACKFILLABLE_KINDS`
-- and defaults to `quote_policy = AUTO` like every other kind.
--
-- Data only: no schema object changes, so — like `0051` and `0071` — this
-- file has a journal entry and no snapshot, and `drizzle-kit generate` keeps
-- reporting "No schema changes detected".
--
-- ## 1. Pre-ADR-0018 FUND rows stop saying MANUAL_ONLY
--
-- `MANUAL_ONLY` was the FUND kind default on the premise that no automated
-- NAV source existed (R4).
-- It is display-only on the wire (« Saisie manuelle » / « Automatique »,
-- the instrument detail's manual-pricing note) and gates nothing in the
-- pipeline, which keys on `kind`. Flipped so the label matches what the
-- worker now does; manual NAV points already entered stay and keep winning
-- on ties (`core/domain` `valuation.ts`, FR-23).
--
-- ## 2. Every existing FUND gets a PENDING backfill request
--
-- A FUND created before this change was never enqueued (AC-14), so it has no
-- `instrument_backfill_state` row at all — and the hourly reconcile sweep
-- only scans rows that exist. Insert one per FUND exactly as
-- `ensureInstrumentBackfillRequested` would: `requested_from` is the
-- earlier of "20 years back" and "30 days before the instrument's first
-- transaction", floored at 25 years (`market/ingestion`'s
-- `computeBackfillRequestedFrom`). The sweep then enqueues each row, the
-- handler resolves the `0P…` line on Yahoo and walks the window. Where the
-- migrator role cannot read `transaction` (FORCE RLS), the subquery sees no
-- rows and the window is the plain 20 years — the same answer an instrument
-- with no transactions gets.
UPDATE "instrument"
   SET "quote_policy" = 'AUTO'
 WHERE "kind" = 'FUND'
   AND "quote_policy" = 'MANUAL_ONLY';
--> statement-breakpoint
INSERT INTO "instrument_backfill_state" ("instrument_id", "requested_from", "status")
SELECT i."id",
       GREATEST(
         LEAST(
           (CURRENT_DATE - INTERVAL '20 years')::date,
           COALESCE(
             (SELECT MIN(t."trade_date") FROM "transaction" t WHERE t."instrument_id" = i."id") - 30,
             CURRENT_DATE
           )
         ),
         (CURRENT_DATE - INTERVAL '25 years')::date
       ),
       'PENDING'
  FROM "instrument" i
 WHERE i."kind" = 'FUND'
ON CONFLICT ("instrument_id") DO NOTHING;
