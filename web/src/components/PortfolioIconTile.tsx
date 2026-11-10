import { useState, type CSSProperties } from "react";
import type { PortfolioAccentColor } from "@kerdial/core-reference-data";
import { portfolioIconUrl } from "../lib/api-client.js";
import { portfolioAccentColor } from "../lib/portfolio-accent.js";
import { Icon } from "./ui/index.js";

/**
 * `PortfolioIconTile.tsx` — the one component that renders a portfolio's
 * uploaded icon, on all three surfaces
 * (FR-468, FR-469,
 * FR-473, FR-474).
 *
 * ## Why a sibling of `InstrumentIconTile` and not a generalised component
 *
 * PD-16, and it is a measurement rather than a preference.
 * `InstrumentIconTile` takes an `instrumentId`, builds an instrument URL, owns
 * a three-member size/box map for instrument surfaces, and carries an opt-in
 * pencil affordance whose whole purpose is "the one screen an instrument icon
 * can be written from". Generalising it would rewrite a shipped, security-
 * reviewed component — with a doc comment that is entirely about instruments —
 * to save roughly forty lines, and would couple two features' render paths.
 * The part genuinely worth sharing is *validation*, and that is shared, in
 * `core/` and in `lib/icon-pick.ts`.
 *
 * ## `hasIcon` false ⇒ no `<img>` ⇒ zero icon requests (FR-467, NFR-53)
 *
 * Structural, not a policy: when `hasIcon` is false the element that would
 * issue the request is **not in the tree**, so there is no request to suppress
 * and nothing to probe. `hasIcon` rides the one `["portfolios","list"]` read
 * every surface already mounts (the join costs zero extra
 * statements) precisely so this component never has to ask. There is
 * deliberately no `useQuery`, no `HEAD`, no `onLoad`-driven retry and no
 * imperative `new Image()` in this file.
 *
 * ## `onError` ⇒ the wallet fallback (FR-474)
 *
 * A `404` after a concurrent removal in another tab, an expired session, an
 * undecodable stream and an offline load all take the same branch and render
 * the existing `<span className="k-pf-tile">` wallet glyph — never the
 * browser's broken-image icon, never an empty box. The `<img>` carries
 * explicit `width`/`height` equal to the fallback box, so the swap moves
 * nothing.
 *
 * **The failure is remembered as `` `${portfolioId}@${iconVersion}` ``, not as
 * a boolean** — `InstrumentIconTile`'s GATE-3 correction, inherited with
 * its reason intact: a failure belongs to the bytes that failed, not to the
 * portfolio forever. Keyed this way it clears itself on a successful re-upload
 * with no reset effect at all, because the stale value simply stops matching.
 *
 * ## `key={iconIdentity}` is the only thing that makes a replace re-request
 *
 * `portfolioIconUrl` is a pure function of the id, so a replace leaves the
 * `src` byte-identical; React then reconciles the **same** `<img>` element, the
 * browser is never asked to load anything, and the bitmap already decoded into
 * that element stays on screen. `no-store` does not help — it governs caches,
 * and a mounted element's decoded bitmap is in none of them. Keying the
 * element on the version makes a bump unmount the old `<img>` and mount a new
 * one, and a fresh element has no bitmap to keep: it must load, and under
 * `no-store` it must load from the network.
 *
 * **The URL stays token-free.** A `?v=` would defeat the `src`-by-exact-string
 * assertions and would land outside the request-volume spec's interception.
 * The identity of the *element* carries the version instead.
 *
 * `iconVersion` is omitted by read-only surfaces, which have no write to
 * observe and remount on navigation anyway — a version that never changes
 * never remounts anything, which is what keeps the per-row request count at
 * one.
 *
 * ## `alt=""` and `aria-hidden="true"` (FR-473)
 *
 * The reasoning is the portfolio's own, not inherited: no filename is stored,
 * so the only candidate name would be derived from the portfolio name — which
 * is rendered as real text immediately beside this element on all three
 * surfaces. Naming the tile would make a screen reader announce the portfolio
 * twice per row. AC-408 (PD-T11) asserts the computed accessible names are
 * string-identical with and without every field set.
 *
 * **An `<img src>` here is not a `no-inline-icons` violation**, for
 * `InstrumentIconTile`'s recorded class reason: an app icon is chrome and goes
 * through `Icon.tsx`'s registry; an uploaded portfolio icon is tenant data, in
 * the same class as its name. No `ICON_NAMES` entry, no icon package, no
 * emoji — `Icon.tsx` and `icon-discipline.test.ts` are untouched.
 *
 * ## The accent is a ring on the box, never a fill (PD-15)
 *
 * `data-accent` plus an inline `--k-pf-accent` custom property; the 2px inset
 * `box-shadow` that reads them lives in `styles/screens/portfolios.css`
 * (PD-T11). When `accentColor` is `null` **no attribute and no style are
 * emitted**, so the tile keeps its current `--surface-brand-soft` ground and
 * `--text-brand` glyph byte for byte (G2). Why a ring and not a fill:
 * `portfolio-accent.ts`' own header has it — the six ramp tokens are vetted as
 * marks on the app surface, and a saturated fill behind the wallet glyph is a
 * foreground/background pairing nobody has checked.
 */

