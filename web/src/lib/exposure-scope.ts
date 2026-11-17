import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import type { ValuedAmount } from "../components/Figure.js";
import type { AllocationHolding, AllocationInput } from "./allocation.js";

/**
 * What the exposure card's sector and country bars are a breakdown **of**:
 * shares, ETFs and funds only. A sector or a country says nothing of cash or
 * of a crypto-asset, and the other kinds are left out with them, so the two
 * bars read "where are my securities", each adding up to 100 % of those —
 * not to 100 % of the portfolio, which is the type bar's and the ring's job.
 *
 * That makes it a second apportionment, over a second total: the holdings of
 * those kinds, against their own sum. The sum is taken here because no such
 * subtotal is on the wire; it is only ever the denominator of the shares and
 * is never displayed.
 */
const SECURITIES_KINDS: readonly string[] = ["SHARE", "ETF", "FUND"];

const ZERO = new Decimal(0);

function tryParse(raw: string): Decimal | undefined {
  try {
    return parseDecimalString(raw);
  } catch {
    return undefined;
  }
}

/**
 * The allocation input of the securities alone. A holding valued in another
 * currency than the total, or with no readable value, is left out — the same
 * row the whole-portfolio allocation already declines to place. With no
 * security at all the total is zero and `computeAllocation` reports it
 * unavailable, which suppresses both breakdowns.
 */
export function securitiesAllocationInputOf(response: {
  readonly holdings: readonly AllocationHolding[];
  readonly totalValue: ValuedAmount;
}): AllocationInput {
  const currency = response.totalValue.currency;
  const holdings: AllocationHolding[] = [];
  let total = ZERO;
  for (const holding of response.holdings) {
    if (!SECURITIES_KINDS.includes(holding.kind)) continue;
    if (holding.currentValue.currency !== currency) continue;
    const value = tryParse(holding.currentValue.amount);
    if (value === undefined) continue;
    holdings.push({
      instrumentId: holding.instrumentId,
      kind: holding.kind,
      currentValue: holding.currentValue,
    });
    total = total.plus(value);
  }
  return {
    holdings,
    totalValue: { amount: total.toString(), currency, provenance: { derivedFrom: [] } },
  };
}
