/**
 * `classifyFlows` — the single flow-classification function (T-21). This is the one place in the system that answers
 * "what kind of flow is this?", and every downstream metric consumes its
 * answer through `transaction_posting.flow_class` rather than re-deriving it:
 *
 * - `EXTERNAL` — deposits, withdrawals, and the two legs of a security
 *   transfer (`TRANSFER_OUT`/`TRANSFER_IN`: value leaving one
 *   portfolio or entering another, at its market value). These four kinds are
 *   the **only** flows that open a new TWR sub-period (FR-25/AC18) and the
 *   **only** ones XIRR treats as external cash flows
 *   (FR-26). TWR and MWR are computed by two
 *   deliberately disjoint code paths, so if either re-derived
 *   "external" for itself they could disagree about, say, whether a dividend
 *   is a contribution — the classic bug FR-33's side-by-side display would
 *   then put on screen. This function existing, and being the only source of
 *   the answer, is the mechanism that prevents it.
 * - `INTERNAL` — buys, sells, DRIPs, currency exchanges and cashless share
 *   distributions: value moving between cash and positions *inside* the
 *   portfolio, or units arriving against no money at all. Invisible to TWR
 *   sub-period boundaries, invisible to XIRR.
 * - `INCOME` — dividends, and interest earned on cash (`INTEREST`): cash the
 *   portfolio earned, never a contribution. Increases cash, but is not an
 *   external contribution.
 * - `FEE`, `TAX` — the fee leg (FR-60), the withholding-tax leg (FR-9), and
 *   the principal leg of a standalone portfolio fee (`FEE` kind,
 *   portfolio-cash): value leakage, never a contribution. These are the genuine value leakage the postings' sum-to-zero
 *   invariant is stated "up to".
 *
 * Pure and DB-free (D13): this file imports nothing at
 * all, and `core/domain` may import nothing but `core/decimal` (enforced by the `core-domain-purity` dependency-cruiser rule). The
 * `TransactionKind`/`FlowClass` unions below therefore restate the
 * `transaction_kind`/`flow_class` Postgres enums rather than importing
 * `platform/db`'s schema — the same deliberate duplication `./types.ts`
 * documents for `IsoDate`/`CurrencyCode`. The two are kept in agreement
 * structurally, not by discipline: `ledger`'s posting expander passes this
 * function's result straight into the `transaction_posting` insert, so a
 * divergence between the union and the enum stops `pnpm typecheck`.
 */

/** The `transaction_kind` enum. */
export type TransactionKind =
  | "BUY"
  | "SELL"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "DIVIDEND"
  | "DRIP"
  | "CURRENCY_EXCHANGE"
  | "SHARE_DISTRIBUTION"
  | "TRANSFER_OUT"
  | "TRANSFER_IN"
  | "INTEREST"
  | "FEE";

/** The `flow_class` enum. */
export type FlowClass = "EXTERNAL" | "INTERNAL" | "INCOME" | "FEE" | "TAX";

/**
 * Which leg of the transaction a posting represents. A transaction expands
 * into several postings and they do not all share one class: a BUY's
 * position and cash legs are `INTERNAL` while its fee leg is `FEE`, and a
 * DIVIDEND's cash leg is `INCOME` while its withholding leg is `TAX`.
 *
 * `SETTLEMENT_ASSET` is FR-66/AC52's asset-settled leg — the 0.1 BTC of "buy
 * 2 ETH paying 0.1 BTC". On a BUY it is a **disposal** of that asset
 * (producing a realized gain against its PMP), on a SELL an
 * acquisition. Either way it is `INTERNAL`: the asset moves between two
 * positions inside the portfolio and nothing enters or leaves it, so it must
 * never open a TWR sub-period or appear in XIRR's flow list. That is exactly
 * why this leg is a distinct case here rather than an assumption made
 * separately by each caller.
 */
export type TransactionLeg = "PRINCIPAL" | "SETTLEMENT_ASSET" | "FEE" | "WITHHOLDING_TAX";

/**
 * The minimal shape `classifyFlows` reads. A `transaction` row (plus the leg
 * being classified) is structurally assignable to it — the classification
 * depends on nothing else, and deliberately not on any amount: a zero-value
 * deposit is still external, and a large fee is still a fee.
 */
export interface ClassifiableTransaction {
  readonly kind: TransactionKind;
  /** Defaults to `PRINCIPAL` — the transaction's own money/position legs. */
  readonly leg?: TransactionLeg;
}

/**
 * Returns the `flow_class` for one leg of one
 * transaction. Total over every `(kind, leg)` pair: there is no `undefined`
 * or "unknown" result a caller would have to invent a default for, and the
 * `never` fallthrough below makes a thirteenth `kind` a compile error here
 * rather than a silently mis-classified flow.
 */
export function classifyFlows(transaction: ClassifiableTransaction): FlowClass {
  const leg = transaction.leg ?? "PRINCIPAL";
  // The fee and withholding legs are classified by what they *are*,
  // independently of the kind that carries them: a fee on a BUY and a fee on
  // a currency exchange are both FEE.
  if (leg === "FEE") return "FEE";
  if (leg === "WITHHOLDING_TAX") return "TAX";

  switch (transaction.kind) {
    case "DEPOSIT":
    case "WITHDRAWAL":
      return "EXTERNAL";
    case "TRANSFER_OUT":
    case "TRANSFER_IN":
      // FR-560, L1: from one portfolio's point of view a
      // security transfer is value leaving (the source leg) or entering (the
      // target leg) at its market value — withdrawal- and deposit-shaped. Not
      // `INTERNAL`: nothing moved between cash and positions *inside* the
      // portfolio. A linked pair nets to zero on the combined view because
      // both legs carry the same market value at the same rate.
      return "EXTERNAL";
    case "DIVIDEND":
    case "INTEREST":
      // `cash-interest` (FR-624, CI-L1): interest earned on cash is income the
      // portfolio earned, exactly as a dividend is — never a contribution.
      // Classifying it `EXTERNAL` (as booking it as a DEPOSIT did) would open
      // a TWR sub-period and count it as invested capital.
      return "INCOME";
    case "BUY":
    case "SELL":
    case "DRIP":
    case "CURRENCY_EXCHANGE":
    case "SHARE_DISTRIBUTION":
      // Including `leg === "SETTLEMENT_ASSET"`: a crypto-settled trade's
      // paid-with leg is an internal disposal, never an external outflow.
      //
      // **A cashless share distribution belongs here**, and the
      // two alternatives are both wrong in a way that shows up in a published
      // figure. It is not `EXTERNAL`: that is the only class opening a TWR
      // sub-period and the only one XIRR reads as a contribution, and no money
      // entered or left the portfolio — counting free shares as a contribution
      // would understate the return by their market value. It is not `INCOME`
      // either: that class means "increases cash", and this event increases
      // none. What happened is that an existing holding's cost basis spread
      // over more units — movement inside the portfolio, the same answer a
      // split would give.
      return "INTERNAL";
    case "FEE":
      // `portfolio-cash` (FR-671, PC-L5): a standalone
      // portfolio fee (custody, account keeping, debit interest) is value the
      // portfolio lost, not money the owner took out. Classifying it
      // `EXTERNAL` (as booking it as a WITHDRAWAL did) would open a TWR
      // sub-period and hide the cost from the return.
      return "FEE";
    default: {
      const unreachable: never = transaction.kind;
      throw new TypeError(`Unclassifiable transaction kind: ${String(unreachable)}`);
    }
  }
}
