-- Per-movement cash rounding — the stored half of `expandPostings`'
-- `roundCashMovements`.
--
-- drizzle-kit generated as an empty custom migration (`--custom`, so the file
-- and journal tag already carry the descriptive name); `meta/0080_snapshot.json`
-- is the generator's and equals `0079`'s schema (no DDL here).
--
-- **What.** A cash account's balance is the sum of its movements, each settled
-- to the currency's minor unit, as the broker settles it. From this release
-- the expander rounds the **net** of one transaction on one cash account
-- (`ROUND_HALF_UP`, `currency.minor_unit`) and puts the difference on that
-- group's first CASH leg in `seq` order — the principal leg whenever the row
-- has one. Postings written before it carry the unrounded net, typically a
-- USD trade settled in the EUR base account (`cash_amount = gross × fx_rate`
-- at twelve decimals), so a balance summed from them drifts from the bank's.
--
-- (1) applies the same rule to every stored CASH posting group, so the stored
-- ledger equals what a re-expansion of the unchanged `transaction` row now
-- produces. Postgres `round(numeric, int)` rounds half away from zero, which is
-- decimal.js `ROUND_HALF_UP`. Only `amount_native` moves; `amount_base`,
-- `fx_rate_applied` and every POSITION leg are untouched, and no
-- `transaction` row is modified (the source data stays as imported/entered).
-- A group that is already exact is not written.
--
-- (2) brings `cash_balance` back to `sum(amount_native)` per
-- `(portfolio, cash_account, currency)` — what `recomputeAndInvalidate`
-- writes — for the rows (1) changed. Keys and `calc_epoch` are unchanged.
--
-- (3) `portfolio_daily_valuation` holds `V(d)` including cash (`0078`): a lazy
-- cache the materialiser rebuilds on the next read, emptied as `0078` did.
--
-- Runs as the migration superuser, which bypasses FORCE RLS (as `0046`'s
-- backfill `UPDATE` does). `TRUNCATE` is not subject to RLS. No DDL, no
-- `GRANT`, no `OWNER TO`, RLS unchanged; `'CASH'` is a `posting_leg` value
-- that exists since `0003`, and no `transaction_kind` literal is named.

-- (1) Re-round each (transaction, cash account, currency) net on its first leg.
WITH grp AS (
  SELECT p.transaction_id,
         p.cash_account_id,
         p.currency,
         min(p.seq) AS first_seq,
         sum(p.amount_native) AS net,
         round(sum(p.amount_native), c.minor_unit) AS rounded
    FROM "transaction_posting" p
    JOIN "currency" c ON c.code = p.currency
   WHERE p.leg = 'CASH'
   GROUP BY p.transaction_id, p.cash_account_id, p.currency, c.minor_unit
)
UPDATE "transaction_posting" p
   SET amount_native = p.amount_native + (grp.rounded - grp.net)
  FROM grp
 WHERE p.transaction_id = grp.transaction_id
   AND p.cash_account_id = grp.cash_account_id
   AND p.currency = grp.currency
   AND p.seq = grp.first_seq
   AND grp.rounded <> grp.net;
--> statement-breakpoint

-- (2) Re-sum the materialised balances from the re-rounded postings.
UPDATE "cash_balance" b
   SET amount = s.amount
  FROM (
    SELECT tenant_id, portfolio_id, cash_account_id, currency, sum(amount_native) AS amount
      FROM "transaction_posting"
     WHERE leg = 'CASH'
     GROUP BY tenant_id, portfolio_id, cash_account_id, currency
  ) s
 WHERE b.tenant_id = s.tenant_id
   AND b.portfolio_id = s.portfolio_id
   AND b.cash_account_id = s.cash_account_id
   AND b.currency = s.currency
   AND b.amount <> s.amount;
--> statement-breakpoint

-- (3) Force re-materialisation of the cached daily values (`0078`).
TRUNCATE "portfolio_daily_valuation";
