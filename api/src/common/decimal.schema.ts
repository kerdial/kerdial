/**
 * The API/JSON boundary's decimal codec: "every
 * decimal crosses the API boundary as a JSON string. Not a number, ever."
 *
 * **Moved to `@kerdial/api-contracts` by T-44** (a pure
 * move, not a rewrite — see that package's `decimal-codec.ts` for the full
 * doc comment) so `web`'s transaction form can import the exact same codec
 * `api` validates against, without giving `web` a dependency on the `api`
 * package itself (shared-Zod-schema requirement).
 * Re-exported here verbatim so every existing import site in this package
 * (`instruments.schema.ts`, `portfolios.schema.ts`, `transactions.schema.ts`,
 * `openapi/openapi-builder.ts`) needs no change at all.
 */
export {
  DECIMAL_OPENAPI_SCHEMA,
  decimalStringSchema,
  serializeDecimal,
  zDecimal,
} from "@kerdial/api-contracts";
