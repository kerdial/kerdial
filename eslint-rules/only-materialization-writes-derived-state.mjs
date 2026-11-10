// @ts-check
import { ESLintUtils } from "@typescript-eslint/utils";

/**
 * `only-materialization-writes-derived-state` — ADR-0007 (AR-3), the
 * structural half of the invalidation contract.
 *
 * The four derived tables (`holding_state`, `cash_balance`, `realized_gain`,
 * `portfolio_daily_valuation`) and the `portfolio.calc_epoch` counter are
 * written by `ledger/src/materialization.ts` and by nothing else — that is
 * what makes the write-path registry's guarantee ("every valuation-affecting
 * write bumps the epoch and clears stale rows") checkable at all. A service
 * that deleted a derived row or bumped the epoch on its own would bypass the
 * registry silently; this rule makes that a lint error instead of a review
 * hazard, the same structural-over-discretionary argument this codebase
 * applies to FX (and the same idiom as `no-float-ops-on-decimal`).
 *
 * Two shapes are flagged, everywhere outside `materialization.ts` (test
 * files and test-support excluded — suites legitimately corrupt rows to
 * red-confirm their own detection, e.g. UR-4's red-confirmation describe):
 *
 *  1. `.delete(<derived table>)` — a drizzle delete of one of the four
 *     derived-state tables, matched by the imported schema identifier.
 *  2. `.set({ calcEpoch: ... })` / `.set({ ..., calcEpoch, ... })` — an
 *     UPDATE writing `portfolio.calc_epoch`. Inserting a row that *carries*
 *     a `calcEpoch` stamp (`valuation`'s `portfolio_daily_valuation` rows)
 *     is deliberately not flagged: stamping a new derived row with the
 *     current epoch is the read path's job; *moving* the counter is not.
 *
 * `valuation/src/materialize.ts` inserts `portfolio_daily_valuation` rows —
 * INSERTs are not flagged (materialise-on-read is the design); what no
 * module but materialization.ts may do is destroy or version-bump.
 */

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/kerdial/kerdial#eslint-rule-${name}`,
);

const DERIVED_TABLE_IDENTIFIERS = new Set([
  "holdingState",
  "cashBalance",
  "realizedGain",
  "portfolioDailyValuation",
]);

/** @param {string} filename */
function isExemptFile(filename) {
  return (
    /[/\\]materialization\.ts$/.test(filename) ||
    /\.test\.tsx?$/.test(filename) ||
    /[/\\]test-support[/\\]/.test(filename) ||
    /[/\\]platform[/\\]test-support[/\\]/.test(filename)
  );
}

export const onlyMaterializationWritesDerivedState = createRule({
  name: "only-materialization-writes-derived-state",
  meta: {
    type: "problem",
    docs: {
      description:
        "Derived state (holding_state, cash_balance, realized_gain, portfolio_daily_valuation, portfolio.calc_epoch) is written only by ledger/src/materialization.ts (ADR-0007, AR-3)",
    },
    messages: {
      deleteDerived:
        "Only ledger/src/materialization.ts may delete from {{table}} — route this through recomputeAndInvalidate / invalidateForInstrumentPrice / destroyDerivedStateForPortfolio (ADR-0007).",
      writeCalcEpoch:
        "Only ledger/src/materialization.ts may write portfolio.calc_epoch — a write path that needs the epoch moved calls recomputeAndInvalidate (ADR-0007).",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    if (isExemptFile(context.filename)) return {};
    return {
      /** @param {import('@typescript-eslint/utils').TSESTree.CallExpression} node */
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return;

        if (
          callee.property.name === "delete" &&
          node.arguments.length === 1 &&
          node.arguments[0]?.type === "Identifier" &&
          DERIVED_TABLE_IDENTIFIERS.has(node.arguments[0].name)
        ) {
          context.report({
            node,
            messageId: "deleteDerived",
            data: { table: node.arguments[0].name },
          });
          return;
        }

        if (callee.property.name === "set" && node.arguments[0]?.type === "ObjectExpression") {
          const writesEpoch = node.arguments[0].properties.some(
            (property) =>
              property.type === "Property" &&
              ((property.key.type === "Identifier" && property.key.name === "calcEpoch") ||
                (property.key.type === "Literal" && property.key.value === "calcEpoch")),
          );
          if (writesEpoch) {
            context.report({ node, messageId: "writeCalcEpoch" });
          }
        }
      },
    };
  },
});
