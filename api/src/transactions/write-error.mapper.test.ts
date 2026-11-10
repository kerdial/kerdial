import { Writable } from "node:stream";
import { HttpException } from "@nestjs/common";
import { Decimal } from "@kerdial/core-decimal";
import { createLogger, setRootLoggerForTest } from "@kerdial/platform-logging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CashAccountArchivedError,
  CashAccountCurrencyMismatchError,
  CashAccountNotAllowedError,
  CashAccountNotFoundError,
  CashAccountRequiredError,
  CashAmountNotAcceptedError,
  CashAmountRequiredError,
  CashAmountStaleError,
  CostComponentsInvalidError,
  ImpliedSettlementRateOutOfRangeError,
  TransactionShareDistributionShapeError,
  TransactionTransferShapeError,
  TransferDestinationIsSourceError,
  TransferDestinationNotFoundError,
  TransferPropagationDidNotSettleError,
  TransferTargetReadOnlyError,
} from "@kerdial/ledger";
import { mapTransactionWriteError } from "./write-error.mapper.js";

/**
 * **FT-17 (Batch C) — the
 * status *and* the code, one test per error class.**
 *
 * Deliberately not one test asserting "the errors map correctly": the whole
 * content of the rule is that the three settlement rejections get **their
 * own** codes rather than the generic shape code, and a test over a list
 * cannot fail for the one entry that collapsed onto its neighbour's code.
 *
 * Real error instances, constructed exactly as `TransactionWriteService`
 * constructs them — the `portfolios.controller.error-mapping.test.ts`
 * precedent: only the *origin* of the error is synthetic, the mapping under
 * test is the real, unmodified function.
 */

function mapped(err: unknown): {
  status: number;
  code: string | undefined;
  title: unknown;
  /** Asserts on the sentence the user reads, not only on the code. */
  detail: string | undefined;
} {
  const result = mapTransactionWriteError(err);
  expect(
    result,
    "the mapper returned the error unchanged — it would reach the 500 fallback",
  ).toBeInstanceOf(HttpException);
  const exception = result as HttpException;
  const body = exception.getResponse() as { code?: string; title?: string; detail?: string };
  return {
    status: exception.getStatus(),
    code: body.code,
    title: body.title,
    detail: body.detail,
  };
}

