import { Controller, Get, Inject } from "@nestjs/common";
import { listCurrencies } from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import { DB } from "../db/db.tokens.js";
import { toCurrencyResponse, type CurrencyResponse } from "./currencies.schema.js";

/**
 * `/currencies`,
 * decision D5. No business logic here: the query itself lives in
 * `ledger`'s `listCurrencies`.
 */
@Controller("currencies")
export class CurrenciesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `GET /currencies` — the full seeded ISO 4217 active-currency list,
   * ordered by code, deliberately **unpaginated** (a fixed
   * ~180-row reference set). Bounded by the instance-wide admission bound
   * (formerly MEDIUM-2's shared per-tenant cheap-read cap).
   */
  @Get()
  async list(): Promise<{ items: CurrencyResponse[] }> {
    const rows = await listCurrencies(this.db);
    return { items: rows.map(toCurrencyResponse) };
  }
}
