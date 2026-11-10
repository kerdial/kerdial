import { TABLET_BREAKPOINT_QUERY, useMediaQuery } from "../hooks/use-media-query.js";
import { SideNav } from "./SideNav.js";

/**
 * UR-25's conditional-mount wrapper around `SideNav`: the rail exists only
 * from `640px` up (`AppShell.tsx` mounts `MobileTabBar` below it instead).
 *
 * Previously, the rail and the mobile drawer trigger were **both**
 * always mounted, one merely CSS-hidden (`hidden sm:flex` /
 * `sm:hidden`) — the same class of hazard `use-media-query.ts`'s own F5 note
 * documents against `HoldingsTable`/`HoldingsCardList` (an invisible tree
 * still mounts every descendant, e.g. `Tooltip` instances, quietly
 * defeating whatever the invisible tree was supposed to avoid). The rail has
 * no virtualization concern the way a holdings table does, but the same
 * "exactly one of the alternatives is mounted, gated on `useMediaQuery`"
 * discipline applies here for consistency, and because a permanently-mounted
 * rail is exactly the "primary-nav" role query that `nav-drawer-aria-hidden
 * .spec.ts` must be able to rely on being genuinely absent below `640px`,
 * not merely invisible.
 *
 * `data-testid="primary-nav"` lives on `SideNav`'s own
 * `<nav>`, not here — this component either renders that `<nav>` or renders
 * nothing.
 */
export function PrimaryNav() {
  const isTabletUp = useMediaQuery(TABLET_BREAKPOINT_QUERY);
  if (!isTabletUp) return null;
  return <SideNav />;
}
