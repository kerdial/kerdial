/**
 * Curated MIC dataset (DD10, decision D3). A small, hand-curated set of ISO 10383 Market
 * Identifier Codes for the exchanges this app's users most commonly hold
 * instruments on, with French UI labels for `web`'s combobox (IC-13) —
 * **not** an attempt at a full ISO 10383 registry (explicitly out of scope,
 * NG2). `api` uses {@link PROVIDER_EXCHANGE_CODE_TO_MIC} to compute a
 * `suggestedMic` discovery hint (IC-11); `web` uses
 * {@link CURATED_EXCHANGE_MICS}/{@link micToLabel} to render the dropdown and
 * a chosen value's label.
 *
 * Deliberately **framework-free** (no `zod` import): this module is plain
 * data plus total helper functions, consumed by both `api` and `web`
 * (`web-no-server-runtime-imports` only allows `core/*` into `web/src` — this
 * stays dependency-free so that permission never needs widening).
 */

/** One curated exchange entry. `mic` must pass `@kerdial/api-contracts`'s unmodified `exchangeMicSchema` charset rule (`instrument-create.schema.ts`) — asserted by `core/api-contracts/src/exchange-mic-schema-drift.test.ts`, never assumed. */
export interface CuratedExchange {
  /** ISO 10383 Market Identifier Code, e.g. `"XPAR"`. */
  readonly mic: string;
  /** French UI label, e.g. `"Euronext Paris"`. */
  readonly label: string;
  /** ISO 3166-1 alpha-2 country code, for grouping the combobox by country (IC-13). */
  readonly countryCode: string;
}

/**
 * ~30 hand-curated entries (FR-7, decision D3 — a static dataset,
 * not a DB table or a full registry). Hand-maintained, exactly like
 * `market_calendar`'s seed: a missing
 * entry only ever means a missing pre-selection, never a wrong MIC written
 * silently (FR-8/AC-9 make any pre-selection a suggestion the user confirms
 * by submitting).
 */
export const CURATED_EXCHANGE_MICS: readonly CuratedExchange[] = [
  { mic: "XPAR", label: "Euronext Paris", countryCode: "FR" },
  { mic: "XNYS", label: "Bourse de New York (NYSE)", countryCode: "US" },
  { mic: "XNAS", label: "NASDAQ", countryCode: "US" },
  { mic: "XLON", label: "Bourse de Londres (LSE)", countryCode: "GB" },
  { mic: "XETR", label: "Bourse de Francfort (Xetra)", countryCode: "DE" },
  // Börse Frankfurt proper (not Xetra). The equity provider files
  // every Morningstar-sourced fund NAV line (`0P…`, quoteType MUTUALFUND)
  // under its `FRA` code, so without this entry no OPCVM ever gets a
  // `suggestedMic` and the user is left hand-picking a wrong venue.
  { mic: "XFRA", label: "Bourse de Francfort", countryCode: "DE" },
  { mic: "XAMS", label: "Euronext Amsterdam", countryCode: "NL" },
  { mic: "XBRU", label: "Euronext Bruxelles", countryCode: "BE" },
  { mic: "XLIS", label: "Euronext Lisbonne", countryCode: "PT" },
  { mic: "XMIL", label: "Bourse de Milan (Euronext Milan)", countryCode: "IT" },
  { mic: "XMAD", label: "Bourse de Madrid", countryCode: "ES" },
  { mic: "XSWX", label: "Bourse suisse (SIX)", countryCode: "CH" },
  { mic: "XWBO", label: "Bourse de Vienne", countryCode: "AT" },
  { mic: "XDUB", label: "Euronext Dublin", countryCode: "IE" },
  { mic: "XOSL", label: "Bourse d'Oslo", countryCode: "NO" },
  { mic: "XSTO", label: "Bourse de Stockholm (Nasdaq)", countryCode: "SE" },
  { mic: "XCSE", label: "Bourse de Copenhague (Nasdaq)", countryCode: "DK" },
  { mic: "XHEL", label: "Bourse d'Helsinki (Nasdaq)", countryCode: "FI" },
  { mic: "XWAR", label: "Bourse de Varsovie", countryCode: "PL" },
  { mic: "XPRA", label: "Bourse de Prague", countryCode: "CZ" },
  { mic: "XBUD", label: "Bourse de Budapest", countryCode: "HU" },
  { mic: "XATH", label: "Bourse d'Athènes", countryCode: "GR" },
  { mic: "XIST", label: "Bourse d'Istanbul", countryCode: "TR" },
  { mic: "XTSE", label: "Bourse de Toronto", countryCode: "CA" },
  { mic: "XMEX", label: "Bourse mexicaine", countryCode: "MX" },
  { mic: "BVMF", label: "Bourse de São Paulo (B3)", countryCode: "BR" },
  { mic: "XTKS", label: "Bourse de Tokyo", countryCode: "JP" },
  { mic: "XHKG", label: "Bourse de Hong Kong", countryCode: "HK" },
  { mic: "XSHG", label: "Bourse de Shanghai", countryCode: "CN" },
  { mic: "XKRX", label: "Bourse de Corée", countryCode: "KR" },
  { mic: "XASX", label: "Bourse australienne (ASX)", countryCode: "AU" },
] as const;

