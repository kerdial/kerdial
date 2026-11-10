import type { IconName } from "./components/ui/Icon.js";

/**
 * The single source of truth for the shell's navigation — rendered by
 * `SideNav` (the persistent rail, `>=640px`) and `MobileNav` (the `<640px`
 * drawer) from this exact same data. The architecture rule is "no separate
 * mobile routes and no feature gating by viewport" — sharing one source is
 * what makes that a structural guarantee (AC30's parity precondition) rather
 * than a convention two independent implementations could drift out of sync
 * with.
 *
 * The two sections of three become **three sections**,
 * adopting the Kerdial design's own taxonomy — "Vue d'ensemble",
 * "Investissements", "Données et administration" (the handoff's
 * information architecture). The design's grouping has eight destinations;
 * seven ship: Price & valuation was dropped outright (no read exists
 * that it could show which Instruments or Contrôles does not), and Performance
 * arrived later. The destination set is now complete.
 *
 * The design's "no single-item section, and no taxonomy the data does
 * not support" still holds: every section has two, and every heading names
 * something the destinations actually share.
 *
 * UR-24/UR-25: the flat list became **sectioned** — while `NAV_ITEMS`
 * stays exported as the exact same flat shape it always was, now **derived**
 * (`NAV_SECTIONS.flatMap(...)`) rather than declared directly. This is what
 * lets `nav-helpers.ts`/`responsive-nav.spec.ts`/`mobile-parity.spec.ts`/
 * `tester-full-journey.spec.ts` keep passing unmodified against six
 * destinations instead of four — the guarantee is strengthened, not
 * rewritten.
 *
 * A review (2026-08-17) renamed `Opérations` → `Contrôles`
 * (`/operations` → `/controls`) — "Opérations" collides with "Activité" in a
 * product where transactions are literally operations, and it invites the
 * audit-log reading FR-123/AC115 forbid. FR-95's binding requirement is the
 * **destination set**, not the labels, so the locked FR is preserved.
 *
 * **UR-26..UR-28 flipped `/instruments` live** (an earlier slice): the route
 * exists (`InstrumentsRoute.tsx`, `router.tsx`), so its `disabledReason` was
 * removed and it renders as a real `<Link>` on every surface.
 *
 * **csv-import OD-11(a) adds an eighth destination, `/import`**, to "Données
 * et administration" (2 -> 3). Three constraints, all read from this file
 * rather than assumed: the section is *grown*, never a new one-item section;
 * `RoutedNavPath` gains it while `PendingNavPath` stays `never`, so the nav
 * entry and the live route land in the same commit (the "zero disabled
 * destinations" assertion below turns red on a staged split); and
 * `MOBILE_TAB_PATHS` is untouched — an import is desk work, and it reaches
 * the mobile drawer (which renders every destination) without displacing a
 * tab.
 *
 * **A ninth destination, `/currencies` (Devises), was added** to
 * "Données et administration" (3 -> 4) — the same three constraints the import
 * addition below records apply and are met: the section grows rather than a new
 * one-item section being opened, `RoutedNavPath` gains it in the same commit as
 * the live route (so the "zero disabled destinations" assertion stays green),
 * and `MOBILE_TAB_PATHS` is untouched.
 *
 * **`dividend-screen` LD-9 adds a tenth destination, `/dividends` (Dividendes)**,
 * to "Investissements" (3 -> 4). The same three constraints this file already
 * records for `/import` and `/currencies` apply and are met: the section is
 * *grown* rather than a one-item section being opened; `RoutedNavPath` gains it
 * in the same commit as the live route, so the "zero disabled destinations"
 * assertion stays green; and `MOBILE_TAB_PATHS` is **untouched** — this is a
 * review surface, not a one-handed one, and it reaches the mobile drawer
 * (which renders every destination) without displacing a tab. It sits in
 * "Investissements" rather than "Données et administration" because it reports
 * on the positions themselves, the same reading that put Performance there.
 *
 * **`watchlist` LD-4/UR-47 adds an eleventh destination, `/watchlist`
 * (Suivi)**, to "Investissements" (4 -> 5) — the same three constraints again,
 * met the same way: the section grows rather than a one-item section being
 * opened, `RoutedNavPath` gains it in the same commit as the live route, and
 * `MOBILE_TAB_PATHS` is **untouched**. Its glyph is `eye`, the same verb
 * `<WatchToggle>` carries; it was already in the registry and used by no nav
 * item.
 *
 * **UR-30..UR-32 (this slice) flip `/controls` live**: `ControlsRoute.tsx`/
 * `router.tsx` now ship the route, so its `disabledReason` is removed here
 * too. **This is the sixth and final destination — AC88 ("every destination
 * reachable") is now fully closed**: every member of `NAV_ITEMS` is a
 * `RoutedNavItem`, so `PendingNavPath`/`PendingNavItem` have no remaining
 * inhabitant (kept below, empty, rather than deleted, so a future task that
 * needs to route-gate a not-yet-shipped destination again has the shape
 * ready). The closing proof used to be `nav-items.test.ts`'s own "zero
 * disabled destinations" assertion; the `test-diet` cycle deleted that file
 * and **nothing re-asserts it today** — `PendingNavItem`
 * having no inhabitant is now held by the type, since a `PendingNavPath` with
 * no members cannot be constructed, and not by a test.
 */
