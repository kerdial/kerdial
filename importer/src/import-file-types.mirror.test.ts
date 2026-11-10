import { IMPORT_FILE_TYPES, type ImportFileTypeName } from "@kerdial/api-contracts";
import { describe, expect, it } from "vitest";

import type { AnyImportFileType } from "./types.js";

/**
 * The drift guard for the by-value mirror between the wire
 * enum (`core/api-contracts`'s {@link IMPORT_FILE_TYPES}) and this package's
 * own {@link AnyImportFileType}.
 *
 * `core/api-contracts/src/import-request.schema.ts`'s header states that the
 * vocabularies are "declared a second time by value" and that "the pairs are
 * asserted equal by `api/src/imports/imports.schema.test.ts`". That file does
 * not exist — most likely a test-diet casualty — so the mirror was
 * unguarded at exactly the moment the `portfolio-export-import` cycle widened
 * both sides by two members.
 *
 * ## Why here, and why there is no third copy of the list
 *
 * `importer` depends on `@kerdial/api-contracts`; the reverse edge would be a
 * package cycle, so only this side of the boundary can see both declarations.
 * And nothing below re-types the five names: a local tuple would be a **third**
 * copy of a constant this repository has already been bitten by duplicating,
 * and it would drift in its own right. The two directions are instead asserted
 * as set inclusions, which is stronger than a list comparison and impossible to
 * write stale:
 *
 *  - **wire ⊆ importer** — `IMPORT_FILE_TYPES satisfies readonly
 *    AnyImportFileType[]`, evaluated on the imported tuple itself.
 *  - **importer ⊆ wire** — `Exclude<AnyImportFileType, ImportFileTypeName>` must be
 *    `never`, checked by {@link AssertNever}.
 *
 * Both are **compile** errors rather than red assertions, which is the point:
 * adding a member to one side and not the other must not produce a build that
 * runs at all. The runtime assertions below cover what a type cannot — a
 * duplicated entry, and the cardinality, so a silent deletion is visible as a
 * number rather than as a set that still satisfies both inclusions.
 */

/** Resolves only when `T` is `never`; a non-empty `Exclude` is a compile error at the use site. */
type AssertNever<T extends never> = T;

/** importer ⊆ wire. A member added to `AnyImportFileType` alone does not compile. */
type ImporterMembersAreOnTheWire = AssertNever<Exclude<AnyImportFileType, ImportFileTypeName>>;

/** wire ⊆ importer. A member added to `IMPORT_FILE_TYPES` alone does not compile. */
const wireMembersAreImporterMembers = IMPORT_FILE_TYPES satisfies readonly AnyImportFileType[];

describe("IMPORT_FILE_TYPES mirrors AnyImportFileType", () => {
  it("carries exactly the five file types this cycle leaves behind, with no duplicate", () => {
    // The cardinality is asserted as a literal rather than derived from the
    // tuple, so a deletion is a red test and not a silently smaller set that
    // still satisfies both inclusions above.
    expect(wireMembersAreImporterMembers).toHaveLength(5);
    expect(new Set(wireMembersAreImporterMembers).size).toBe(5);
  });

  it("names both packages of the portfolio-export-import cycle", () => {
    // Spelled out, because the two inclusions are about *shape*: they would
    // both hold for a pair of tuples that agreed on the wrong five names.
    expect([...wireMembersAreImporterMembers]).toStrictEqual([
      "ASSETS",
      "CASH_ACCOUNT_TRANSACTIONS",
      "INVESTMENT_ACCOUNT_TRANSACTIONS",
      "KERDIAL_TRANSACTIONS",
      "KERDIAL_CATALOGUE",
    ]);
  });

  it("keeps the type-level inclusion checks referenced, so neither is dead code", () => {
    // `ImporterMembersAreOnTheWire` is a type; a lint rule that removes unused
    // declarations would take the guard with it. Naming it in a value position
    // is not possible, so it is named here in a type position that is.
    const witness: ImporterMembersAreOnTheWire[] = [];
    expect(witness).toHaveLength(0);
  });
});
