import { useState, type ReactNode } from "react";
import { instrumentIconUrl } from "../lib/api-client.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { Icon } from "./ui/index.js";

/**
 * `InstrumentIconTile.tsx` — the one component that renders an instrument's
 * uploaded icon, on all five surfaces
 * (FR-303,
 * FR-307–FR-312, FR-314).
 *
 * ## Why an `<img src>` here is not a `no-inline-icons` violation, and why
 * that is a class distinction rather than an exemption
 *
 * `kerdial-tokens/no-inline-icons` runs at `error` over all of `web/src` and
 * reports exactly four shapes (`eslint-rules/no-inline-icons.mjs`): an `<svg>`
 * subtree containing a `<path>`, an import of one of eight foreign icon
 * packages, a direct `lucide-react` import outside `components/ui/Icon.tsx`,
 * and an emoji in a `Literal`/`JSXText`. This file contains none of them.
 *
 * The distinction it rests on is not "the linter did not catch it":
 * **an app icon is chrome and an instrument icon is tenant data.** Chrome goes
 * through `Icon.tsx`'s registry — one Lucide set, one stroke, one size scale,
 * decided by the design system. What this component renders is a file a user
 * uploaded for one row of their own portfolio, in the same class as that row's
 * `display_name`: the product neither chose it nor can name it, and there is
 * no registry it could belong to. `web/src/components/ui/Brand.tsx` already
 * renders the brand mark as a decorative same-origin `<img>` for the same
 * reason and is likewise not a violation. (Its asset path is deliberately not
 * quoted here: `brand.test.tsx` asserts that exactly one file in `web/src`
 * mentions it, by a bare substring scan that reads comments too, so prose
 * naming the path would break a real single-source-of-truth guard. Found by
 * that test going red on an earlier draft of this comment.)
 *
 * So this cycle adds **no** entry to `ICON_NAMES` (46 at the branch point,
 * counted from `Icon.tsx`'s `REGISTRY`), no second icon registry, no icon
 * package, no inline path data and no emoji, and `Icon.tsx` and
 * `icon-discipline.test.ts` are untouched (FR-312, AC-310). V13 records that
 * the ESLint rule cannot police an `<img>`, which is why that is a requirement
 * with its own criterion rather than a property inherited from the gate.
 *
 * ## The monogram tiles are the fallback, read and never rewritten (G2, NG8)
 *
 * `children` is the existing tile — `HoldingsTable`/`HoldingsCardList`'s
 * `<span className="holdings-asset-tile k-mono" aria-hidden="true">`, or
 * `InstrumentDetailView`'s `k-inst-ticker` span — passed through verbatim.
 * An instrument with no icon therefore renders **exactly** what it renders
 * today, byte for byte, because it renders the same element.
 *
 * ## `hasIcon` false ⇒ no `<img>` ⇒ zero icon requests (FR-314)
 *
 * The property is structural, not a policy: when `hasIcon` is false the
 * element that would issue the request is **not in the tree**, so there is no
 * request to suppress and nothing to probe. `hasIcon` rides the holdings read
 * and both instrument reads (IK-10) precisely so this component never has to
 * ask. There is deliberately no `useQuery`, no `HEAD`, no `onLoad`-driven
 * retry and no imperative `new Image()` anywhere in this file.
 *
 * ## A failed load falls back, and never shows a broken image (FR-311)
 *
 * `onError` covers a 404 after a concurrent removal in another tab, an expired
 * session, an undecodable byte stream and an offline load alike — all four take
 * the same branch and render `children`. Never the browser's broken-image
 * glyph, never an empty box.
 *
 * A 401 on the `<img>` does **not** log the user out: `main.tsx`'s global 401
 * handler is wired to TanStack Query, not to image loads. An expired session
 * therefore shows monograms until the next real query does the logout — a
 * deliberate non-effect, recorded so it is not filed as a bug.
 *
 * ## A replace on *this* mount re-requests the bytes (FR-306, `iconVersion`)
 *
 * `instrumentIconUrl` is a pure function of the id, so a replace leaves the
 * `src` byte-identical. React then reconciles the **same** `<img>` element,
 * the browser is never asked to load anything, and the bitmap already decoded
 * into that element stays on screen — α after β was stored. LD-6 argued no
 * version token was needed because `no-store` leaves no cached copy for one to
 * bust; that is true of the HTTP cache, Cache Storage and the service worker,
 * and says nothing about a decoded bitmap held by a mounted element. GATE-3
 * measured the gap: zero new icon requests after a successful replace, α still
 * rendered (`instrument-icon-surfaces.spec.ts`, FR-306).
 *
 * The fix is **not** a query token on the URL, and that is a hard constraint
 * rather than a preference: FR-303/AC-311's own assertions read the rendered
 * `src` as an exact string, so `…/icon?v=2` would fail the criterion it was
 * meant to serve. Instead the identity of the *element* carries the version.
 * `key={iconIdentity}` makes a bumped version unmount the old `<img>` and
 * mount a new one, and a fresh element has no bitmap to keep: it must load,
 * and under `no-store` it must load from the network. So LD-6's reasoning is
 * used rather than contradicted — nothing about caching, headers, CSP or
 * routes changes, and the URL stays a pure function of the id.
 *
 * The counter is **local and never transmitted**. Its only duty is "the icon
 * you are showing may no longer be the current one", so a monotone `number`
 * the managing screen bumps is total-ordering-correct with no wire dependency,
 * and behaves identically for a removal — which resolves `204` and has no
 * `updatedAt` to borrow. `iconVersion` is omitted on the four read-only
 * surfaces, which have no write to observe and remount on navigation anyway;
 * that is also what keeps AC-308's request volume at one per iconed row
 * (a version that never changes never remounts anything).
 *
 * ## The pencil is opt-in, which is what keeps the other four read-only
 *
 * `onEditClick` — and *only* passing it — adds the small pencil chip over the
 * corner of the tile. It replaces the identity card's « Gérer l'icône » button
 * and its `<h3>` sub-header: one screen, one affordance, on the thing it
 * edits. `InstrumentDetailView.tsx` is the single call site that passes it, so
 * the holdings tables, the two instruments-list presentations,
 * `AssetSearchPopover`, `InstrumentDiscoverySearch` and `InstrumentCreateForm`
 * render exactly as before — "correctable where it is shown, nowhere else"
 * (NG2/NG3/NG4, IK-13) becomes structural rather than a placement convention,
 * because a surface that does not pass the prop cannot show the affordance.
 *
 * The chip is a real `<button>` **beside** the `aria-hidden` box rather than
 * inside it: the tile is decorative (see the accessibility section below) and
 * the control that edits it is not, so it carries its own name
 * ({@link INSTRUMENT_COPY.iconManage}, the same words the removed button had)
 * and stays reachable by keyboard and by assistive technology. Both branches
 * of the tile — icon and monogram — get it, because "this instrument has no
 * icon yet" is exactly when adding one is wanted.
 *
 * ## Accessibility: the icon announces nothing, and that is a decision
 *
 * `alt=""` **and** `aria-hidden="true"` — the `Brand.tsx` pairing. `alt=""`
 * alone already removes an image from the accessibility tree; both are set
 * because all three existing tiles set `aria-hidden` explicitly and the pair
 * makes the intent unmissable at the call site.
 *
 * The reasoning, which is FR-310/AC-313 and is a decision this cycle had to
 * make rather than inherit: an uploaded logo **is** real content, unlike the
 * monogram it replaces, so "it was decorative before" is not on its own an
 * argument. What settles it is that there is no honest name to give it. No
 * filename is stored (FR-304 forbids reflecting one), so the only candidate
 * text is derived from the display name — which is rendered as real text
 * immediately beside this element on every one of the five surfaces. Naming it
 * « icône de Air Liquide » would make a screen reader announce the same
 * instrument twice per row, and inventing anything else would be a fabricated
 * identifier on a financial row — the same argument `holdings.css`'s own note
 * gives for the monogram not being a ticker. So the accessible name of a
 * holdings row, an instruments-list row and the detail heading is **identical**
 * with and without an icon, which `InstrumentIconTile.test.tsx` asserts as
 * computed strings rather than as the presence of an attribute.
 */

