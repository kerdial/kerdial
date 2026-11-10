import type { CurrencyRecord } from "@kerdial/ledger";

/**
 * `GET /currencies`, decision D5.
 */
export interface CurrencyResponse {
  readonly code: string;
  readonly name: string;
  readonly minorUnit: number;
}

export function toCurrencyResponse(record: CurrencyRecord): CurrencyResponse {
  return { code: record.code, name: record.name, minorUnit: record.minorUnit };
}
