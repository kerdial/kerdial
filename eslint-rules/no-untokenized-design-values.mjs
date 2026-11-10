/**
 * `no-untokenized-design-values` — the token gate for `web/src/**`.
 *
 * `kerdial.css` is the single source of truth for colour, type, space, radius,
 * elevation and motion: no colour, size or radius may be introduced that is
 * not in that file. That rule is only worth anything if something enforces it, because the failure
 * mode is invisible: a hard-coded `#00A98F` looks exactly like the token until
 * the day the token changes and one component does not follow.
 *
 * Two violations, both in `className` strings and style objects:
 *
 * 1. A raw colour literal — hex, `rgb()`, `rgba()`, `hsl()`. Use a token.
 * 2. A Tailwind default-palette colour utility (`bg-slate-800`, `text-violet-700`).
 *    Tailwind's own palette is still loaded during the milestone — see the note
 *    in `web/src/styles.css` for why clearing it early would leave the app
 *    broken for the length of the migration — so these still *resolve*. They
 *    are counted down by `token-adoption.test.ts` and the namespace is cleared
 *    once the count reaches zero.
 *
 * Deliberately NOT flagged: colour literals inside `web/src/styles/*.css` (the
 * token files themselves), and `currentColor`/`transparent`/`inherit`, which
 * are keywords rather than values.
 */

/** Tailwind's default palette. Kerdial's own ramps (ink, paper, teal, apricot, lilac, sky, lemon, gain, loss, warn) are deliberately absent. */
const DEFAULT_PALETTE = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];

/** `bg-slate-800`, `hover:text-violet-700/50`, `dark:border-gray-200` — prefix and opacity modifier both optional. */
const PALETTE_UTILITY = new RegExp(
  String.raw`(?:^|\s|:)(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|accent|caret|shadow|decoration|placeholder)-(?:${DEFAULT_PALETTE.join("|")})-\d{2,3}(?:\/\d{1,3})?\b`,
);

/** `#abc`, `#aabbcc`, `#aabbccdd`, `rgb(...)`, `rgba(...)`, `hsl(...)`, `hsla(...)`. */
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/;

/** @type {import("eslint").Rule.RuleModule} */
export const noUntokenizedDesignValues = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Design values in web/src must come from the Kerdial token set, not from a literal or Tailwind's default palette.",
    },
    schema: [],
    messages: {
      colourLiteral:
        "Raw colour literal `{{value}}`. Use a Kerdial token — see web/src/styles/kerdial.css.",
      defaultPalette:
        "Tailwind default-palette utility `{{value}}`. Kerdial's ramps are ink / paper / teal / apricot / lilac / sky / lemon / gain / loss / warn; semantic aliases (bg-surface-card, text-text-muted, border-border-subtle) are preferred.",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    // The token files are where the literals are supposed to live.
    if (filename.includes("/styles/")) return {};
    // `chart-theme.ts` is the one module allowed colour literals. ECharts draws
    // to a canvas and cannot resolve a CSS custom property, and
    // `getComputedStyle` returns nothing before the stylesheet applies — so it
    // carries fallbacks by necessity. They are not unpinned: the token stays
    // the runtime source, and `chart-theme.drift.test.ts` fails if any fallback
    // stops matching what `kerdial.css` declares.
    if (filename.endsWith("lib/chart-theme.ts")) return {};
    // Tests are not styling call sites, and some of them legitimately assert on
    // exact values — `brand.test.tsx` checks that the manifest's theme colour is
    // the design's app ground and no longer the old slate, which it can only do
    // by naming both. Linting them turned that assertion into a violation of
    // the very rule it was helping enforce.
    if (/\.test\.[jt]sx?$/.test(filename)) return {};

    /** @param {import("estree").Node & {value?: unknown}} node @param {string} text */
    function check(node, text) {
      const palette = PALETTE_UTILITY.exec(text);
      if (palette) {
        context.report({ node, messageId: "defaultPalette", data: { value: palette[0].trim() } });
      }
      const colour = COLOUR_LITERAL.exec(text);
      if (colour) {
        context.report({ node, messageId: "colourLiteral", data: { value: colour[0] } });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        if (typeof node.value.cooked === "string") check(node, node.value.cooked);
      },
    };
  },
};
