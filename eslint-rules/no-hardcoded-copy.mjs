/**
 * `no-hardcoded-copy` — the copy gate for `web/src/components/**` and
 * `web/src/routes/**`.
 *
 * Decided 2026-08-21: the UI ships French only, and English follows later.
 * That decision stays cheap exactly as long as the strings are not welded to
 * the point of render. So: a user-facing string is a **key into a catalogue**
 * (`web/src/lib/copy/`, and the copy modules that already sat beside it —
 * `empty-states.ts`, `problem-messages.ts`, `import-copy.ts`,
 * `history-status-copy.ts`, `control-rows.ts`), never a literal in a component.
 *
 * This rule is the enforcement half, in the same shape as the token gate
 * (`no-untokenized-design-values`) and the icon gate (`no-inline-icons`): the
 * catalogue is only a single source of truth if something fails when a screen
 * writes its own words instead.
 *
 * **Three shapes are flagged**, all of them things a user reads:
 *
 * 1. `JSXText` — the words between the tags.
 * 2. A string literal that is a JSX **child** — `{cond ? "Oui" : "Non"}` is
 *    rendered text no less than `Oui` would be.
 * 3. A string literal given to one of the `COPY_ATTRIBUTES` below — the prop
 *    vocabulary this app actually uses for text a user sees, swept out of
 *    `components/` and `routes/` rather than guessed.
 *
 * **Deliberately NOT flagged**, because they are not copy: `className`,
 * `data-testid`, `id`, `to`, `href`, `src`, `htmlFor`, `role`, `type`, `name`,
 * `kind`, `variant`, `tone`, `size`, `padding`, `mode`, `scope`, `icon`,
 * `iconLeft`/`iconRight`, `stateId`, `testId`/`testIdPrefix`/`closeTestId`,
 * and every other attribute not named in the allowlist. The allowlist is
 * positive on purpose: a new machine-readable prop must not silently become a
 * lint error, and a new *text* prop is a two-line change here.
 *
 * **What counts as "words"** is `\p{L}{2,}` — two or more consecutive letters,
 * in any script. Two consequences, both intended:
 *
 * - Accented French survives the character heuristics by construction. The
 *   `no-inline-icons` header records why this matters (its EMOJI ranges are
 *   deliberately not "all non-ASCII"): a rule that treats « é » as suspicious
 *   is a rule that flags the entire shipped locale for being itself.
 * - A separator or a unit is not copy. `·`, `—`, `%`, `/`, `€`, U+2212 MINUS
 *   SIGN (which the design *mandates* for negatives) carry no letters and are
 *   left alone, so `{a} · {b}` needs no catalogue entry.
 *
 * Test files are exempt, for the token rule's own reason: they are not render
 * sites, and asserting on French copy by its exact text is what proves the
 * catalogue renders. A component test that names a string is doing its job.
 */

/**
 * The JSX attributes whose string value a user reads.
 *
 * Swept from `web/src/components/**` and `web/src/routes/**` (the props that
 * actually carry text here: `label`, `title`, `hint`, `panelLabel`,
 * `subtitle`, `description`, `aria-label`, `placeholder`, `closeLabel`), plus
 * the kit props of the same kind that had no literal call site at the time —
 * `alt`, `error`, `note`, `detail`, `summary`, `disabledReason`, the remaining
 * `*Label` props of the primitive kit, and the ARIA text attributes. Including
 * a currently-unused one costs nothing and closes the hole before it opens.
 */
const COPY_ATTRIBUTES = new Set([
  // Plain text props.
  "label",
  "title",
  "subtitle",
  "description",
  "summary",
  "caption",
  "legend",
  "hint",
  "note",
  "detail",
  "error",
  "placeholder",
  "alt",
  // The primitive kit's own `*Label` vocabulary.
  "panelLabel",
  "closeLabel",
  "openLabel",
  "showLabel",
  "valueLabel",
  "removeLabel",
  "emptyLabel",
  "actionLabel",
  "disabledReason",
  // ARIA text — read aloud, therefore copy.
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
]);

