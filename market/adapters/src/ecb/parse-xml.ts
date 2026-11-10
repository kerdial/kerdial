import { ProviderMalformedResponse } from "@kerdial/market-ports";
import type { CurrencyCode, IsoDate } from "@kerdial/market-ports";
import { ECB_PROVIDER_KEY } from "./currencies.js";

/**
 * The single day parsed from `eurofxref-daily.xml`:
 * "the always-on XML feed is a 90-day rolling window ... suitable for
 * incremental daily updates going forward." `rates` holds the raw ECB-base
 * decimal-numeral strings, unconverted — {@link
 * import("./provider.js").EcbFxRateProvider} is responsible for the
 * direction inversion.
 */
export interface EcbDailySnapshot {
  readonly date: IsoDate;
  readonly rates: ReadonlyMap<CurrencyCode, string>;
}

const DATED_CUBE_PATTERN = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>/;
const RATE_CUBE_PATTERN =
  /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"](\d+(?:\.\d+)?)['"]\s*\/>/g;

/**
 * Parses ECB's `eurofxref-daily.xml` shape — confirmed against a live fetch
 * of the file during development (not by test
 * code, which never touches the network):
 *
 * ```xml
 * <gesmes:Envelope ...>
 *   <Cube>
 *     <Cube time='2024-01-10'>
 *       <Cube currency='USD' rate='1.0850'/>
 *       ...
 *     </Cube>
 *   </Cube>
 * </gesmes:Envelope>
 * ```
 *
 * A regex parser (rather than a full XML/DOM dependency) is deliberate: the
 * shape is small, fixed, and attribute-only, and adding an XML parsing
 * library would be a new dependency requiring `license-gate` clearance for
 * no real benefit here. Anything that does not match — no dated `<Cube
 * time=...>` element, or zero `<Cube currency=... rate=.../>` entries — is a
 * {@link ProviderMalformedResponse}.
 */
export function parseDailyXml(xml: string): EcbDailySnapshot {
  const dateMatch = DATED_CUBE_PATTERN.exec(xml);
  const date = dateMatch?.[1];
  if (date === undefined) {
    throw new ProviderMalformedResponse(
      ECB_PROVIDER_KEY,
      'eurofxref-daily.xml: no dated <Cube time="..."> element found',
    );
  }

  const rates = new Map<CurrencyCode, string>();
  for (const match of xml.matchAll(RATE_CUBE_PATTERN)) {
    const currency = match[1];
    const rate = match[2];
    if (currency !== undefined && rate !== undefined) rates.set(currency, rate);
  }
  if (rates.size === 0) {
    throw new ProviderMalformedResponse(
      ECB_PROVIDER_KEY,
      'eurofxref-daily.xml: no <Cube currency="..." rate="..."/> entries found',
    );
  }

  return { date, rates };
}