describe("mapTransactionWriteError — FT-17: the three settlement-figure rejections", () => {
  it("CashAmountNotAcceptedError -> 400 CASH_AMOUNT_NOT_ACCEPTED", () => {
    const result = mapped(
      new CashAmountNotAcceptedError(
        "cashAmount",
        "DERIVED_IN_BASE_CURRENCY",
        "the settling account is denominated in the base currency, so the settled amount is gross x fx_rate",
      ),
    );

    expect(result.status).toBe(400);
    expect(result.code).toBe("CASH_AMOUNT_NOT_ACCEPTED");
    // …and specifically **not** the generic shape code, which is the whole
    // point of giving it one of its own ("never the generic
    // shape code, because both are 'your input is fine but this endpoint
    // derives that figure'").
    expect(result.code).not.toBe("TRANSACTION_INVALID_SHAPE");
  });

  it("CashAmountRequiredError -> 400 CASH_AMOUNT_REQUIRED", () => {
    const result = mapped(
      new CashAmountRequiredError(
        "cashAmount",
        "settled in GBP against a USD trade in a EUR tenant",
      ),
    );

    expect(result.status).toBe(400);
    expect(result.code).toBe("CASH_AMOUNT_REQUIRED");
    expect(result.code).not.toBe("TRANSACTION_INVALID_SHAPE");
  });

  it("CashAmountStaleError -> 400 CASH_AMOUNT_STALE", () => {
    const result = mapped(
      new CashAmountStaleError(
        "00000000-0000-7000-8000-0000000000aa",
        "cashAmount",
        "GBP",
        "GROSS_MOVED",
        "quantity moved, so gross_amount moved with it",
      ),
    );

    expect(result.status).toBe(400);
    expect(result.code).toBe("CASH_AMOUNT_STALE");
    expect(result.code).not.toBe("TRANSACTION_INVALID_SHAPE");
  });

  /**
   * One code, two triggers, two titles. FR-254 names three
   * triggers and only the gross one was implemented, so the single title stated
   * the wrong cause for the trigger that was missing — a caller re-denominating
   * a leg was told their edit "moves the gross amount".
   */
  it("CashAmountStaleError's SETTLEMENT_CURRENCY_CHANGED reason keeps the code and changes the title", () => {
    const result = mapped(
      new CashAmountStaleError(
        "00000000-0000-7000-8000-0000000000aa",
        "cashAmount",
        "GBP",
        "SETTLEMENT_CURRENCY_CHANGED",
        "this edit moves the settling currency from CHF to GBP",
      ),
    );

    expect(result.status).toBe(400);
    expect(result.code).toBe("CASH_AMOUNT_STALE");
    expect(String(result.title)).toContain("settling currency");
    expect(String(result.title)).not.toContain("gross amount");
  });

  /**
   * The class had no case here at all, so
   * `CostComponentsInvalidError -> 400 COST_COMPONENTS_INVALID` was mapped by
   * code no test touched. Both reasons, because they are different sentences
   * and a shared code would make them one.
   */
  it.each([
    ["SUM_MISMATCH" as const, "the components do not add up to the supplied total"],
    ["NO_SETTLING_ACCOUNT" as const, "there is no account to denominate them in"],
  ])("CostComponentsInvalidError/%s -> 400 COST_COMPONENTS_INVALID", (reason, detail) => {
    const result = mapped(new CostComponentsInvalidError("fee.components", reason, detail));

    expect(result.status).toBe(400);
    expect(result.code).toBe("COST_COMPONENTS_INVALID");
    // Not the generic shape code, which is what this mapping exists to replace.
    expect(result.code).not.toBe("TRANSACTION_INVALID_SHAPE");
    expect(result.detail).toContain(detail);
    // No constraint name reaches the body.
    expect(String(result.detail)).not.toMatch(/transaction_[a-z_]+/);
  });

  /**
   * **The implied-rate overflow.** A 422, not a 400, and the test says why in the
   * assertions rather than only in prose: the status separates it from the
   * three `CASH_AMOUNT_*` refusals above, which all say "this endpoint derives
   * that figure" about a request that is otherwise fine. This one says the
   * request is fine *and* the posting it implies cannot be represented.
   */
  it("ImpliedSettlementRateOutOfRangeError -> 422 IMPLIED_SETTLEMENT_RATE_OUT_OF_RANGE", () => {
    const result = mapped(
      new ImpliedSettlementRateOutOfRangeError({
        field: "cashAmount",
        impliedRate: new Decimal("1000000000000000000"),
        maximumExclusive: new Decimal("10000000000000000"),
        detail: "the settled amount is too small beside the trade's base value",
      }),
    );

    expect(result.status).toBe(422);
    expect(result.code).toBe("IMPLIED_SETTLEMENT_RATE_OUT_OF_RANGE");
    expect(result.code).not.toBe("TRANSACTION_INVALID_SHAPE");
    // Never the SQLSTATE the guard exists to prevent surfacing.
    expect(result.detail).not.toMatch(/22003/);
    // The detail names the field and the bound, which is what makes it
    // actionable rather than merely correct.
    expect(result.detail).toContain("cashAmount");
    expect(result.detail).toContain("10000000000000000");
  });

  /**
   * The three codes are distinct **from each other** as well as from the
   * generic one. Asserted separately because the individual tests above would
   * all still pass if two of the three branches had been written with the
   * same string by copy-paste — no, they would not, but they *would* if a
   * later edit renamed one and updated its test in the same stroke. This is
   * the cardinality guard: three distinct codes, three classes.
   */
  it("the three codes are three distinct strings — a shared code would make two of the sentences one", () => {
    const codes = [
      mapped(new CashAmountNotAcceptedError("cashAmount", "DEGENERATE_EQUALS_GROSS", "x")).code,
      mapped(new CashAmountRequiredError("cashAmount", "x")).code,
      mapped(
        new CashAmountStaleError(
          "00000000-0000-7000-8000-0000000000aa",
          "cashAmount",
          "GBP",
          "GROSS_MOVED",
          "x",
        ),
      ).code,
    ];

    expect(new Set(codes).size).toBe(3);
    expect(codes).toEqual([
      "CASH_AMOUNT_NOT_ACCEPTED",
      "CASH_AMOUNT_REQUIRED",
      "CASH_AMOUNT_STALE",
    ]);
  });

  /**
   * Extends the cardinality guard rather than sitting outside
   * it: four settlement refusals, four distinct codes, and the fourth is the
   * only one that is not a 400 — asserted together so a later edit cannot
   * collapse the new sentence into one of the old ones.
   */
  it("the settlement refusals are four distinct codes, and exactly one of them is a 422", () => {
    const results = [
      mapped(new CashAmountNotAcceptedError("cashAmount", "DEGENERATE_EQUALS_GROSS", "x")),
      mapped(new CashAmountRequiredError("cashAmount", "x")),
      mapped(
        new CashAmountStaleError(
          "00000000-0000-7000-8000-0000000000aa",
          "cashAmount",
          "GBP",
          "GROSS_MOVED",
          "x",
        ),
      ),
      mapped(
        new ImpliedSettlementRateOutOfRangeError({
          field: "cashAmount",
          impliedRate: new Decimal("1000000000000000000"),
          maximumExclusive: new Decimal("10000000000000000"),
          detail: "x",
        }),
      ),
    ];

    expect(new Set(results.map((result) => result.code)).size).toBe(4);
    expect(results.filter((result) => result.status === 422)).toHaveLength(1);
    expect(results.filter((result) => result.status === 400)).toHaveLength(3);
  });

  /**
   * `CashAmountNotAcceptedError` carries five distinct reasons
   * ({@link CashAmountNotAcceptedReason}); all five are the same 400, and the
   * reason travels in `detail` rather than in a fifth code. Asserted so the
   * mapping is known to be reason-independent rather than accidentally
   * matching only the reason the first test happened to use.
   */
  it("every CashAmountNotAcceptedError reason maps to the same 400, with the reason in the detail", () => {
    for (const reason of [
      "DERIVED_IN_BASE_CURRENCY",
      "DEGENERATE_EQUALS_GROSS",
      "UNPAIRED_WITHOUT_CURRENCY",
      "CURRENCY_EXCHANGE_PINNED",
      "ASSET_SETTLED_PRINCIPAL",
    ] as const) {
      const result = mapTransactionWriteError(
        new CashAmountNotAcceptedError("cashAmount", reason, "detail"),
      ) as HttpException;
      const body = result.getResponse() as { code?: string; detail?: string };

      expect(result.getStatus(), reason).toBe(400);
      expect(body.code, reason).toBe("CASH_AMOUNT_NOT_ACCEPTED");
      expect(body.detail, reason).toContain(reason);
    }
  });
});