/** All eleven destinations have a real route. */
export type RoutedNavPath =
  | "/"
  | "/portfolios"
  | "/holdings"
  | "/activity"
  | "/performance"
  | "/dividends"
  | "/watchlist"
  | "/instruments"
  | "/controls"
  | "/import"
  | "/currencies";
/** No destination is currently pending a route — kept as a type for shape-readiness, per this file's own header. */
export type PendingNavPath = never;
export type NavPath = RoutedNavPath | PendingNavPath;

/**
 * A discriminated union on `disabledReason`, not a single interface with an
 * optional field: a routed item's `to` must type-check against the router's
 * own known paths (`<Link to>`), and TypeScript can only narrow `to`'s type
 * down to `RoutedNavPath` inside an `item.disabledReason === undefined`
 * branch if the two variants are genuinely distinguishable at the type
 * level — a plain optional `disabledReason?: string` on one shared interface
 * would not narrow `to` at all, forcing an unchecked cast at every `<Link>`
 * call site instead.
 */
export interface RoutedNavItem {
  readonly to: RoutedNavPath;
  readonly label: string;
  /**
   * The destination's Lucide glyph, declared here rather
   * than in the rail and the tab bar separately — the same reason the label
   * lives here. Two surfaces reading one icon is what keeps them from drifting
   * (the parity guarantee this file exists for), and it is why the rail's old
   * bullet placeholder could sit in both surfaces unnoticed.
   */
  readonly icon: IconName;
  readonly disabledReason?: undefined;
}

export interface PendingNavItem {
  readonly to: PendingNavPath;
  readonly label: string;
  readonly icon: IconName;
  /**
   * Present only for a destination with no route yet. Non-`undefined` is
   * exactly what every renderer keys its honest-disabled treatment off of —
   * never a separate "known-pending" list that could drift from this one.
   */
  readonly disabledReason: string;
}

export type NavItem = RoutedNavItem | PendingNavItem;

