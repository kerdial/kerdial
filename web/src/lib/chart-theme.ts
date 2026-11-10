import { assetClassColor } from "./asset-class.js";
import { transactionKindColor } from "./transaction-kind.js";

/**
 * Token access for canvas-rendered charts.
 *
 * ECharts draws to a canvas, so it cannot resolve `var(--teal-500)` the way the
 * DOM can — it needs a literal colour at option-build time. That is the one
 * place the "never a colour outside the token file" rule needs a
 * mechanism rather than a lint rule: the value is read from the live stylesheet
 * at runtime, so the token stays the single source and the chart follows it.
 *
 * The fallbacks exist because `getComputedStyle` returns an empty string when
 * the stylesheet is not applied — jsdom in unit tests, and the first paint
 * before CSS lands. They are the only hard-coded colours in the app, and they
 * are not allowed to drift: `chart-theme.drift.test.ts` parses `kerdial.css`
 * and fails if any fallback stops matching the token it stands in for.
 */
const FALLBACK: Readonly<Record<string, string>> = {
  "--chart-1": "#00A98F",
  "--chart-2": "#FF7A3D",
  "--chart-3": "#7C6CF0",
  "--chart-4": "#2E90FA",
  "--chart-5": "#EFC419",
  "--chart-6": "#7C8792",
  "--class-stock": "#00A98F",
  "--class-etf": "#2E90FA",
  "--class-fund": "#7C6CF0",
  "--class-scpi": "#B08D06",
  "--class-crypto": "#FF7A3D",
  "--gain-500": "#12B76A",
  "--loss-500": "#F04438",
  // The four remaining badge-tone ramps, for the trade markers — the tones
  // `transaction-kind.ts` assigns that the entries above do not already cover.
  "--teal-500": "#00A98F",
  "--warn-500": "#F79009",
  "--apricot-500": "#F4601E",
  "--ink-400": "#7C8792",
  "--ink-200": "#CBD2D9",
  "--ink-500": "#5A6673",
  "--text-strong": "#14181F",
  "--surface-card": "#FFFFFF",
  // The sparkline's `axisPointer` guide — the line that shows which day the
  // axis-triggered tooltip is describing. An alias of `--ink-300`, resolved
  // here the way `--border-strong` resolves it in the stylesheet (the drift
  // test follows one level of aliasing, so the semantic name is the one to
  // register).
  "--border-strong": "#a5aeb8",
};

/** Exported for the drift test, which checks each entry against `kerdial.css`. */
export const CHART_TOKEN_FALLBACKS = FALLBACK;

export function readToken(name: string): string {
  const fallback = FALLBACK[name];
  if (fallback === undefined) {
    throw new Error(`chart-theme: no fallback registered for ${name}`);
  }
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return resolved === "" ? fallback : resolved;
}

/** The chart ramp, in order — `--chart-1` … `--chart-6`. */
export function chartSeriesColor(index: number): string {
  return readToken(`--chart-${(index % 6) + 1}`);
}

/**
 * The same colour the chip and the legend use for a class.
 *
 * Resolved through `asset-class.ts` rather than through a second table, so the
 * locked map has exactly one definition and a chart cannot disagree with the
 * chip beside it. `assetClassColor` returns `var(--name)`; this unwraps it and
 * resolves it.
 */
export function assetClassChartColor(kind: string): string {
  return resolveReference(assetClassColor(kind));
}

/**
 * The same colour a transaction kind's badge reads as, for a marker drawn on
 * the canvas.
 *
 * Resolved through `transaction-kind.ts` — which derives it from the locked
 * `TRANSACTION_KIND_TONE` map — rather than through a second table here, for
 * the same reason {@link assetClassChartColor} is: a marker on the price chart
 * and the kind badge in the ledger cannot be allowed to disagree.
 */
export function transactionKindChartColor(kind: string): string {
  return resolveReference(transactionKindColor(kind));
}

/** `var(--name)` -> the token's literal value; anything else falls back to the neutral. */
function resolveReference(reference: string): string {
  const name = /^var\((--[\w-]+)\)$/.exec(reference)?.[1];
  return name === undefined ? readToken("--chart-6") : readToken(name);
}

/** Gain/loss for a series, from first versus last point. */
export function trendColor(first: number, last: number): string {
  return readToken(last < first ? "--loss-500" : "--gain-500");
}

/**
 * Charts fade and draw once on mount, and do not loop.
 *
 * Reduced motion is honoured here rather than in CSS, because canvas animation
 * never touches the stylesheet — the token file's blanket 0ms collapse cannot
 * reach it, so the media query has to be read directly. That is the one place
 * the "inherit it from the tokens" pattern genuinely does not work.
 */
export function chartAnimation(): { animation: boolean; animationDuration: number } {
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Matches --dur-slow. Not read from the token because a duration token
  // resolves to "360ms" and ECharts wants a number; the drift test pins it.
  return reduced
    ? { animation: false, animationDuration: 0 }
    : { animation: true, animationDuration: 360 };
}

/**
 * Applies an opacity to a resolved token, for the one thing ECharts needs that
 * the token set cannot express: a gradient stop.
 *
 * The token set has no alpha ramp, so the alternative would be inventing a
 * second, pre-faded colour — the hue would then have two definitions. This
 * keeps one hue and varies only its opacity. It lives here rather than beside
 * the chart because this is the module allowed to handle literal colours.
 */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color.trim())?.[1];
  if (hex === undefined) return color;
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
