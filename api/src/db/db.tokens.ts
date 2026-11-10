/**
 * DI token for the `@kerdial/platform-db` `Db` handle. `Db` (from
 * `drizzle-orm`) is a type, not a class, so it cannot be used as an
 * injection token by itself — every provider/consumer that needs the
 * database goes through this token via `@Inject(DB)`.
 */
export const DB = Symbol("DB");
