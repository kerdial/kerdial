/**
 * `no-inline-icons` — the icon-discipline half of the Kerdial design gate.
 *
 * The Kerdial skin's icon rule: Lucide, stroke 2,
 * `currentColor`, always through the one `Icon` wrapper — no inline path data,
 * no second icon library, no emoji or Unicode symbols standing in for icons.
 *
 * The rule matters because each of the three is individually reasonable-looking
 * and collectively fatal to a consistent icon set: an inline `<svg>` is "just
 * one glyph we didn't have", a second library is "it had the icon I needed",
 * and an emoji is "it's only a badge". The result is four visual languages in
 * one table.
 *
 * `Icon.tsx` is exempt: it is the wrapper, and it is where the Lucide import
 * is supposed to live.
 */

/** Any icon package that is not the one the design specifies. */
const FOREIGN_ICON_PACKAGES = [
  "react-icons",
  "@heroicons/react",
  "@tabler/icons-react",
  "feather-icons",
  "@fortawesome/react-fontawesome",
  "react-feather",
  "@radix-ui/react-icons",
  "@phosphor-icons/react",
];

/**
 * Pictographic emoji and the dingbats most often pressed into service as icons.
 *
 * Deliberately **not** "all non-ASCII", and not even all of Miscellaneous
 * Technical. Three things must survive this rule:
 *
 * - accented French copy — the UI is French;
 * - U+2212 MINUS SIGN, which the skin *mandates* for every negative;
 * - the arrow and return glyphs the design itself specifies as typographic
 *   keyboard hints in the asset-search popover ("↑↓ ⏎" — U+2191, U+2193,
 *   U+23CE). The vendored `latin` font subset ships U+2191/U+2193 explicitly,
 *   which is a fair sign the design meant them as text rather than as icons.
 *
 * So the ranges below are the emoji-classified ones: emoticons and pictographs,
 * the dingbat block, the watch/hourglass pair and the media-control run inside
 * Miscellaneous Technical (which is where ⏱ U+23F1 lives), and the trigram
 * block that supplies the ☰ so often used as a menu glyph.
 *
 * U+FE0F, the emoji-presentation variation selector, is deliberately absent:
 * inside a character class it trips `no-misleading-character-class`, and it
 * only ever modifies a base character the ranges above already catch.
 */
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{231A}-\u{231B}\u{23E9}-\u{23FA}\u{2630}-\u{2637}]/u;

/** Whether a JSX subtree contains a `<path>` element — i.e. real glyph data rather than an `<svg>` used for layout. */
function containsPathElement(node) {
  for (const child of node.children ?? []) {
    if (child.type !== "JSXElement") continue;
    const childName = child.openingElement.name;
    if (childName.type === "JSXIdentifier" && childName.name === "path") return true;
    if (containsPathElement(child)) return true;
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
export const noInlineIcons = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Icons come from the Icon wrapper (Lucide) — never inline SVG path data, a second icon library, or an emoji.",
    },
    schema: [],
    messages: {
      inlineSvg:
        "Inline <svg> path data. Add the glyph to the registry in web/src/components/ui/Icon.tsx and render <Icon name=… />.",
      foreignPackage:
        "Second icon library `{{source}}`. This app uses Lucide only, through web/src/components/ui/Icon.tsx.",
      emoji:
        "Emoji `{{value}}` used as UI text. The icon set carries all ornament — use <Icon name=… /> (no emoji anywhere).",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    // The wrapper itself is where Lucide is imported and where sizing lives.
    if (filename.endsWith("components/ui/Icon.tsx")) return {};

    return {
      ImportDeclaration(node) {
        const source = String(node.source.value);
        if (FOREIGN_ICON_PACKAGES.some((pkg) => source === pkg || source.startsWith(`${pkg}/`))) {
          context.report({ node, messageId: "foreignPackage", data: { source } });
        }
        // Lucide is allowed, but only through the wrapper — a direct import
        // anywhere else bypasses the registry and the size/stroke contract.
        if (source === "lucide-react" || source.startsWith("lucide-react/")) {
          context.report({ node, messageId: "foreignPackage", data: { source } });
        }
      },

      JSXElement(node) {
        const name = node.openingElement.name;
        if (name.type !== "JSXIdentifier" || name.name !== "svg") return;
        // Walked rather than serialised: ESLint AST nodes carry `parent`
        // back-references, so JSON.stringify on a subtree throws on the cycle.
        if (containsPathElement(node)) context.report({ node, messageId: "inlineSvg" });
      },

      Literal(node) {
        if (typeof node.value !== "string") return;
        const match = EMOJI.exec(node.value);
        if (match) context.report({ node, messageId: "emoji", data: { value: match[0] } });
      },

      JSXText(node) {
        const match = EMOJI.exec(node.value);
        if (match) context.report({ node, messageId: "emoji", data: { value: match[0] } });
      },
    };
  },
};
