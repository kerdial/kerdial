import { asc, eq } from "drizzle-orm";
import { currency, type Db } from "@kerdial/platform-db";

/**
 * `GET /currencies` (decision D5, DD12). `app_web` already holds `SELECT`
 * on `currency` (migration `0007`) — no new grant needed.
 */
export interface CurrencyRecord {
  readonly code: string;
  readonly name: string;
  readonly minorUnit: number;
}

/**
 * Every active ISO 4217 currency, ordered by `code` — deliberately
 * **unpaginated** (a fixed ~180-row reference set that
 * populates one dropdown; paging it would force the client to loop before it
 * can render).
 */
export async function listCurrencies(db: Db): Promise<CurrencyRecord[]> {
  return db
    .select({ code: currency.code, name: currency.name, minorUnit: currency.minorUnit })
    .from(currency)
    .where(eq(currency.isActive, true))
    .orderBy(asc(currency.code));
}
