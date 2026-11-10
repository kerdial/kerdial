import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client.js";
import {
  MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES,
  MANUAL_PRICE_POINT_TENANT_ROW_CAP,
  MAX_DIVIDEND_INSTRUMENTS_PER_VIEW,
  MAX_HOLDINGS_PER_VIEW,
  MAX_PORTFOLIOS_PER_TENANT,
  MAX_REALIZED_GAINS_PER_HOLDING,
} from "./api-limits.js";
import { MESSAGE_TABLE, messageForError } from "./problem-messages.js";

/**
 * UR-6 acceptance criteria, verified one-to-one
 * below.
 */

function problem(status: number, code?: string): ApiError {
  return new ApiError(status, code === undefined ? undefined : { code });
}

/**
 * Hardcoded straight from FR-110/FR-113/FR-122's literal code lists,
 * plus `TRANSACTION_FX_LEG_IMMUTABLE`. Deliberately **not** derived from
 * `MESSAGE_TABLE` (`Object.keys(MESSAGE_TABLE)` would make this assertion
 * vacuous — a map that silently lost an entry would still "cover" a list
 * generated from its own remaining keys) and deliberately not imported from
 * `problem-messages.ts` either, so this list can only ever agree with the
 * module by both sides independently matching the spec, not by construction.
 */
const FR_COVERED_CODES = [
  // FR-110
  "TRANSACTION_INSUFFICIENT_QUANTITY",
  "TRANSACTION_FX_EDIT_FORBIDDEN",
  "TRANSACTION_EDIT_EMPTY",
  "TRANSACTION_GROSS_AMOUNT_NOT_EDITABLE",
  "TRANSACTION_UNIT_PRICE_NOT_EDITABLE",
  "TRANSACTION_SELF_SETTLED",
  "TRANSACTION_INVALID_SHAPE",
  "TRANSACTION_AMOUNT_NOT_POSITIVE",
  "TRANSACTION_EDIT_NOT_EXPRESSIBLE",
  // FR-113
  "MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED",
  "MANUAL_PRICE_POINT_SCALE_EXCEEDED",
  // FR-122
  "VALUATION_PRICE_UNAVAILABLE",
  "VALUATION_FX_RATE_UNAVAILABLE",
  "VALUATION_RESPONSE_TOO_LARGE",
  // The stated superset
  "TRANSACTION_FX_LEG_IMMUTABLE",
  // The five the fee-tax-breakdown cycle added. Listed here for
  // the same reason as everything above: the cycle shipped five new server
  // codes and this table learned none of them, so each fell through to a
  // status-class default — and on `TransactionForm`, which rendered
  // `problem.detail` directly, straight onto the screen in English.
  "CASH_AMOUNT_REQUIRED",
  "CASH_AMOUNT_NOT_ACCEPTED",
  "CASH_AMOUNT_STALE",
  "COST_COMPONENTS_INVALID",
  "IMPLIED_SETTLEMENT_RATE_OUT_OF_RANGE",
  // The two the dividend-screen cycle added, for the same
  // reason as the five above: `GET /dividends/summary` can answer with either,
  // and neither was mapped — so the Dividendes screen rendered the 422
  // status-class default on its own all-time default view.
  "DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE",
  "DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG",
  // The one `GET /transactions` gained with its amount filters.
  // Listed here on the same principle: the cycle that ships a server code is
  // the cycle that teaches this table to speak it, rather than leaving it to
  // the 422 status-class default — « Cette opération n'a pas pu aboutir. »,
  // which says nothing about the parameter that is missing.
  "TRANSACTION_AMOUNT_FILTER_REQUIRES_CURRENCY",
  // The one added later, for the same reason as every code above it:
  // `PATCH /transactions/:id` can now answer with it, and an unmapped code
  // falls through to the 422 status default — « Cette opération n'a pas pu
  // aboutir. » — which says nothing the user could act on.
  "TRANSACTION_SHARE_DISTRIBUTION_INVALID_SHAPE",
  // The seven `instrument-icons` IK7 added (FR-292–FR-294, FR-302, FR-315),
  // for the same reason as every group above: `PUT /instruments/:id/icon`
  // answers with each of them, and an unmapped code degrades to a status-class
  // default — which for the four 422s is « Cette opération n'a pas pu
  // aboutir. », a sentence that tells someone who just picked a GIF nothing
  // about why. `INSTRUMENT_ICON_NOT_FOUND` is deliberately **not** here: it is
  // the read route's answer and is handled by the `<img>`'s own `onError`
  // fallback, never by this mapper.
  "INSTRUMENT_ICON_MALFORMED_BASE64",
  "INSTRUMENT_ICON_TOO_LARGE",
  "INSTRUMENT_ICON_UNSUPPORTED_FORMAT",
  "INSTRUMENT_ICON_UNREADABLE",
  "INSTRUMENT_ICON_TYPE_MISMATCH",
  "INSTRUMENT_ICON_DIMENSIONS_EXCEEDED",
  "INSTRUMENT_ICON_TENANT_CAP_EXCEEDED",
  // The five `security-transfer` added (TR-19): the create,
  // edit and FX-correction routes answer with each of them.
  "TRANSFER_DESTINATION_IS_SOURCE",
  "TRANSFER_DESTINATION_NOT_FOUND",
  "TRANSACTION_TRANSFER_IN_NOT_CREATABLE",
  "TRANSACTION_TRANSFER_TARGET_READ_ONLY",
  "TRANSACTION_TRANSFER_INVALID_SHAPE",
  // The propagation's named internal failure — a 500 that would
  // otherwise read as the generic server-error copy.
  "TRANSFER_PROPAGATION_DID_NOT_SETTLE",
] as const;

