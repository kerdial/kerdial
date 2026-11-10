import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDecimalString } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import { formatAmount, formatInputAmount, tryFormatAmount } from "./figure-format.js";

/**
 * The numeral conventions, enforced rather than
 * documented.
 *
 * Two rules, and both fail silently if nothing checks them: a hyphen instead
 * of a true minus looks almost right, and a missing `.k-num` only shows up as
 * a column that jitters when a price ticks — neither produces an error, a
 * failing render, or anything a reviewer reliably catches by eye.
 */
const MINUS = "−"; // U+2212 MINUS SIGN
const HYPHEN = "-"; // U+002D HYPHEN-MINUS
const NBSP = "\u202f"; // U+202F NARROW NO-BREAK SPACE, the thousands separator

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, "..");

/** Every `.tsx` under `web/src`, tests excluded. */
function componentSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
        out.push({ file: full.slice(webSrc.length + 1), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(webSrc);
  return out;
}

describe("true minus", () => {
  it("renders U+2212, not an ASCII hyphen, for every formatter kind", () => {
    expect(formatAmount("monetary", parseDecimalString("-1234.50"), 2)).toBe(
      `${MINUS}1${NBSP}234.50`,
    );
    expect(formatAmount("quantity", parseDecimalString("-42.5"), 0)).toBe(`${MINUS}42.5`);
    expect(formatAmount("percentage", parseDecimalString("-0.0184"), 0)).toBe(`${MINUS}1.84%`);
    expect(formatAmount("fxRate", parseDecimalString("-1.0876"), 0)).toBe(`${MINUS}1.087600`);
  });

  it("leaves positives, zero and the placeholder untouched", () => {
    expect(formatAmount("monetary", parseDecimalString("1234.50"), 2)).toBe(`1${NBSP}234.50`);
    expect(formatAmount("monetary", parseDecimalString("0"), 2)).toBe("0.00");
    expect(tryFormatAmount("monetary", "not-a-number", 2)).toBeUndefined();
  });

  it("substitutes only the leading sign", () => {
    // A hyphen anywhere else would be a formatter bug, not a glyph to rewrite.
    const formatted = formatAmount("monetary", parseDecimalString("-1000000.00"), 2);
    expect(formatted.indexOf(MINUS)).toBe(0);
    expect(formatted.slice(1)).not.toContain(MINUS);
    expect(formatted).not.toContain(HYPHEN);
  });

  it("keeps the display substitution out of the wire round trip", () => {
    // The reason `toDisplayMinus` lives in web's `figure-format.ts` and not in
    // `@kerdial/core-decimal`: the shared formatters also produce values the
    // API serialises, and `parseDecimalString` cannot read its own output back
    // if a U+2212 gets into it. This asserts the boundary is where we say it is.
    const display = formatAmount("monetary", parseDecimalString("-50.00"), 2);
    expect(() => parseDecimalString(display)).toThrow();
    expect(() => parseDecimalString("-50.00")).not.toThrow();
  });
});

describe("tabular figures", () => {
  it("has no component reaching for Tailwind's tabular-nums instead of .k-num", () => {
    // `tabular-nums` gives tabular figures but not the slashed zero or the
    // `ss01` feature the token file's `.k-num` turns on together — so the two
    // are not interchangeable, and the near-miss is the likely mistake.
    const offenders = componentSources()
      .filter(({ text }) => /\btabular-nums\b/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("keeps every figure renderer on the .k-num class", () => {
    // `<Figure>` and `<LedgerAmount>` are the two renderers every money and
    // quantity value in the UI passes through (`Figure.tsx`'s own header, and
    // `figure-format-sole-importer.test.ts` for the formatting half).
    for (const name of ["components/Figure.tsx", "components/LedgerAmount.tsx"]) {
      const source = componentSources().find(({ file }) => file === name);
      expect(source, `${name} not found`).toBeDefined();
      expect(source!.text, `${name} lost its .k-num class`).toContain("k-num");
    }
  });
});

describe("thousands grouping — « €128,430.12 », in French typography", () => {
  it("groups the integer part of money and quantities in threes with U+202F", () => {
    expect(formatAmount("monetary", parseDecimalString("62362.64"), 2)).toBe(`62${NBSP}362.64`);
    expect(formatAmount("monetary", parseDecimalString("1234567.891"), 2)).toBe(
      `1${NBSP}234${NBSP}567.89`,
    );
    expect(formatAmount("monetary", parseDecimalString("-125000.5"), 2)).toBe(
      `${MINUS}125${NBSP}000.50`,
    );
    expect(formatAmount("quantity", parseDecimalString("150000"), 0)).toBe(`150${NBSP}000`);
  });

  it("leaves three-digit integers, the fraction, percentages and FX rates untouched", () => {
    expect(formatAmount("monetary", parseDecimalString("999.99"), 2)).toBe("999.99");
    expect(formatAmount("monetary", parseDecimalString("1000.12345"), 5)).toBe(`1${NBSP}000.12345`);
    expect(formatAmount("percentage", parseDecimalString("12.3456"), 0)).toBe("1234.56%");
    expect(formatAmount("fxRate", parseDecimalString("1234.5678"), 0)).toBe("1234.567800");
  });

  it("never uses a plain space or a comma as the separator", () => {
    const formatted = formatAmount("monetary", parseDecimalString("1234567.89"), 2);
    expect(formatted).not.toMatch(/[ ,]/);
  });
});

describe("formatInputAmount — a computed amount written into a form field", () => {
  it("keeps the wire form: no grouping, no comma, the scale's trailing zeros", () => {
    const formatted = formatInputAmount(parseDecimalString("1234.5"), 2);
    expect(formatted).toBe("1234.50");
    expect(formatted).not.toContain(NBSP);
    expect(formatted).not.toContain(",");
    expect(formatInputAmount(parseDecimalString("2"), 2)).toBe("2.00");
  });

  it("rounds half-up and keeps an ASCII minus, so the field value parses back", () => {
    expect(formatInputAmount(parseDecimalString("0.125"), 2)).toBe("0.13");
    const negative = formatInputAmount(parseDecimalString("-1234.5"), 2);
    expect(negative).toBe("-1234.50");
    expect(() => parseDecimalString(negative)).not.toThrow();
  });
});
