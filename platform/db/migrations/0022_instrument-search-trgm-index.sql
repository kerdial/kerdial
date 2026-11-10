-- F5 (T-37) — `GET /instruments?query=`'s
-- `ILIKE '%...%'` search (`ledger/src/instrument-service.ts`'s
-- `listInstruments`) is a leading-wildcard pattern, which a plain b-tree
-- index on `display_name`/`symbol`/`isin` cannot use at all — every such
-- query is a sequential scan. `pg_trgm`'s GIN trigram indexes are the
-- standard Postgres answer to substring search and *do* support a
-- leading-wildcard `LIKE`/`ILIKE`. Confirmed available in the
-- `postgres:17-alpine` base image Testcontainers uses in this repo's test
-- suite (verified directly: `CREATE EXTENSION IF NOT EXISTS pg_trgm`
-- succeeds with no extra packages) before adding this migration — per the
-- original instruction to skip the index (keeping only the
-- escaping + statement_timeout fixes) if it turned out unavailable or
-- otherwise complicated the tree. It did not, so it is added here.
--
-- One index per searched column, not a single combined-expression index:
-- `listInstruments` runs three independent `ILIKE` predicates OR'd together
-- (`display_name`, `symbol`, `isin`), and a separate index per column is
-- both the simpler mapping and lets the planner use whichever column's
-- index is most selective for a given query, rather than forcing every
-- search through one wide concatenated expression.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- `display_name`/`symbol` are `text`, which `gin_trgm_ops` accepts directly.
-- `isin` is `char(12)` (bpchar) — `gin_trgm_ops` has no bpchar overload, so
-- this is an expression index on the `text` cast.
CREATE INDEX "instrument_display_name_trgm_idx" ON "instrument" USING gin ("display_name" gin_trgm_ops);
CREATE INDEX "instrument_symbol_trgm_idx" ON "instrument" USING gin ("symbol" gin_trgm_ops);
CREATE INDEX "instrument_isin_trgm_idx" ON "instrument" USING gin ((isin::text) gin_trgm_ops);
