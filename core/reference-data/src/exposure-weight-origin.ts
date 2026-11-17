/**
 * Where a stored exposure weight came from (NFR-100). Both values exist from
 * day one and **no** CHECK narrows the stored value to `MANUAL`: a later
 * provider cycle writes `PROVIDER` rows with no DDL change. Nothing writes
 * `PROVIDER` this cycle, and the one reader filters `MANUAL`.
 *
 * Spread into the `exposure_weight_origin` `pgEnum`, so member **order** is
 * load-bearing: the schema suite compares `pg_enum`'s labels to this tuple in
 * order.
 */
export const EXPOSURE_WEIGHT_ORIGINS = ["MANUAL", "PROVIDER"] as const;