/**
 * FR-260 at the mapper: phase 1 adds branches, it moves none. Every
 * cash-account rejection keeps the status and code CA-11's error table gave
 * it — asserted one class per test, because the three settlement branches
 * were inserted **above** these and an `instanceof` chain is order-sensitive.
 */
describe("mapTransactionWriteError — the pre-existing cash-account rejections, unchanged by phase 1", () => {
  it("CashAccountNotFoundError -> 404 CASH_ACCOUNT_NOT_FOUND", () => {
    const result = mapped(
      new CashAccountNotFoundError("00000000-0000-7000-8000-0000000000bb", "cashAccountId"),
    );

    expect(result.status).toBe(404);
    expect(result.code).toBe("CASH_ACCOUNT_NOT_FOUND");
  });

  it("CashAccountCurrencyMismatchError -> 400 CASH_ACCOUNT_CURRENCY_MISMATCH", () => {
    const result = mapped(
      new CashAccountCurrencyMismatchError(
        "00000000-0000-7000-8000-0000000000bb",
        "cashAccountId",
        "USD",
        "EUR",
      ),
    );

    expect(result.status).toBe(400);
    expect(result.code).toBe("CASH_ACCOUNT_CURRENCY_MISMATCH");
  });

  it("CashAccountArchivedError -> 409 CASH_ACCOUNT_ARCHIVED", () => {
    const result = mapped(
      new CashAccountArchivedError("00000000-0000-7000-8000-0000000000bb", "cashAccountId"),
    );

    expect(result.status).toBe(409);
    expect(result.code).toBe("CASH_ACCOUNT_ARCHIVED");
  });

  it("CashAccountRequiredError -> 400 CASH_ACCOUNT_REQUIRED", () => {
    const result = mapped(new CashAccountRequiredError("cashAccountId", "a BUY moves cash"));

    expect(result.status).toBe(400);
    expect(result.code).toBe("CASH_ACCOUNT_REQUIRED");
  });

  it("CashAccountNotAllowedError -> 400 CASH_ACCOUNT_NOT_ALLOWED", () => {
    const result = mapped(
      new CashAccountNotAllowedError("cashAccountId", "ASSET_SETTLED_PRINCIPAL", "moves no cash"),
    );

    expect(result.status).toBe(400);
    expect(result.code).toBe("CASH_ACCOUNT_NOT_ALLOWED");
  });

  /**
   * **Cashless distribution edits** — the edit path's refusal of a malformed cashless
   * distribution. Its own code, and a 422: the body is well formed and
   * internally coherent, so this is not the `23514` branch's generic 400
   * `TRANSACTION_INVALID_SHAPE` (which is where exactly this input used to
   * land, red-confirmed in
   * `api/src/transactions-share-distribution-edit.e2e.test.ts`).
   */
  it("TransactionShareDistributionShapeError -> 422 TRANSACTION_SHARE_DISTRIBUTION_INVALID_SHAPE, both reasons", () => {
    const forbidden = mapped(
      new TransactionShareDistributionShapeError(
        "00000000-0000-7000-8000-0000000000cc",
        "unitPrice",
        "FORBIDDEN",
      ),
    );
    expect(forbidden.status).toBe(422);
    expect(forbidden.code).toBe("TRANSACTION_SHARE_DISTRIBUTION_INVALID_SHAPE");
    expect(forbidden.code).not.toBe("TRANSACTION_INVALID_SHAPE");
    expect(forbidden.detail).toContain("unitPrice");

    // The other half of the kind's shape travels on the same code — the remedy
    // is the same, and `reason` is on the error for anything that needs to
    // tell the two apart.
    const required = mapped(
      new TransactionShareDistributionShapeError(
        "00000000-0000-7000-8000-0000000000cc",
        "quantity",
        "REQUIRED",
      ),
    );
    expect(required.status).toBe(422);
    expect(required.code).toBe("TRANSACTION_SHARE_DISTRIBUTION_INVALID_SHAPE");
    expect(required.detail).toContain("quantity");
    expect(required.detail).not.toBe(forbidden.detail);
  });
});