/**
 * Maps the equity discovery provider's own exchange-code taxonomy (an
 * arbitrary, provider-specific code, e.g. `"NMS"` — see
 * `ProviderSymbolMatch.providerExchangeCode`'s own doc comment in
 * `@kerdial/market-ports`; **not** ISO 10383, and not guaranteed stable) to
 * one of {@link CURATED_EXCHANGE_MICS}'s MICs. Named generically, never
 * provider-prefixed (the "no provider names outside `market/adapters`"
 * convention, extended to this shared package). A code
 * with no entry here is not an error — it just means no `suggestedMic` hint
 * is offered, and the user picks a MIC themselves.
 */
export const PROVIDER_EXCHANGE_CODE_TO_MIC: Readonly<Record<string, string>> = {
  NMS: "XNAS",
  NGM: "XNAS",
  NYQ: "XNYS",
  PCX: "XNYS",
  PAR: "XPAR",
  LSE: "XLON",
  GER: "XETR",
  // See the XFRA entry above.
  FRA: "XFRA",
  AMS: "XAMS",
  BRU: "XBRU",
  LIS: "XLIS",
  MIL: "XMIL",
  MCE: "XMAD",
  EBS: "XSWX",
  VIE: "XWBO",
  DUB: "XDUB",
  ISE: "XDUB",
  OSL: "XOSL",
  STO: "XSTO",
  CPH: "XCSE",
  HEL: "XHEL",
  WSE: "XWAR",
  PRA: "XPRA",
  BUD: "XBUD",
  ATH: "XATH",
  IST: "XIST",
  TOR: "XTSE",
  MEX: "XMEX",
  SAO: "BVMF",
  JPX: "XTKS",
  HKG: "XHKG",
  SHH: "XSHG",
  KSC: "XKRX",
  ASX: "XASX",
};

/**
 * Backs the create form's user-locked "Autre — saisir le code MIC" escape
 * hatch (FR-9/AC-10, DD11) — **UI-only**, never submitted to
 * the API. Chosen deliberately unlike any real MIC value (an `__`-wrapped,
 * lower/mixed-case-hostile literal cannot collide with the 4-character
 * uppercase-alphanumeric charset `exchangeMicSchema` enforces), and this
 * module's own test suite asserts the non-collision explicitly rather than
 * merely relying on that shape difference.
 */
export const MIC_UNLISTED_SENTINEL = "__AUTRE__";

/**
 * Total function: `undefined` for a code with no curated mapping, never
 * throws. F-6 (security review): `code` is the equity discovery provider's
 * own value, verbatim (`ProviderSymbolMatch.providerExchangeCode`) — plain
 * bracket indexing of a plain object literal resolves an inherited key
 * (`"__proto__"`, `"constructor"`, `"toString"`, ...) to that key's own
 * value on `Object.prototype` rather than `undefined`, silently breaking
 * this function's declared `string | undefined` contract (confirmed by a
 * live probe: `findMicByCode("__proto__")` previously returned
 * `Object.prototype` itself, which serialised over the wire as
 * `"suggestedMic":{}` and then crashed `InstrumentCreateForm.tsx`'s
 * `trimmedUpperOrUndefined`, which assumes a string). `Object.hasOwn` — not
 * merely `in` (which would also see through the prototype chain) — restricts
 * the lookup to the table's own enumerable keys before ever indexing it.
 */
export function findMicByCode(code: string): string | undefined {
  return Object.hasOwn(PROVIDER_EXCHANGE_CODE_TO_MIC, code)
    ? PROVIDER_EXCHANGE_CODE_TO_MIC[code]
    : undefined;
}

/** Total function: `undefined` for a MIC not in the curated set, never throws. */
export function micToLabel(mic: string): string | undefined {
  return CURATED_EXCHANGE_MICS.find((exchange) => exchange.mic === mic)?.label;
}

/**
 * Total function: `undefined` for a MIC not in the curated set (and for the
 * NULL `exchange_mic` a CRYPTO row carries), never throws.
 *
 * Lives here rather than in `country.ts` because it is a fact about MICs, not
 * about countries.
 * It is what makes « Pays de cotation » a **projection** of `exchange_mic`
 * computed once, server-side, at the response boundary — exact by
 * construction and never stale — as opposed to a stored column that could
 * disagree with the MIC beside it. It must never be used to default
 * `instrument.domicile_country`: listing country and issuer domicile are
 * different facts, and the no-auto-default rule is enforced at the database
 * by migration `0036`'s grants, not by this comment.
 */
export function micToCountryCode(mic: string): string | undefined {
  return CURATED_EXCHANGE_MICS.find((exchange) => exchange.mic === mic)?.countryCode;
}