/**
 * `.k-pf-tile`'s box, `web/src/styles/screens/portfolios.css` —
 * `var(--tap-target)`, 44px. **Reused, not redeclared** (NG8): the box stays
 * the box and this cycle adds no second 44px geometry. The number is mirrored
 * here only as the `<img>`'s intrinsic `width`/`height`, so the fallback→image
 * swap moves nothing while the bytes are in flight.
 *
 * `.k-inst-icon-img` is likewise reused rather than cloned under a `k-pf-`
 * name: it is four purely geometric declarations (fill the host box,
 * `object-fit: contain`, `radius-sm`, `display: block`) in the global
 * `components.css`, it carries no instrument semantics, and a byte-identical
 * copy would be two sources of truth for one rule.
 */
const TILE_PX = 44;

export interface PortfolioIconTileProps {
  readonly portfolioId: string;
  /** From `PortfolioSummary.hasIcon` — never from a request of this component's own (FR-467). */
  readonly hasIcon: boolean;
  readonly accentColor: PortfolioAccentColor | null;
  /** Bumped by the screen that manages this portfolio's icon, after every successful write. */
  readonly iconVersion?: number;
}

export function PortfolioIconTile({
  portfolioId,
  hasIcon,
  accentColor,
  iconVersion = 0,
}: PortfolioIconTileProps) {
  /*
   * "Which portfolio's icon, at which version" — the identity of the bytes this
   * element is meant to be showing. Both the `<img>`'s `key` and the failure
   * memory below are keyed on it, which is what makes one value fix two
   * defects: a bump remounts the element (so a replace re-requests) and
   * simultaneously stops matching a recorded failure (so an upload after a
   * failed load renders).
   */
  const iconIdentity = `${portfolioId}@${iconVersion}`;
  const [failedFor, setFailedFor] = useState<string | undefined>(undefined);

  /*
   * No `data-accent` and no inline style when the accent is unset — G2's
   * "a portfolio with none of the four fields set looks exactly as it does
   * today" is an assertion about the emitted attributes, not about a
   * transparent value being painted.
   */
  const accentProps =
    accentColor === null
      ? {}
      : {
          "data-accent": accentColor,
          style: { "--k-pf-accent": portfolioAccentColor(accentColor) } as CSSProperties,
        };

  if (!hasIcon || failedFor === iconIdentity) {
    return (
      <span
        className="k-pf-tile"
        aria-hidden="true"
        data-testid="portfolio-icon-box"
        {...accentProps}
      >
        <Icon name="wallet" size="md" />
      </span>
    );
  }

  return (
    <span
      className="k-pf-tile"
      aria-hidden="true"
      data-testid="portfolio-icon-box"
      {...accentProps}
    >
      <img
        /* The `src` is unchanged across a replace, so this key is the *only*
           thing that tells React the element showing α is not the element that
           should show β. Without it the same DOM node is reused and no request
           is issued. */
        key={iconIdentity}
        src={portfolioIconUrl(portfolioId)}
        alt=""
        aria-hidden="true"
        width={TILE_PX}
        height={TILE_PX}
        className="k-inst-icon-img"
        data-testid="portfolio-icon-image"
        onError={() => setFailedFor(iconIdentity)}
      />
    </span>
  );
}