/** `.holdings-asset-tile`'s box, `web/src/styles/screens/holdings.css` — 34px, reused and not redeclared (NG8). */
const TILE_PX = 34;

/** `.k-inst-ticker`'s box, `web/src/styles/screens/instruments.css` — 38px, likewise. */
const BADGE_PX = 38;

/** `.k-donut-slice-icon`'s box, `web/src/styles/components.css` — 20px, the marker outside the dashboard donut's ring. */
const SLICE_PX = 20;

/**
 * The host box each size renders the image inside. Both classes already exist
 * and are **not** touched by this cycle: the box stays the box, and
 * `.k-inst-icon-img` only fills it.
 *
 * `.holdings-asset-tile` is declared in `screens/holdings.css` and is reused
 * here by the two instruments-list surfaces as well, which is what NG8's
 * "reused, not redeclared" requires — declaring a second 34px box in
 * `instruments.css` would be two sources of truth for one geometry, and
 * `styles.css` imports every screen sheet globally so the class resolves on
 * every screen.
 */
const BOX_CLASS: Readonly<Record<IconTileSize, string>> = {
  tile: "holdings-asset-tile",
  badge: "k-inst-ticker",
  slice: "k-donut-slice-icon",
};

const BOX_PX: Readonly<Record<IconTileSize, number>> = {
  tile: TILE_PX,
  badge: BADGE_PX,
  slice: SLICE_PX,
};

/**
 * `"tile"` (34px, the holdings and instruments lists), `"badge"` (38px, the
 * detail header) or `"slice"` (20px, drawn outside a donut's ring at its
 * arc's midpoint by `ui/DonutAllocation`). The third size is the only one whose box
 * class this component owns: the first two reuse boxes that pre-date it (NG8),
 * and there was no 20px box to reuse.
 */
export type IconTileSize = "tile" | "badge" | "slice";

