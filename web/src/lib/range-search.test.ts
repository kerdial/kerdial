import { describe, expect, it, vi } from "vitest";
import { rangeSearchControl, type RangeSearch } from "./range-search.js";
import { CUSTOM_RANGE_ID, resolvePresetRange } from "./period-presets.js";

const TODAY = "2026-09-18";

/**
 * The navigation half of a custom window, which is where the failure
 * that matters lives: «Perso.» must change which control is lit and not a
 * single figure.
 */
describe("rangeSearchControl", () => {
  it("resolves a preset window and offers the custom props beside it", () => {
    const { resolved, custom } = rangeSearchControl({ range: "3M" }, vi.fn(), TODAY);
    expect(resolved).toEqual(resolvePresetRange("3M", TODAY));
    expect(custom.from).toBeUndefined();
    expect(custom.to).toBeUndefined();
  });

  it("opening «Perso.» seeds the URL with the window already on screen", () => {
    // The bug this prevents: writing `range=CUSTOM` with no bounds resolves to
    // the *default* preset, so a reader on MAX would click «Perso.» and watch
    // a 25-year chart become a 1-year one.
    const navigate = vi.fn<(next: RangeSearch) => void>();
    const { custom } = rangeSearchControl({ range: "MAX" }, navigate, TODAY);
    custom.onOpen();
    expect(navigate).toHaveBeenCalledWith({
      range: CUSTOM_RANGE_ID,
      ...resolvePresetRange("MAX", TODAY),
    });
  });

  it("the seeded window resolves to exactly the window it replaced", () => {
    const navigate = vi.fn<(next: RangeSearch) => void>();
    rangeSearchControl({ range: "MAX" }, navigate, TODAY).custom.onOpen();
    const seeded = navigate.mock.calls[0]?.[0] as RangeSearch;
    expect(rangeSearchControl(seeded, vi.fn(), TODAY).resolved).toEqual(
      resolvePresetRange("MAX", TODAY),
    );
  });

  it("editing a bound writes the whole triple, never a patch", () => {
    const navigate = vi.fn<(next: RangeSearch) => void>();
    const { custom } = rangeSearchControl(
      { range: CUSTOM_RANGE_ID, from: "2019-11-08", to: "2020-02-14" },
      navigate,
      TODAY,
    );
    custom.onChange({ from: "2019-11-08", to: "2021-06-18" });
    expect(navigate).toHaveBeenCalledWith({
      range: CUSTOM_RANGE_ID,
      from: "2019-11-08",
      to: "2021-06-18",
    });
  });

  it("keeps an out-of-bounds URL window in the fields while querying the fallback", () => {
    // Both halves matter: the reader must still see what they typed (so they
    // can fix it), and no request may go out for a window the server would
    // 400.
    const search = { range: CUSTOM_RANGE_ID, from: "2026-01-01", to: "2099-01-01" };
    const { resolved, custom } = rangeSearchControl(search, vi.fn(), TODAY);
    expect(custom.from).toBe("2026-01-01");
    expect(custom.to).toBe("2099-01-01");
    expect(resolved).toEqual(resolvePresetRange("1Y", TODAY));
  });
});
