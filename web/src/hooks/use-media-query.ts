import { useEffect, useState } from "react";

/**
 * Tracks a CSS media query via `window.matchMedia` — F5 (security review,
 * T-45, LOW): before this hook, `HoldingsRoute.tsx` mounted *both*
 * `HoldingsTable` (desktop) and `HoldingsCardList` (mobile) unconditionally,
 * one merely hidden via CSS (`hidden lg:block`/`lg:hidden`). Below the `lg`
 * breakpoint, every holding's realized-gain list — Radix `Tooltip`
 * components via `<Figure>` — was still fully mounted inside the
 * *invisible* desktop table, quietly defeating `HoldingsTable`'s own
 * virtualization (its entire point is to cap how many rows exist in the DOM
 * at once; this data's own bounds are ~10^6 rows/gains). `HoldingsRoute.tsx`
 * now mounts exactly one of the two trees, gated on this hook.
 *
 * Same race-safety shape as `use-online-status.ts`'s own fix: the `useState`
 * initializer's one-time read is re-synced as the very first thing the
 * effect does, closing the window between first render and the effect
 * actually attaching its own `change` listener.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mediaQueryList = window.matchMedia(query);
    setMatches(mediaQueryList.matches);
    const handleChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    mediaQueryList.addEventListener("change", handleChange);
    return () => mediaQueryList.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}

/** Tailwind's `lg` breakpoint (1024px) — the same threshold `HoldingsTable`/`HoldingsCardList`'s own (now-redundant-but-harmless) CSS classes target. */
export const DESKTOP_BREAKPOINT_QUERY = "(min-width: 1024px)";

/**
 * Tailwind's `sm` breakpoint (640px) — UR-24/UR-25's
 * nav rail/tab-bar switch (rail from `640px` up,
 * fixed bottom tab bar below it). `PrimaryNav`/`MobileTabBar` each mount
 * exclusively on one side of this query — the same "exactly one of the two
 * trees, gated on `useMediaQuery`, never both with one CSS-hidden" rule
 * `DESKTOP_BREAKPOINT_QUERY`'s own callers (`HoldingsRoute`, `ActivityView`,
 * `PortfolioDetailView`) already follow.
 */
export const TABLET_BREAKPOINT_QUERY = "(min-width: 640px)";