export interface InstrumentIconTileProps {
  readonly instrumentId: string;
  /** From `HoldingResponse.hasIcon` / `InstrumentDetailResponse.hasIcon` — never from a request of this component's own (FR-313). */
  readonly hasIcon: boolean;
  /** The existing monogram/ticker span, passed through untouched (NG8). */
  readonly children: ReactNode;
  /** See {@link IconTileSize}. */
  readonly size?: IconTileSize;
  /**
   * Bumped by the screen that *manages* this instrument's icon after every
   * successful write to it — set, replace or remove (FR-306, through the icon dialog).
   * Omitted everywhere else; see the `iconVersion` section above for why a
   * counter and not the stored `updatedAt`.
   */
  readonly iconVersion?: number;
  /**
   * Opens the icon dialog. Passed **only** by `InstrumentDetailView.tsx`, the
   * one screen an icon can be written from (LD-5/FR-291); omitting it —
   * which every other surface does — renders the tile exactly as before, with
   * no pencil and no extra element.
   */
  readonly onEditClick?: () => void;
}

export function InstrumentIconTile({
  instrumentId,
  hasIcon,
  children,
  size = "tile",
  iconVersion = 0,
  onEditClick,
}: InstrumentIconTileProps) {
  /*
   * "Which instrument's icon, at which version" — the identity of the bytes
   * this element is meant to be showing. Both the `<img>`'s `key` and the
   * failure memory below are keyed on it, which is what makes one value fix
   * two defects: a bump remounts the element (so a replace re-requests) and
   * simultaneously stops matching a recorded failure (so an upload after a
   * failed load renders).
   */
  const iconIdentity = `${instrumentId}@${iconVersion}`;
  /*
   * The failure is stored **as the id it happened to**, not as a boolean.
   *
   * `HoldingsTable` and `InstrumentTable` window their rows through
   * `@tanstack/react-virtual`, which recycles a row's React node for a
   * different holding as the list scrolls. A `useState(false)` + `useEffect`
   * reset would leave a one-render window in which the recycled row still
   * carries the previous instrument's failure and shows the wrong fallback;
   * comparing against the current `instrumentId` closes that window without a
   * reset effect at all, because the stale value simply stops matching.
   *
   * It is stored as {@link iconIdentity} rather than as the bare id for the
   * same reason, extended one step: a failure belongs to the bytes that failed,
   * not to the instrument forever. GATE-3 reached the id-only version as a user
   * would — `hasIcon` true with the bytes already removed in another tab gives
   * a 404 and a monogram, and the successful upload that followed rendered
   * nothing, because `failedFor` could only ever be cleared by the row being
   * recycled onto a *different* instrument. Keying on the version clears it
   * with no reset effect, exactly as the id keying clears the recycled row.
   */
  const [failedFor, setFailedFor] = useState<string | undefined>(undefined);

  const tile =
    !hasIcon || failedFor === iconIdentity ? (
      <>{children}</>
    ) : (
      renderIcon(instrumentId, iconIdentity, size, setFailedFor)
    );

  if (onEditClick === undefined) return tile;

  return (
    <span className="k-inst-icon-editable">
      {tile}
      <button
        type="button"
        className="k-inst-icon-edit"
        data-testid="instrument-detail-icon-edit"
        aria-label={INSTRUMENT_COPY.iconManage}
        title={INSTRUMENT_COPY.iconManage}
        onClick={onEditClick}
      >
        <span className="k-inst-icon-edit-chip">
          <Icon name="pencil" size="xs" />
        </span>
      </button>
    </span>
  );
}

/**
 * The `<img>` branch, lifted out only so the editable wrapper above reads as
 * one expression. Every attribute on it is unchanged from the version that
 * returned directly from the component.
 */
function renderIcon(
  instrumentId: string,
  iconIdentity: string,
  size: IconTileSize,
  onFailure: (identity: string) => void,
) {
  return (
    <span className={BOX_CLASS[size]} aria-hidden="true" data-testid="instrument-icon-box">
      <img
        /*
         * FR-306. Not cosmetic and not a React hygiene habit: the `src` is
         * unchanged across a replace, so this key is the *only* thing that
         * tells React the element showing α is not the element that should
         * show β. Without it the same DOM node is reused and no request is
         * issued.
         */
        key={iconIdentity}
        src={instrumentIconUrl(instrumentId)}
        alt=""
        aria-hidden="true"
        /*
         * Explicit intrinsic size equal to the fallback box, so the swap moves
         * nothing while the bytes are in flight (AC-314's no-layout-shift
         * half). The CSS then scales the loaded image to fill that box with
         * `object-fit: contain` — SD-3 imposes no aspect ratio, so a wide logo
         * is letterboxed rather than cropped, which is the honest rendering of
         * a file the product refuses to re-encode (SD-4).
         */
        width={BOX_PX[size]}
        height={BOX_PX[size]}
        className="k-inst-icon-img"
        data-testid="instrument-icon-image"
        onError={() => onFailure(iconIdentity)}
      />
    </span>
  );
}