/**
 * Deliberately conservative: only unambiguous English functional/technical
 * words that would appear in a raw English error dump but that idiomatic
 * French copy never produces by coincidence. Short, collision-prone
 * "words" that are also common French tokens (e.g. "a"/"an"/"on"/"in"/"of"/
 * "or"/"at"/"by"/"it"/"no"/"so") are deliberately excluded — including them
 * would make this list itself false-positive against ordinary French
 * sentences ("on ne peut pas...", "il n'y a pas...") the same way a banned
 * SQL type name matched inside "Brazilian Real" data before that gate
 * learned to mask string literals. Every word below is checked at a word
 * boundary, case-insensitively, against ASCII text only.
 */
const ENGLISH_STOP_WORDS = [
  "the",
  "and",
  "is",
  "are",
  "was",
  "were",
  "this",
  "that",
  "these",
  "those",
  "have",
  "has",
  "had",
  "will",
  "would",
  "should",
  "could",
  "must",
  "cannot",
  "for",
  "with",
  "from",
  "into",
  "about",
  "please",
  "error",
  "invalid",
  "exceeded",
  "limit",
  "request",
  "requests",
  "server",
  "internal",
  "failed",
  "unable",
  "allowed",
  "concurrent",
  "tenant",
  "detail",
  "title",
];

