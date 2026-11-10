import { Icon } from "./Icon.js";

/**
 * A signed figure with its meaning in the colour.
 *
 * The colour rule is narrow about this and it is worth restating: gain-green and
 * loss-red are the **only** money-meaning colours, and zero is neutral grey —
 * not green. Apricot never appears here, which is why there is no tone prop.
 *
 * `text` is pre-formatted and arrives from `figure-format.ts`, so the true
 * minus is already in it and this component neither formats nor signs.
 * `sign` is passed separately because the caller knows it from the underlying
 * decimal, and re-deriving it by string-sniffing the formatted text would be
 * both fragile and redundant.
 */
export type DeltaSign = "gain" | "loss" | "flat";

export interface DeltaValueProps {
  /** Pre-formatted, already carrying its own sign — "+1,84 %", "−320,10 EUR". */
  readonly text: string;
  readonly sign: DeltaSign;
  /** Trailing context — "aujourd'hui", "depuis l'origine". */
  readonly suffix?: string;
  readonly showIcon?: boolean;
  /** Wrap in a tinted pill — for table cells and card corners. */
  readonly chip?: boolean;
  readonly size?: "sm" | "md" | "lg";
}

const ICON = { gain: "trending-up", loss: "trending-down", flat: "arrow-right" } as const;

export function DeltaValue({
  text,
  sign,
  suffix,
  showIcon = false,
  chip = false,
  size = "md",
}: DeltaValueProps) {
  const className = ["k-delta", `k-delta-${sign}`, `k-delta-${size}`, chip ? "k-delta-chip" : ""]
    .filter((c) => c.length > 0)
    .join(" ");

  return (
    <span className={className} data-sign={sign}>
      {showIcon ? <Icon name={ICON[sign]} size="xs" /> : null}
      <span className="k-num">{text}</span>
      {suffix !== undefined ? <span className="k-delta-suffix">{suffix}</span> : null}
    </span>
  );
}

/**
 * Derives the sign from a decimal string, so call sites do not each
 * re-implement the zero case.
 *
 * Prefer passing the raw decimal amount. Formatted display text is tolerated
 * because passing it is the obvious mistake and the consequence is a
 * money-meaning one: the first version of this function tested the whole
 * string against a zero pattern, so `deltaSign("0.00%")` fell through to
 * `"gain"` and painted a flat position green. A percent sign, spaces (including
 * the narrow no-break space French formatting uses as a thousands separator)
 * and a currency suffix are therefore stripped before the zero test rather than
 * being allowed to defeat it.
 *
 * Anything still unrecognisable after that is `"flat"` — neutral grey — because
 * the one thing this must never do is invent a direction it cannot read.
 */
export function deltaSign(amount: string | undefined): DeltaSign {
  if (amount === undefined) return "flat";

  const trimmed = amount.trim();
  // Both sign forms: a caller may pass a raw decimal (ASCII hyphen) or text
  // already through `figure-format.ts`, which substitutes U+2212.
  if (trimmed.startsWith("-") || trimmed.startsWith("−")) return "loss";

  const bare = trimmed
    .replace(/^\+/, "")
    .replace(/[%\s\u00a0\u202f]/g, "")
    .replace(/[A-Za-z€$£]+$/, "")
    .replace(/,/g, ".");

  if (bare === "") return "flat";
  if (/^0*(\.0*)?$/.test(bare)) return "flat";
  if (!/^[0-9]*\.?[0-9]*$/.test(bare)) return "flat";
  return "gain";
}