/**
 * **`security-transfer`** — the four refusals the transfer write
 * paths raise, each on its own code. Before TR-19 all four came back
 * unchanged, i.e. a 500.
 */
describe("mapTransactionWriteError — the security-transfer refusals (TR-19)", () => {
  it("TransferDestinationIsSourceError -> 400 TRANSFER_DESTINATION_IS_SOURCE", () => {
    const result = mapped(
      new TransferDestinationIsSourceError("00000000-0000-7000-8000-0000000000d1"),
    );
    expect(result.status).toBe(400);
    expect(result.code).toBe("TRANSFER_DESTINATION_IS_SOURCE");
  });

  it("TransferDestinationNotFoundError -> 404 TRANSFER_DESTINATION_NOT_FOUND", () => {
    const result = mapped(
      new TransferDestinationNotFoundError("00000000-0000-7000-8000-0000000000d2"),
    );
    expect(result.status).toBe(404);
    expect(result.code).toBe("TRANSFER_DESTINATION_NOT_FOUND");
    // Not the source portfolio's own 404: the screen must say which one is missing.
    expect(result.code).not.toBe("PORTFOLIO_NOT_FOUND");
  });

  it("TransferTargetReadOnlyError -> 422 TRANSACTION_TRANSFER_TARGET_READ_ONLY", () => {
    const result = mapped(
      new TransferTargetReadOnlyError(
        "00000000-0000-7000-8000-0000000000d3",
        "quantity",
        "00000000-0000-7000-8000-0000000000d4",
      ),
    );
    expect(result.status).toBe(422);
    expect(result.code).toBe("TRANSACTION_TRANSFER_TARGET_READ_ONLY");
  });

  it("TransactionTransferShapeError -> 422 TRANSACTION_TRANSFER_INVALID_SHAPE, both reasons", () => {
    const forbidden = mapped(
      new TransactionTransferShapeError(
        "00000000-0000-7000-8000-0000000000d5",
        "unitPrice",
        "FORBIDDEN",
      ),
    );
    expect(forbidden.status).toBe(422);
    expect(forbidden.code).toBe("TRANSACTION_TRANSFER_INVALID_SHAPE");
    expect(forbidden.code).not.toBe("TRANSACTION_INVALID_SHAPE");

    const required = mapped(
      new TransactionTransferShapeError(
        "00000000-0000-7000-8000-0000000000d5",
        "quantity",
        "REQUIRED",
      ),
    );
    expect(required.status).toBe(422);
    expect(required.code).toBe("TRANSACTION_TRANSFER_INVALID_SHAPE");
  });
});