/** Two or more consecutive letters in any script — see the header on why this, and not "non-ASCII". */
const HAS_WORDS = /\p{L}{2,}/u;

/** @param {string} text */
function isCopy(text) {
  return HAS_WORDS.test(text);
}

/** The first ~40 characters of the offending text, for an error a reader can locate. */
function excerpt(text) {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/** @type {import("eslint").Rule.RuleModule} */
export const noHardcodedCopy = {
  meta: {
    type: "problem",
    docs: {
      description:
        "User-facing French copy in web/src/components and web/src/routes comes from the catalogue in web/src/lib/copy, not from a literal at the point of render.",
    },
    schema: [],
    messages: {
      jsxText:
        'Hard-coded copy "{{value}}" rendered as JSX text. Add a key to web/src/lib/copy/ and render it — see the catalogue\'s own header.',
      jsxChild:
        'Hard-coded copy "{{value}}" rendered as a JSX child. Add a key to web/src/lib/copy/ and render it — a ternary between two literals still ships two strings.',
      attribute:
        'Hard-coded copy "{{value}}" in the `{{attribute}}` prop. Add a key to web/src/lib/copy/ and pass it — interpolated values go in pre-formatted (figure-format.ts and the date helpers stay the formatters).',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    // Tests assert French copy by its exact text; that is the proof the
    // catalogue renders, not a violation of it.
    if (/\.test\.[jt]sx?$/.test(filename)) return {};

    return {
      JSXText(node) {
        if (!isCopy(node.value)) return;
        context.report({ node, messageId: "jsxText", data: { value: excerpt(node.value) } });
      },

      JSXExpressionContainer(node) {
        // Children only — an attribute's `{"…"}` is handled by JSXAttribute
        // below, where the attribute name decides whether it is copy at all.
        if (node.parent?.type !== "JSXElement" && node.parent?.type !== "JSXFragment") return;
        for (const literal of stringLiteralsOf(node.expression)) {
          if (!isCopy(literal.value)) continue;
          context.report({
            node: literal,
            messageId: "jsxChild",
            data: { value: excerpt(literal.value) },
          });
        }
      },

      JSXAttribute(node) {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : null;
        if (name === null || !COPY_ATTRIBUTES.has(name)) return;
        const value = node.value;
        if (value === null) return;
        const expression =
          value.type === "JSXExpressionContainer" ? value.expression : /** @type {any} */ (value);
        for (const literal of stringLiteralsOf(expression)) {
          if (!isCopy(literal.value)) continue;
          context.report({
            node: literal,
            messageId: "attribute",
            data: { value: excerpt(literal.value), attribute: name },
          });
        }
      },
    };
  },
};

/**
 * The string literals a JSX slot would actually render, one level of choice
 * deep.
 *
 * A bare literal and the two arms of `cond ? "Oui" : "Non"` (and of
 * `x ?? "Aucun"`, and of `a || "Aucun"`) are all text that reaches the screen,
 * so all of them are copy. Anything else — a call, a member access into the
 * catalogue, a template with an expression in it — is left alone: the whole
 * point of the catalogue is that `COPY.foo` is a `MemberExpression`, not a
 * literal, and therefore invisible to this rule.
 *
 * @param {any} expression
 * @returns {{value: string}[]}
 */
function stringLiteralsOf(expression) {
  if (expression === null || expression === undefined) return [];
  switch (expression.type) {
    case "Literal":
      return typeof expression.value === "string" ? [expression] : [];
    case "JSXText":
      return [];
    case "TemplateLiteral":
      // Only a template with no substitutions is a plain string; one with
      // `${…}` in it is composition, and its literal chunks are glue.
      return expression.expressions.length === 0 && expression.quasis.length === 1
        ? [{ ...expression.quasis[0], value: expression.quasis[0].value.cooked ?? "" }]
        : [];
    case "ConditionalExpression":
      return [
        ...stringLiteralsOf(expression.consequent),
        ...stringLiteralsOf(expression.alternate),
      ];
    case "LogicalExpression":
      return [...stringLiteralsOf(expression.left), ...stringLiteralsOf(expression.right)];
    default:
      return [];
  }
}
