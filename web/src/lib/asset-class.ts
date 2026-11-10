import { CASH_COPY } from "./copy/cash.js";

/**
 * The locked asset-class mapping.
 *
 * "Asset-class colours are locked and never re-assigned per screen: the same
 * class is the same colour in every chart, chip and legend." That rule needs
 * exactly one table for it to be true, which is this one. A screen that picks a
 * colour for a class directly is how three different greens end up meaning
 * "fund" on three different screens.
 *
 * ## The shipped set is not the original six
 *
 * The original palette named six classes — stock, etf, fund, bond, crypto, cash. This
 * product's instrument kinds are `SHARE`, `ETF`, `FUND`, `SCPI`, `CRYPTO`,
 * `INDEX` (`INSTRUMENT_KIND_VALUES` in `@kerdial/api-contracts`; this list is
 * a hand-kept mirror because its order is the display order, not the enum's).
 *
 * - **bond** is dropped: a distinct tracked bond class is an explicit
 *   spec non-goal. Its token stays in `kerdial.css`,
 *   because the token file is transcribed whole, but nothing references it.
 * - **cash is restored as a display class** (portfolio-cash PC-L10, which
 *   reverses an earlier kerdial-skin decision and cash-accounts
 *   OD-7(c) on the owner's confirmation). It is {@link CASH_CLASS}, « Liquidités »
 *   in `--class-cash` (lemon-500). It is **not an instrument kind**: no API
 *   type carries it, and {@link ASSET_CLASS_ORDER} / {@link isAssetClass} stay
 *   instrument-only because the instrument search iterates them
 *   (`AssetSearchPopover.tsx`). The display surfaces that show cash (the
 *   allocation roll-up, the pie, the type bars, the Positions row) order by
 *   {@link DISPLAY_CLASS_ORDER}, where it sits last.
 * - **INDEX** was not in that palette. It takes `--chart-6` (ink-400), the
 *   palette's own neutral. That is defensible rather than merely convenient: an
 *   index is a reference series, not a held position, so a neutral is the
 *   honest signal.
 * - **SCPI** was not in it either
 *   (SC-L8: its own class). It takes
 *   `--class-scpi` (lemon-700), distinct from every class in use and from
 *   `--class-cash` (lemon-500). It sits after FUND, so the relative
 *   order of the five earlier classes — and every legend without an SCPI — is
 *   unchanged.
 */

/** The enumerated display order. No sector or region wording, because no such field exists on the wire. */
export const ASSET_CLASS_ORDER = ["SHARE", "ETF", "FUND", "SCPI", "CRYPTO", "INDEX"] as const;

export type AssetClass = (typeof ASSET_CLASS_ORDER)[number];

/** portfolio-cash: the « Liquidités » display class — web display layer only, never an instrument kind. */
export const CASH_CLASS = "CASH";

/** Every class a display surface can show, in display order — the instrument classes, then « Liquidités » last. */
export const DISPLAY_CLASS_ORDER = [...ASSET_CLASS_ORDER, CASH_CLASS] as const;

type DisplayClass = (typeof DISPLAY_CLASS_ORDER)[number];

/**
 * Class to CSS custom property. Returned as a `var(...)` reference rather than
 * a literal so the value stays in `kerdial.css` — and so the token lint rule
 * has nothing to object to at the call sites.
 */
const CLASS_COLOR: Record<DisplayClass, string> = {
  SHARE: "var(--class-stock)",
  ETF: "var(--class-etf)",
  FUND: "var(--class-fund)",
  SCPI: "var(--class-scpi)",
  CRYPTO: "var(--class-crypto)",
  INDEX: "var(--chart-6)",
  CASH: "var(--class-cash)",
};

/** French labels, sentence case. */
const CLASS_LABEL: Record<DisplayClass, string> = {
  SHARE: "Action",
  ETF: "ETF",
  FUND: "Fonds",
  SCPI: "SCPI",
  CRYPTO: "Crypto",
  INDEX: "Indice",
  CASH: CASH_COPY.label,
};

export function isAssetClass(kind: string): kind is AssetClass {
  return (ASSET_CLASS_ORDER as readonly string[]).includes(kind);
}

function isDisplayClass(kind: string): kind is DisplayClass {
  return (DISPLAY_CLASS_ORDER as readonly string[]).includes(kind);
}

/**
 * An unknown kind gets the neutral rather than a thrown error or a default that
 * collides with a real class: the wire could carry a kind added server-side
 * before the client knows about it, and a legend rendering it as "fund purple"
 * would be actively misleading where grey is merely uninformative.
 */
export function assetClassColor(kind: string): string {
  return isDisplayClass(kind) ? CLASS_COLOR[kind] : "var(--chart-6)";
}

export function assetClassLabel(kind: string): string {
  return isDisplayClass(kind) ? CLASS_LABEL[kind] : kind;
}

/** Sort key for a legend or a stacked bar, so every surface orders classes identically. */
export function assetClassRank(kind: string): number {
  const index = (DISPLAY_CLASS_ORDER as readonly string[]).indexOf(kind);
  return index === -1 ? DISPLAY_CLASS_ORDER.length : index;
}
