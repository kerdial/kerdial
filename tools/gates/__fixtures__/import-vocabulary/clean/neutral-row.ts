// Passing fixture for the import-vocabulary gate: a neutral-layer file that
// carries none of the eleven format literals. See the notes at
// https://example.invalid/import-neutral-layer — a URL on its own line must not
// produce a hit, and must not blind the scan to the rest of this file either.

export type NeutralShape = "INSTRUMENT" | "CASH_MOVEMENT" | "DIVIDEND" | "TRADE";

export interface NeutralIdentity {
  readonly isin: string | null;
  readonly symbol: string | null;
}