/**
 * The propagation's round cap, the one internal failure this mapper
 * names. A 500 either way; before the branch it was the filter's anonymous
 * « Internal Server Error », which the screen could only call a server error.
 */
describe("mapTransactionWriteError — TransferPropagationDidNotSettleError", () => {
  let emitted: string[];
  let restoreLogger: () => void;

  beforeEach(() => {
    emitted = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        emitted.push(chunk.toString("utf8"));
        callback();
      },
    });
    restoreLogger = setRootLoggerForTest(createLogger({ destination, level: "debug" }));
  });

  afterEach(() => {
    restoreLogger();
  });

  it("-> 500 TRANSFER_PROPAGATION_DID_NOT_SETTLE, no internal detail in the body, the error logged", () => {
    const tenantId = "00000000-0000-7000-8000-0000000000d6";
    const result = mapped(new TransferPropagationDidNotSettleError(tenantId, 3));

    expect(result.status).toBe(500);
    expect(result.code).toBe("TRANSFER_PROPAGATION_DID_NOT_SETTLE");
    expect(result.detail).toBeUndefined();

    // A mapped `HttpException` skips the filter's own 500 log line, so the
    // mapper has to write it — or the operator never learns the invariant broke.
    const lines = emitted
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const logged = lines.find((line) => line["msg"] === "transfer propagation did not settle");
    expect(logged, emitted.join("")).toBeDefined();
    expect(logged!["level"]).toBe("error");
    expect(JSON.stringify(logged!["error"])).toContain(tenantId);
  });
});

describe("mapTransactionWriteError — anything else", () => {
  /**
   * The negative companion for the whole file: something the mapper does
   * **not** recognise comes back unchanged, so every `toBeInstanceOf(
   * HttpException)` above is a real narrowing and not a property of the
   * function.
   */
  it("an unrecognised error is returned unchanged — this mapper narrows, it never swallows", () => {
    const err = new Error("something else entirely");

    expect(mapTransactionWriteError(err)).toBe(err);
  });
});
