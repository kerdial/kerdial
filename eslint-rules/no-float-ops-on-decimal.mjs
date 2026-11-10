// @ts-check
import { ESLintUtils } from "@typescript-eslint/utils";

/**
 * `no-float-ops-on-decimal` — the application-code half of the no-floats gate
 * (the schema-grep half was built in T-1's `no-floats-schema-gate`).
 *
 * Bans `Number(x)`, `parseFloat(x)`, unary `+x`, and `Math.*(x)` whenever `x`
 * is typed as the branded `Decimal` from `core/decimal`. Each of these silently
 * reintroduces IEEE-754 float imprecision on a value the rest of the codebase is relying on staying exact-decimal
 * (NFR-12, AC53) — and, critically, TypeScript's own type system does not
 * catch this: `Number()`/`Math.*` accept `any`, so a `Decimal` sails through
 * without a type error. This rule is what actually closes that gap.
 *
 * Detection is type-aware (requires `parserOptions.projectService`/`project`
 * to be configured for the linted files): an expression is treated as
 * "Decimal-typed" if its apparent type resolves to a symbol named `Decimal`
 * declared inside the `decimal.js` package (which is exactly what
 * `core/decimal`'s re-exported `Decimal` type is — see
 * `core/decimal/src/index.ts`).
 */

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/kerdial/kerdial#eslint-rule-${name}`,
);

const BANNED_GLOBAL_CALLEES = new Set(["Number", "parseFloat"]);

/** @param {import('typescript').Declaration} declaration */
function isDeclaredInDecimalJs(declaration) {
  const fileName = declaration.getSourceFile().fileName;
  return /decimal\.js\/decimal\.d\.ts$/.test(fileName) || /[/\\]decimal\.js[/\\]/.test(fileName);
}

/** @param {import('typescript').Type} type */
function isDecimalType(type) {
  if (type.isUnion()) {
    return type.types.some((member) => isDecimalType(member));
  }
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  if (!symbol || symbol.getName() !== "Decimal") return false;
  const declarations = symbol.getDeclarations() ?? [];
  return declarations.some((declaration) => isDeclaredInDecimalJs(declaration));
}

export const noFloatOpsOnDecimal = createRule({
  name: "no-float-ops-on-decimal",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Number()/parseFloat()/unary +/Math.* on values typed as the branded core/decimal Decimal type.",
    },
    messages: {
      noFloatCoercion:
        "Do not apply {{operation}} to a Decimal value — this silently reintroduces IEEE-754 float imprecision (NFR-12). Use a core/decimal formatter (formatMonetary/formatQuantity/formatPercentage/formatFxRate) or the toDecimalString/parseDecimalString codec instead.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    /** @param {import('@typescript-eslint/utils').TSESTree.Node} node */
    function typeOfNode(node) {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return checker.getTypeAtLocation(tsNode);
    }

    /** @param {import('@typescript-eslint/utils').TSESTree.Expression[]} args */
    function anyArgIsDecimal(args) {
      return args.some((arg) => isDecimalType(typeOfNode(arg)));
    }

    return {
      "CallExpression[callee.type='Identifier']"(node) {
        const calleeName = node.callee.name;
        if (!BANNED_GLOBAL_CALLEES.has(calleeName)) return;
        if (node.arguments.length === 0) return;
        if (anyArgIsDecimal(/** @type {any} */ (node.arguments))) {
          context.report({
            node,
            messageId: "noFloatCoercion",
            data: { operation: `${calleeName}()` },
          });
        }
      },
      "CallExpression[callee.type='MemberExpression'][callee.object.type='Identifier'][callee.object.name='Math']":
        (node) => {
          if (anyArgIsDecimal(/** @type {any} */ (node.arguments))) {
            context.report({ node, messageId: "noFloatCoercion", data: { operation: "Math.*" } });
          }
        },
      "UnaryExpression[operator='+']"(node) {
        if (isDecimalType(typeOfNode(node.argument))) {
          context.report({ node, messageId: "noFloatCoercion", data: { operation: "unary +" } });
        }
      },
    };
  },
});

export default noFloatOpsOnDecimal;