export interface NavSection {
  readonly id: string;
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: "vue-ensemble",
    label: "Vue d'ensemble",
    items: [
      { to: "/", label: "Aperçu", icon: "layout-dashboard" },
      // Locked OQ-P3
      // (dedicated route).
      { to: "/portfolios", label: "Portefeuilles", icon: "building" },
    ],
  },
  {
    id: "investissements",
    label: "Investissements",
    items: [
      { to: "/holdings", label: "Positions", icon: "wallet" },
      // UR-19 — the ledger's own nav destination.
      { to: "/activity", label: "Activité", icon: "file-text" },
      // The design's seventh destination, and the last
      // one: Price & valuation was dropped.
      { to: "/performance", label: "Performance", icon: "line-chart" },
      // `dividend-screen` LD-9 — the fourth Investissements destination.
      // `GET /dividends/summary` is the read it shows; the section grows
      // rather than a one-item section being opened. `banknote` rather than
      // `coins`, which is already Devises': two destinations sharing a glyph
      // defeats the reason the icon lives in this file at all.
      { to: "/dividends", label: "Dividendes", icon: "banknote" },
      // `watchlist` LD-4/UR-47 — the fifth Investissements destination. The
      // same three constraints this file records for `/import`, `/currencies`
      // and `/dividends` apply and are met: the section is *grown* (four ->
      // five) rather than a one-item section being opened; `RoutedNavPath`
      // gains it in the same commit as the live route, so the "zero disabled
      // destinations" assertion stays green; and `MOBILE_TAB_PATHS` is
      // **untouched** — a decision-support review surface is not a one-handed
      // destination, and it reaches mobile through the "Plus" drawer, which
      // renders every destination.
      //
      // It sits in "Investissements" rather than "Données et administration"
      // for the reading that put Dividendes there: it reports on instruments as
      // investments (cours, variations, indicateurs), and it is not desk work
      // over the data itself. `eye` rather than a new glyph — it is the same
      // "watch" verb `<WatchToggle>` carries, it is already in the registry and
      // already pinned, and no other nav item uses it.
      { to: "/watchlist", label: "Suivi", icon: "eye" },
    ],
  },
  {
    id: "donnees",
    label: "Données et administration",
    items: [
      // UR-26..UR-28.
      { to: "/instruments", label: "Instruments", icon: "table" },
      // UR-30..UR-32 (the AC88 closing destination).
      { to: "/controls", label: "Contrôles", icon: "list-checks" },
      // Devises: the FX pairs this deployment
      // fetches, their stored coverage, and the two controls the owner asked
      // for (relance, ajout d'une paire). It belongs in this section by the
      // same reading of the heading the import does: it is desk work over the
      // data itself, not a portfolio view. Price & valuation was dropped as "no read exists
      // that it could show"; `GET /market-data/fx` is that read, and FX is the
      // scope this destination ships with.
      { to: "/currencies", label: "Devises", icon: "coins" },
      // csv-import, OD-11(a) (CI-22). This section **grows**
      // from two to three rather than a fourth section being opened for one
      // item — that is exactly how this file's "no single-item section" rule
      // is satisfied, and the import belongs with the other two by the same
      // reading of the heading: it is desk work over the data itself, not a
      // portfolio view.
      { to: "/import", label: "Importer", icon: "upload" },
    ],
  },
];

/** Preserved flat export — derived, never declared directly. */
export const NAV_ITEMS: readonly NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

/**
 * The bottom tab bar's four highest-frequency destinations.
 *
 * **Devises does not join it**, for the same reason Instruments and
 * Contrôles do not: it is desk work, reached one tap away in the "Plus"
 * drawer (which renders every destination), not one-handed on a phone.
 *
 * **The long-standing discrepancy is now resolved, in favour of
 * Portefeuilles.** An earlier design named Portefeuilles; a later review
 * named Contrôles and won at the time for being newer. The Kerdial design
 * is newer still, and it names Portefeuilles *with a reason* rather than as a
 * list: Instruments, Price & valuation and Contrôles "live under More — they
 * are desk work". That reasoning decides it. Contrôles is a
 * data-quality console, not something reached one-handed on a phone; it stays
 * one tap away in the "Plus" drawer, which renders every destination.
 *
 * Recorded rather than silently flipped: this changes which four tabs a
 * mobile user sees.
 *
 * Built by looking each path up in `NAV_ITEMS` (never a separate literal
 * list) so the two can never structurally diverge, and so the subset holds
 * by *reference* identity, not merely by equal value. `nav-items.test.ts`
 * asserted that until the `test-diet` cycle deleted it; the `.find()` below, which
 * throws when a path is absent, is what enforces it now.
 */
const MOBILE_TAB_PATHS: readonly NavPath[] = ["/", "/holdings", "/activity", "/portfolios"];

export const MOBILE_TAB_ITEMS: readonly NavItem[] = MOBILE_TAB_PATHS.map((to) => {
  const item = NAV_ITEMS.find((candidate) => candidate.to === to);
  if (item === undefined) {
    throw new Error(`MOBILE_TAB_ITEMS: no NAV_ITEMS entry for ${to}`);
  }
  return item;
});