function containsAsciiOnlyEnglishStopWord(text: string): boolean {
  return ENGLISH_STOP_WORDS.some((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
}

describe("problem-messages.ts — coverage over FR-110/FR-113/FR-122 (+ TRANSACTION_FX_LEG_IMMUTABLE)", () => {
  it.each(FR_COVERED_CODES)("MESSAGE_TABLE contains a well-formed French entry for %s", (code) => {
    const entry = MESSAGE_TABLE[code];
    expect(entry).toBeDefined();
    expect(entry!.text.length).toBeGreaterThan(0);
    expect(containsAsciiOnlyEnglishStopWord(entry!.text)).toBe(false);
  });

  // Discrimination proof for the stop-word list itself: an actual English
  // raw-dump-style sentence must be caught, so the check above is not
  // vacuously always-false.
  it("the stop-word check itself fires on a genuine English sentence", () => {
    expect(
      containsAsciiOnlyEnglishStopWord("The request failed on the server and cannot be retried."),
    ).toBe(true);
  });

  // And it must not false-positive on ordinary French copy carrying short
  // English-look-alike tokens ("on", "a", "car") — the "Brazilian Real"
  // class of false match.
  it("the stop-word check does not false-positive on ordinary French copy", () => {
    expect(
      containsAsciiOnlyEnglishStopWord(
        "On ne peut pas modifier ce montant, car il n'y a pas de droit d'édition.",
      ),
    ).toBe(false);
  });
});

describe("messageForError — resolution order is code-first (FR-122)", () => {
  it("MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED (a 429) reads as a capacity message, not a throttle message", () => {
    const msg = messageForError(problem(429, "MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED"));
    expect(msg.text).not.toMatch(/requête/i);
    expect(msg.text).not.toMatch(/limite de requêtes/i);
    expect(msg.text).toBe(MESSAGE_TABLE.MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED!.text);
  });

  it("a genuine 429 with no mapped code (or an unmapped code) does fall back to the throttle-shaped status default", () => {
    const msg = messageForError(problem(429, "SOME_UNMAPPED_429_CODE"));
    expect(msg.text).toBe("Trop de requêtes simultanées. Patientez un instant puis réessayez.");
  });

  /**
   * Security confirm, F7. The Kerdial import routes' 429 shipped
   * with no entry, so a user who made **one** request was told they had made too
   * many — the status default above — and the actual remedy (another import is
   * running; wait for it) was never said.
   */
  it("KERDIAL_IMPORT_THROTTLED names the import in flight rather than the caller's own request rate", () => {
    const msg = messageForError(problem(429, "KERDIAL_IMPORT_THROTTLED"));

    expect(msg.text).not.toBe("Trop de requêtes simultanées. Patientez un instant puis réessayez.");
    expect(msg.text).toContain("import");
    expect(msg.tone).toBe("warning");
  });

  /**
   * DV11's refusal is **permanent**: a stored dividend carries
   * a `fee_amount`, so the server cannot tell withholding from transaction
   * cost, and no amount of waiting changes that. Until this fix it rendered as
   * « Cette opération n'a pas pu aboutir. » — the 422 default — on the
   * Dividendes screen's default view, which says nothing a user could act on.
   */
  it("DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG reads as a data problem to correct, not as the 422 default", () => {
    const msg = messageForError(problem(422, "DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG"));
    expect(msg.text).toBe(MESSAGE_TABLE.DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG!.text);
    expect(msg.text).not.toBe(messageForError(problem(422, "SOME_UNMAPPED_422_CODE")).text);
    // It says the data must be corrected — the one thing that resolves it.
    expect(msg.text).toMatch(/corrig/i);
    expect(msg.tone).toBe("error");
  });

  /**
   * The edit path's refusal of a malformed cashless
   * distribution. It must not read as `TRANSACTION_INVALID_SHAPE`'s
   * « informations incohérentes »: the price or account the user supplied is
   * perfectly coherent, it simply belongs to a kind this row is not.
   */
  it("TRANSACTION_SHARE_DISTRIBUTION_INVALID_SHAPE names the kind, and is neither the 422 default nor the incoherence message", () => {
    const msg = messageForError(problem(422, "TRANSACTION_SHARE_DISTRIBUTION_INVALID_SHAPE"));
    expect(msg.text).toBe(MESSAGE_TABLE.TRANSACTION_SHARE_DISTRIBUTION_INVALID_SHAPE!.text);
    expect(msg.text).not.toBe(messageForError(problem(422, "SOME_UNMAPPED_422_CODE")).text);
    expect(msg.text).not.toBe(MESSAGE_TABLE.TRANSACTION_INVALID_SHAPE!.text);
    // It names what the kind is, in the user's own vocabulary — the code's
    // `SHARE_DISTRIBUTION` never reaches the screen.
    expect(msg.text).toMatch(/actions gratuites/i);
    expect(msg.text).not.toMatch(/SHARE_DISTRIBUTION/);
    expect(msg.tone).toBe("error");
  });
});

/**
 * `security-transfer` TR-19: the five transfer codes. `detail` is
 * never rendered, so each sentence must stand alone — and none may leak the
 * wire vocabulary it was raised in.
 */
describe("messageForError — the five security-transfer codes (TR-19)", () => {
  const TRANSFER_CODES = [
    [400, "TRANSFER_DESTINATION_IS_SOURCE"],
    [404, "TRANSFER_DESTINATION_NOT_FOUND"],
    [400, "TRANSACTION_TRANSFER_IN_NOT_CREATABLE"],
    [422, "TRANSACTION_TRANSFER_TARGET_READ_ONLY"],
    [422, "TRANSACTION_TRANSFER_INVALID_SHAPE"],
    [500, "TRANSFER_PROPAGATION_DID_NOT_SETTLE"],
  ] as const;
  /** Every raw kind label the ledger stores, the transfer pair first among them. */
  const RAW_KIND_LABELS = [
    "TRANSFER_OUT",
    "TRANSFER_IN",
    "SHARE_DISTRIBUTION",
    "CURRENCY_EXCHANGE",
    "WITHDRAWAL",
    "DEPOSIT",
    "DIVIDEND",
    "DRIP",
    "BUY",
    "SELL",
  ];

  it.each(TRANSFER_CODES)(
    "%i %s reads as its own sentence, with no raw kind label in it",
    (status, code) => {
      const msg = messageForError(problem(status, code));
      expect(msg.text).toBe(MESSAGE_TABLE[code]!.text);
      expect(msg.text).not.toBe(messageForError(problem(status, "SOME_UNMAPPED_CODE")).text);
      for (const label of RAW_KIND_LABELS) {
        expect(msg.text, label).not.toMatch(new RegExp(`\\b${label}\\b`));
      }
      expect(msg.tone).toBe("error");
    },
  );

  it("the destination refusals are two different sentences — « not yours » is never told apart from « not there »", () => {
    expect(MESSAGE_TABLE.TRANSFER_DESTINATION_IS_SOURCE!.text).not.toBe(
      MESSAGE_TABLE.TRANSFER_DESTINATION_NOT_FOUND!.text,
    );
    expect(MESSAGE_TABLE.TRANSFER_DESTINATION_NOT_FOUND!.text).toMatch(/introuvable/);
  });
});

describe("messageForError — cap numbers are sourced from api-limits.ts, never hardcoded (OD-6)", () => {
  it("MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED's message contains the French-locale-formatted row cap", () => {
    const msg = messageForError(problem(429, "MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED"));
    expect(msg.text).toContain(
      new Intl.NumberFormat("fr-FR").format(MANUAL_PRICE_POINT_TENANT_ROW_CAP),
    );
  });

  it("MANUAL_PRICE_POINT_SCALE_EXCEEDED's message contains the decimal-places cap", () => {
    const msg = messageForError(problem(400, "MANUAL_PRICE_POINT_SCALE_EXCEEDED"));
    expect(msg.text).toContain(
      new Intl.NumberFormat("fr-FR").format(MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES),
    );
  });

  it("VALUATION_RESPONSE_TOO_LARGE's message contains both holdings and realized-gains caps", () => {
    const msg = messageForError(problem(422, "VALUATION_RESPONSE_TOO_LARGE"));
    expect(msg.text).toContain(new Intl.NumberFormat("fr-FR").format(MAX_HOLDINGS_PER_VIEW));
    expect(msg.text).toContain(
      new Intl.NumberFormat("fr-FR").format(MAX_REALIZED_GAINS_PER_HOLDING),
    );
  });

  it("PORTFOLIO_TENANT_CAP_EXCEEDED's message contains the portfolio cap", () => {
    const msg = messageForError(problem(409, "PORTFOLIO_TENANT_CAP_EXCEEDED"));
    expect(msg.text).toContain(new Intl.NumberFormat("fr-FR").format(MAX_PORTFOLIOS_PER_TENANT));
  });

  /**
   * `MAX_HOLDINGS_PER_VIEW`, `MAX_REALIZED_GAINS_PER_HOLDING` and
   * `MAX_DIVIDEND_INSTRUMENTS_PER_VIEW` are all 1 000 today, so "the message
   * contains 1 000" could not tell the dividend cap from the holdings one —
   * a `DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE` entry that wrongly interpolated
   * `MAX_HOLDINGS_PER_VIEW` would pass such an assertion. Mutating the one
   * constant in a scratch module graph can tell them apart: only the dividend
   * message moves.
   */
  it("regenerates the dividend-cap message from a scratch-mutated MAX_DIVIDEND_INSTRUMENTS_PER_VIEW, leaving the holdings message alone", async () => {
    vi.resetModules();
    vi.doMock("./api-limits.js", async () => {
      const actual = await vi.importActual<typeof import("./api-limits.js")>("./api-limits.js");
      return { ...actual, MAX_DIVIDEND_INSTRUMENTS_PER_VIEW: 123_456 };
    });

    const { messageForError: scratchMessageForError } = await import("./problem-messages.js");
    const { ApiError: ScratchApiError } = await import("./api-client.js");
    const dividend = scratchMessageForError(
      new ScratchApiError(422, { code: "DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE" }),
    );
    const valuation = scratchMessageForError(
      new ScratchApiError(422, { code: "VALUATION_RESPONSE_TOO_LARGE" }),
    );

    expect(dividend.text).toContain(new Intl.NumberFormat("fr-FR").format(123_456));
    expect(valuation.text).not.toContain(new Intl.NumberFormat("fr-FR").format(123_456));
    expect(valuation.text).toContain(new Intl.NumberFormat("fr-FR").format(MAX_HOLDINGS_PER_VIEW));

    vi.doUnmock("./api-limits.js");
    vi.resetModules();
  });

  it("DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE's message contains the instrument cap", () => {
    const msg = messageForError(problem(422, "DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE"));
    expect(msg.text).toContain(
      new Intl.NumberFormat("fr-FR").format(MAX_DIVIDEND_INSTRUMENTS_PER_VIEW),
    );
  });

  // The load-bearing proof (not merely "this number happens to be right
  // today"): mutate the mirrored constant in a scratch copy of the module
  // graph (vi.doMock) and observe the *rendered message* regenerate from the
  // new value — proving genuine interpolation, not a literal that happens to
  // equal the real cap.
  it("regenerates the cap-exceeded message from a scratch-mutated api-limits.ts constant", async () => {
    vi.resetModules();
    vi.doMock("./api-limits.js", async () => {
      const actual = await vi.importActual<typeof import("./api-limits.js")>("./api-limits.js");
      return { ...actual, MANUAL_PRICE_POINT_TENANT_ROW_CAP: 123_456 };
    });

    const { messageForError: scratchMessageForError } = await import("./problem-messages.js");
    const { ApiError: ScratchApiError } = await import("./api-client.js");
    const scratchMsg = scratchMessageForError(
      new ScratchApiError(429, { code: "MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED" }),
    );

    expect(scratchMsg.text).toContain(new Intl.NumberFormat("fr-FR").format(123_456));
    expect(scratchMsg.text).not.toContain(new Intl.NumberFormat("fr-FR").format(500_000));

    vi.doUnmock("./api-limits.js");
    vi.resetModules();
  });
});

describe("messageForError — the server's detail/title is never rendered", () => {
  it("ignores an ApiError's message (built from title/detail) for a mapped code", () => {
    const err = new ApiError(409, {
      code: "TRANSACTION_INSUFFICIENT_QUANTITY",
      title: "Conflict",
      detail: "at most 2 concurrent /portfolios valuation read(s) per tenant are allowed",
    });
    const msg = messageForError(err);
    expect(msg.text).not.toContain("at most 2 concurrent");
    expect(msg.text).not.toContain(err.message);
  });
});

describe("messageForError — unmapped codes warn once in DEV and never in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("triggers exactly one console.warn naming the unmapped code, in DEV", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    messageForError(problem(400, "SOME_BRAND_NEW_SERVER_CODE"));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({ code: "SOME_BRAND_NEW_SERVER_CODE" });
  });

  it("stays silent for an unmapped code when DEV is false (production build)", () => {
    vi.stubEnv("DEV", false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    messageForError(problem(400, "SOME_BRAND_NEW_SERVER_CODE"));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("messageForError — offline and generic fallback (steps 3-4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the offline message for a non-ApiError thrown while navigator.onLine is false", () => {
    vi.stubGlobal("navigator", { onLine: false });
    const msg = messageForError(new TypeError("Failed to fetch"));
    expect(msg.text).toBe("Hors ligne — cette action nécessite une connexion.");
  });

  it("returns the generic fallback for a non-ApiError thrown while online", () => {
    vi.stubGlobal("navigator", { onLine: true });
    const msg = messageForError(new TypeError("boom"));
    expect(msg.text).toBe("Une erreur inattendue s'est produite. Réessayez.");
  });
});

describe("messageForError — problem extension members make a message specific", () => {
  it("names the pair and the date for a missing valuation FX rate, instead of the table's fixed sentence", () => {
    const message = messageForError(
      new ApiError(422, {
        code: "VALUATION_FX_RATE_UNAVAILABLE",
        params: { currency: "USD", valuationDate: "2026-03-12" },
      }),
    );
    expect(message.text).toContain("USD");
    expect(message.text).toContain("EUR");
    expect(message.text).toContain("12/03/2026");
    // Says where rates come from, so "not available" is not the whole answer.
    expect(message.text).toContain("BCE");
    // The negative half: the vague table sentence is NOT what came back.
    expect(message.text).not.toBe(
      "Le taux de change nécessaire à cette valorisation n'est pas disponible pour le moment.",
    );
    expect(message.tone).toBe("warning");
  });

  it("falls back to the table's sentence when the server sent no extension members", () => {
    // The positive companion to the test above: the specific path is reached
    // *because of* the members, not because the code changed. Without them the
    // shipped generic copy is still what a user sees — never nothing.
    const message = messageForError(new ApiError(422, { code: "VALUATION_FX_RATE_UNAVAILABLE" }));
    expect(message.text).toBe(
      "Le taux de change nécessaire à cette valorisation n'est pas disponible pour le moment.",
    );
  });

  it("names the date and the manual-price remedy for a missing valuation price", () => {
    const message = messageForError(
      new ApiError(422, {
        code: "VALUATION_PRICE_UNAVAILABLE",
        params: { valuationDate: "2026-03-12" },
      }),
    );
    expect(message.text).toContain("12/03/2026");
    expect(message.text).toContain("manuellement");
  });

  it("ignores extension members of the wrong type rather than rendering them", () => {
    // `params` is server-shaped data; a number where a currency code belongs
    // must not reach the sentence. It falls back, it does not interpolate.
    const message = messageForError(
      new ApiError(422, {
        code: "VALUATION_FX_RATE_UNAVAILABLE",
        params: { currency: 42 },
      }),
    );
    expect(message.text).toBe(
      "Le taux de change nécessaire à cette valorisation n'est pas disponible pour le moment.",
    );
  });
});
