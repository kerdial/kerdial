import { Link } from "@tanstack/react-router";
import { TABLET_BREAKPOINT_QUERY, useMediaQuery } from "../hooks/use-media-query.js";
import { MOBILE_TAB_ITEMS } from "../nav-items.js";
import { MobileNav } from "./MobileNav.js";
import { Icon } from "./ui/Icon.js";
import { SHELL_COPY } from "../lib/copy/shell.js";

/**
 * The `<640px` fixed bottom tab bar (UR-25): `MOBILE_TAB_ITEMS`' four
 * highest-frequency destinations, plus a fifth "Plus" entry — `MobileNav`
 * itself, rendered inline here so its Radix `Dialog.Trigger` sits in the tab
 * bar's own flex row while its `Dialog.Portal`/`Dialog.Content` (the
 * drawer, containing all six destinations grouped by section) render via
 * Radix's portal regardless of where in the tree this component sits.
 * `data-testid="mobile-nav-trigger"` therefore *is* this bar's "Plus"
 * button — there is exactly one drawer trigger, as before.
 *
 * Mounted only below `640px` (`PrimaryNav.tsx` mounts `SideNav` above it) —
 * a genuine conditional mount via `useMediaQuery`, not a CSS-hide; see
 * `PrimaryNav.tsx`'s own doc comment for why that distinction matters here.
 *
 * `/controls` (Contrôles) is one of the four tab-bar entries
 * despite having no route yet — it renders
 * honest-disabled here exactly as it does in the rail/drawer
 * (`nav-items.ts`'s `disabledReason`), so the tab bar's composition does not
 * change once UR-30..UR-32 ship, only that one tab's interactivity does.
 */
export function MobileTabBar() {
  const isTabletUp = useMediaQuery(TABLET_BREAKPOINT_QUERY);
  if (isTabletUp) return null;

  return (
    <nav data-testid="mobile-tab-bar" aria-label={SHELL_COPY.primaryNav} className="k-tabbar">
      {MOBILE_TAB_ITEMS.map((item) =>
        item.disabledReason === undefined ? (
          <Link
            key={item.to}
            to={item.to}
            className="k-tabbar-item"
            activeProps={{ className: "active" }}
          >
            <Icon name={item.icon} size="md" />
            <span>{item.label}</span>
          </Link>
        ) : (
          <span
            key={item.to}
            role="link"
            aria-disabled="true"
            tabIndex={-1}
            title={item.disabledReason}
            className="k-tabbar-item k-tabbar-item-disabled"
          >
            <Icon name={item.icon} size="md" />
            <span>{item.label}</span>
          </span>
        ),
      )}
      <MobileNav />
    </nav>
  );
}
